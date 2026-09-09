/**
 * Static analysis of a graph spec - the "dependency test" as code.
 *
 * Answers, before anything runs:
 *   - what exact data crosses each edge (edges are derived from $nodes refs)
 *   - which edges are status-only (fake dependencies)
 *   - is the graph acyclic (except declared, bounded repair cycles)
 *   - what is the estimated critical path vs the sum of all work
 *   - how wide does the graph get, and does that fit the width budget
 *   - are the frozen constraints satisfied (gate before side effect, spend cap, ...)
 *   - rough cost estimate per model tier
 */
import {
  effectiveFailure,
  effectiveFrozen,
  gatesOf,
  type FrozenConstraintId,
  type GraphSpec,
  type NodeSpec,
} from "./schema.js";
import { collectNodeRefs, collectStatusConds, usesInput, type FoundRef } from "../engine/expr.js";
import { estimateCallCostUsd, modelInfo, resolveModel } from "../models.js";

export type EdgeKind = "data" | "status" | "gate" | "order" | "repair" | "route";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The exact references that cross this edge - the answer to "what data crosses this arrow?" */
  data: string[];
}

export interface Finding {
  level: "error" | "warning" | "info";
  code: string;
  node?: string;
  message: string;
}

export interface NodeAnalysis {
  id: string;
  kind: string;
  model?: string;
  deps: string[];
  dependents: string[];
  level: number;
  est_ms: number;
  est_cost_usd: number;
  fan_out: boolean;
  on_critical_path: boolean;
}

export interface Analysis {
  name: string;
  nodes: Record<string, NodeAnalysis>;
  edges: Edge[];
  order: string[];
  levels: string[][];
  critical_path: { nodes: string[]; est_ms: number };
  sum_of_work_ms: number;
  parallel_speedup: number;
  max_width: number;
  est_cost_usd: { min: number; max: number };
  frozen: FrozenConstraintId[];
  findings: Finding[];
  checklist: Array<{ item: string; ok: boolean | null; note?: string }>;
  ok: boolean;
}

const KIND_EST_MS: Record<string, number> = { code: 200, router: 5, gate: 0, loop: 60000, subgraph: 30000 };

function nodeModel(spec: GraphSpec, n: NodeSpec): string | undefined {
  if (n.kind === "agent" || n.kind === "verify") return resolveModel(n.model ?? spec.defaults?.model);
  return undefined;
}

function nodeEstMs(spec: GraphSpec, n: NodeSpec): number {
  if (n.est_ms) return n.est_ms;
  if (n.kind === "agent" || (n.kind === "verify" && (n.mode ?? "agent") === "agent")) {
    return modelInfo(nodeModel(spec, n)!).estLatencyMs;
  }
  if (n.kind === "verify") return 200;
  if (n.kind === "subgraph") return analyze(n.graph as GraphSpec).critical_path.est_ms;
  if (n.kind === "loop") return analyze(n.body).critical_path.est_ms * Math.min(n.until.max_rounds, 3);
  return KIND_EST_MS[n.kind] ?? 1000;
}

/** Fields of a node that may carry references (and thus create data edges). */
function refCarryingFields(n: NodeSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { input: n.input, when: n.when, map: n.map };
  switch (n.kind) {
    case "agent":
      return { ...base, prompt: n.prompt, system: n.system };
    case "verify":
      return { ...base, target: n.target, prompt: n.prompt, system: n.system, args: n.args };
    case "code":
      return { ...base, args: n.args };
    case "gate":
      return { ...base, show: n.show, prompt: n.prompt, auto_approve_when: n.auto_approve_when };
    case "router":
      return { ...base, routes: n.routes };
    case "loop":
      return { ...base };
    case "subgraph":
      return { ...base };
  }
}

