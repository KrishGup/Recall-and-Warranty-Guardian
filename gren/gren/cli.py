"""gren CLI - validate, analyze, run, resume, fork, approve, monitor, and serve graphs."""
from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import sys
import threading
import time
from typing import Any, Optional

import typer
import yaml

from . import __version__
from .engine.runtime import GraphRun, RunOptions
from .engine.state import RunStore, now_iso
from .engine.validate import validate_against
from .metrics.metrics import compute_metrics_deep, format_metrics
from .models.registry import BRIDGE_NAMES, ModelRegistry, default_bridge
from .reducers.builtin import BUILTIN_REDUCERS
from .shapes import SHAPES, scaffold
from .spec.analyze import analyze, format_analysis
from .spec.load import SpecError, load_graph
from .spec.schema import FROZEN_CONSTRAINTS, GraphSpec

app = typer.Typer(help="gren - Graph Engineering Runtime for Claude multi-agent systems, on Strands Agents.", no_args_is_help=True, add_completion=False, context_settings={"help_option_names": ["-h", "--help"]}, rich_markup_mode=None)

_T0 = time.time()


def _runs_dir(runs: str | None) -> str:
    return os.path.abspath(runs or os.environ.get("GREN_RUNS") or "runs")


def _fail(msg: str, code: int = 1) -> None:
    typer.echo(msg, err=True)
    raise typer.Exit(code)


def _parse_input(raw: str | None) -> Any:
    if not raw:
        return {}
    if raw.startswith("@"):
        with open(raw[1:], encoding="utf-8") as f:
            return yaml.safe_load(f)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return yaml.safe_load(raw)


def _pkg_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    for up in (os.path.dirname(here), os.path.join(here, "_data")):
        if os.path.isdir(os.path.join(up, "skills")) and os.path.isdir(os.path.join(up, "graphs")):
            return up
    return os.path.dirname(here)


def fmt_event(e: dict[str, Any]) -> str:
    t = f"{(time.time() - _T0):6.1f}s"
    node = f" {e['node']}{'#' + str(e['item']) if e.get('item') is not None else ''}" if e.get("node") else ""
    d = e.get("data") or {}
    typ = e["type"]
    if typ == "run.started":
        detail = f"{d.get('graph')} via {d.get('bridge')}, {d.get('nodes')} nodes, est. critical path {float(d.get('critical_path_est_ms') or 0) / 1000:.0f}s"
    elif typ == "node.completed":
        it = d.get("items")
        detail = f"{float(d.get('duration_ms') or 0) / 1000:.1f}s ${float(d.get('cost_usd') or 0):.4f}{f' items {it['completed']}/{it['total']}' if it else ''}"
    elif typ in ("node.failed", "run.failed"):
        detail = str(d.get("error") or "")
    elif typ == "node.skipped":
        detail = str(d.get("reason") or "")
    elif typ == "node.retry":
        detail = f"attempt {d.get('attempt')}{' (fallback)' if d.get('fallback') else ''}: {d.get('error')}"
    elif typ == "call.started":
        detail = f"{d.get('model')} via {d.get('bridge')} (attempt {d.get('attempt')})"
    elif typ == "call.finished":
        detail = f"{float(d.get('duration_ms') or 0) / 1000:.1f}s ${float(d.get('cost_usd') or 0):.4f}{f' repairs {d['repairs']}' if d.get('repairs') else ''}" if d.get("ok") else f"FAILED {d.get('error')}"
    elif typ == "call.invalid_output":
        detail = "schema errors: " + "; ".join((d.get("errors") or [])[:3])
    elif typ == "fanout.started":
        detail = f"{d.get('pending')}/{d.get('total')} items, width {d.get('width') or '-'}"
    elif typ == "fanout.finished":
        detail = f"{d.get('completed')}/{d.get('total')} completed, {d.get('failed')} failed (quorum {d.get('quorum')})"
    elif typ == "verify.kill":
        detail = f"KILL ({float(d.get('confidence') or 0):.2f}): {(d.get('reasons') or [''])[0]}"
    elif typ == "verify.finished":
        detail = f"{d.get('killed')}/{d.get('total')} killed ({float(d.get('kill_rate') or 0) * 100:.0f}%)"
    elif typ == "repair.scheduled":
        detail = f"round {d.get('round')} -> {d.get('producer')}; reset {','.join(d.get('reset') or [])}"
    elif typ == "route.selected":
        detail = f"-> {d.get('route')} ({d.get('reason')})"
    elif typ == "gate.waiting":
        detail = f"WAITING: {d.get('title')}"
    elif typ in ("gate.approved", "gate.auto_approved", "gate.rejected"):
        detail = f"{d.get('by') or ''}{': ' + str(d['comment']) if d.get('comment') else ''}"
    elif typ == "task.created":
        detail = f"inbox task {d.get('task_id')} ({d.get('model')}) - waiting for a worker"
    elif typ == "task.completed":
        detail = f"task {d.get('task_id')} by {d.get('worker') or d.get('source')}"
    elif typ == "loop.round.finished":
        detail = f"round {d.get('round')}: {d.get('items')} found, {d.get('fresh')} new, dry {d.get('dry_rounds')}"
    elif typ == "loop.finished":
        detail = f"{d.get('rounds')} rounds, {d.get('collected')} items, {'converged' if d.get('converged') else 'NOT converged'}: {d.get('stop_reason')}"
    elif typ == "run.completed":
        detail = f"${float(d.get('cost_usd') or 0):.4f} in {float(d.get('wall_ms') or 0) / 1000:.1f}s{' DEGRADED (failed: ' + ','.join(d.get('failed') or []) + ')' if d.get('degraded') else ''}"
    elif typ == "run.paused":
        detail = f"waiting on {', '.join(d.get('waiting') or [])}"
    else:
        detail = json.dumps(d, default=str)[:160] if d else ""
    return f"{t} {typ:<20}{node}  {detail}"


