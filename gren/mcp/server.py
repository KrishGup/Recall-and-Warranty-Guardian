"""gren MCP server - the same operations as the CLI/dashboard, as tools any Claude agent can call.

The important design point: with the `inbox` provider the calling agent IS the execution layer.
  gren_run -> gren_wait -> gren_tasks -> (execute each task with a cheap subagent) -> gren_complete_task -> gren_wait ...
The engine still owns the graph: dependencies, parallelism, validation, retries, budgets, gates.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import yaml
from mcp.server.mcpserver import MCPServer

from ..control import RunControl, list_graphs
from ..engine.state import RunStore, now_iso
from ..engine.validate import validate_against
from ..metrics.metrics import compute_metrics_deep, format_metrics
from ..models.registry import BRIDGE_NAMES
from ..reducers.builtin import BUILTIN_REDUCERS
from ..shapes import SHAPE_IDS, scaffold, shapes_summary
from ..spec.analyze import analyze, format_analysis
from ..spec.load import SpecError, load_graph, parse_spec_text
from ..spec.schema import FROZEN_CONSTRAINTS, GraphSpec

INSTRUCTIONS = (
    "gren runs graph-engineered multi-agent workflows on Strands Agents. Typical loop: gren_validate -> gren_run "
    "(bridge inbox means YOU execute agent nodes) -> gren_wait -> gren_tasks -> run each task with a subagent using the task's "
    "model -> gren_complete_task -> gren_wait ... -> gren_output/gren_metrics. Load the graph-engineering skill for design guidance."
)


def _j(v: Any) -> str:
    return json.dumps(v, indent=2, ensure_ascii=False, default=str)


def status_summary(store: RunStore, state) -> dict[str, Any]:
    spec = GraphSpec.model_validate(state.run["spec"])
    nodes = []
    for n in state.nodes.values():
        items = n.get("items")
        nodes.append({
            "id": n["id"], "kind": n["kind"], "status": n["status"], "duration_ms": n.get("duration_ms"), "cost_usd": round(float(n.get("cost_usd") or 0), 5),
            "items": f"{sum(1 for i in items if i['status'] == 'completed')}/{len(items)}" if items else None, "kill_rate": (n.get("verify") or {}).get("kill_rate"),
            "route": n.get("route"), "gate": (n.get("gate") or {}).get("decision"), "error": n.get("error"), "skip_reason": n.get("skip_reason"),
            "retries": n.get("retries") or None, "repairs": n.get("repairs") or None,
        })
    waiting = []
    for n in state.nodes.values():
        if n["status"] != "waiting_approval":
            continue
        g = spec.node(n["id"])
        art = store.read_artifact(state.run["id"], n["artifact"]) if n.get("artifact") else None
        art = art or {}
        waiting.append({"gate": n["id"], "title": getattr(g, "title", None), "prompt": art.get("prompt"), "if_you_approve": getattr(g, "approve_effect", None) or art.get("approve_effect"),
                        "if_you_reject": getattr(g, "reject_effect", None) or art.get("reject_effect"), "show": art.get("show")})
    tasks = [{"task_id": t["task_id"], "run_id": t["run_id"], "node": t["node_id"], "item": t.get("item_index"), "model": t.get("model"), "effort": t.get("effort"), "role": t.get("role"), "status": t.get("status")} for t in store.list_tasks_deep(state.run["id"])]
    st = state.run["status"]
    if st == "completed":
        nxt = "run is complete: call gren_output / gren_metrics"
    elif st in ("failed", "cancelled"):
        nxt = "run ended: inspect gren_events / gren_node for the failing node, fix the graph, re-run"
    elif tasks:
        nxt = "execute the pending tasks (gren_tasks for full prompts) and submit each with gren_complete_task, then gren_wait"
    elif waiting:
        nxt = "a human gate is waiting: decide with gren_approve (only if you are authorised to act as the approver)"
    else:
        nxt = "call gren_wait to block until something needs you"
    return {"run_id": state.run["id"], "graph": state.run["graph"], "status": st, "bridge": state.run["bridge"], "error": state.run.get("error"), "warnings": state.run.get("warnings"),
            "totals": state.run["totals"], "nodes": nodes, "waiting_gates": waiting, "pending_tasks": tasks, "next_step": nxt}


def build_server(store: RunStore, graphs_dir: str) -> MCPServer:
    graphs_dir = os.path.abspath(graphs_dir)
    recent: list[dict[str, Any]] = []

    def log(m: str) -> None:
        sys.stderr.write(f"[gren-mcp] {m}\n")
        sys.stderr.flush()

    def remember(e: dict[str, Any]) -> None:
        recent.append(e)
        if len(recent) > 2000:
            del recent[: len(recent) - 2000]

    control = RunControl(store, graphs_dir, emit=remember, log=log)
    server = MCPServer(name="gren", instructions=INSTRUCTIONS, version="2.0.0", log_level="WARNING")

    def resolve_spec(spec_path: str | None, spec_yaml: str | None) -> GraphSpec:
        if spec_yaml:
            return parse_spec_text(spec_yaml)
        return control.load(spec_path=spec_path).spec

    @server.tool(name="gren_shapes", description="List the five graph shapes (fork/join, escalation ladder, tournament, map-reduce-verify, bounded discovery loop) with diagrams and when to use them.")
    def gren_shapes() -> str:
        return _j(shapes_summary())

    @server.tool(name="gren_reference", description="Reference for writing graph specs: node kinds, reference syntax, failure policy, frozen constraints, built-in reducers, providers. Read this before authoring a graph.")
    def gren_reference() -> str:
        candidates = [os.path.join(graphs_dir, "..", "docs", "SPEC.md"), os.path.join(os.getcwd(), "docs", "SPEC.md"), os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "docs", "SPEC.md")]
        doc = next((f for f in candidates if os.path.exists(f)), None)
        body = open(doc, encoding="utf-8").read() if doc else "(docs/SPEC.md not found)"
        frozen = "\n".join(f"- {k}: {v}" for k, v in FROZEN_CONSTRAINTS.items())
        return f"{body}\n\n## Frozen constraints\n{frozen}\n\n## Built-in reducers\n{', '.join(BUILTIN_REDUCERS)}\n\n## Providers (bridges)\n{', '.join(BRIDGE_NAMES)}"

    @server.tool(name="gren_scaffold", description=f"Generate a starter graph spec (YAML) for a shape: {', '.join(SHAPE_IDS)}.")
    def gren_scaffold(shape: str, name: str) -> str:
        return scaffold(shape, name)

    @server.tool(name="gren_validate", description="Validate a graph spec (path or YAML text): schema, derived edges (what data crosses each), cycle check, frozen constraints, dependency-test warnings, estimated critical path/cost, checklist. Fix every error before running.")
    def gren_validate(spec_path: str | None = None, spec_yaml: str | None = None) -> str:
        try:
            spec = resolve_spec(spec_path, spec_yaml)
            a = analyze(spec)
            return f"{format_analysis(a)}\n\nJSON:\n{_j({'ok': a.ok, 'findings': [f.to_dict() for f in a.findings], 'edges': [e.to_dict() for e in a.edges], 'critical_path': a.critical_path, 'max_width': a.max_width, 'est_cost_usd': a.est_cost_usd})}"
        except SpecError as e:
            return f"INVALID: {e.message}\n" + "\n".join(f"  - {i}" for i in e.issues)
        except Exception as e:  # noqa: BLE001
            return f"INVALID: {e}"

    @server.tool(name="gren_write_graph", description="Validate a YAML graph spec and write it to a file (relative paths resolve inside the graphs dir). Refuses to write specs with errors.")
    def gren_write_graph(path: str, spec_yaml: str) -> str:
        spec = parse_spec_text(spec_yaml)
        a = analyze(spec)
        if not a.ok:
            return f"NOT WRITTEN - errors:\n{format_analysis(a)}"
        file = path if os.path.isabs(path) else os.path.join(graphs_dir, path)
        os.makedirs(os.path.dirname(file) or ".", exist_ok=True)
        with open(file, "w", encoding="utf-8") as f:
            f.write(spec_yaml)
        return f"wrote {file}\n{format_analysis(a)}"

    @server.tool(name="gren_list_graphs", description="List graph specs available in the graphs directory with a validation summary.")
    def gren_list_graphs() -> str:
        return _j(list_graphs(graphs_dir))

    @server.tool(name="gren_run", description="Start a run (in the background, inside this MCP process). bridge: 'inbox' (default) = agent nodes become tasks that YOU execute (gren_wait/gren_tasks/gren_complete_task); 'bedrock' = Amazon Bedrock (AWS credentials); 'anthropic' = ANTHROPIC_API_KEY; 'claude-code' = headless Claude Code sessions; 'mock' = no tokens. Returns run_id immediately.")
    def gren_run(spec_path: str | None = None, spec_yaml: str | None = None, input: dict[str, Any] | None = None, bridge: str | None = None, run_id: str | None = None, auto_approve: bool = False) -> str:
        rid = control.start(spec_path=spec_path, spec_yaml=spec_yaml, input_=input or {}, bridge=bridge or os.environ.get("GREN_BRIDGE") or "inbox", run_id=run_id, auto_approve=auto_approve)
        time.sleep(0.3)
        return _j({"run_id": rid, **status_summary(store, store.load(rid))})

    @server.tool(name="gren_status", description="Current state of a run: node table, waiting gates, pending tasks, totals, and the suggested next step.")
    def gren_status(run_id: str) -> str:
        return _j(status_summary(store, store.load(run_id)))

    @server.tool(name="gren_wait", description="Block until the run needs attention: pending inbox tasks exist, a gate is waiting, or the run finished. Returns the same summary as gren_status. Use timeout_ms up to 120000.")
    def gren_wait(run_id: str, timeout_ms: int = 30000) -> str:
        deadline = time.time() + min(max(int(timeout_ms), 100), 120000) / 1000
        while True:
            st = store.load(run_id)
            tasks = store.list_tasks_deep(run_id)
            gates = any(n["status"] == "waiting_approval" for n in st.nodes.values())
            terminal = st.run["status"] in ("completed", "failed", "cancelled")
            if tasks or gates or terminal or time.time() >= deadline:
                return _j({**status_summary(store, st), "timed_out": not (tasks or gates or terminal)})
            time.sleep(0.4)

    @server.tool(name="gren_tasks", description="Pending inbox tasks (full prompt, system prompt, JSON schema, model, effort) for a run - or all runs. Execute each with the requested model (e.g. spawn a subagent with that model), then gren_complete_task.")
    def gren_tasks(run_id: str | None = None, include_claimed: bool = False) -> str:
        return _j(store.list_tasks_deep(run_id) if run_id else store.list_all_pending_tasks())

    @server.tool(name="gren_claim_task", description="Mark an inbox task as claimed by a worker (optional bookkeeping so parallel workers do not double-execute).")
    def gren_claim_task(run_id: str, task_id: str, worker: str | None = None) -> str:
        t = store.read_task(run_id, task_id)
        if t is None:
            return f"task {task_id} not found in {run_id}"
        if store.read_task_result(run_id, task_id):
            return _j({"ok": False, "reason": "already has a result"})
        if t.get("status") != "pending":
            return _j({"ok": False, "reason": f"task is {t.get('status')}{' by ' + str(t.get('claimed_by')) if t.get('claimed_by') else ''}"})
        t["status"], t["claimed_by"], t["claimed_at"] = "claimed", worker or "mcp", now_iso()
        store.write_task(t)
        after = store.read_task(run_id, task_id) or {}
        if after.get("claimed_by") != t["claimed_by"]:
            return _j({"ok": False, "reason": f"lost a claim race to {after.get('claimed_by')}"})
        return _j({"ok": True, "task_id": task_id, "claimed_by": t["claimed_by"]})

    @server.tool(name="gren_complete_task", description="Submit the result of an inbox task. `output` must validate against the task's output_schema (validated here; the engine validates again). Report cost_usd/model/source honestly so the run's metrics are real. Use `error` to report that the task could not be done (the engine applies the node's failure policy).")
    def gren_complete_task(run_id: str, task_id: str, output: Any = None, error: str | None = None, cost_usd: float | None = None, model: str | None = None, source: str | None = None, worker: str | None = None, force: bool = False) -> str:
        t = store.read_task(run_id, task_id)
        if t is None:
            return f"task {task_id} not found in {run_id}"
        if t.get("status") == "completed" or store.read_task_result(run_id, task_id):
            return f"task {task_id} already has a result; not overwriting"
        if t.get("status") == "cancelled":
            return f"task {task_id} was cancelled by the engine (timed out or run ended); do not submit"
        if error is None:
            ok, errs = validate_against(t.get("output_schema"), output)
            if not ok and not force:
                return "REJECTED - output does not match output_schema:\n" + "\n".join(f"  - {e}" for e in errs) + "\nFix the output and submit again (or set force=true to let the engine reject it and apply the failure policy)."
        store.write_task_result(run_id, {"task_id": task_id, "output": output, "error": error, "cost_usd": cost_usd, "model": model or t.get("model"), "source": source or "orchestrator", "worker": worker or "mcp-client", "completed_at": now_iso()})
        return _j({"ok": True, "task_id": task_id, "remaining": len(store.list_tasks_deep(run_id.split("/nested/")[0]))})

    @server.tool(name="gren_approve", description="Record a human gate decision. Only call this when the human you are acting for has actually decided (or the run was started for a demo with explicit permission).")
    def gren_approve(run_id: str, gate: str, decision: str, by: str | None = None, comment: str | None = None) -> str:
        decision = "rejected" if decision == "rejected" else "approved"
        control.approve(run_id, gate, decision, by or "mcp-client", comment)
        st = store.load(run_id)
        if not control.is_running(run_id) and st.run["status"] == "paused":
            control.resume(run_id)
        return _j({"ok": True, "gate": gate, "decision": decision})

    @server.tool(name="gren_resume", description="Resume a checkpointed run (paused/failed/interrupted) inside this process.")
    def gren_resume(run_id: str, bridge: str | None = None) -> str:
        return _j({"run_id": control.resume(run_id, bridge)})

    @server.tool(name="gren_cancel", description="Cancel an in-process run.")
    def gren_cancel(run_id: str) -> str:
        return _j({"cancelled": control.cancel(run_id)})

    @server.tool(name="gren_fork", description="Fork a finished/paused run and re-execute from the given nodes (they and everything downstream re-run; upstream outputs are reused). Optionally supply an edited spec (YAML) - the developer loop for iterating on late nodes without paying for the whole graph again.")
    def gren_fork(run_id: str, from_nodes: list[str], spec_yaml: str | None = None, input: dict[str, Any] | None = None, bridge: str | None = None, new_run_id: str | None = None) -> str:
        rid = control.fork(run_id, from_nodes, spec_yaml=spec_yaml, input_=input, bridge=bridge or os.environ.get("GREN_BRIDGE") or "inbox", new_run_id=new_run_id)
        time.sleep(0.3)
        return _j({**status_summary(store, store.load(rid)), "forked_from": run_id})

    @server.tool(name="gren_list_runs", description="List runs (newest first).")
    def gren_list_runs(include_nested: bool = False) -> str:
        return _j([r for r in store.list() if include_nested or not r.get("parent")])

    @server.tool(name="gren_output", description="Final output of a completed run.")
    def gren_output(run_id: str) -> str:
        st = store.load(run_id)
        return _j({"status": st.run["status"], "output": st.run.get("output"), "warnings": st.run.get("warnings"), "error": st.run.get("error")})

    @server.tool(name="gren_metrics", description="Graph-shaped metrics: critical path, parallel speedup, width, failure/retry rate, verifier kill rate, fan-out efficiency, compression, human intervention, cost by model, hints.")
    def gren_metrics(run_id: str, format: str = "text") -> str:
        m = compute_metrics_deep(store, run_id)
        return _j(m) if format == "json" else format_metrics(m)

    @server.tool(name="gren_events", description="Event log of a run (after a sequence number).")
    def gren_events(run_id: str, after: int = 0, limit: int = 200) -> str:
        return _j(store.read_events(run_id, after)[-limit:])

    @server.tool(name="gren_node", description="Full record of one node in a run, including its prompts and raw outputs (artifacts) - for debugging a node.")
    def gren_node(run_id: str, node_id: str, include_artifacts: bool = True) -> str:
        st = store.load(run_id)
        rec = st.nodes.get(node_id)
        if rec is None:
            return f"node {node_id} not found"
        spec = GraphSpec.model_validate(st.run["spec"]).node(node_id)
        artifacts = [{"attempt": a["attempt"], "item": a.get("item"), "artifact": store.read_artifact(run_id, a["artifact"])} for a in rec["attempts"] if a.get("artifact")] if include_artifacts else None
        return _j({"node": rec, "spec": spec.model_dump(exclude_none=True, by_alias=True) if spec else None, "decisions": [d for d in st.run["decisions"] if d["node"] == node_id], "artifacts": artifacts})

    @server.tool(name="gren_decisions", description="Every routing / gate / verify / loop / failure decision of a run with the state that produced it (why did the system choose this route?).")
    def gren_decisions(run_id: str) -> str:
        return _j(store.load(run_id).run["decisions"])

    @server.tool(name="gren_spec", description="The frozen spec snapshot of a run as YAML.")
    def gren_spec(run_id: str) -> str:
        return yaml.safe_dump(store.load(run_id).run["spec"], sort_keys=False, allow_unicode=True)

    server.gren_control = control  # type: ignore[attr-defined]
    return server


def start_mcp_server(store: RunStore, graphs_dir: str) -> None:
    server = build_server(store, graphs_dir)
    sys.stderr.write(f"[gren-mcp] gren MCP server ready (runs: {store.root}, graphs: {os.path.abspath(graphs_dir)})\n")
    sys.stderr.flush()
    server.run(transport="stdio")
