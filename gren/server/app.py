"""gren dashboard server: REST + Server-Sent Events over the run store, plus in-process run control.

  GET  /                                  dashboard
  GET  /api/runs?all=1                    run summaries (nested runs when all=1)
  POST /api/runs          {graph|spec_yaml, input, bridge?, auto_approve?, run_id?}   start a run here
  GET  /api/run?id=                       run state + analysis + metrics + tasks + spec yaml
  GET  /api/run/events?id=&after=         events after seq
  GET  /api/run/artifact?id=&path=        an artifact (prompt / raw output)
  GET  /api/run/tasks?id=                 pending inbox tasks (deep)
  POST /api/run/approve   {id, gate, decision, by?, comment?}
  POST /api/run/task      {id, task_id, output?, error?, cost_usd?, model?, source?, worker?, force?}
  POST /api/run/resume    {id, bridge?}
  POST /api/run/fork      {id, from, spec_yaml?, input?, bridge?, new_id?}
  POST /api/run/cancel    {id}
  POST /api/run/delete    {id}
  GET  /api/graphs | /api/graph?path= | POST /api/graph/validate | /api/graph/save | /api/graph/scaffold
  GET  /api/bridges | /api/shapes | /api/reference | /api/events (SSE)
"""
from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
import time
from typing import Any

import yaml
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from ..control import RunControl, list_graphs
from ..engine.state import RunStore, now_iso
from ..engine.validate import validate_against
from ..metrics.metrics import compute_metrics_deep
from ..models.registry import BRIDGE_NAMES, ModelRegistry, default_bridge
from ..reducers.builtin import BUILTIN_REDUCERS
from ..shapes import scaffold, shapes_summary
from ..spec.analyze import analyze
from ..spec.load import SpecError, load_graph, load_graph_from_object
from ..spec.schema import FROZEN_CONSTRAINTS, GraphSpec

UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")


def _err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


class Broadcaster:
    def __init__(self) -> None:
        self.clients: set[queue.Queue] = set()
        self.lock = threading.Lock()

    def publish(self, e: dict[str, Any]) -> None:
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait(e)
                except queue.Full:
                    pass

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=5000)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)


def start_poller(store: RunStore, control: RunControl, broadcast: Broadcaster, log) -> threading.Thread:
    """Tail events of runs executed by OTHER processes (CLI / MCP) so the dashboard stays live."""
    last_seq: dict[str, int] = {}

    def loop() -> None:
        while True:
            try:
                for r in store.list():
                    rid = r["id"]
                    if control.is_running(rid):
                        continue
                    active = r["status"] in ("running", "paused", "created")
                    seen = last_seq.get(rid)
                    if not active and seen is None:
                        evs = store.read_events(rid, 0)
                        last_seq[rid] = evs[-1]["seq"] if evs else 0
                        last_seq[f"{rid}:final"] = 1
                        try:
                            from datetime import datetime

                            recent = (time.time() - datetime.fromisoformat(str(r["updated_at"]).replace("Z", "+00:00")).timestamp()) < 15
                        except (ValueError, KeyError):
                            recent = False
                        if recent:
                            broadcast.publish({"ts": now_iso(), "seq": 0, "run_id": rid, "type": "run.discovered", "data": {"status": r["status"], "graph": r["graph"]}})
                        continue
                    if not active and seen is not None and f"{rid}:final" not in last_seq:
                        for e in store.read_events(rid, seen):
                            last_seq[rid] = e["seq"]
                            broadcast.publish(e)
                        last_seq[f"{rid}:final"] = 1
                        continue
                    if not active:
                        continue
                    if seen is None:
                        evs = store.read_events(rid, 0)
                        last_seq[rid] = evs[-1]["seq"] if evs else 0
                        broadcast.publish({"ts": now_iso(), "seq": 0, "run_id": rid, "type": "run.discovered", "data": {"status": r["status"], "graph": r["graph"]}})
                        continue
                    for e in store.read_events(rid, seen):
                        last_seq[rid] = e["seq"]
                        broadcast.publish(e)
            except Exception as e:  # noqa: BLE001
                log(f"poll error: {e}")
            time.sleep(1.0)

    t = threading.Thread(target=loop, name="gren-poller", daemon=True)
    t.start()
    return t


