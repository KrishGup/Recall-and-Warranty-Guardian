/**
 * Mock bridge: deterministic, schema-driven outputs with latency and failure injection.
 * Used for tests, `gren run --bridge mock`, and to prove failure domains / retries / quorum behaviour
 * without spending a token.
 *
 * Schema hints:
 *   "examples": [..]        pick one (seeded)
 *   "x-mock": <value>        use exactly this value
 *   "enum": [..]             pick one (seeded)
 * Verify role: verdict is "kill" with probability `killRate` (default 0.25).
 */
import crypto from "node:crypto";
import { estimateCostUsd } from "../models.js";
import { BridgeError, type AgentRequest, type AgentResponse, type Bridge, type BridgeContext } from "./types.js";

export interface MockOptions {
  latencyMs?: number;
  jitterMs?: number;
  /** Probability [0,1] that an attempt throws a transient error. */
  failRate?: number;
  /** Probability that an attempt returns schema-invalid output (exercises the repair loop). */
  invalidRate?: number;
  killRate?: number;
  seed?: string;
  /** Node ids that always fail (to demonstrate failure domains). */
  alwaysFail?: string[];
}

function rng(seed: string): () => number {
  let h = crypto.createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    if (i >= h.length - 4) {
      h = crypto.createHash("sha256").update(h).digest();
      i = 0;
    }
    const v = h.readUInt32BE(i) / 0xffffffff;
    i += 4;
    return v;
  };
}

export function generateFromSchema(schema: Record<string, unknown>, rand: () => number, ctx: { node: string; item?: number; depth?: number; key?: string }): unknown {
  const depth = ctx.depth ?? 0;
  if ("x-mock" in schema) return schema["x-mock"];
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[Math.floor(rand() * schema.examples.length)];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[Math.floor(rand() * schema.enum.length)];
  if ("const" in schema) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [k, sub] of Object.entries(props)) out[k] = generateFromSchema(sub, rand, { ...ctx, depth: depth + 1, key: k });
      return out;
    }
    case "array": {
      const itemSchema = (schema.items ?? { type: "string" }) as Record<string, unknown>;
      const min = typeof schema.minItems === "number" ? schema.minItems : 1;
      const max = typeof schema.maxItems === "number" ? schema.maxItems : Math.max(min, 3);
      const n = depth > 3 ? min : min + Math.floor(rand() * (max - min + 1));
      return Array.from({ length: n }, (_, i) => generateFromSchema(itemSchema, rand, { ...ctx, depth: depth + 1, key: `${ctx.key ?? "item"}[${i}]` }));
    }
    case "number":
    case "integer": {
      const min = typeof schema.minimum === "number" ? schema.minimum : 0;
      const max = typeof schema.maximum === "number" ? schema.maximum : type === "integer" ? 10 : 1;
      const v = min + rand() * (max - min);
      return type === "integer" ? Math.round(v) : Number(v.toFixed(3));
    }
    case "boolean":
      return rand() > 0.3;
    case "null":
      return null;
    default: {
      const key = ctx.key ?? "value";
      const fmt = schema.format;
      if (fmt === "uri" || /url|link|source/i.test(key)) return `https://example.org/${ctx.node}/${key.replace(/[^a-z0-9]/gi, "")}-${Math.floor(rand() * 1000)}`;
      if (fmt === "date-time") return new Date(1_700_000_000_000 + Math.floor(rand() * 1e10)).toISOString();
      const words = ["evidence", "signal", "claim", "market", "latency", "graph", "reducer", "verifier", "budget", "topology"];
      const pick = () => words[Math.floor(rand() * words.length)];
      return `mock ${key} from ${ctx.node}${ctx.item !== undefined ? `#${ctx.item}` : ""}: ${pick()} ${pick()} ${pick()}`;
    }
  }
}

export class MockBridge implements Bridge {
  readonly name = "mock";
  constructor(private opts: MockOptions = {}) {}

  describe() {
    return "deterministic schema-driven mock (no tokens spent)";
  }

  async available() {
    return { ok: true };
  }

  async execute(req: AgentRequest, ctx: BridgeContext): Promise<AgentResponse> {
    const start = Date.now();
    const seed = `${this.opts.seed ?? "gren"}:${req.run_id}:${req.node_id}:${req.item_index ?? -1}:${req.attempt}`;
    const rand = rng(seed);
    const latency = (this.opts.latencyMs ?? 40) + Math.floor(rand() * (this.opts.jitterMs ?? 60));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, latency);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new BridgeError("cancelled", "cancelled", false));
      }, { once: true });
    });
    if (this.opts.alwaysFail?.includes(req.node_id)) throw new BridgeError(`mock: node ${req.node_id} configured to always fail`, "transport");
    if (rand() < (this.opts.failRate ?? 0)) throw new BridgeError("mock: injected transient failure", "transport");

    let output: unknown;
    if (req.role === "verify") {
      const kill = rand() < (this.opts.killRate ?? 0.25);
      output = { verdict: kill ? "kill" : "pass", reasons: kill ? ["mock verifier: could not confirm the source supports the claim"] : [], confidence: kill ? 0.6 + rand() * 0.4 : 0.2 + rand() * 0.3 };
    } else if (rand() < (this.opts.invalidRate ?? 0) && !req.repair_errors) {
      output = { _invalid: true, note: "mock: injected schema-invalid output" };
    } else {
      output = generateFromSchema(req.output_schema, rand, { node: req.node_id, item: req.item_index });
    }
    const usage = { input_tokens: 400 + Math.floor(req.prompt.length / 4), output_tokens: 250 };
    return {
      output,
      raw: JSON.stringify(output),
      usage,
      cost_usd: estimateCostUsd(req.model, usage),
      model: req.model,
      bridge: this.name,
      duration_ms: Date.now() - start,
      source: "mock",
    };
  }
}
