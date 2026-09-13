"""Inbox provider: the engine writes a task file and waits for a result written by an external worker
(a Claude Code session using the gren MCP tools, the CLI, or a human). The engine still owns validation,
retries, budgets and fan-out width; the worker just answers one prompt.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from ._base import OneShotModel, new_id
from .pricing import estimate_cost_usd


class InboxModel(OneShotModel):
    def __init__(self, model_id: str = "claude-sonnet-5", effort: str | None = None, runs_root: str | None = None, tools: list[str] | None = None,
                 poll_s: float = 0.5, min_timeout_s: float = 1800, **_: Any):
        super().__init__(model_id, effort=effort, tools=tools or [], poll_s=poll_s, min_timeout_s=min_timeout_s)
        self.runs_root = runs_root or "runs"
        self.run_id = "run"
        self.node_id = "node"
        self.item: int | None = None
        self.attempt = 1
        self.role = "agent"
        self.timeout_s = min_timeout_s
        self.on_event = None

    def bind(self, run_id: str, node_id: str, item: int | None, attempt: int, role: str, timeout_s: float, on_event=None) -> None:
        self.run_id, self.node_id, self.item, self.attempt, self.role = run_id, node_id, item, attempt, role
        self.timeout_s = max(timeout_s, float(self.config["min_timeout_s"]))
        self.on_event = on_event

    def _inbox_dir(self) -> str:
        d = os.path.join(self.runs_root, self.run_id, "inbox")
        os.makedirs(d, exist_ok=True)
        return d

    async def complete(self, prompt: str, system_prompt: str | None, output_schema: dict[str, Any] | None) -> dict[str, Any]:
        task_id = f"{self.node_id}{f'-i{self.item}' if self.item is not None else ''}-a{self.attempt}-{new_id('')[1:]}"
        task = {
            "task_id": task_id, "run_id": self.run_id, "node_id": self.node_id, "item_index": self.item, "attempt": self.attempt,
            "role": self.role, "model": self.config["model_id"], "effort": self.config.get("effort"), "system": system_prompt or "",
            "prompt": prompt, "output_schema": output_schema or {"type": "object"}, "tools": self.config.get("tools") or [],
            "created_at": _iso(), "timeout_at": _iso(time.time() + self.timeout_s), "status": "pending",
            "instructions": f'Execute this node with model "{self.config["model_id"]}". Treat "system" as the system prompt and "prompt" as the user message. '
                            f"Return ONLY a JSON object that validates against output_schema via gren_complete_task (or: gren complete {self.run_id} {task_id} --result <file>).",
        }
        d = self._inbox_dir()
        _atomic_write(os.path.join(d, f"{task_id}.json"), task)
        if self.on_event:
            self.on_event("task.created", {"task_id": task_id, "node": self.node_id, "item": self.item, "model": self.config["model_id"], "role": self.role})
        t0 = time.time()
        result_file = os.path.join(d, f"{task_id}.result.json")
        while True:
            if os.path.exists(result_file):
                try:
                    res = json.load(open(result_file, encoding="utf8"))
                except (json.JSONDecodeError, OSError):
                    await asyncio.sleep(0.2)
                    continue
                task["status"] = "completed"
                _atomic_write(os.path.join(d, f"{task_id}.json"), task)
                if self.on_event:
                    self.on_event("task.completed", {"task_id": task_id, "node": self.node_id, "item": self.item, "source": res.get("source"), "worker": res.get("worker")})
                if res.get("error"):
                    raise RuntimeError(f"worker reported failure: {res['error']}")
                usage = res.get("usage") or {}
                return {"text": json.dumps(res.get("output")), "json": res.get("output"), "usage": usage,
                        "cost_usd": res.get("cost_usd") if res.get("cost_usd") is not None else (estimate_cost_usd(self.config["model_id"], usage) if usage else None),
                        "latency_ms": int((time.time() - t0) * 1000)}
            if time.time() - t0 > self.timeout_s:
                task["status"] = "cancelled"
                _atomic_write(os.path.join(d, f"{task_id}.json"), task)
                raise RuntimeError(f"inbox task {task_id} timed out after {self.timeout_s:.0f}s with no worker result")
            await asyncio.sleep(float(self.config["poll_s"]))


def _iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _atomic_write(path: str, data: Any) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(data, f, indent=2, default=str)
    for _ in range(6):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.02)
    with open(path, "w", encoding="utf8") as f:
        json.dump(data, f, indent=2, default=str)
    try:
        os.remove(tmp)
    except OSError:
        pass