def create_app(store: RunStore, graphs_dir: str, registry: ModelRegistry | None = None, token: str | None = None, quiet: bool = False) -> FastAPI:
    graphs_dir = os.path.abspath(graphs_dir)
    log = (lambda m: None) if quiet else (lambda m: print(f"[gren] {m}", flush=True))
    broadcast = Broadcaster()
    control = RunControl(store, graphs_dir, registry, emit=broadcast.publish, log=log)
    start_poller(store, control, broadcast, log)
    token = token if token is not None else os.environ.get("GREN_API_TOKEN")
    app = FastAPI(title="gren", docs_url=None, redoc_url=None)
    app.state.control = control
    app.state.store = store

    @app.middleware("http")
    async def auth_and_cors(request: Request, call_next):  # type: ignore[no-untyped-def]
        if request.method == "OPTIONS":
            return JSONResponse({}, status_code=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET,POST,OPTIONS"})
        if token and request.url.path.startswith("/api/"):
            auth = request.headers.get("authorization", "")
            provided = auth[7:] if auth.startswith("Bearer ") else request.query_params.get("token", "")
            if provided != token:
                return _err(401, "unauthorized: set Authorization: Bearer <GREN_API_TOKEN>")
        resp = await call_next(request)
        resp.headers["access-control-allow-origin"] = "*"
        resp.headers["cache-control"] = "no-store"
        return resp

    @app.exception_handler(Exception)
    async def on_error(request: Request, exc: Exception):  # type: ignore[no-untyped-def]
        if isinstance(exc, SpecError):
            return _err(400, exc.message, issues=exc.issues)
        return _err(500, str(exc) or exc.__class__.__name__)

    async def body(request: Request) -> dict[str, Any]:
        raw = await request.body()
        if not raw.strip():
            return {}
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}

    @app.get("/", response_class=HTMLResponse)
    @app.get("/index.html", response_class=HTMLResponse)
    async def index() -> str:
        with open(os.path.join(UI_DIR, "index.html"), encoding="utf-8") as f:
            return f.read()

    @app.get("/api/events")
    async def events() -> StreamingResponse:
        async def gen():
            q = broadcast.subscribe()
            try:
                yield f"data: {json.dumps({'type': 'hello', 'ts': now_iso(), 'seq': 0, 'run_id': ''})}\n\n"
                while True:
                    try:
                        item = await asyncio.to_thread(q.get, True, 15)
                    except queue.Empty:
                        yield ": ping\n\n"
                        continue
                    yield f"data: {json.dumps(item, default=str)}\n\n"
            finally:
                broadcast.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "connection": "keep-alive"})

    @app.get("/api/runs")
    async def runs(all: str = "0") -> Any:
        return [{**r, "in_process": control.is_running(r["id"])} for r in store.list() if all == "1" or not r.get("parent")]

    @app.post("/api/runs")
    async def start(request: Request) -> Any:
        b = await body(request)
        rid = control.start(spec_path=b.get("graph") if isinstance(b.get("graph"), str) else None, spec_yaml=b.get("spec_yaml") if isinstance(b.get("spec_yaml"), str) else None,
                            input_=b.get("input") or {}, bridge=b.get("bridge") or None, run_id=b.get("run_id") if isinstance(b.get("run_id"), str) else None, auto_approve=bool(b.get("auto_approve")))
        return {"run_id": rid}

    @app.get("/api/run")
    async def run(id: str = "") -> Any:
        if not id:
            return _err(400, "id required")
        state = store.load(id)
        events_ = store.read_events(id)
        return {
            "run": state.run, "nodes": state.nodes, "analysis": analyze(GraphSpec.model_validate(state.run["spec"])).to_dict(), "metrics": compute_metrics_deep(store, id),
            "tasks": store.list_tasks_deep(id), "spec_yaml": yaml.safe_dump(state.run["spec"], sort_keys=False, allow_unicode=True), "in_process": control.is_running(id), "events_count": len(events_),
        }

    @app.get("/api/run/events")
    async def run_events(id: str = "", after: int = 0) -> Any:
        if not id:
            return _err(400, "id required")
        return store.read_events(id, after)

    @app.get("/api/run/artifact")
    async def run_artifact(id: str = "", path: str = "") -> Any:
        if not id or not path or ".." in path:
            return _err(400, "id and path required")
        return store.read_artifact(id, path)

    @app.get("/api/run/tasks")
    async def run_tasks(id: str = "") -> Any:
        return store.list_tasks_deep(id) if id else store.list_all_pending_tasks()

    @app.post("/api/run/approve")
    async def approve(request: Request) -> Any:
        b = await body(request)
        rid, gate = str(b.get("id") or ""), str(b.get("gate") or "")
        decision = "rejected" if b.get("decision") == "rejected" else "approved"
        control.approve(rid, gate, decision, str(b.get("by") or "dashboard"), b.get("comment") if isinstance(b.get("comment"), str) else None)
        st = store.load(rid)
        if not control.is_running(rid) and st.run["status"] in ("paused", "created"):
            control.resume(rid)
        return {"ok": True}

    @app.post("/api/run/task")
    async def task(request: Request) -> Any:
        b = await body(request)
        rid, tid = str(b.get("id") or ""), str(b.get("task_id") or "")
        t = store.read_task(rid, tid)
        if t is None:
            return _err(404, f"task {tid} not found")
        if b.get("error") is None:
            ok, errs = validate_against(t.get("output_schema"), b.get("output"))
            if not ok and not b.get("force"):
                return _err(400, "output does not match output_schema", details=errs)
        store.write_task_result(rid, {"task_id": tid, "output": b.get("output"), "error": b.get("error") if isinstance(b.get("error"), str) else None,
                                      "cost_usd": b.get("cost_usd") if isinstance(b.get("cost_usd"), (int, float)) else None, "model": b.get("model") if isinstance(b.get("model"), str) else None,
                                      "source": b.get("source") or "human", "worker": b.get("worker") if isinstance(b.get("worker"), str) else "dashboard", "completed_at": now_iso()})
        return {"ok": True}

    @app.post("/api/run/resume")
    async def resume(request: Request) -> Any:
        b = await body(request)
        return {"run_id": control.resume(str(b.get("id") or ""), b.get("bridge") if isinstance(b.get("bridge"), str) and b.get("bridge") else None)}

    @app.post("/api/run/fork")
    async def fork(request: Request) -> Any:
        b = await body(request)
        frm = b.get("from")
        from_nodes = [str(x) for x in frm] if isinstance(frm, list) else [s.strip() for s in str(frm or "").split(",") if s.strip()]
        if not from_nodes:
            return _err(400, "from (node ids) required")
        rid = control.fork(str(b.get("id") or ""), from_nodes, spec_yaml=b.get("spec_yaml") if isinstance(b.get("spec_yaml"), str) else None, input_=b.get("input"),
                           bridge=b.get("bridge") or None, new_run_id=b.get("new_id") if isinstance(b.get("new_id"), str) else None)
        return {"run_id": rid}

    @app.post("/api/run/cancel")
    async def cancel(request: Request) -> Any:
        b = await body(request)
        return {"ok": control.cancel(str(b.get("id") or ""))}

    @app.post("/api/run/delete")
    async def delete(request: Request) -> Any:
        b = await body(request)
        rid = str(b.get("id") or "")
        if control.is_running(rid):
            return _err(409, "run is executing in this process; cancel it first")
        store.delete(rid)
        return {"ok": True}

    @app.get("/api/graphs")
    async def graphs() -> Any:
        return list_graphs(graphs_dir)

    @app.get("/api/graph")
    async def graph(path: str = "") -> Any:
        if not path:
            return _err(400, "path required")
        file = os.path.abspath(os.path.join(graphs_dir, path))
        rel = os.path.relpath(file, graphs_dir)
        if rel.startswith("..") or os.path.isabs(rel) or not file.endswith((".yaml", ".yml", ".json")):
            return _err(400, "path must be a .yaml/.json file inside the graphs directory")
        spec = load_graph(file).spec
        with open(file, encoding="utf-8") as f:
            text = f.read()
        return {"spec": spec.model_dump(exclude_none=True, by_alias=True), "analysis": analyze(spec).to_dict(), "yaml": text}

    @app.post("/api/graph/validate")
    async def graph_validate(request: Request) -> Any:
        b = await body(request)
        try:
            spec = load_graph_from_object(yaml.safe_load(str(b.get("spec_yaml") or "")), graphs_dir).spec
            return {"ok": True, "spec": spec.model_dump(exclude_none=True, by_alias=True), "analysis": analyze(spec).to_dict()}
        except SpecError as e:
            return {"ok": False, "error": e.message, "issues": e.issues}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e), "issues": []}

    @app.post("/api/graph/save")
    async def graph_save(request: Request) -> Any:
        b = await body(request)
        rel = str(b.get("path") or "")
        if not rel or ".." in rel or os.path.isabs(rel):
            return _err(400, "path must be relative to the graphs dir")
        spec = load_graph_from_object(yaml.safe_load(str(b.get("spec_yaml") or "")), graphs_dir).spec
        a = analyze(spec)
        if not a.ok:
            return _err(400, "spec has errors", details=[f"{f.code}{f' ({f.node})' if f.node else ''}: {f.message}" for f in a.findings if f.level == "error"])
        file = os.path.join(graphs_dir, rel if rel.endswith((".yaml", ".yml")) else f"{rel}.yaml")
        os.makedirs(os.path.dirname(file), exist_ok=True)
        with open(file, "w", encoding="utf-8") as f:
            f.write(str(b.get("spec_yaml")))
        return {"ok": True, "file": file}

    @app.post("/api/graph/scaffold")
    async def graph_scaffold(request: Request) -> Any:
        b = await body(request)
        return {"yaml": scaffold(str(b.get("shape") or "fork-join"), str(b.get("name") or "my-graph"))}

    @app.get("/api/bridges")
    async def bridges() -> Any:
        reg = control.registry
        return {"default": default_bridge().name, "bridges": [{"name": n, "ok": reg.available(n)[0], "reason": reg.available(n)[1], "description": reg.describe(n)} for n in BRIDGE_NAMES]}

    @app.get("/api/shapes")
    async def shapes() -> Any:
        return shapes_summary()

    @app.get("/api/reference")
    async def reference() -> Any:
        return {"frozen": FROZEN_CONSTRAINTS, "reducers": list(BUILTIN_REDUCERS)}

    return app


def serve(store: RunStore, graphs_dir: str, host: str = "127.0.0.1", port: int = 4545, token: str | None = None, registry: ModelRegistry | None = None, quiet: bool = False) -> None:
    import uvicorn

    app = create_app(store, graphs_dir, registry, token, quiet)
    tok = token if token is not None else os.environ.get("GREN_API_TOKEN")
    if not quiet:
        print(f"gren dashboard: http://{host}:{port}  (runs: {store.root}, graphs: {os.path.abspath(graphs_dir)}{', API token required' if tok else ''})", flush=True)
        if host not in ("127.0.0.1", "localhost") and not tok:
            print("[gren] WARNING: dashboard bound to a non-loopback address without GREN_API_TOKEN - anyone who can reach it can start runs and approve gates", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
