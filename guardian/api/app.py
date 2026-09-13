"""Guardian API.

  GET  /api/summary                      home page numbers, agent status, last sweep, ending-soon warranties
  GET  /api/items?q=&category=&warranty=&recall=&page=&page_size=
  GET  /api/items/{id}                   item with matches and activity
  POST /api/items                        manual add (NewItem)
  POST /api/items/import                 {items: NewItem[]}
  POST /api/items/{id}/problem           {text}
  POST /api/intake                       {text, source} -> runs the intake graph, returns the item
  GET  /api/decisions                    {pending, past}
  POST /api/decisions/{id}/answer        {choice, by?, comment?}
  GET  /api/activity?days=7
  GET  /api/preferences | PUT /api/preferences
  POST /api/sweep                        {window_days?, full_scan?} -> {run_id}
  GET  /api/events                       SSE: guardian events and gren engine events
  /gren/api/*                            gren run dashboard API (runs, run, events, approve, fork, artifacts)
  /                                      the built dashboard (web/dist) when present
"""
from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from ..models import Preferences, now_iso
from ..service import Guardian

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB_DIST = os.path.join(ROOT, "web", "dist")


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


def create_guardian_app(data_dir: str | None = None, runs_dir: str | None = None, bridge: str | None = None, web_dist: str | None = None, quiet: bool = True) -> FastAPI:
    guardian, gren_app = Guardian.build(data_dir=data_dir, runs_dir=runs_dir, bridge=bridge, quiet=quiet, with_gren_app=True)
    broadcast = Broadcaster()
    guardian.listeners.append(broadcast.publish)
    app = FastAPI(title="Guardian", docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
    app.state.guardian = guardian
    web_dist = web_dist or WEB_DIST

    @app.middleware("http")
    async def no_store(request: Request, call_next):  # type: ignore[no-untyped-def]
        resp = await call_next(request)
        if request.url.path.startswith("/api/"):
            resp.headers["cache-control"] = "no-store"
        return resp

    @app.exception_handler(KeyError)
    async def on_key(_: Request, exc: KeyError):  # type: ignore[no-untyped-def]
        return _err(404, f"not found: {exc.args[0] if exc.args else ''}")

    @app.exception_handler(ValueError)
    async def on_value(_: Request, exc: ValueError):  # type: ignore[no-untyped-def]
        return _err(400, str(exc))

    async def body(request: Request) -> dict[str, Any]:
        raw = await request.body()
        if not raw.strip():
            return {}
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}

    # ---- summary / activity ----
    @app.get("/api/summary")
    async def summary() -> Any:
        return await asyncio.to_thread(guardian.summary)

    @app.get("/api/activity")
    async def activity(days: int = 7) -> Any:
        return await asyncio.to_thread(guardian.activity_nights, max(1, min(days, 90)))

    # ---- items ----
    @app.get("/api/items")
    async def items(q: str = "", category: str = "", warranty: str = "", recall: str = "", page: int = 1, page_size: int = 25) -> Any:
        return await asyncio.to_thread(guardian.items_page, q, category, warranty, recall, max(1, page), max(1, min(page_size, 200)))

    @app.get("/api/items/{item_id}")
    async def item(item_id: str) -> Any:
        v = await asyncio.to_thread(guardian.item_detail, item_id)
        return v if v is not None else _err(404, f"item {item_id} not found")

    @app.post("/api/items")
    async def create_item(request: Request) -> Any:
        b = await body(request)
        if not b.get("name") or not b.get("purchase_date"):
            return _err(400, "name and purchase_date are required")
        return await asyncio.to_thread(guardian.add_item, b, "manual")

    @app.post("/api/items/import")
    async def import_items(request: Request) -> Any:
        b = await body(request)
        rows = b.get("items") if isinstance(b.get("items"), list) else []
        created = [await asyncio.to_thread(guardian.add_item, r, "csv") for r in rows if isinstance(r, dict) and r.get("name") and r.get("purchase_date")]
        return {"created": len(created), "items": created}

    @app.post("/api/items/{item_id}/problem")
    async def problem(item_id: str, request: Request) -> Any:
        b = await body(request)
        return await asyncio.to_thread(guardian.report_problem, item_id, str(b.get("text") or ""))

    @app.post("/api/intake")
    async def intake(request: Request) -> Any:
        b = await body(request)
        text = str(b.get("text") or "")
        if len(text.strip()) < 8:
            return _err(400, "text is too short")
        return await asyncio.to_thread(guardian.intake, text, str(b.get("source") or "paste"))

    # ---- decisions ----
    @app.get("/api/decisions")
    async def decisions() -> Any:
        return await asyncio.to_thread(guardian.decisions)

    @app.post("/api/decisions/{decision_id}/answer")
    async def answer(decision_id: str, request: Request) -> Any:
        b = await body(request)
        if not b.get("choice"):
            return _err(400, "choice is required")
        return await asyncio.to_thread(guardian.answer, decision_id, str(b["choice"]), str(b.get("by") or "dashboard"), b.get("comment") if isinstance(b.get("comment"), str) else None)

    # ---- preferences ----
    @app.get("/api/preferences")
    async def preferences() -> Any:
        return guardian.preferences().model_dump()

    @app.put("/api/preferences")
    async def save_preferences(request: Request) -> Any:
        b = await body(request)
        return (await asyncio.to_thread(guardian.save_preferences, Preferences.model_validate(b))).model_dump()

    # ---- sweep ----
    @app.post("/api/sweep")
    async def sweep(request: Request) -> Any:
        b = await body(request)
        rid = await asyncio.to_thread(guardian.start_sweep, int(b.get("window_days") or 45), bool(b.get("full_scan")), bool(b.get("auto_approve")), "dashboard")
        return {"run_id": rid}

    # ---- events ----
    @app.get("/api/events")
    async def events() -> StreamingResponse:
        async def gen():
            q = broadcast.subscribe()
            try:
                yield f"data: {json.dumps({'type': 'hello', 'at': now_iso()})}\n\n"
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

    @app.get("/api/health")
    async def health() -> Any:
        return {"ok": True, "data": guardian.store.root, "runs": guardian.run_store.root, "bridge": guardian.bridge}

    if gren_app is not None:
        app.mount("/gren", gren_app)

    # ---- the built dashboard ----
    index = os.path.join(web_dist, "index.html")
    if os.path.isdir(os.path.join(web_dist, "assets")):
        app.mount("/assets", StaticFiles(directory=os.path.join(web_dist, "assets")), name="assets")

    @app.get("/{path:path}", response_class=HTMLResponse)
    async def spa(path: str) -> Any:
        candidate = os.path.abspath(os.path.join(web_dist, path)) if path else index
        if path and candidate.startswith(os.path.abspath(web_dist)) and os.path.isfile(candidate):
            return FileResponse(candidate)
        if os.path.isfile(index):
            return FileResponse(index)
        return HTMLResponse("<p style='font-family:serif;padding:24px'>Guardian API is running. Build the dashboard with <code>cd web && npm run build</code>, or run <code>npm run dev</code> for the Vite dev server.</p>")

    return app
