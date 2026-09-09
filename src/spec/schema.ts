/**
 * The graph spec: nodes, edges (derived from data references), gates, budgets, frozen constraints.
 *
 * Design rules encoded here (from the two Graph Engineering essays):
 *  - An edge is a DATA contract, not an arrow. Edges are derived from `$nodes.<id>...` references.
 *    Ordering-only edges must be declared with `after: [{node, reason}]` and are flagged by analysis.
 *  - Every node has one job, explicit input, structured output, and an explicit failure policy.
 *  - Human approval is an edge type (`gate` nodes + `requires_gate`), not a prompt instruction.
 *  - Every cycle (loop / repair) has a hard stop and a budget.
 *  - Some rules are frozen: they are validated by the engine, not suggested to the model.
 */
import { z } from "zod";

// ---------- shared pieces ----------

export const JsonSchemaZ = z.record(z.string(), z.unknown());

export type Cond =
  | string
  | boolean
  | { eq: [unknown, unknown] }
  | { neq: [unknown, unknown] }
  | { gt: [unknown, unknown] }
  | { gte: [unknown, unknown] }
  | { lt: [unknown, unknown] }
  | { lte: [unknown, unknown] }
  | { in: [unknown, unknown] }
  | { contains: [unknown, unknown] }
  | { matches: [unknown, string] }
  | { exists: unknown }
  | { empty: unknown }
  | { truthy: unknown }
  | { status: [string, string] }
  | { and: Cond[] }
  | { or: Cond[] }
  | { not: Cond };

export const CondZ: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.string(), // bare "$ref" => truthy
    z.boolean(),
    z.object({ eq: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ neq: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ gt: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ gte: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ lt: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ lte: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ in: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ contains: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ matches: z.tuple([z.unknown(), z.string()]) }),
    z.object({ exists: z.unknown() }),
    z.object({ empty: z.unknown() }),
    z.object({ truthy: z.unknown() }),
    z.object({ status: z.tuple([z.string(), z.string()]) }),
    z.object({ and: z.array(CondZ) }),
    z.object({ or: z.array(CondZ) }),
    z.object({ not: CondZ }),
  ]) as unknown as z.ZodType<Cond>,
);

export const FailurePolicyZ = z.object({
  /** Additional attempts after the first (default 1 => two attempts total). */
  retries: z.number().int().min(0).max(10).optional(),
  backoff_ms: z.number().int().min(0).optional(),
  /** Per-attempt timeout. */
  timeout_ms: z.number().int().min(1000).optional(),
  /** Used for the LAST attempt when set: swap model and/or bridge. */
  fallback: z.object({ model: z.string().optional(), bridge: z.string().optional() }).optional(),
  /** block = fail the whole run; continue = record structured failure, let dependents decide. */
  on_failure: z.enum(["block", "continue"]).optional(),
  /** For map nodes: fraction (0..1] of items that must succeed for the node to count as completed. */
  quorum: z.number().min(0).max(1).optional(),
  /** Schema-validation repair attempts (the model is shown the validation errors and asked again). */
  repair_attempts: z.number().int().min(0).max(5).optional(),
});
export type FailurePolicy = z.infer<typeof FailurePolicyZ>;

export const BudgetZ = z.object({
  max_cost_usd: z.number().positive().optional(),
  max_wall_ms: z.number().int().positive().optional(),
  /** Global width budget: max concurrently running agent calls. */
  max_width: z.number().int().positive().optional(),
  max_agent_calls: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
});
export type Budget = z.infer<typeof BudgetZ>;

export const FROZEN_CONSTRAINTS = {
  gate_before_side_effect:
    "Every node with side_effect:true must declare requires_gate pointing at a gate node. Publishing is unreachable without approval.",
  spend_cap: "budget.max_cost_usd must be set; the engine hard-stops the run when it is exceeded.",
  no_unbounded_loops: "Every loop and repair cycle must have a hard stop (max_rounds) - enforced structurally.",
  structured_outputs_only: "Every agent/verify node must declare output_schema; free text never crosses an edge.",
  no_status_only_edges: "`after:` ordering-only edges are forbidden - every edge must carry data.",
  verifier_can_kill:
    "Every verify node's verdict must be consumed downstream (survivors/killed) or drive a repair; a verifier nobody listens to is decoration.",
  width_budget: "budget.max_width must be set; fan-out is capped by it.",
  no_side_effect_retry_without_idempotency:
    "side_effect nodes are executed at most once per run (idempotency key = run+node), never re-run on resume.",
} as const;
export type FrozenConstraintId = keyof typeof FROZEN_CONSTRAINTS;
export const DEFAULT_FROZEN: FrozenConstraintId[] = [
  "gate_before_side_effect",
  "spend_cap",
  "no_unbounded_loops",
  "structured_outputs_only",
  "no_side_effect_retry_without_idempotency",
];