def print_status(state, store: RunStore) -> None:
    r = state.run
    typer.echo(f"Run {r['id']}  graph={r['graph']}  status={r['status']}  bridge={r['bridge']}  cost=${r['totals']['cost_usd']:.4f}  calls={r['totals']['agent_calls']}  wall={r['totals']['wall_ms'] / 1000:.1f}s")
    if r.get("error"):
        typer.echo(f"  error: {r['error']}")
    for w in r.get("warnings") or []:
        typer.echo(f"  warning: {w}")
    typer.echo("")
    typer.echo(f"  {'node':<22} {'kind':<9} {'status':<17} {'dur':>7}  {'cost':>8}  detail")
    for n in state.nodes.values():
        detail = ""
        items = n.get("items")
        if items:
            detail = f"items {sum(1 for i in items if i['status'] == 'completed')}/{len(items)}"
        v = n.get("verify")
        if v:
            detail += f" kill {float(v['kill_rate']) * 100:.0f}% ({len(v['killed'])}/{v['total']})"
        if n.get("route"):
            detail += f" route={n['route']}"
        if (n.get("gate") or {}).get("decision"):
            detail += f" {n['gate']['decision']} by {n['gate'].get('by')}"
        if n.get("loop"):
            detail += f" {n['loop']['rounds']} rounds, {n['loop']['collected']} items, {n['loop']['stop_reason']}"
        if n.get("error"):
            detail += f" ERR {str(n['error'])[:80]}"
        if n.get("skip_reason"):
            detail += f" {n['skip_reason']}"
        if n.get("retries"):
            detail += f" retries={n['retries']}"
        if n.get("repairs"):
            detail += f" repairs={n['repairs']}"
        typer.echo(f"  {n['id']:<22} {n['kind']:<9} {n['status']:<17} {float(n.get('duration_ms') or 0) / 1000:6.1f}s  ${float(n.get('cost_usd') or 0):7.4f}  {detail.strip()}")
    waiting = [n for n in state.nodes.values() if n["status"] == "waiting_approval"]
    if waiting:
        spec = GraphSpec.model_validate(r["spec"])
        typer.echo("")
        for g in waiting:
            gn = spec.node(g["id"])
            typer.echo(f"  GATE WAITING: {g['id']} - {getattr(gn, 'title', '')}")
            if getattr(gn, "approve_effect", None):
                typer.echo(f"    If you approve: {gn.approve_effect}")
            if getattr(gn, "reject_effect", None):
                typer.echo(f"    If you reject:  {gn.reject_effect}")
            typer.echo(f'    gren approve {r["id"]} {g["id"]} [--reject] [--comment "..."]')
    nested = store.nested_run_ids(r["id"])
    if nested:
        typer.echo("")
        typer.echo(f"  nested runs ({len(nested)}):")
        for nid in nested[-12:]:
            try:
                s = store.load(nid)
            except Exception:  # noqa: BLE001
                continue
            done = sum(1 for n in s.nodes.values() if n["status"] == "completed")
            running = [n["id"] for n in s.nodes.values() if n["status"] == "running"]
            typer.echo(f"    {' > '.join(nid.split('/nested/')[1:]):<34} {s.run['status']:<10} {done}/{len(s.nodes)} done  ${s.run['totals']['cost_usd']:.4f}{'  running: ' + ', '.join(running) if running else ''}")
        if len(nested) > 12:
            typer.echo(f"    ... {len(nested) - 12} more (gren list --all)")
    tasks = store.list_tasks_deep(r["id"])
    if tasks:
        typer.echo("")
        typer.echo(f"  {len(tasks)} pending inbox task(s):  gren tasks {r['id']} --json")
        for t in tasks:
            typer.echo(f"    {t['task_id']:<32} {t['node_id']}{'#' + str(t['item_index']) if t.get('item_index') is not None else ''}  {t.get('model')}  {t.get('status')}")


