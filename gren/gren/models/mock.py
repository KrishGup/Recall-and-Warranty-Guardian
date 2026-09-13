"""Mock provider: deterministic, schema-driven outputs with latency and failure injection. No tokens.

Schema hints: "examples": [..] pick one (seeded); "x-mock": value; "enum": pick one.
Verify calls (schema with a verdict enum) kill with probability `kill_rate`.
"""
from __future__ import annotations

import asyncio
import hashlib
import random
from typing import Any

from ._base import OneShotModel
from .pricing import estimate_cost_usd

WORDS = ["evidence", "signal", "claim", "market", "latency", "graph", "reducer", "verifier", "budget", "topology"]


def generate_from_schema(schema: dict[str, Any], rng: random.Random, node: str, key: str = "value", depth: int = 0) -> Any:
    if "x-mock" in schema:
        return schema["x-mock"]
    if schema.get("examples"):
        return rng.choice(schema["examples"])
    if schema.get("enum"):
        return rng.choice(schema["enum"])
    if "const" in schema:
        return schema["const"]
    if "anyOf" in schema:
        options = [o for o in schema["anyOf"] if o.get("type") != "null"] or schema["anyOf"]
        return generate_from_schema(options[0], rng, node, key, depth)
    t = schema.get("type")
    t = t[0] if isinstance(t, list) else t
    if t == "object":
        return {k: generate_from_schema(sub, rng, node, k, depth + 1) for k, sub in (schema.get("properties") or {}).items()}
    if t == "array":
        items = schema.get("items") or {"type": "string"}
        lo = int(schema.get("minItems", 1))
        hi = int(schema.get("maxItems", max(lo, 3)))
        n = lo if depth > 3 else rng.randint(lo, hi)
        return [generate_from_schema(items, rng, node, f"{key}[{i}]", depth + 1) for i in range(n)]
    if t in ("number", "integer"):
        lo = float(schema.get("minimum", 0))
        hi = float(schema.get("maximum", 10 if t == "integer" else 1))
        v = lo + rng.random() * (hi - lo)
        return round(v) if t == "integer" else round(v, 3)
    if t == "boolean":
        return rng.random() > 0.3
    if t == "null":
        return None
    fmt = schema.get("format")
    if fmt == "uri" or any(w in key.lower() for w in ("url", "link", "source")):
        return f"https://example.org/{node}/{key.replace('[', '-').replace(']', '')}-{rng.randint(0, 999)}"
    if fmt == "date-time":
        return "2026-01-01T00:00:00Z"
    s = f"mock {key} from {node}: {rng.choice(WORDS)} {rng.choice(WORDS)} {rng.choice(WORDS)}"
    while len(s) < int(schema.get("minLength", 0)):
        s += f" {rng.choice(WORDS)} {rng.choice(WORDS)}"
    if "maxLength" in schema:
        s = s[: int(schema["maxLength"])]
    if schema.get("pattern") == "^[a-z0-9-]+$":
        s = "-".join(w for w in s.lower().replace(":", "").split() if w.isalnum())
    return s


class MockModel(OneShotModel):
    def __init__(self, model_id: str = "claude-haiku-4-5", latency_ms: int = 20, jitter_ms: int = 30, fail_rate: float = 0.0,
                 invalid_rate: float = 0.0, kill_rate: float = 0.25, seed: str = "gren", always_fail: list[str] | None = None, **_: Any):
        super().__init__(model_id, latency_ms=latency_ms, jitter_ms=jitter_ms, fail_rate=fail_rate, invalid_rate=invalid_rate,
                         kill_rate=kill_rate, seed=seed, always_fail=always_fail or [])
        self.node_id = "node"
        self.attempt = 1
        self.item: int | None = None
        self.repair = False

    def bind(self, node_id: str, attempt: int, item: int | None, repair: bool) -> None:
        self.node_id, self.attempt, self.item, self.repair = node_id, attempt, item, repair

    async def complete(self, prompt: str, system_prompt: str | None, output_schema: dict[str, Any] | None) -> dict[str, Any]:
        c = self.config
        seed = f"{c['seed']}:{self.node_id}:{self.item}:{self.attempt}:{hashlib.sha1(prompt.encode()).hexdigest()[:8]}"
        rng = random.Random(seed)
        await asyncio.sleep((c["latency_ms"] + rng.random() * c["jitter_ms"]) / 1000)
        if self.node_id in c["always_fail"]:
            raise RuntimeError(f"mock: node {self.node_id} configured to always fail")
        if rng.random() < c["fail_rate"]:
            raise RuntimeError("mock: injected transient failure")
        usage = {"inputTokens": 400 + len(prompt) // 4, "outputTokens": 250}
        cost = estimate_cost_usd(c["model_id"], usage)
        if output_schema is None:
            return {"text": f"mock reply from {self.node_id}", "json": None, "usage": usage, "cost_usd": cost}
        props = output_schema.get("properties") or {}
        is_verify = "verdict" in props and "reasons" in props
        if is_verify:
            kill = rng.random() < c["kill_rate"]
            data: Any = {"verdict": "kill" if kill else "pass",
                         "reasons": ["mock verifier: could not confirm the source supports the claim"] if kill else [],
                         "confidence": round(0.6 + rng.random() * 0.4 if kill else 0.2 + rng.random() * 0.3, 3)}
        elif rng.random() < c["invalid_rate"] and not self.repair:
            data = {"_invalid": True, "note": "mock: injected schema-invalid output"}
        else:
            data = generate_from_schema(output_schema, rng, self.node_id)
        return {"text": "", "json": data, "usage": usage, "cost_usd": cost}
