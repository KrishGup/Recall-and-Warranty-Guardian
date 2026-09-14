"""Durable run state. The graph must be able to answer, at any moment:
  What has already happened?  (events.jsonl, node records)
  Why did the system choose this route?  (decisions[] with the state that produced them)
  Where can execution safely resume?  (state.json checkpoint after every node + the Strands session)

Layout (unchanged from gren 1 so the dashboard reads both): runs/<run_id>/
  run.json  state.json  events.jsonl  artifacts/  inbox/  approvals/  nested/<node>/<child>/  session/ (Strands)
"""
from __future__ import annotations

import json
import os
import random
import shutil
import time
from dataclasses import dataclass
from typing import Any

from ..models.pricing import sum_usage
from ..spec.schema import GraphSpec

TERMINAL = ("completed", "failed", "skipped")


def now_iso() -> str:
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


def new_run_id(prefix: str = "run") -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return f"{prefix}-{stamp}-{random.randbytes(3).hex()}"


def atomic_write(path: str, data: Any) -> None:
    """Write-then-rename with EPERM retries (Windows: the dashboard may be reading the file)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{random.randbytes(2).hex()}.tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(data, f, indent=2, default=str)
    for attempt in range(6):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.015 * (attempt + 1))
    with open(path, "w", encoding="utf8") as f:
        json.dump(data, f, indent=2, default=str)
    try:
        os.remove(tmp)
    except OSError:
        pass


def read_json(path: str) -> Any:
    last: Exception | None = None
    for attempt in range(5):
        try:
            with open(path, encoding="utf8") as f:
                return json.load(f)
        except FileNotFoundError:
            raise
        except (json.JSONDecodeError, OSError) as e:
            last = e
            time.sleep(0.01 * (attempt + 1))
    raise last  # type: ignore[misc]


def new_node_record(node_id: str, kind: str) -> dict[str, Any]:
    return {"id": node_id, "kind": kind, "status": "pending", "attempts": [], "cost_usd": 0.0, "usage": {}, "agent_calls": 0, "retries": 0, "repairs": 0}


@dataclass
class RunState:
    run: dict[str, Any]
    nodes: dict[str, dict[str, Any]]


def add_usage(rec: dict[str, Any], usage: dict[str, Any] | None, cost: float | None, calls: int = 1) -> None:
    rec["usage"] = sum_usage(rec.get("usage"), usage)
    rec["cost_usd"] = float(rec.get("cost_usd", 0.0)) + float(cost or 0.0)
    rec["agent_calls"] = int(rec.get("agent_calls", 0)) + calls


class RunStore:
    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)
        self._seq: dict[str, int] = {}

    def run_dir(self, run_id: str) -> str:
        return os.path.join(self.root, *run_id.split("/"))

    def exists(self, run_id: str) -> bool:
        return os.path.exists(os.path.join(self.run_dir(run_id), "run.json"))

    def create(self, spec: GraphSpec, spec_file: str, input_: Any, bridge: str, budget: dict[str, Any], frozen: list[str], run_id: str | None = None,
               parent: dict[str, Any] | None = None, labels: dict[str, str] | None = None, context: dict[str, Any] | None = None) -> RunState:
        rid = run_id or new_run_id("".join(c if c.isalnum() else "-" for c in spec.name)[:24])
        d = self.run_dir(rid)
        for sub in ("artifacts", "inbox", "approvals"):
            os.makedirs(os.path.join(d, sub), exist_ok=True)
        ts = now_iso()
        run = {
            "id": rid, "graph": spec.name, "spec_file": spec_file, "spec": spec.model_dump(exclude_none=True, by_alias=True), "input": input_,
            "status": "created", "created_at": ts, "updated_at": ts, "bridge": bridge, "budget": budget, "frozen": frozen,
            "totals": {"cost_usd": 0.0, "usage": {}, "agent_calls": 0, "retries": 0, "wall_ms": 0}, "approvals": {}, "decisions": [],
            "parent": parent, "labels": labels, "context": context, "engine": "strands",
        }
        nodes = {n.id: new_node_record(n.id, n.kind) for n in spec.nodes}
        state = RunState(run=run, nodes=nodes)
        self.save(state)
        return state

    def load(self, run_id: str) -> RunState:
        d = self.run_dir(run_id)
        run_file = os.path.join(d, "run.json")
        if not os.path.exists(run_file):
            raise FileNotFoundError(f"run not found: {run_id}")
        run = read_json(run_file)
        state_file = os.path.join(d, "state.json")
        nodes = read_json(state_file).get("nodes", {}) if os.path.exists(state_file) else {}
        return RunState(run=run, nodes=nodes)

    def spec_of(self, state: RunState) -> GraphSpec:
        return GraphSpec.model_validate(state.run["spec"])

    def save(self, state: RunState) -> None:
        state.run["updated_at"] = now_iso()
        d = self.run_dir(state.run["id"])
        atomic_write(os.path.join(d, "run.json"), state.run)
        atomic_write(os.path.join(d, "state.json"), {"nodes": state.nodes})

    # ---- events ----
    def _last_seq(self, run_id: str) -> int:
        f = os.path.join(self.run_dir(run_id), "events.jsonl")
        if not os.path.exists(f):
            return 0
        last = 0
        with open(f, encoding="utf8") as fh:
            for line in fh:
                if line.strip():
                    try:
                        last = int(json.loads(line).get("seq", last))
                    except json.JSONDecodeError:
                        pass
        return last

    def append_event(self, run_id: str, type_: str, node: str | None = None, item: int | None = None, data: dict[str, Any] | None = None) -> dict[str, Any]:
        seq = self._seq.get(run_id, self._last_seq(run_id)) + 1
        self._seq[run_id] = seq
        evt = {"ts": now_iso(), "seq": seq, "run_id": run_id, "type": type_, "node": node, "item": item, "data": data or {}}
        d = self.run_dir(run_id)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "events.jsonl"), "a", encoding="utf8") as f:
            f.write(json.dumps(evt, default=str) + "\n")
        return evt

    def read_events(self, run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        f = os.path.join(self.run_dir(run_id), "events.jsonl")
        if not os.path.exists(f):
            return []
        out = []
        with open(f, encoding="utf8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("seq", 0) > after_seq:
                    out.append(e)
        return out

    def nested_run_ids(self, run_id: str, depth: int = 0) -> list[str]:
        out: list[str] = []
        if depth > 6:
            return out
        nested = os.path.join(self.run_dir(run_id), "nested")
        if not os.path.isdir(nested):
            return out
        for node in sorted(os.listdir(nested)):
            node_dir = os.path.join(nested, node)
            if not os.path.isdir(node_dir):
                continue
            for child in sorted(os.listdir(node_dir)):
                if os.path.exists(os.path.join(node_dir, child, "run.json")):
                    cid = f"{run_id}/nested/{node}/{child}"
                    out.append(cid)
                    out.extend(self.nested_run_ids(cid, depth + 1))
        return out

    def read_events_deep(self, run_id: str) -> list[dict[str, Any]]:
        evs = self.read_events(run_id)
        for cid in self.nested_run_ids(run_id):
            evs.extend(self.read_events(cid))
        return sorted(evs, key=lambda e: e.get("ts", ""))

    # ---- artifacts ----
    def write_artifact(self, run_id: str, name: str, data: Any) -> str:
        rel = f"artifacts/{name}.json"
        atomic_write(os.path.join(self.run_dir(run_id), "artifacts", f"{name}.json"), data)
        return rel

    def read_artifact(self, run_id: str, rel: str) -> Any:
        p = os.path.join(self.run_dir(run_id), *rel.split("/"))
        return read_json(p) if os.path.exists(p) else None

    # ---- approvals ----
    def write_approval(self, run_id: str, approval: dict[str, Any]) -> None:
        atomic_write(os.path.join(self.run_dir(run_id), "approvals", f"{approval['gate']}.json"), approval)

    def read_approval(self, run_id: str, gate: str) -> dict[str, Any] | None:
        p = os.path.join(self.run_dir(run_id), "approvals", f"{gate}.json")
        try:
            return read_json(p) if os.path.exists(p) else None
        except Exception:
            return None

    def clear_approval(self, run_id: str, gate: str) -> None:
        p = os.path.join(self.run_dir(run_id), "approvals", f"{gate}.json")
        if os.path.exists(p):
            os.remove(p)

    # ---- inbox ----
    def _inbox(self, run_id: str) -> str:
        return os.path.join(self.run_dir(run_id), "inbox")

    def write_task(self, task: dict[str, Any]) -> None:
        atomic_write(os.path.join(self._inbox(task["run_id"]), f"{task['task_id']}.json"), task)

    def read_task(self, run_id: str, task_id: str) -> dict[str, Any] | None:
        p = os.path.join(self._inbox(run_id), f"{task_id}.json")
        return read_json(p) if os.path.exists(p) else None

    def list_tasks(self, run_id: str) -> list[dict[str, Any]]:
        d = self._inbox(run_id)
        if not os.path.isdir(d):
            return []
        out = []
        for f in os.listdir(d):
            if not f.endswith(".json") or f.count(".") != 1:
                continue
            try:
                t = read_json(os.path.join(d, f))
            except Exception:
                continue
            if not isinstance(t, dict) or "task_id" not in t or "created_at" not in t:
                continue
            if t.get("status") != "completed" and os.path.exists(os.path.join(d, f"{t['task_id']}.result.json")):
                t = {**t, "status": "completed"}
            out.append(t)
        return sorted(out, key=lambda t: t["created_at"])

    def list_tasks_deep(self, run_id: str, only_pending: bool = True) -> list[dict[str, Any]]:
        out = []
        for rid in [run_id, *self.nested_run_ids(run_id)]:
            for t in self.list_tasks(rid):
                if not only_pending or t.get("status") in ("pending", "claimed"):
                    out.append(t)
        return out

    def list_all_pending_tasks(self) -> list[dict[str, Any]]:
        out = []
        for r in self.list():
            if r.get("parent") or r["status"] not in ("running", "paused", "created"):
                continue
            out.extend(self.list_tasks_deep(r["id"]))
        return out

    def write_task_result(self, run_id: str, result: dict[str, Any]) -> None:
        atomic_write(os.path.join(self._inbox(run_id), f"{result['task_id']}.result.json"), result)

    def read_task_result(self, run_id: str, task_id: str) -> dict[str, Any] | None:
        p = os.path.join(self._inbox(run_id), f"{task_id}.result.json")
        try:
            return read_json(p) if os.path.exists(p) else None
        except Exception:
            return None

    # ---- listing / lifecycle ----
    def list(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []

        def walk(d: str, prefix: str, depth: int) -> None:
            if not os.path.isdir(d) or depth > 4:
                return
            for entry in sorted(os.listdir(d)):
                full = os.path.join(d, entry)
                if not os.path.isdir(full):
                    continue
                rid = f"{prefix}/{entry}" if prefix else entry
                if os.path.exists(os.path.join(full, "run.json")):
                    try:
                        out.append(summarize(self.load(rid)))
                    except Exception:
                        pass
                    walk(os.path.join(full, "nested"), f"{rid}/nested", depth + 1)
                elif entry == "nested" or prefix.endswith("nested"):
                    walk(full, rid, depth + 1)

        walk(self.root, "", 0)
        return sorted(out, key=lambda r: r["created_at"], reverse=True)

    def delete(self, run_id: str) -> None:
        shutil.rmtree(self.run_dir(run_id), ignore_errors=True)

    def fork(self, src_id: str, new_id: str | None = None) -> RunState:
        src = self.load(src_id)
        rid = new_id or new_run_id("".join(c if c.isalnum() else "-" for c in src.run["graph"])[:20] + "-fork")
        frm, to = self.run_dir(src_id), self.run_dir(rid)
        if os.path.exists(to):
            raise FileExistsError(f"run {rid} already exists")
        os.makedirs(to, exist_ok=True)
        for sub in ("artifacts", "approvals", "nested"):
            if os.path.isdir(os.path.join(frm, sub)):
                shutil.copytree(os.path.join(frm, sub), os.path.join(to, sub))
        os.makedirs(os.path.join(to, "inbox"), exist_ok=True)
        run = {**src.run, "id": rid, "status": "created", "ended_at": None, "error": None, "output": None, "warnings": None, "forked_from": src_id, "created_at": now_iso()}
        state = RunState(run=run, nodes=src.nodes)
        self.save(state)
        self.append_event(rid, "run.forked", data={"from": src_id})
        return state


def summarize(state: RunState) -> dict[str, Any]:
    ns = list(state.nodes.values())
    r = state.run
    return {
        "id": r["id"], "graph": r["graph"], "status": r["status"], "created_at": r["created_at"], "updated_at": r["updated_at"],
        "cost_usd": r["totals"]["cost_usd"], "bridge": r["bridge"], "parent": r.get("parent"),
        "labels": r.get("labels") or None, "wall_ms": r["totals"].get("wall_ms"), "ended_at": r.get("ended_at"), "forked_from": r.get("forked_from"),
        "error": (r.get("error") or None) if r["status"] == "failed" else None,
        "nodes": {
            "total": len(ns),
            "completed": sum(1 for n in ns if n["status"] == "completed"),
            "failed": sum(1 for n in ns if n["status"] == "failed"),
            "skipped": sum(1 for n in ns if n["status"] == "skipped"),
            "waiting": sum(1 for n in ns if n["status"] in ("waiting_approval", "waiting_task")),
        },
    }