# ---------------------------------------------------------------- run / resume / fork


def _registry(mock_fail_rate: float, mock_invalid_rate: float, mock_kill_rate: float, mock_latency: int, seed: str | None, mock_fail_nodes: str | None, claude_path: str | None, runs: str) -> ModelRegistry:
    return ModelRegistry(mock_options={"fail_rate": mock_fail_rate, "invalid_rate": mock_invalid_rate, "kill_rate": mock_kill_rate, "latency_ms": mock_latency,
                                       **({"seed": seed} if seed else {}), "always_fail": [s for s in (mock_fail_nodes or "").split(",") if s]}, claude_path=claude_path, runs_root=runs)


def _execute(run: GraphRun, store: RunStore, quiet: bool, as_json: bool, auto_approve: bool, gate_wait: str, gate_q: "queue.Queue[dict[str, Any]]") -> None:
    interactive = sys.stdin.isatty() and not auto_approve and gate_wait == "block" and not as_json
    if not quiet:
        typer.echo(f"run {run.id} started (runs dir {store.root})")
    result: dict[str, Any] = {}

    def worker() -> None:
        try:
            result["state"] = run.run()
        except Exception as e:  # noqa: BLE001
            result["error"] = e

    th = threading.Thread(target=worker, daemon=True)
    th.start()

    def on_sigint(*_: Any) -> None:
        typer.echo(f"\ninterrupted - checkpointing; resume with: gren resume {run.id}", err=True)
        run.cancel("SIGINT")

    try:
        signal.signal(signal.SIGINT, on_sigint)
    except ValueError:
        pass
    while th.is_alive():
        try:
            e = gate_q.get(timeout=0.25)
        except queue.Empty:
            continue
        gate, d = e["node"], e.get("data") or {}
        if interactive:
            typer.echo("")
            typer.echo(f"=== HUMAN GATE: {gate} - {d.get('title') or gate} ===")
            if d.get("prompt"):
                typer.echo(d["prompt"])
            if d.get("approve_effect"):
                typer.echo(f"If you approve: {d['approve_effect']}")
            if d.get("reject_effect"):
                typer.echo(f"If you reject:  {d['reject_effect']}")
            if d.get("show") is not None:
                typer.echo(json.dumps(d["show"], indent=2, default=str)[:4000])
            answer = input(f'Approve "{gate}"? [y]es / [n]o / n <comment>: ').strip()
            if answer.lower() in ("y", "yes"):
                run.approve(gate, "approved", "cli", None)
            else:
                comment = answer[1:].strip() if answer.lower().startswith("n") else answer
                run.approve(gate, "rejected", "cli", comment or None)
        else:
            typer.echo(f'gate "{gate}" is waiting. Approve from another terminal: gren approve {run.id} {gate}', err=True)
    th.join()
    if "error" in result:
        raise result["error"]
    state = result["state"]
    if as_json:
        typer.echo(json.dumps({"run": {k: v for k, v in state.run.items() if k != "spec"}, "nodes": state.nodes, "metrics": compute_metrics_deep(store, state.run["id"])}, indent=2, default=str))
    else:
        typer.echo("")
        print_status(state, store)
        if state.run["status"] == "completed":
            typer.echo("")
            typer.echo(format_metrics(compute_metrics_deep(store, state.run["id"])))
            typer.echo("")
            typer.echo("Output:")
            typer.echo(json.dumps(state.run.get("output"), indent=2, default=str)[:6000])
    raise typer.Exit(0 if state.run["status"] == "completed" else 2 if state.run["status"] == "paused" else 1)


