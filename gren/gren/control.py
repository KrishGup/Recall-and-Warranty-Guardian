"""In-process run control shared by the dashboard server, the MCP server and the CLI.

Runs execute on background threads (each with its own asyncio loop). Approvals written by any process land as files,
so a run executing here can be approved from the CLI, and a run paused elsewhere can be resumed here.
"""
from __future__ import annotations

import os
import threading
from typing import Any, Callable

import yaml

from .engine.runtime import GraphRun, RunOptions
from .engine.state import RunStore, now_iso
from .models.registry import ModelRegistry, default_bridge
from .spec.analyze import analyze
from .spec.load import LoadedGraph, load_graph, load_graph_from_object, parse_spec_text


class RunControl:
    def __init__(self, store: RunStore, graphs_dir: str, registry: ModelRegistry | None = None,
                 emit: Callable[[dict[str, Any]], None] | None = None, log: Callable[[str], None] | None = None):
        self.store = store
        self.graphs_dir = os.path.abspath(graphs_dir)
        self.registry = registry or ModelRegistry(runs_root=store.root)
        self.emit = emit or (lambda e: None)
        self.log = log or (lambda m: None)
        self.runs: dict[str, GraphRun] = {}
        self._lock = threading.Lock()

    # ---- helpers ----
    def load(self, spec_path: str | None = None, spec_yaml: str | None = None) -> LoadedGraph:
        if spec_yaml:
            return load_graph_from_object(yaml.safe_load(spec_yaml), self.graphs_dir)
        if spec_path:
            p = spec_path if os.path.isabs(spec_path) else os.path.join(self.graphs_dir, spec_path)
            if not os.path.exists(p) and os.path.exists(spec_path):
                p = os.path.abspath(spec_path)
            return load_graph(p)
        raise ValueError("graph (path) or spec_yaml is required")

    def _options(self, bridge: str | None, auto_approve: bool, cwd: str | None) -> RunOptions:
        return RunOptions(bridge=bridge or None, default_bridge=default_bridge().name, on_event=self.emit, log=self.log, gate_wait="block", cwd=cwd, auto_approve=auto_approve)

    def _track(self, run: GraphRun) -> str:
        with self._lock:
            self.runs[run.id] = run

        def exec_() -> None:
            try:
                run.run()
            except Exception as e:  # noqa: BLE001
                self.log(f"run {run.id} crashed: {e}")
            finally:
                with self._lock:
                    self.runs.pop(run.id, None)

        threading.Thread(target=exec_, name=f"gren-run-{run.id}", daemon=True).start()
        return run.id

    def is_running(self, run_id: str) -> bool:
        return run_id in self.runs

    # ---- operations ----
    def start(self, spec_path: str | None = None, spec_yaml: str | None = None, input_: Any = None, bridge: str | None = None,
              run_id: str | None = None, auto_approve: bool = False, labels: dict[str, str] | None = None) -> str:
        g = self.load(spec_path, spec_yaml)
        run = GraphRun.create(self.store, g.spec, g.file, input_ or {}, self.registry, self._options(bridge, auto_approve, g.dir), run_id=run_id, labels=labels)
        return self._track(run)

    def resume(self, run_id: str, bridge: str | None = None, auto_approve: bool = False) -> str:
        if run_id in self.runs:
            return run_id
        run = GraphRun.resume(self.store, run_id, self.registry, self._options(bridge, auto_approve, None))
        return self._track(run)

    def fork(self, run_id: str, from_nodes: list[str], spec_yaml: str | None = None, input_: Any = None, bridge: str | None = None,
             new_run_id: str | None = None, auto_approve: bool = False) -> str:
        spec = parse_spec_text(spec_yaml) if spec_yaml else None
        run = GraphRun.fork(self.store, run_id, from_nodes, self.registry, self._options(bridge, auto_approve, None), new_run_id=new_run_id, spec=spec, input_=input_)
        return self._track(run)

    def approve(self, run_id: str, gate: str, decision: str, by: str = "human", comment: str | None = None) -> dict[str, Any]:
        run = self.runs.get(run_id)
        if run is not None:
            return run.approve(gate, decision, by, comment)
        approval = {"gate": gate, "decision": decision, "by": by, "comment": comment, "at": now_iso()}
        self.store.write_approval(run_id, approval)
        return approval

    def cancel(self, run_id: str) -> bool:
        run = self.runs.get(run_id)
        if run is None:
            return False
        run.cancel("cancelled by operator")
        return True


def list_graphs(graphs_dir: str) -> list[dict[str, Any]]:
    if not os.path.isdir(graphs_dir):
        return []
    out: list[dict[str, Any]] = []
    for f in sorted(os.listdir(graphs_dir)):
        if not f.endswith((".yaml", ".yml", ".json")):
            continue
        file = os.path.join(graphs_dir, f)
        try:
            spec = load_graph(file).spec
            a = analyze(spec)
            out.append({
                "path": f, "file": file, "name": spec.name, "description": spec.description, "goal": spec.goal, "nodes": len(spec.nodes), "ok": a.ok,
                "errors": sum(1 for x in a.findings if x.level == "error"), "warnings": sum(1 for x in a.findings if x.level == "warning"),
                "input_schema": spec.input_schema, "budget": spec.budget.model_dump(exclude_none=True) if spec.budget else None,
                "defaults": spec.defaults.model_dump(exclude_none=True) if spec.defaults else None,
            })
        except Exception as e:  # noqa: BLE001
            out.append({"path": f, "file": file, "name": f, "error": str(e), "ok": False, "nodes": 0, "errors": 1, "warnings": 0})
    return out
