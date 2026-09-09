/**
 * Model catalogue, aliases, and pricing used for cost estimation and routing.
 * Prices are USD per 1M tokens (first-party Claude API rates, cached 2026-06).
 * Aliases let graph specs say `model: haiku` and stay stable across model bumps.
 */
export const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
  fable: "claude-fable-5-1",
};

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Rough typical latency for a bounded structured task, used only for critical-path *estimates* before a run. */
  estLatencyMs: number;
  tier: "small" | "medium" | "large" | "frontier";
}

export const PRICING: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, estLatencyMs: 6000, tier: "small" },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, estLatencyMs: 15000, tier: "medium" },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, estLatencyMs: 15000, tier: "medium" },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, estLatencyMs: 30000, tier: "large" },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, estLatencyMs: 30000, tier: "large" },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, estLatencyMs: 30000, tier: "large" },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, estLatencyMs: 30000, tier: "large" },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, estLatencyMs: 45000, tier: "frontier" },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, estLatencyMs: 45000, tier: "frontier" },
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function resolveModel(nameOrAlias: string | undefined, fallback = "sonnet"): string {
  const key = (nameOrAlias ?? fallback).trim();
  return MODEL_ALIASES[key] ?? key;
}

export function modelInfo(model: string): ModelPrice {
  return PRICING[resolveModel(model)] ?? PRICING["claude-sonnet-5"]!;
}

export function estimateCostUsd(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  const p = modelInfo(model);
  const m = 1 / 1_000_000;
  return (
    (usage.input_tokens ?? 0) * p.input * m +
    (usage.output_tokens ?? 0) * p.output * m +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead * m +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite * m
  );
}

/** Estimate the cost of one bounded structured call, given rough prompt/output sizes. Used by `gren analyze`. */
export function estimateCallCostUsd(model: string, promptChars: number, outputTokens = 800): number {
  const p = modelInfo(model);
  const inputTokens = Math.ceil(promptChars / 4) + 600; // + system overhead
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function sumUsage(a: Usage | undefined, b: Usage | undefined): Usage {
  return {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
    cache_read_input_tokens: (a?.cache_read_input_tokens ?? 0) + (b?.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a?.cache_creation_input_tokens ?? 0) + (b?.cache_creation_input_tokens ?? 0),
  };
}