const EffortZ = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortZ>;

const AfterZ = z.array(z.object({ node: z.string(), reason: z.string().min(3) }));

const NodeBaseZ = z.object({
  id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_\-]*$/, "node id must be an identifier"),
  description: z.string().optional(),
  /** Explicit input mapping. Values may be `$refs` or templates; resolved before execution. */
  input: z.record(z.string(), z.unknown()).optional(),
  /** Deterministic activation condition (router edge). False => node skipped with reason. */
  when: CondZ.optional(),
  /** Ordering-only dependencies (status, not data). Discouraged; must carry a reason. */
  after: AfterZ.optional(),
  /** Nodes whose skip/failure this node tolerates (their refs resolve to undefined instead of cascading a skip). */
  optional: z.array(z.string()).optional(),
  failure: FailurePolicyZ.optional(),
  /** Gate(s) that must be approved before this node can start. */
  requires_gate: z.union([z.string(), z.array(z.string())]).optional(),
  /** Marks an irreversible action. Frozen rule: needs requires_gate; executed at most once per run. */
  side_effect: z.boolean().optional(),
  /** Fan-out: `$ref` to an array; the node runs once per item with `$item` / `$index` in scope. */
  map: z.string().optional(),
  /** Per-node width cap for map fan-out (also bounded by budget.max_width). */
  max_width: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  /** Estimated duration, used for pre-run critical-path estimates. */
  est_ms: z.number().int().positive().optional(),
});
export type NodeBase = z.infer<typeof NodeBaseZ>;

export const AgentNodeZ = NodeBaseZ.extend({
  kind: z.literal("agent"),
  model: z.string().optional(),
  bridge: z.string().optional(),
  effort: EffortZ.optional(),
  system: z.string().optional(),
  prompt: z.string().min(1),
  output_schema: JsonSchemaZ,
  /** Claude Code bridge only: tools the worker may use (default none => pure reasoning). */
  tools: z.array(z.string()).optional(),
  max_turns: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});
export type AgentNode = z.infer<typeof AgentNodeZ>;

export const CodeNodeZ = NodeBaseZ.extend({
  kind: z.literal("code"),
  /** Built-in reducer name (see src/reducers/builtin.ts). */
  fn: z.string().optional(),
  /** Path to a JS module exporting `default async (input, ctx) => output` (relative to the spec file). */
  module: z.string().optional(),
  /** Static args merged into the reducer call. */
  args: z.record(z.string(), z.unknown()).optional(),
  output_schema: JsonSchemaZ.optional(),
});
export type CodeNode = z.infer<typeof CodeNodeZ>;

export const VerifyNodeZ = NodeBaseZ.extend({
  kind: z.literal("verify"),
  /** `$ref` to the item array (or single value) to attack. */
  target: z.string(),
  mode: z.enum(["agent", "code"]).optional(),
  model: z.string().optional(),
  bridge: z.string().optional(),
  effort: EffortZ.optional(),
  system: z.string().optional(),
  /** Adversarial prompt: "find the reason this should be rejected". `{{ $item }}` is the candidate. */
  prompt: z.string().optional(),
  fn: z.string().optional(),
  module: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  /** Kill if verdict is kill AND confidence >= this (default 0.5). */
  kill_threshold: z.number().min(0).max(1).optional(),
  /** Minimum survivors, else the node fails (default 0). */
  min_survivors: z.number().int().min(0).optional(),
  /** Controlled cycle: send killed items' reasons back to the producer node, bounded. */
  repair: z.object({ node: z.string(), max_rounds: z.number().int().min(1).max(10) }).optional(),
});
export type VerifyNode = z.infer<typeof VerifyNodeZ>;

export const GateNodeZ = NodeBaseZ.extend({
  kind: z.literal("gate"),
  title: z.string(),
  prompt: z.string().optional(),
  /** `$ref`/mapping of what the human sees when deciding. */
  show: z.unknown().optional(),
  timeout_ms: z.number().int().positive().optional(),
  on_timeout: z.enum(["reject", "wait"]).optional(),
  /** What happens on reject: fail the run (default) or route to a repair node id. */
  on_reject: z.object({ route: z.string().optional(), fail_run: z.boolean().optional() }).optional(),
  /** Escalation-ladder convenience: auto-approve when this condition holds (recorded as auto). */
  auto_approve_when: CondZ.optional(),
});
export type GateNode = z.infer<typeof GateNodeZ>;

export const RouterNodeZ = NodeBaseZ.extend({
  kind: z.literal("router"),
  routes: z.array(z.object({ when: CondZ, route: z.string(), reason: z.string().optional() })).min(1),
  default: z.string(),
});
export type RouterNode = z.infer<typeof RouterNodeZ>;