def _common_options(quiet: bool, as_json: bool, auto_approve: bool, wait: bool, bridge: str | None, cwd: str | None, gate_q: "queue.Queue[dict[str, Any]]") -> RunOptions:
    q = quiet or as_json

    def on_event(e: dict[str, Any]) -> None:
        if not q:
            typer.echo(fmt_event(e))
        if e["type"] == "gate.waiting" and e.get("node"):
            gate_q.put(e)

    return RunOptions(bridge=bridge, default_bridge=default_bridge().name, on_event=on_event, log=None if q else (lambda m: typer.echo(f"  | {m}", err=True)),
                      gate_wait="block" if wait else "return", cwd=cwd, auto_approve=auto_approve)


@app.command()
def run(spec: str = typer.Argument(..., help="graph spec (.yaml/.json)"), input: Optional[str] = typer.Option(None, "--input", help="JSON, YAML or @file"), bridge: Optional[str] = typer.Option(None, help=f"provider: {'|'.join(BRIDGE_NAMES)}"),
        id: Optional[str] = typer.Option(None, "--id", help="run id"), wait: bool = typer.Option(True, "--wait/--no-wait", help="block on human gates (or return paused)"), auto_approve: bool = typer.Option(False, "--auto-approve"),
        quiet: bool = typer.Option(False, "--quiet"), as_json: bool = typer.Option(False, "--json"), label: Optional[str] = typer.Option(None), runs: Optional[str] = typer.Option(None, "--runs", help="runs dir (GREN_RUNS)"),
        mock_fail_rate: float = typer.Option(0.0, "--mock-fail-rate"), mock_invalid_rate: float = typer.Option(0.0, "--mock-invalid-rate"), mock_kill_rate: float = typer.Option(0.25, "--mock-kill-rate"),
        mock_latency: int = typer.Option(60, "--mock-latency"), seed: Optional[str] = typer.Option(None, "--seed"), mock_fail_nodes: Optional[str] = typer.Option(None, "--mock-fail-nodes"), claude_path: Optional[str] = typer.Option(None, "--claude-path")) -> None:
    """Run a graph."""
    store = RunStore(_runs_dir(runs))
    g = load_graph(spec)
    a = analyze(g.spec)
    if not a.ok:
        typer.echo(format_analysis(a), err=True)
        _fail(f"graph has {sum(1 for f in a.findings if f.level == 'error')} error(s); fix them before running")
    db = default_bridge(bridge)
    if db.warning:
        typer.echo(f"  | {db.warning}", err=True)
    if not (quiet or as_json) and not bridge:
        typer.echo(f"  | bridge: {g.spec.defaults.bridge if g.spec.defaults and g.spec.defaults.bridge else db.name} ({'from the spec' if g.spec.defaults and g.spec.defaults.bridge else 'from ' + db.source})", err=True)
    gate_q: "queue.Queue[dict[str, Any]]" = queue.Queue()
    opts = _common_options(quiet, as_json, auto_approve, wait, bridge, g.dir, gate_q)
    reg = _registry(mock_fail_rate, mock_invalid_rate, mock_kill_rate, mock_latency, seed, mock_fail_nodes, claude_path, store.root)
    r = GraphRun.create(store, g.spec, g.file, _parse_input(input), reg, opts, run_id=id, labels={"label": label} if label else None)
    _execute(r, store, quiet, as_json, auto_approve, opts.gate_wait, gate_q)


