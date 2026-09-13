"""Graph-shaped metrics. "Observe the graph, not the chat."

critical-path latency (actual), sum of work vs wall (parallel speedup), peak width vs budget, node failure rate,
retry rate, verifier kill rate, fan-out efficiency, compression ratio, human intervention, cost by model, hints.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from ..engine.state import RunState, RunStore
from ..spec.analyze import analyze
from ..spec.schema import GraphSpec


def _ms(a: str | None, b: str | None) -> float:
    if not a or not b:
        return 0.0
    try:
        return (datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds() * 1000
    except ValueError:
        return 0.0


def compute_metrics_deep(store: RunStore, run_id: str) -> dict[str, Any]:
    state = store.load(run_id)
    nested = []
    for cid in store.nested_run_ids(run_id):
        try:
            nested.append(store.load(cid))
        except Exception:
            pass
    return compute_metrics(state, store.read_events_deep(run_id), nested)


def compute_metrics(state: RunState, events: list[dict[str, Any]] | None = None, nested: list[RunState] | None = None) -> dict[str, Any]:
    events = events or []
    nested = nested or []
    run = state.run
    spec = GraphSpec.model_validate(run["spec"])
    a = analyze(spec)
    nodes = list(state.nodes.values())

    human_wait = 0.0
    paused_at: float | None = None
    for e in events:
        if e.get("run_id") != run["id"]:
            continue
        if e["type"] == "run.paused":
            paused_at = _ts(e["ts"])
        elif e["type"] == "run.resumed" and paused_at is not None:
            human_wait += (_ts(e["ts"]) - paused_at) * 1000
            paused_at = None

    dur = {n["id"]: float(n.get("duration_ms") or _ms(n.get("started_at"), n.get("ended_at"))) for n in nodes}
    work = {}
    for n in nodes:
        items = n.get("items") or []
        w = sum(float(i.get("duration_ms") or 0) for i in items) if items else 0.0
        work[n["id"]] = w or dur[n["id"]]

    # actual critical path along dependency edges
    longest: dict[str, tuple[float, str | None]] = {}
    for nid in a.order:
        best, via = 0.0, None
        for d in a.nodes[nid].deps if nid in a.nodes else []:
            l = longest.get(d, (0.0, None))[0]
            if l > best:
                best, via = l, d
        longest[nid] = (best + dur.get(nid, 0.0), via)
    end = max(longest.items(), key=lambda kv: kv[1][0])[0] if longest else None
    cp: list[str] = []
    cur = end
    while cur:
        cp.insert(0, cur)
        cur = longest[cur][1]
    cp_ms = longest[end][0] if end else 0.0
    sum_work = sum(work.values())

    # width from call events (deep)
    starts = sorted((_ts(e["ts"]), 1) for e in events if e["type"] == "call.started")
    ends = sorted((_ts(e["ts"]), -1) for e in events if e["type"] == "call.finished")
    peak = cur_w = 0
    for _, d in sorted(starts + ends, key=lambda x: (x[0], x[1])):
        cur_w += d
        peak = max(peak, cur_w)
    agent_seconds = sum(float((e.get("data") or {}).get("duration_ms") or 0) for e in events if e["type"] == "call.finished") / 1000

    attempts = failed_attempts = retries = agent_calls = 0
    candidates = killed = 0
    workers = failed_workers = 0
    verifiers, node_metrics, compression = [], [], []
    cost_by_model: dict[str, float] = {}

    def fold(n: dict[str, Any], prefix: str = "") -> None:
        nonlocal attempts, failed_attempts, retries, agent_calls, candidates, killed, workers, failed_workers
        ats = n.get("attempts") or []
        fa = sum(1 for t in ats if t.get("status") not in ("ok", "cancelled"))
        attempts += len(ats)
        failed_attempts += fa
        retries += int(n.get("retries") or 0)
        agent_calls += int(n.get("agent_calls") or 0)
        for t in ats:
            if t.get("model"):
                cost_by_model[t["model"]] = cost_by_model.get(t["model"], 0.0) + float(t.get("cost_usd") or 0)
        v = n.get("verify")
        if v:
            candidates += int(v.get("total") or 0)
            killed += len(v.get("killed") or [])
            verifiers.append({"id": prefix + n["id"], "candidates": v.get("total"), "killed": len(v.get("killed") or []), "kill_rate": v.get("kill_rate"), "repair_rounds": v.get("repair_round")})
        if n.get("items") and n["kind"] != "verify":
            workers += len(n["items"])
            failed_workers += sum(1 for i in n["items"] if i.get("status") == "failed")

    for n in nodes:
        fold(n)
        m: dict[str, Any] = {
            "id": n["id"], "kind": n["kind"], "status": n["status"], "duration_ms": dur[n["id"]], "cost_usd": round(float(n.get("cost_usd") or 0), 5),
            "attempts": len(n.get("attempts") or []), "failed_attempts": sum(1 for t in (n.get("attempts") or []) if t.get("status") not in ("ok", "cancelled")),
            "retries": n.get("retries", 0), "repairs": n.get("repairs", 0), "on_critical_path": n["id"] in cp,
        }
        if n.get("items"):
            m["items"] = {"total": len(n["items"]), "completed": sum(1 for i in n["items"] if i.get("status") == "completed")}
        if n.get("verify"):
            m["kill_rate"] = n["verify"].get("kill_rate")
        st = (n.get("output") or {}).get("_stats") if isinstance(n.get("output"), dict) else None
        if n["kind"] == "code" and isinstance(st, dict) and isinstance(st.get("in"), (int, float)) and isinstance(st.get("out"), (int, float)):
            m["compression"] = {"in": st["in"], "out": st["out"]}
            compression.append({"id": n["id"], "in": st["in"], "out": st["out"]})
        node_metrics.append(m)
    for child in nested:
        for n in child.nodes.values():
            fold(n, f"{(child.run.get('parent') or {}).get('node_id', 'nested')}/")

    records_in = records_out = 0
    if compression:
        order_idx = {nid: i for i, nid in enumerate(a.order)}
        srt = sorted(compression, key=lambda c: order_idx.get(c["id"], 0))
        records_in = max(c["in"] for c in srt)
        records_out = srt[-1]["out"]

    gates = [n for n in nodes if n["kind"] == "gate"]
    approved = sum(1 for n in gates if (n.get("gate") or {}).get("decision") == "approved")
    rejected = sum(1 for n in gates if (n.get("gate") or {}).get("decision") == "rejected")
    auto = sum(1 for n in gates if (n.get("gate") or {}).get("decision") == "auto")
    manual_tasks = sum(1 for e in events if e["type"] == "task.completed" and (e.get("data") or {}).get("source") == "human")
    orchestrator_tasks = sum(1 for e in events if e["type"] == "task.completed" and (e.get("data") or {}).get("source") != "human")
    human_gates = sum(1 for n in gates if (n.get("gate") or {}).get("decision") in ("approved", "rejected") and not str((n.get("gate") or {}).get("by", "")).startswith("auto"))
    cost_unknown = sum(1 for n in nodes for t in (n.get("attempts") or []) if t.get("status") == "ok" and not t.get("cost_usd") and t.get("bridge") not in ("code", "subgraph"))
    wall = float(run["totals"].get("wall_ms") or _ms(run.get("started_at"), run.get("ended_at") or run.get("updated_at")))
    active = max(0.0, wall - human_wait)
    kill_rate = killed / candidates if candidates else 0.0
    tokens = run["totals"].get("usage") or {}

    hints: list[str] = []
    if human_wait > 0:
        hints.append(f"{human_wait / 60000:.1f} min of the wall clock was spent waiting for a human at a gate (active time {active / 1000:.0f}s).")
    if candidates and kill_rate == 0:
        hints.append("Verifier rejected 0% of candidates: it may be decoration (weak prompt or threshold too high).")
    if candidates and kill_rate >= 0.8:
        hints.append(f"Verifier killed {kill_rate * 100:.0f}%: workers may be poorly scoped or the verifier too strict.")
    if agent_calls and retries / agent_calls > 0.3:
        hints.append(f"Retry rate {retries / agent_calls * 100:.0f}%: a graph that succeeds only after retries is not healthy.")
    if records_in and records_out / records_in > 0.9:
        hints.append("Reducers removed <10% of records: synthesis is reading almost raw fan-out output. Consider stronger dedupe/ranking.")
    budget_width = (run.get("budget") or {}).get("max_width")
    if budget_width and peak >= budget_width:
        hints.append(f"Peak width hit the budget ({peak}/{budget_width}). Raising it only helps if workers add unique coverage.")
    if sum_work and cp_ms and sum_work / cp_ms < 1.2 and workers:
        hints.append("Parallel speedup is ~1x although there is a fan-out: the graph ran as a chain. Re-check which edges carry real data.")
    if manual_tasks + rejected:
        hints.append(f"Humans rescued the system {manual_tasks + rejected} time(s) (manual tasks + rejections): each manual rescue is an architecture target.")
    if orchestrator_tasks:
        hints.append(f"{orchestrator_tasks} task(s) were executed by an orchestrator/subagent worker (inbox provider).")
    if cost_unknown:
        hints.append(f"{cost_unknown} successful call(s) reported no cost (workers did not pass cost_usd/usage); the cost total is a lower bound.")

    return {
        "run_id": run["id"], "graph": run["graph"], "status": run["status"], "wall_ms": wall, "human_wait_ms": human_wait, "active_ms": active,
        "nested_runs": len(nested), "cost_usd": round(float(run["totals"]["cost_usd"]), 5), "agent_calls": agent_calls,
        "tokens": {"input": tokens.get("inputTokens", 0), "output": tokens.get("outputTokens", 0), "cache_read": tokens.get("cacheReadInputTokens", 0)},
        "critical_path": {"nodes": cp, "ms": cp_ms}, "sum_of_node_ms": sum_work,
        "parallel_speedup": round(sum_work / cp_ms, 2) if cp_ms else 1.0,
        "width": {"peak": peak, "budget": budget_width, "agent_seconds": round(agent_seconds, 1)},
        "node_failure_rate": round(failed_attempts / attempts, 3) if attempts else 0.0,
        "retry_rate": round(retries / agent_calls, 3) if agent_calls else 0.0,
        "verifier": {"candidates": candidates, "killed": killed, "kill_rate": round(kill_rate, 3), "per_verifier": verifiers},
        "fan_out": {"workers": workers, "failed_workers": failed_workers, "unique_per_worker": _unique_per_worker(nodes)},
        "compression": {"records_in": records_in, "records_out": records_out, "ratio": round(records_out / records_in, 3) if records_in else 1.0, "per_reducer": compression},
        "human": {"gates": len(gates), "approved": approved, "rejected": rejected, "auto": auto, "manual_tasks": manual_tasks, "orchestrator_tasks": orchestrator_tasks,
                  "cost_unknown_calls": cost_unknown, "intervention_rate": round((human_gates + manual_tasks) / len(nodes), 3) if nodes else 0.0},
        "cost_by_model": {k: round(v, 5) for k, v in cost_by_model.items()},
        "nodes": node_metrics, "hints": hints,
    }


def _unique_per_worker(nodes: list[dict[str, Any]]) -> float | None:
    for n in nodes:
        out = n.get("output")
        if isinstance(out, dict) and out.get("unique_per_worker") is not None:
            return out["unique_per_worker"]
    return None


def _ts(s: str) -> float:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def format_metrics(m: dict[str, Any]) -> str:
    L = [f"Run {m['run_id']} ({m['graph']}) - {m['status']}"]
    hw = f" ({m['human_wait_ms'] / 1000:.0f}s waiting on humans, {m['active_ms'] / 1000:.0f}s active)" if m["human_wait_ms"] else ""
    L.append(f"Wall {m['wall_ms'] / 1000:.1f}s{hw} | cost ${m['cost_usd']} | agent calls {m['agent_calls']}{' | nested runs ' + str(m['nested_runs']) if m['nested_runs'] else ''} | tokens in {m['tokens']['input']} out {m['tokens']['output']}")
    L.append(f"Critical path {m['critical_path']['ms'] / 1000:.1f}s: {' -> '.join(m['critical_path']['nodes'])}")
    L.append(f"Sum of node time {m['sum_of_node_ms'] / 1000:.1f}s => parallel speedup {m['parallel_speedup']}x | peak width {m['width']['peak']}{'/' + str(m['width']['budget']) if m['width']['budget'] else ''}")
    L.append(f"Node failure rate {m['node_failure_rate'] * 100:.0f}% | retry rate {m['retry_rate'] * 100:.0f}%")
    v = m["verifier"]
    L.append(f"Verifier: {v['killed']}/{v['candidates']} killed ({v['kill_rate'] * 100:.0f}%)")
    f = m["fan_out"]
    L.append(f"Fan-out: {f['workers']} workers, {f['failed_workers']} failed{', ' + str(f['unique_per_worker']) + ' unique/worker' if f['unique_per_worker'] is not None else ''}")
    c = m["compression"]
    L.append(f"Compression: {c['records_in']} -> {c['records_out']} ({c['ratio'] * 100:.0f}% kept)")
    h = m["human"]
    L.append(f"Human: {h['gates']} gates ({h['approved']} approved, {h['rejected']} rejected, {h['auto']} auto), {h['manual_tasks']} manual tasks{', ' + str(h['orchestrator_tasks']) + ' orchestrator tasks' if h['orchestrator_tasks'] else ''}")
    L.append("Cost by model: " + ", ".join(f"{k}=${v_}" for k, v_ in m["cost_by_model"].items()))
    L.append("")
    L.append("Nodes:")
    for n in m["nodes"]:
        extra = []
        if n.get("items"):
            extra.append(f"items {n['items']['completed']}/{n['items']['total']}")
        if n.get("kill_rate") is not None:
            extra.append(f"kill {n['kill_rate'] * 100:.0f}%")
        if n.get("compression"):
            extra.append(f"{n['compression']['in']}->{n['compression']['out']}")
        L.append(f"  {'*' if n['on_critical_path'] else ' '} {n['id']:<22} {n['kind']:<8} {n['status']:<12} {n['duration_ms'] / 1000:>6.1f}s  ${n['cost_usd']:.4f}  att {n['attempts']} {' '.join(extra)}")
    if m["hints"]:
        L.append("")
        L.append("Hints:")
        L.extend(f"  - {h_}" for h_ in m["hints"])
    return "\n".join(L)