export const LoopUntilZ = z.object({
  max_rounds: z.number().int().min(1).max(100),
  no_new_for_rounds: z.number().int().min(1).optional(),
  max_cost_usd: z.number().positive().optional(),
  max_wall_ms: z.number().int().positive().optional(),
  converged: CondZ.optional(),
});
export type LoopUntil = z.infer<typeof LoopUntilZ>;

export interface GraphDefaults {
  bridge?: string;
  model?: string;
  effort?: Effort;
  failure?: FailurePolicy;
}

export interface GraphSpec {
  name: string;
  version?: number | string;
  description?: string;
  goal?: string;
  input_schema?: Record<string, unknown>;
  output?: { from: string } | Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  budget?: Budget;
  frozen?: FrozenConstraintId[];
  defaults?: GraphDefaults;
  nodes: NodeSpec[];
}

export interface LoopNode extends NodeBase {
  kind: "loop";
  /** Inline body graph. Receives `$input` = { ...input, round, seen, collected, prev }. */
  body: GraphSpec;
  until: LoopUntil;
  /** `$ref` (rooted at the body's output, e.g. `$output.items`) yielding the items discovered this round. */
  collect: string;
  /** Path within each collected item used for de-duplication across ALL rounds (default: JSON of item). */
  seen_key?: string;
  on_nonconvergence?: "accept" | "fail";
}

export interface SubgraphNode extends NodeBase {
  kind: "subgraph";
  graph: string | GraphSpec;
}

export type NodeSpec = AgentNode | CodeNode | VerifyNode | GateNode | RouterNode | LoopNode | SubgraphNode;
export type NodeKind = NodeSpec["kind"];

export const LoopNodeZ: z.ZodType<LoopNode> = z.lazy(() =>
  NodeBaseZ.extend({
    kind: z.literal("loop"),
    body: GraphSpecZ,
    until: LoopUntilZ,
    collect: z.string(),
    seen_key: z.string().optional(),
    on_nonconvergence: z.enum(["accept", "fail"]).optional(),
  }),
) as unknown as z.ZodType<LoopNode>;

export const SubgraphNodeZ: z.ZodType<SubgraphNode> = z.lazy(() =>
  NodeBaseZ.extend({
    kind: z.literal("subgraph"),
    graph: z.union([z.string(), GraphSpecZ]),
  }),
) as unknown as z.ZodType<SubgraphNode>;

export const NodeSpecZ: z.ZodType<NodeSpec> = z.lazy(() =>
  z.union([AgentNodeZ, CodeNodeZ, VerifyNodeZ, GateNodeZ, RouterNodeZ, LoopNodeZ, SubgraphNodeZ]),
) as unknown as z.ZodType<NodeSpec>;

export const GraphSpecZ: z.ZodType<GraphSpec> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    version: z.union([z.number(), z.string()]).optional(),
    description: z.string().optional(),
    goal: z.string().optional(),
    input_schema: JsonSchemaZ.optional(),
    output: z.union([z.object({ from: z.string() }), z.record(z.string(), z.unknown())]).optional(),
    output_schema: JsonSchemaZ.optional(),
    budget: BudgetZ.optional(),
    frozen: z.array(z.enum(Object.keys(FROZEN_CONSTRAINTS) as [FrozenConstraintId, ...FrozenConstraintId[]])).optional(),
    defaults: z
      .object({
        bridge: z.string().optional(),
        model: z.string().optional(),
        effort: EffortZ.optional(),
        failure: FailurePolicyZ.optional(),
      })
      .optional(),
    nodes: z.array(NodeSpecZ).min(1),
  }),
) as unknown as z.ZodType<GraphSpec>;

/** Fixed contract for adversarial verifiers. The verifier has authority to kill. */
export const VERIFY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "kill"] },
    reasons: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["verdict", "reasons", "confidence"],
  additionalProperties: false,
} as const;

export interface EffectiveFailure {
  retries: number;
  backoff_ms: number;
  timeout_ms: number;
  on_failure: "block" | "continue";
  quorum: number;
  repair_attempts: number;
  fallback?: { model?: string; bridge?: string };
}

export const DEFAULT_FAILURE: EffectiveFailure = {
  retries: 1,
  backoff_ms: 1500,
  timeout_ms: 300_000,
  on_failure: "block",
  quorum: 1,
  repair_attempts: 1,
};

export function effectiveFailure(spec: GraphSpec, node: NodeSpec): EffectiveFailure {
  return { ...DEFAULT_FAILURE, ...(spec.defaults?.failure ?? {}), ...(node.failure ?? {}) } as EffectiveFailure;
}

export function effectiveFrozen(spec: GraphSpec): FrozenConstraintId[] {
  const set = new Set<FrozenConstraintId>([...DEFAULT_FROZEN, ...(spec.frozen ?? [])]);
  return [...set];
}

export function gatesOf(node: NodeSpec): string[] {
  if (!node.requires_gate) return [];
  return Array.isArray(node.requires_gate) ? node.requires_gate : [node.requires_gate];
}
