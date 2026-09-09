/**
 * A bridge executes ONE bounded agent call: prompt in, schema-valid JSON out.
 * The engine owns retries, validation, budgets, timeouts and fan-out; bridges own transport.
 *
 *   api          Anthropic Messages API (ANTHROPIC_API_KEY / `ant auth login` profile)
 *   claude-code  Claude Code headless via the Agent SDK (subscription login, no API key)
 *   inbox        Orchestrator bridge: tasks are written to the run inbox and executed by an external
 *                worker - typically a Claude Code session using the gren MCP tools + its Agent tool
 *   mock         Deterministic schema-driven responses with latency/failure injection (tests, dry runs)
 */
import type { Effort } from "../spec/schema.js";
import type { Usage } from "../models.js";
import type { RunStore } from "../engine/state.js";

export interface AgentRequest {
  run_id: string;
  node_id: string;
  item_index?: number;
  attempt: number;
  role: "agent" | "verify";
  /** Fully resolved model id (e.g. claude-sonnet-5). */
  model: string;
  effort?: Effort;
  system?: string;
  prompt: string;
  output_schema: Record<string, unknown>;
  tools?: string[];
  max_turns?: number;
  max_output_tokens?: number;
  timeout_ms: number;
  cwd?: string;
  /** Remaining run budget (USD) - bridges that can enforce a per-call cap must not exceed it. */
  max_cost_usd?: number;
  /** Validation errors from the previous attempt (repair loop). */
  repair_errors?: string[];
}

export interface AgentResponse {
  output: unknown;
  raw?: string;
  usage?: Usage;
  cost_usd?: number;
  model: string;
  bridge: string;
  duration_ms: number;
  session_id?: string;
  source?: "model" | "orchestrator" | "human" | "subagent" | "mock" | "api";
  worker?: string;
}

export interface BridgeContext {
  signal: AbortSignal;
  store: RunStore;
  log: (msg: string) => void;
  emit: (type: string, data?: Record<string, unknown>) => void;
}

export interface Bridge {
  readonly name: string;
  describe(): string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  execute(req: AgentRequest, ctx: BridgeContext): Promise<AgentResponse>;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly kind: "transport" | "auth" | "timeout" | "invalid_output" | "cancelled" | "rate_limit" | "refusal" = "transport",
    public readonly retryable = true,
  ) {
    super(message);
  }
}

/** Extract the first JSON object/array from free text (fallback when a bridge cannot enforce a schema). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1]?.trim(), trimmed].filter((s): s is string => Boolean(s));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* continue */
    }
    const start = Math.min(...["{", "["].map((ch) => (c.indexOf(ch) === -1 ? Infinity : c.indexOf(ch))));
    if (!Number.isFinite(start)) continue;
    const endObj = c.lastIndexOf("}");
    const endArr = c.lastIndexOf("]");
    const end = Math.max(endObj, endArr);
    if (end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        /* continue */
      }
    }
  }
  throw new BridgeError("no JSON object found in model output", "invalid_output");
}

/** System prompt fragment every bridge prepends so the structured contract is explicit for the model. */
export function contractPreamble(req: AgentRequest): string {
  const lines = [
    `You are one bounded node ("${req.node_id}") inside a larger multi-agent graph. You have exactly one job: produce the requested structured output.`,
    "Rules:",
    "- Respond with a single JSON object that validates against the provided JSON schema. No prose before or after it.",
    "- Never invent sources, citations, numbers or facts you did not actually derive from the provided input. If evidence is missing, say so inside the structured fields (lower confidence, empty arrays) rather than filling gaps.",
    "- Do not explain your reasoning outside the schema. Do not add fields that are not in the schema.",
  ];
  if (req.role === "verify") {
    lines.push("- You are an ADVERSARIAL verifier. Your objective is different from the producer's: find the reason this candidate should be rejected. You have authority to kill it. Only pass a candidate you could not falsify.");
  }
  if (req.repair_errors?.length) {
    lines.push("", "Your previous answer FAILED schema validation with these errors - fix them:", ...req.repair_errors.map((e) => `  - ${e}`));
  }
  lines.push("", "JSON schema for your output:", JSON.stringify(req.output_schema));
  return lines.join("\n");
}