@app.command()
def resume(run_id: str, bridge: Optional[str] = typer.Option(None), wait: bool = typer.Option(True, "--wait/--no-wait"), auto_approve: bool = typer.Option(False, "--auto-approve"), quiet: bool = typer.Option(False, "--quiet"),
           as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs"), claude_path: Optional[str] = typer.Option(None, "--claude-path")) -> None:
    """Continue a run from its last checkpoint."""
    store = RunStore(_runs_dir(runs))
    gate_q: "queue.Queue[dict[str, Any]]" = queue.Queue()
    opts = _common_options(quiet, as_json, auto_approve, wait, bridge, os.getcwd(), gate_q)
    reg = _registry(0, 0, 0.25, 60, None, None, claude_path, store.root)
    r = GraphRun.resume(store, run_id, reg, opts)
    _execute(r, store, quiet, as_json, auto_approve, opts.gate_wait, gate_q)


@app.command()
def fork(run_id: str, from_: str = typer.Option(..., "--from", help="node id(s), comma separated"), spec: Optional[str] = typer.Option(None, help="replacement spec file"), input: Optional[str] = typer.Option(None, "--input"),
         id: Optional[str] = typer.Option(None, "--id"), bridge: Optional[str] = typer.Option(None), wait: bool = typer.Option(True, "--wait/--no-wait"), auto_approve: bool = typer.Option(False, "--auto-approve"),
         quiet: bool = typer.Option(False, "--quiet"), as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs"), claude_path: Optional[str] = typer.Option(None, "--claude-path")) -> None:
    """Re-run from the given nodes; upstream outputs are reused."""
    store = RunStore(_runs_dir(runs))
    from_nodes = [s.strip() for s in from_.split(",") if s.strip()]
    loaded = load_graph(spec) if spec else None
    gate_q: "queue.Queue[dict[str, Any]]" = queue.Queue()
    opts = _common_options(quiet, as_json, auto_approve, wait, bridge, loaded.dir if loaded else os.getcwd(), gate_q)
    reg = _registry(0, 0, 0.25, 60, None, None, claude_path, store.root)
    r = GraphRun.fork(store, run_id, from_nodes, reg, opts, new_run_id=id, spec=loaded.spec if loaded else None, spec_file=loaded.file if loaded else None, input_=_parse_input(input) if input is not None else None)
    _execute(r, store, quiet, as_json, auto_approve, opts.gate_wait, gate_q)


# ---------------------------------------------------------------- inspection


@app.command()
def validate(spec: str, as_json: bool = typer.Option(False, "--json")) -> None:
    """Schema + static analysis (exit 1 on errors)."""
    _analyze(spec, as_json, strict=True)


@app.command()
def analyze_(spec: str, as_json: bool = typer.Option(False, "--json")) -> None:
    """Dependency test, critical path, width, cost, checklist."""
    _analyze(spec, as_json, strict=False)


app.registered_commands[-1].name = "analyze"


def _analyze(spec: str, as_json: bool, strict: bool) -> None:
    try:
        g = load_graph(spec)
    except SpecError as e:
        _fail(f"{e.message}\n  - " + "\n  - ".join(e.issues))
        return
    a = analyze(g.spec)
    typer.echo(json.dumps(a.to_dict(), indent=2, default=str) if as_json else format_analysis(a))
    if not a.ok:
        raise typer.Exit(1)
    if strict and not as_json:
        typer.echo(f"\nOK: {g.spec.name} is valid ({sum(1 for f in a.findings if f.level == 'warning')} warning(s)).")


@app.command()
def status(run_id: str, as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Node table + waiting gates + pending tasks."""
    store = RunStore(_runs_dir(runs))
    state = store.load(run_id)
    if as_json:
        typer.echo(json.dumps({"run": {k: v for k, v in state.run.items() if k != "spec"}, "nodes": state.nodes, "tasks": store.list_tasks_deep(run_id)}, indent=2, default=str))
    else:
        print_status(state, store)


@app.command()
def output(run_id: str, runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Final output of a run."""
    typer.echo(json.dumps(RunStore(_runs_dir(runs)).load(run_id).run.get("output"), indent=2, default=str))


@app.command()
def events(run_id: str, follow: bool = typer.Option(False, "--follow"), as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Event log of a run."""
    store = RunStore(_runs_dir(runs))
    last = 0
    while True:
        for e in store.read_events(run_id, last):
            last = e["seq"]
            typer.echo(json.dumps(e, default=str) if as_json else f"{e['ts']} {fmt_event(e)}")
        if not follow or store.load(run_id).run["status"] in ("completed", "failed", "cancelled"):
            return
        time.sleep(0.7)


@app.command()
def metrics(run_id: str, as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Graph-shaped metrics of a run."""
    m = compute_metrics_deep(RunStore(_runs_dir(runs)), run_id)
    typer.echo(json.dumps(m, indent=2, default=str) if as_json else format_metrics(m))


@app.command(name="list")
def list_(all: bool = typer.Option(False, "--all", help="include nested runs"), as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """List runs."""
    rs = [r for r in RunStore(_runs_dir(runs)).list() if all or not r.get("parent")]
    if as_json:
        typer.echo(json.dumps(rs, indent=2, default=str))
        return
    for r in rs:
        n = r["nodes"]
        typer.echo(f"{r['id']:<44} {r['graph']:<22} {r['status']:<10} ${float(r['cost_usd']):8.4f}  {n['completed']}/{n['total']} done{f' {n['waiting']} waiting' if n.get('waiting') else ''}  {r['created_at']}")
    if not rs:
        typer.echo("no runs yet")


@app.command()
def delete(run_id: str, runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Delete a run directory."""
    RunStore(_runs_dir(runs)).delete(run_id)
    typer.echo(f"deleted {run_id}")


# ---------------------------------------------------------------- gates + inbox


@app.command()
def approve(run_id: str, gate: str, reject: bool = typer.Option(False, "--reject"), by: Optional[str] = typer.Option(None), comment: Optional[str] = typer.Option(None), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Record a human decision for a waiting gate."""
    store = RunStore(_runs_dir(runs))
    state = store.load(run_id)
    node = GraphSpec.model_validate(state.run["spec"]).node(gate)
    if node is None or node.kind != "gate":
        _fail(f'"{gate}" is not a gate node in run {run_id}')
    approval = {"gate": gate, "decision": "rejected" if reject else "approved", "by": by or os.environ.get("USER") or os.environ.get("USERNAME") or "human", "comment": comment, "at": now_iso()}
    store.write_approval(run_id, approval)
    typer.echo(f'{approval["decision"]} gate "{gate}" on {run_id} (by {approval["by"]}). ' + (f"If no engine process is attached, continue with: gren resume {run_id}" if state.run["status"] == "paused" else ""))


@app.command()
def tasks(run_id: Optional[str] = typer.Argument(None), as_json: bool = typer.Option(False, "--json"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Pending inbox tasks (orchestrator provider)."""
    store = RunStore(_runs_dir(runs))
    ts = store.list_tasks_deep(run_id) if run_id else store.list_all_pending_tasks()
    if as_json:
        typer.echo(json.dumps(ts, indent=2, default=str))
        return
    if not ts:
        typer.echo("no pending tasks")
        return
    for t in ts:
        typer.echo(f"{t['run_id']}  {t['task_id']}  node={t['node_id']}{'#' + str(t['item_index']) if t.get('item_index') is not None else ''}  model={t.get('model')}{' effort=' + str(t['effort']) if t.get('effort') else ''}  role={t.get('role')}  status={t.get('status')}  timeout={t.get('timeout_at')}")
    typer.echo(f"\n{len(ts)} task(s). Full prompts/schemas: gren tasks [run_id] --json")


@app.command()
def claim(run_id: str, task_id: str, by: Optional[str] = typer.Option(None), force: bool = typer.Option(False, "--force"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Claim an inbox task."""
    store = RunStore(_runs_dir(runs))
    t = store.read_task(run_id, task_id)
    if t is None:
        _fail(f"task {task_id} not found in {run_id}")
    if store.read_task_result(run_id, task_id):
        _fail(f"task {task_id} already has a result; nothing to claim", 3)
    if t.get("status") != "pending" and not force:
        _fail(f"task {task_id} is {t.get('status')}{' by ' + str(t.get('claimed_by')) if t.get('claimed_by') else ''}; pick another task (or --force)", 3)
    t["status"], t["claimed_by"], t["claimed_at"] = "claimed", by or "worker", now_iso()
    store.write_task(t)
    after = store.read_task(run_id, task_id) or {}
    if after.get("claimed_by") != t["claimed_by"]:
        _fail(f"task {task_id} was claimed by {after.get('claimed_by')} at the same time; pick another task", 3)
    typer.echo(f"claimed {task_id} by {t['claimed_by']}")


@app.command()
def complete(run_id: str, task_id: str, result: Optional[str] = typer.Option(None, "--result", help="JSON or @file"), cost: Optional[float] = typer.Option(None), model: Optional[str] = typer.Option(None),
             source: str = typer.Option("orchestrator"), error: Optional[str] = typer.Option(None), by: Optional[str] = typer.Option(None), force: bool = typer.Option(False, "--force"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Submit the result of an inbox task."""
    store = RunStore(_runs_dir(runs))
    t = store.read_task(run_id, task_id)
    if t is None:
        _fail(f"task {task_id} not found in {run_id}")
    prev = store.read_task_result(run_id, task_id)
    if prev and not force:
        _fail(f"task {task_id} already has a result (submitted by {prev.get('worker') or 'another worker'}); not overwriting (use --force)", 3)
    if t.get("status") == "cancelled":
        _fail(f"task {task_id} was cancelled by the engine (timed out or run ended); do not submit", 3)
    out = None
    if not error:
        if result is None:
            _fail("--result is required (JSON string or @file)")
        out = _parse_input(result)
        ok, errs = validate_against(t.get("output_schema"), out)
        if not ok and not force:
            _fail("result does not match the task's output_schema:\n  - " + "\n  - ".join(errs) + "\n(use --force to submit anyway; the engine will reject it and retry)")
    store.write_task_result(run_id, {"task_id": task_id, "output": out, "error": error, "cost_usd": cost, "model": model, "source": source, "worker": by, "completed_at": now_iso()})
    typer.echo(f"submitted result for {task_id}{' (as failure)' if error else ''}")


# ---------------------------------------------------------------- reference


@app.command()
def bridges() -> None:
    """Show which providers are available."""
    reg = ModelRegistry()
    for n in BRIDGE_NAMES:
        ok, reason = reg.available(n)
        typer.echo(f"{n:<12} {'available' if ok else 'unavailable'}  {reg.describe(n)}  ({reason})")
    db = default_bridge()
    typer.echo(f"\ndefault: {db.name} (from {db.source}; override with --bridge or GREN_BRIDGE)")


@app.command()
def reducers() -> None:
    """List built-in reducers."""
    for name in BUILTIN_REDUCERS:
        typer.echo(name)


@app.command()
def frozen() -> None:
    """List frozen constraints."""
    for k, v in FROZEN_CONSTRAINTS.items():
        typer.echo(f"{k:<42} {v}")


@app.command()
def shapes() -> None:
    """The five graph shapes."""
    for s in SHAPES:
        typer.echo(f"{s.id:<14} {s.title}\n{s.diagram}\n  use for: {s.use}\n")


@app.command()
def new(shape: str, name: str, out: Optional[str] = typer.Option(None, "--out")) -> None:
    """Scaffold a graph from a shape."""
    text = scaffold(shape, name)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        typer.echo(f"wrote {out}")
    else:
        typer.echo(text)


@app.command()
def version() -> None:
    """Print the version."""
    typer.echo(f"gren {__version__}")


# ---------------------------------------------------------------- servers


@app.command()
def ui(port: int = typer.Option(int(os.environ.get("GREN_PORT") or 4545), "--port"), host: str = typer.Option("127.0.0.1", "--host"), graphs: str = typer.Option("graphs", "--graphs"),
       runs: Optional[str] = typer.Option(None, "--runs"), token: Optional[str] = typer.Option(None, "--token"), claude_path: Optional[str] = typer.Option(None, "--claude-path")) -> None:
    """Dashboard + live monitoring + approvals."""
    from .server.app import serve

    store = RunStore(_runs_dir(runs))
    serve(store, graphs, host=host, port=port, token=token, registry=ModelRegistry(claude_path=claude_path, runs_root=store.root))


@app.command()
def mcp(graphs: str = typer.Option("graphs", "--graphs"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """MCP server (stdio) exposing the same operations as tools."""
    from .mcp.server import start_mcp_server

    start_mcp_server(RunStore(_runs_dir(runs)), graphs)


@app.command()
def init(target: str = typer.Argument("."), force: bool = typer.Option(False, "--force")) -> None:
    """Scaffold a project: .mcp.json, CLAUDE.md, skill, starter graphs."""
    target = os.path.abspath(target)
    root = _pkg_root()
    copied: list[str] = []

    def copy_dir(src: str, dst: str) -> None:
        if not os.path.isdir(src):
            return
        for dp, _, files in os.walk(src):
            if "__pycache__" in dp:
                continue
            for fn in files:
                if fn.endswith(".pyc"):
                    continue
                s = os.path.join(dp, fn)
                d = os.path.join(dst, os.path.relpath(s, src))
                if not os.path.exists(d) or force:
                    os.makedirs(os.path.dirname(d), exist_ok=True)
                    shutil.copyfile(s, d)
                    copied.append(os.path.relpath(d, target))

    copy_dir(os.path.join(root, "skills", "graph-engineering"), os.path.join(target, ".claude", "skills", "graph-engineering"))
    copy_dir(os.path.join(root, "graphs", "reducers"), os.path.join(target, "graphs", "reducers"))
    copy_dir(os.path.join(root, "graphs", "inputs"), os.path.join(target, "graphs", "inputs"))
    for g in sorted(os.listdir(os.path.join(root, "graphs"))):
        if g.endswith(".yaml"):
            s, d = os.path.join(root, "graphs", g), os.path.join(target, "graphs", g)
            if not os.path.exists(d) or force:
                os.makedirs(os.path.dirname(d), exist_ok=True)
                shutil.copyfile(s, d)
                copied.append(os.path.relpath(d, target))

    def write_if_missing(rel: str, content: str) -> None:
        p = os.path.join(target, rel)
        if os.path.exists(p) and not force:
            return
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        copied.append(rel)

    py = sys.executable.replace("\\", "/")
    write_if_missing(".mcp.json", json.dumps({"mcpServers": {"gren": {"command": py, "args": ["-m", "gren", "mcp"], "env": {"GREN_RUNS": "runs"}}}}, indent=2) + "\n")
    write_if_missing("CLAUDE.md", "# gren project notes\n\n- gren = Graph Engineering Runtime on Strands Agents. Design multi-agent workflows as graphs (graphs/*.yaml), run them, monitor them.\n"
                     f"- CLI: `gren <command>` (validate | analyze | run | resume | fork | status | metrics | approve | tasks | complete | ui | mcp). Python: `{py} -m gren <command>`.\n"
                     "- MCP: .mcp.json registers the `gren` server (tools gren_*). Skill: .claude/skills/graph-engineering - load it (/graph-engineering) before designing a graph.\n"
                     "- Providers: bedrock (AWS credentials) | anthropic (ANTHROPIC_API_KEY) | claude-code (Claude Code login) | inbox (this session executes nodes with subagents) | mock (no tokens).\n"
                     "- Runs are checkpointed under runs/ (gitignored). Dashboard: `gren ui` -> http://127.0.0.1:4545\n- Reference: gren_reference (MCP) or docs/SPEC.md in the gren repository. Start from graphs/starter-fork-join.yaml.\n")
    write_if_missing(".gitignore", "runs/\nout/\n.worktrees/\n__pycache__/\n*.log\n")
    typer.echo(f"gren init: {len(copied)} file(s) written under {target}")
    for c in copied[:12]:
        typer.echo(f"  + {c}")
    if len(copied) > 12:
        typer.echo(f"  ... {len(copied) - 12} more")
    typer.echo(f'\nNext: start a Claude Code session in {target} (approve the "gren" MCP server when asked) and load /graph-engineering, or run: gren validate graphs/starter-fork-join.yaml')


def main() -> None:
    try:
        app()
    except SpecError as e:
        _fail(f"{e.message}\n  - " + "\n  - ".join(e.issues))


if __name__ == "__main__":
    main()
