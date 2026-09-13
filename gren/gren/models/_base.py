"""Shared plumbing for gren's custom Strands model providers (claude-code, inbox, mock).

All three produce a complete assistant message in one go, so `stream()` emits the canonical event sequence
(messageStart, contentBlockStart/Delta/Stop, messageStop, metadata) and `structured_output()` validates the
JSON against the Pydantic model. Tool use is not exposed to Strands by these providers: Claude Code executes
its own tools inside the session, the inbox worker executes whatever it likes, and the mock has none.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, AsyncGenerator, AsyncIterable, TypeVar

from pydantic import BaseModel, ValidationError
from strands.models import Model
from strands.types.content import Messages
from strands.types.streaming import StreamEvent
from strands.types.tools import ToolSpec

from ..engine.validate import schema_of

T = TypeVar("T", bound=BaseModel)


def messages_to_prompt(messages: Messages) -> str:
    """Flatten a Strands conversation into one prompt for a one-shot provider."""
    parts: list[str] = []
    for m in messages:
        role = m.get("role", "user")
        texts: list[str] = []
        for block in m.get("content", []):
            if "text" in block:
                texts.append(str(block["text"]))
            elif "toolResult" in block:
                tr = block["toolResult"]
                texts.append(f"[tool result {tr.get('toolUseId')}]: " + json.dumps(tr.get("content"), default=str)[:4000])
            elif "toolUse" in block:
                texts.append(f"[tool use]: {json.dumps(block['toolUse'], default=str)[:2000]}")
        if texts:
            parts.append(("" if role == "user" and len(messages) == 1 else f"{role.upper()}:\n") + "\n".join(texts))
    return "\n\n".join(parts)


def extract_json(text: str) -> Any:
    t = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", t, re.I)
    candidates = [m.group(1).strip()] if m else []
    candidates.append(t)
    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            pass
        starts = [i for i in (c.find("{"), c.find("[")) if i >= 0]
        if not starts:
            continue
        s = min(starts)
        e = max(c.rfind("}"), c.rfind("]"))
        if e > s:
            try:
                return json.loads(c[s : e + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError("no JSON object found in model output")


class OneShotModel(Model):
    """Base for providers that return a whole answer at once."""

    lenient_output: bool = False  # gren's runtime sets True: invalid JSON comes back raw and the engine repairs it

    def __init__(self, model_id: str, **config: Any):
        self.config: dict[str, Any] = {"model_id": model_id, **config}
        self.last_usage: dict[str, Any] = {}
        self.last_cost_usd: float | None = None
        self.last_session_id: str | None = None

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    def get_config(self) -> dict[str, Any]:
        return dict(self.config)

    # ---- subclass contract ----
    async def complete(self, prompt: str, system_prompt: str | None, output_schema: dict[str, Any] | None) -> dict[str, Any]:
        """Return {"text": str, "json": Any | None, "usage": {...}, "cost_usd": float | None, "session_id": str | None}."""
        raise NotImplementedError

    # ---- Strands Model interface ----
    async def stream(  # type: ignore[override]
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterable[StreamEvent]:
        res = await self.complete(messages_to_prompt(messages), system_prompt, None)
        self._remember(res)
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": res.get("text") or ""}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": self._usage(res), "metrics": {"latencyMs": int(res.get("latency_ms") or 0)}}}

    async def structured_output(  # type: ignore[override]
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        schema = schema_of(output_model)
        res = await self.complete(messages_to_prompt(prompt), system_prompt, schema)
        self._remember(res)
        data = res.get("json")
        if data is None:
            data = extract_json(res.get("text") or "")
        yield {"metadata": {"usage": self._usage(res), "metrics": {"latencyMs": int(res.get("latency_ms") or 0)}}}
        if self.lenient_output:
            # the gren runtime validates against the spec's JSON schema itself and runs its repair loop on failure
            try:
                yield {"output": output_model.model_validate(data)}
            except ValidationError:
                yield {"output": data}
            return
        yield {"output": output_model.model_validate(data)}

    def _remember(self, res: dict[str, Any]) -> None:
        self.last_usage = self._usage(res)
        self.last_cost_usd = res.get("cost_usd")
        self.last_session_id = res.get("session_id")

    @staticmethod
    def _usage(res: dict[str, Any]) -> dict[str, int]:
        u = res.get("usage") or {}
        i = int(u.get("inputTokens") or u.get("input_tokens") or 0)
        o = int(u.get("outputTokens") or u.get("output_tokens") or 0)
        return {
            "inputTokens": i,
            "outputTokens": o,
            "totalTokens": i + o,
            "cacheReadInputTokens": int(u.get("cacheReadInputTokens") or u.get("cache_read_input_tokens") or 0),
            "cacheWriteInputTokens": int(u.get("cacheWriteInputTokens") or u.get("cache_creation_input_tokens") or 0),
        }


def new_id(prefix: str = "id") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"
