"""Model catalogue, aliases and pricing (USD per 1M tokens; first-party Claude API rates, cached 2026-06).

Aliases keep specs stable (`model: haiku`). Each provider maps an alias to its own model id:
  anthropic / claude-code  -> claude-haiku-4-5 ...
  bedrock                  -> global.anthropic.claude-haiku-4-5-20251001-v1:0, global.anthropic.claude-sonnet-5 ... (override with GREN_BEDROCK_<ALIAS>)
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

MODEL_ALIASES: dict[str, str] = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-5",
    "fable": "claude-fable-5-1",
}

BEDROCK_ALIASES: dict[str, str] = {
    "haiku": os.environ.get("GREN_BEDROCK_HAIKU", "global.anthropic.claude-haiku-4-5-20251001-v1:0"),  # Bedrock's Haiku 4.5 profile carries the date suffix; the Claude 5 profiles do not
    "sonnet": os.environ.get("GREN_BEDROCK_SONNET", "global.anthropic.claude-sonnet-5"),
    "opus": os.environ.get("GREN_BEDROCK_OPUS", "global.anthropic.claude-opus-5"),
    "fable": os.environ.get("GREN_BEDROCK_FABLE", "global.anthropic.claude-fable-5-1"),
}


@dataclass(frozen=True)
class ModelPrice:
    input: float
    output: float
    cache_read: float
    cache_write: float
    est_latency_ms: int
    tier: str


PRICING: dict[str, ModelPrice] = {
    "claude-haiku-4-5": ModelPrice(1, 5, 0.1, 1.25, 6000, "small"),
    "claude-sonnet-5": ModelPrice(2, 10, 0.2, 2.5, 15000, "medium"),
    "claude-sonnet-4-6": ModelPrice(3, 15, 0.3, 3.75, 15000, "medium"),
    "claude-opus-5": ModelPrice(5, 25, 0.5, 6.25, 30000, "large"),
    "claude-opus-4-8": ModelPrice(5, 25, 0.5, 6.25, 30000, "large"),
    "claude-opus-4-7": ModelPrice(5, 25, 0.5, 6.25, 30000, "large"),
    "claude-opus-4-6": ModelPrice(5, 25, 0.5, 6.25, 30000, "large"),
    "claude-fable-5-1": ModelPrice(10, 50, 0.25, 12.5, 45000, "frontier"),
    "claude-fable-5": ModelPrice(10, 50, 1, 12.5, 45000, "frontier"),
}


def resolve_model(name_or_alias: str | None, fallback: str = "sonnet") -> str:
    key = (name_or_alias or fallback).strip()
    return MODEL_ALIASES.get(key, key)


def canonical_model(model_id: str) -> str:
    """Strip provider prefixes/suffixes so Bedrock ids price like their first-party twins."""
    m = model_id
    for prefix in ("global.anthropic.", "us.anthropic.", "eu.anthropic.", "apac.anthropic.", "anthropic."):
        if m.startswith(prefix):
            m = m[len(prefix):]
    m = m.split("-v1:")[0]
    m = m.rsplit("-2025", 1)[0] if "-2025" in m else m
    m = m.rsplit("-2026", 1)[0] if "-2026" in m else m
    return MODEL_ALIASES.get(m, m)


def model_info(model: str) -> ModelPrice:
    return PRICING.get(canonical_model(resolve_model(model))) or PRICING["claude-sonnet-5"]


def estimate_cost_usd(model: str, usage: dict[str, Any] | None) -> float:
    if not usage:
        return 0.0
    p = model_info(model)
    m = 1 / 1_000_000
    return (
        (usage.get("inputTokens") or usage.get("input_tokens") or 0) * p.input * m
        + (usage.get("outputTokens") or usage.get("output_tokens") or 0) * p.output * m
        + (usage.get("cacheReadInputTokens") or usage.get("cache_read_input_tokens") or 0) * p.cache_read * m
        + (usage.get("cacheWriteInputTokens") or usage.get("cache_creation_input_tokens") or 0) * p.cache_write * m
    )


def estimate_call_cost_usd(model: str, prompt_chars: int, output_tokens: int = 800) -> float:
    p = model_info(model)
    input_tokens = prompt_chars // 4 + 600
    return (input_tokens * p.input + output_tokens * p.output) / 1_000_000


def sum_usage(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, int]:
    out: dict[str, int] = {}
    for k in ("inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens"):
        out[k] = int((a or {}).get(k, 0) or 0) + int((b or {}).get(k, 0) or 0)
    return out