export function analyze(spec: GraphSpec): Analysis {
  const findings: Finding[] = [];
  const ids = spec.nodes.map((n) => n.id);
  const byId = new Map<string, NodeSpec>();
  for (const n of spec.nodes) {
    if (byId.has(n.id)) findings.push({ level: "error", code: "duplicate_id", node: n.id, message: `duplicate node id "${n.id}"` });
    byId.set(n.id, n);
  }
  const frozen = effectiveFrozen(spec);

  // ---- derive edges from references ----
  const edges: Edge[] = [];
  const deps = new Map<string, Set<string>>();
  const addDep = (to: string, from: string) => {
    if (!deps.has(to)) deps.set(to, new Set());
    deps.get(to)!.add(from);
  };

  for (const n of spec.nodes) {
    const fields = refCarryingFields(n);
    const refs: FoundRef[] = [...collectNodeRefs(fields), ...collectStatusConds({ when: fields.when, routes: (fields as { routes?: unknown }).routes, auto_approve_when: (fields as { auto_approve_when?: unknown }).auto_approve_when })];
    const byFrom = new Map<string, FoundRef[]>();
    for (const r of refs) {
      if (r.node === n.id) {
        findings.push({ level: "error", code: "self_reference", node: n.id, message: `node "${n.id}" references itself` });
        continue;
      }
      if (!byId.has(r.node)) {
        findings.push({ level: "error", code: "unknown_ref", node: n.id, message: `node "${n.id}" references unknown node "${r.node}"` });
        continue;
      }
      if (!byFrom.has(r.node)) byFrom.set(r.node, []);
      byFrom.get(r.node)!.push(r);
    }
    for (const [from, rs] of byFrom) {
      const data = [...new Set(rs.map((r) => `$nodes.${from}${r.path}`))];
      const statusOnly = rs.every((r) => r.path === ".status" || r.path === "");
      const routeOnly = rs.every((r) => r.path === ".route");
      const kind: EdgeKind = statusOnly ? "status" : routeOnly ? "route" : "data";
      edges.push({ from, to: n.id, kind, data });
      addDep(n.id, from);
      if (statusOnly) {
        findings.push({
          level: "warning",
          code: "status_only_edge",
          node: n.id,
          message: `edge ${from} -> ${n.id} carries only status (${data.join(", ")}). That is waiting, not dependency. Pass real data or drop the edge.`,
        });
      }
    }
    for (const a of n.after ?? []) {
      if (!byId.has(a.node)) {
        findings.push({ level: "error", code: "unknown_ref", node: n.id, message: `after: unknown node "${a.node}"` });
        continue;
      }
      edges.push({ from: a.node, to: n.id, kind: "order", data: [`(ordering only: ${a.reason})`] });
      addDep(n.id, a.node);
      findings.push({
        level: frozen.includes("no_status_only_edges") ? "error" : "warning",
        code: "ordering_only_edge",
        node: n.id,
        message: `edge ${a.node} -> ${n.id} is ordering-only ("${a.reason}"). No data crosses it.`,
      });
    }
    for (const g of gatesOf(n)) {
      const gate = byId.get(g);
      if (!gate) findings.push({ level: "error", code: "unknown_gate", node: n.id, message: `requires_gate: unknown node "${g}"` });
      else if (gate.kind !== "gate") findings.push({ level: "error", code: "not_a_gate", node: n.id, message: `requires_gate "${g}" is a ${gate.kind}, not a gate` });
      else {
        edges.push({ from: g, to: n.id, kind: "gate", data: ["human approval"] });
        addDep(n.id, g);
      }
    }
    if (n.kind === "gate" && n.on_reject?.route) {
      if (!byId.has(n.on_reject.route)) findings.push({ level: "error", code: "unknown_ref", node: n.id, message: `on_reject.route: unknown node "${n.on_reject.route}"` });
    }
    if (n.kind === "verify" && n.repair) {
      const target = byId.get(n.repair.node);
      if (!target) findings.push({ level: "error", code: "unknown_ref", node: n.id, message: `repair.node: unknown node "${n.repair.node}"` });
      else edges.push({ from: n.id, to: n.repair.node, kind: "repair", data: [`killed reasons (max ${n.repair.max_rounds} rounds)`] });
    }
  }

  // ---- cycle check (ignoring repair back-edges, which are bounded by construction) ----
  const order: string[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  let cyclic = false;
  const visit = (id: string, stack: string[]) => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      cyclic = true;
      findings.push({ level: "error", code: "cycle", node: id, message: `dependency cycle: ${[...stack, id].join(" -> ")}. Use a loop node or a verify repair edge for bounded cycles.` });
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d, [...stack, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const id of ids) visit(id, []);

  // ---- levels & critical path (longest path by estimated duration) ----
  const nodes: Record<string, NodeAnalysis> = {};
  const est = new Map<string, number>();
  const cost = new Map<string, number>();
  for (const n of spec.nodes) {
    est.set(n.id, nodeEstMs(spec, n));
    let c = 0;
    if (n.kind === "agent" || (n.kind === "verify" && (n.mode ?? "agent") === "agent")) {
      const promptChars = (n.prompt?.length ?? 0) + (n.system?.length ?? 0) + JSON.stringify(n.input ?? {}).length + 800;
      c = estimateCallCostUsd(nodeModel(spec, n)!, promptChars);
    }
    cost.set(n.id, c);
  }
  const level = new Map<string, number>();
  const longest = new Map<string, { ms: number; via?: string }>();
  for (const id of cyclic ? ids : order) {
    const ds = [...(deps.get(id) ?? [])];
    const lv = ds.length ? Math.max(...ds.map((d) => level.get(d) ?? 0)) + 1 : 0;
    level.set(id, lv);
    let best: { ms: number; via?: string } = { ms: 0 };
    for (const d of ds) {
      const l = longest.get(d)?.ms ?? 0;
      if (l > best.ms) best = { ms: l, via: d };
    }
    longest.set(id, { ms: best.ms + (est.get(id) ?? 0), via: best.via });
  }
  let endId = "";
  let endMs = -1;
  for (const [id, l] of longest) if (l.ms > endMs) [endId, endMs] = [id, l.ms];
  const cp: string[] = [];
  for (let cur: string | undefined = endId; cur; cur = longest.get(cur)?.via) cp.unshift(cur);
  // Sum of work counts fan-out nodes as (expected items x per-item latency); the critical path counts them once.
  let sumOfWork = 0;
  for (const n of spec.nodes) {
    const expected = n.map ? Math.max(2, Math.min(n.max_width ?? 3, spec.budget?.max_width ?? 3)) : 1;
    sumOfWork += (est.get(n.id) ?? 0) * expected;
  }

  const levels: string[][] = [];
  for (const [id, lv] of level) (levels[lv] ??= []).push(id);
  const maxWidth = Math.max(1, ...levels.map((l) => l.length), ...spec.nodes.map((n) => (n.map ? (n.max_width ?? spec.budget?.max_width ?? 1) : 1)));

  const dependents = new Map<string, string[]>();
  for (const e of edges) {
    if (!dependents.has(e.from)) dependents.set(e.from, []);
    dependents.get(e.from)!.push(e.to);
  }

  let costMin = 0;
  let costMax = 0;
  for (const n of spec.nodes) {
    const c = cost.get(n.id) ?? 0;
    const width = n.map ? Math.max(1, n.max_width ?? spec.budget?.max_width ?? 5) : 1;
    const f = effectiveFailure(spec, n);
    costMin += c * (n.map ? 2 : 1);
    costMax += c * width * (1 + f.retries);
    nodes[n.id] = {
      id: n.id,
      kind: n.kind,
      model: nodeModel(spec, n),
      deps: [...(deps.get(n.id) ?? [])],
      dependents: [...new Set(dependents.get(n.id) ?? [])],
      level: level.get(n.id) ?? 0,
      est_ms: est.get(n.id) ?? 0,
      est_cost_usd: c,
      fan_out: Boolean(n.map),
      on_critical_path: cp.includes(n.id),
    };
  }

  // ---- frozen constraints & design lint ----
  for (const n of spec.nodes) {
    const f = effectiveFailure(spec, n);
    if (n.side_effect && gatesOf(n).length === 0) {
      findings.push({
        level: frozen.includes("gate_before_side_effect") ? "error" : "warning",
        code: "side_effect_without_gate",
        node: n.id,
        message: `node "${n.id}" has side_effect:true but no requires_gate. The unsafe transition must be impossible, not merely discouraged.`,
      });
    }
    if ((n.kind === "agent" || n.kind === "verify") && n.kind === "agent" && (!n.output_schema || Object.keys(n.output_schema).length === 0)) {
      findings.push({ level: "error", code: "no_output_schema", node: n.id, message: `agent node "${n.id}" must declare output_schema` });
    }
    if (n.kind === "agent" && !usesInput(refCarryingFields(n)) && collectNodeRefs(refCarryingFields(n)).length === 0) {
      findings.push({ level: "warning", code: "no_inputs", node: n.id, message: `agent node "${n.id}" consumes no input and no node output. What data enters it?` });
    }
    if (n.map) {
      if (n.failure?.quorum === undefined) {
        findings.push({ level: "warning", code: "no_quorum", node: n.id, message: `fan-out node "${n.id}" has no failure.quorum; default 1.0 means one failed worker fails the join. Set quorum to degrade visibly.` });
      }
      const w = n.max_width ?? spec.budget?.max_width;
      if (!w) findings.push({ level: "warning", code: "unbounded_width", node: n.id, message: `fan-out node "${n.id}" has no max_width and the graph has no budget.max_width.` });
      else if (w > 10) findings.push({ level: "info", code: "wide_fanout", node: n.id, message: `fan-out node "${n.id}" allows width ${w}. Add width only when coverage grows faster than reconciliation cost.` });
    }
    if (n.kind === "agent") {
      const model = nodeModel(spec, n)!;
      const tier = modelInfo(model).tier;
      const rawFanoutInputs = collectNodeRefs(refCarryingFields(n)).filter((r) => /^\.outputs\b|^\.items\b/.test(r.path));
      for (const r of rawFanoutInputs) {
        const src = byId.get(r.node);
        if (src && (tier === "large" || tier === "frontier")) {
          findings.push({
            level: "warning",
            code: "compress_before_reason",
            node: n.id,
            message: `${tier} model "${n.id}" reads raw fan-out output ${`$nodes.${r.node}${r.path}`} directly. Put a deterministic reducer (dedupe/normalize/rank) in front of the expensive reasoning node.`,
          });
        }
      }
    }
    if (n.kind === "verify") {
      const consumers = edges.filter((e) => e.from === n.id && e.kind !== "repair");
      const listened = consumers.some((e) => e.data.some((d) => /\.(survivors|killed|kill_rate|output)\b/.test(d)));
      if (!listened && !n.repair) {
        findings.push({
          level: frozen.includes("verifier_can_kill") ? "error" : "warning",
          code: "verifier_is_decoration",
          node: n.id,
          message: `verify node "${n.id}" is not consumed downstream (nobody reads its survivors/killed) and has no repair edge. A verifier without authority is decoration.`,
        });
      }
      if (n.repair) {
        const tgt = byId.get(n.repair.node);
        if (tgt && !(tgt.kind === "agent" || tgt.kind === "code" || tgt.kind === "subgraph")) {
          findings.push({ level: "error", code: "bad_repair_target", node: n.id, message: `repair.node "${n.repair.node}" must be an agent/code/subgraph node` });
        }
        const targetRefs = collectNodeRefs(n.target);
        if (tgt && !targetRefs.some((r) => r.node === tgt.id)) {
          findings.push({ level: "warning", code: "repair_target_mismatch", node: n.id, message: `verify "${n.id}" repairs "${n.repair.node}" but its target does not read that node's output.` });
        }
      }
    }
    if (n.kind === "loop") {
      if (!n.until.no_new_for_rounds && !n.until.converged) {
        findings.push({ level: "warning", code: "loop_no_convergence", node: n.id, message: `loop "${n.id}" stops only at max_rounds=${n.until.max_rounds}. Add no_new_for_rounds or a converged condition.` });
      }
      if (!n.until.max_cost_usd && !spec.budget?.max_cost_usd) {
        findings.push({ level: "warning", code: "loop_no_budget", node: n.id, message: `loop "${n.id}" has no cost budget (until.max_cost_usd or graph budget).` });
      }
      const sub = analyze(n.body);
      for (const f2 of sub.findings) findings.push({ ...f2, node: `${n.id}/${f2.node ?? ""}`, message: `[loop body] ${f2.message}` });
    }
    if (n.kind === "subgraph") {
      const sub = analyze(n.graph as GraphSpec);
      for (const f2 of sub.findings) findings.push({ ...f2, node: `${n.id}/${f2.node ?? ""}`, message: `[subgraph] ${f2.message}` });
    }
    if (n.kind === "gate") {
      const guarded = spec.nodes.filter((m) => gatesOf(m).includes(n.id));
      const consumed = edges.some((e) => e.from === n.id && e.kind === "data");
      if (guarded.length === 0 && !consumed) findings.push({ level: "warning", code: "gate_guards_nothing", node: n.id, message: `gate "${n.id}" guards no node (nothing declares requires_gate: ${n.id}) and nobody reads its decision.` });
    }
    if (n.kind === "router") {
      const routeNames = new Set([...n.routes.map((r) => r.route), n.default]);
      const consumers = spec.nodes.filter((m) => collectNodeRefs(m.when).some((r) => r.node === n.id));
      if (consumers.length === 0) findings.push({ level: "warning", code: "router_unused", node: n.id, message: `router "${n.id}" selects a route but no node's when: reads $nodes.${n.id}.route` });
      void routeNames;
    }
    if (f.on_failure === "block" && n.map) {
      findings.push({ level: "info", code: "map_blocks", node: n.id, message: `fan-out node "${n.id}" blocks the run if quorum is not met (on_failure: block).` });
    }
  }
  if (frozen.includes("spend_cap") && !spec.budget?.max_cost_usd) {
    findings.push({ level: "error", code: "no_spend_cap", message: "frozen constraint spend_cap: budget.max_cost_usd is required" });
  }
  if (frozen.includes("width_budget") && !spec.budget?.max_width) {
    findings.push({ level: "error", code: "no_width_budget", message: "frozen constraint width_budget: budget.max_width is required" });
  }
  if (spec.output && "from" in spec.output && typeof spec.output.from === "string" && !byId.has(spec.output.from)) {
    findings.push({ level: "error", code: "unknown_output", message: `output.from references unknown node "${spec.output.from}"` });
  }
  const agentNodes = spec.nodes.filter((n) => n.kind === "agent");
  if (agentNodes.length >= 2 && maxWidth === 1 && !spec.nodes.some((n) => n.map)) {
    findings.push({ level: "info", code: "pure_chain", message: "every node waits for the previous one (no parallel branches, no fan-out). If every step truly needs the previous output this is fine; otherwise cut fake edges - or use a single agent." });
  }
  if (spec.budget?.max_width && maxWidth > spec.budget.max_width) {
    findings.push({ level: "info", code: "width_exceeds_budget", message: `graph can have ${maxWidth} nodes ready at once but budget.max_width=${spec.budget.max_width}; the engine will queue the rest.` });
  }

  const hasGate = spec.nodes.some((n) => n.kind === "gate");
  const hasSideEffect = spec.nodes.some((n) => n.side_effect);
  const hasVerify = spec.nodes.some((n) => n.kind === "verify");
  const hasLoop = spec.nodes.some((n) => n.kind === "loop" || (n.kind === "verify" && n.repair));
  const checklist: Analysis["checklist"] = [
    { item: "Every edge carries real data or authority", ok: !findings.some((f) => f.code === "status_only_edge" || f.code === "ordering_only_edge") },
    { item: "Every node has one bounded job with structured output", ok: !findings.some((f) => f.code === "no_output_schema") },
    { item: "Independent nodes can run in parallel", ok: maxWidth > 1 || spec.nodes.some((n) => n.map) ? true : agentNodes.length < 2 ? null : false },
    { item: "Joins are placed only where the full set is required", ok: null, note: "review manually" },
    { item: "Important results are verified before moving downstream", ok: hasVerify ? true : null, note: hasVerify ? undefined : "no verify node" },
    { item: "Failures can be retried without duplicating side effects", ok: !hasSideEffect || spec.nodes.filter((n) => n.side_effect).every((n) => gatesOf(n).length > 0) },
    { item: "The graph can resume from a checkpoint", ok: true, note: "engine checkpoints after every node" },
    { item: "Every cycle has a hard stop and budget", ok: hasLoop ? !findings.some((f) => f.code === "loop_no_budget") : null },
    { item: "A human can interrupt high-risk paths", ok: hasSideEffect ? hasGate : null },
    { item: "Every route selection is explainable", ok: true, note: "router decisions are logged with the state that produced them" },
    { item: "Spend cap set", ok: Boolean(spec.budget?.max_cost_usd) },
    { item: "Width budget set", ok: Boolean(spec.budget?.max_width) },
  ];

  const ok = !findings.some((f) => f.level === "error");
  return {
    name: spec.name,
    nodes,
    edges,
    order: cyclic ? ids : order,
    levels,
    critical_path: { nodes: cp, est_ms: Math.max(0, endMs) },
    sum_of_work_ms: sumOfWork,
    parallel_speedup: endMs > 0 ? Number((sumOfWork / endMs).toFixed(2)) : 1,
    max_width: maxWidth,
    est_cost_usd: { min: Number(costMin.toFixed(4)), max: Number(costMax.toFixed(4)) },
    frozen,
    findings,
    checklist,
    ok,
  };
}

/** Human-readable analysis report. */
export function formatAnalysis(a: Analysis): string {
  const lines: string[] = [];
  lines.push(`Graph: ${a.name}  (${Object.keys(a.nodes).length} nodes, ${a.edges.length} edges)  ${a.ok ? "OK" : "ERRORS"}`);
  lines.push(`Critical path (est): ${(a.critical_path.est_ms / 1000).toFixed(1)}s  vs sum of work ${(a.sum_of_work_ms / 1000).toFixed(1)}s  => ${a.parallel_speedup}x`);
  lines.push(`  ${a.critical_path.nodes.join(" -> ")}`);
  lines.push(`Max width: ${a.max_width}   Est. cost: $${a.est_cost_usd.min} - $${a.est_cost_usd.max}`);
  lines.push(`Frozen: ${a.frozen.join(", ")}`);
  lines.push("");
  lines.push("Levels:");
  a.levels.forEach((l, i) => lines.push(`  ${i}: ${l.join(", ")}`));
  lines.push("");
  lines.push("Edges (what crosses):");
  for (const e of a.edges) lines.push(`  ${e.from} -> ${e.to}  [${e.kind}]  ${e.data.join(", ")}`);
  if (a.findings.length) {
    lines.push("");
    lines.push("Findings:");
    for (const f of a.findings) lines.push(`  ${f.level.toUpperCase().padEnd(7)} ${f.code}${f.node ? ` (${f.node})` : ""}: ${f.message}`);
  }
  lines.push("");
  lines.push("Checklist:");
  for (const c of a.checklist) lines.push(`  [${c.ok === true ? "x" : c.ok === false ? "!" : "?"}] ${c.item}${c.note ? ` - ${c.note}` : ""}`);
  return lines.join("\n");
}
