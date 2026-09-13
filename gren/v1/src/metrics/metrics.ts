/**
 * Graph-shaped metrics. "Observe the graph, not the chat."
 *
 *   critical-path latency     longest dependency chain by ACTUAL durations
 *   node failure rate         failed attempts / attempts, per node and overall
 *   retry rate                retries / agent calls
 *   verifier kill rate        killed / candidates (0% => useless? 80% => workers poorly scoped?)
 *   fan-out efficiency        unique useful records per parallel worker
 *   compression ratio         records entering reducers vs leaving them
 *   human intervention rate   gates + manual completions per run
 *   width                     peak / average concurrent agent calls vs the width budget
 */
import { analyze } from "../spec/analyze.js";
import type { GrenEvent, NodeRecord, RunState, RunStore } from "../engine/state.js";

export interface NodeMetric {
  id: string;
  kind: string;
  status: string;
  duration_ms: number;
  attempts: number;
  failed_attempts: number;
  retries: number;
  repairs: number;
  cost_usd: number;
  agent_calls: number;
  model?: string;
  items?: { total: number; completed: number; failed: number };
  kill_rate?: number;
  compression?: { in: number; out: number; ratio: number };
  on_critical_path: boolean;
}

export interface RunMetrics {
  run_id: string;
  graph: string;
  status: string;
  wall_ms: number;
  human_wait_ms: number;
  active_ms: number;
  nested_runs: number;
  cost_usd: number;
  agent_calls: number;
  tokens: { input: number; output: number; cache_read: number };
  critical_path: { nodes: string[]; ms: number };
  sum_of_node_ms: number;
  parallel_speedup: number;
  width: { peak: number; budget: number | null; agent_seconds: number };
  node_failure_rate: number;
  retry_rate: number;
  verifier: { candidates: number; killed: number; kill_rate: number; per_node: Array<{ id: string; candidates: number; killed: number; kill_rate: number; repair_rounds: number }> };
  fan_out: { nodes: number; workers: number; failed_workers: number; degraded: Array<{ id: string; completed: number; total: number }>; unique_per_worker: number | null };
  compression: { records_in: number; records_out: number; ratio: number; per_node: Array<{ id: string; in: number; out: number }> };
  human: { gates: number; approved: number; rejected: number; auto: number; manual_tasks: number; orchestrator_tasks: number; cost_unknown_calls: number; intervention_rate: number };
  cost_by_model: Record<string, number>;
  nodes: NodeMetric[];
  hints: string[];
  decisions: number;
}

function ms(a?: string, b?: string): number {
  if (!a || !b) return 0;
  return Math.max(0, new Date(b).getTime() - new Date(a).getTime());
}

/** Metrics for a run including everything that happened inside its nested runs (loop rounds, mapped subgraphs). */
export function computeMetricsDeep(store: RunStore, runId: string): RunMetrics {
  const state = store.load(runId);
  const nestedIds = store.nestedRunIds(runId);
  const children = nestedIds.map((id) => {
    try {
      return store.load(id);
    } catch {
      return undefined;
    }
  }).filter((s): s is RunState => Boolean(s));
  return computeMetrics(state, store.readEventsDeep(runId), children);
}

export function computeMetrics(state: RunState, events: GrenEvent[] = [], nested: RunState[] = []): RunMetrics {
  const spec = state.run.spec;
  const a = analyze(spec);
  const nodes = Object.values(state.nodes);
  // human wait: time between run.paused and the following run.resumed
  let humanWait = 0;
  let pausedAt: number | undefined;
  for (const e of events) {
    if (e.run_id !== state.run.id) continue;
    if (e.type === "run.paused") pausedAt = new Date(e.ts).getTime();
    else if (e.type === "run.resumed" && pausedAt !== undefined) {
      humanWait += new Date(e.ts).getTime() - pausedAt;
      pausedAt = undefined;
    }
  }
  if (pausedAt !== undefined && state.run.status === "paused") humanWait += Date.now() - pausedAt;

  // ---- actual critical path (longest path over deps using actual durations, skipped nodes = 0) ----
  const dur = new Map<string, number>();
  const work = new Map<string, number>();
  for (const n of nodes) {
    const d = n.duration_ms ?? ms(n.started_at, n.ended_at);
    dur.set(n.id, d);
    // "work" counts every fan-out item; "duration" is the wall time of the node.
    work.set(n.id, n.items?.length ? n.items.reduce((s, i) => s + (i.duration_ms ?? 0), 0) || d : d);
  }
  const longest = new Map<string, { ms: number; via?: string }>();
  for (const id of a.order) {
    const deps = a.nodes[id]?.deps ?? [];
    let best: { ms: number; via?: string } = { ms: 0 };
    for (const d of deps) {
      const l = longest.get(d)?.ms ?? 0;
      if (l > best.ms) best = { ms: l, via: d };
    }
    longest.set(id, { ms: best.ms + (dur.get(id) ?? 0), via: best.via });
  }
  let endId = "";
  let endMs = -1;
  for (const [id, l] of longest) if (l.ms > endMs) [endId, endMs] = [id, l.ms];
  const cp: string[] = [];
  for (let cur: string | undefined = endId; cur; cur = longest.get(cur)?.via) cp.unshift(cur);
  const sumNode = [...work.values()].reduce((x, y) => x + y, 0);

  // ---- width from events (agent call start/end) ----
  const points: Array<{ t: number; d: number }> = [];
  let agentSeconds = 0;
  const starts = new Map<string, number>();
  for (const e of events) {
    const key = `${e.node}:${e.item ?? -1}:${(e.data?.attempt as number) ?? 0}`;
    if (e.type === "call.started") {
      starts.set(key, new Date(e.ts).getTime());
      points.push({ t: new Date(e.ts).getTime(), d: 1 });
    } else if (e.type === "call.finished") {
      const t = new Date(e.ts).getTime();
      points.push({ t, d: -1 });
      const s = starts.get(key);
      if (s !== undefined) agentSeconds += (t - s) / 1000;
    }
  }
  points.sort((x, y) => x.t - y.t || x.d - y.d);
  let cur = 0;
  let peak = 0;
  for (const p of points) {
    cur += p.d;
    peak = Math.max(peak, cur);
  }

  // ---- per node ----
  let attempts = 0;
  let failedAttempts = 0;
  let retries = 0;
  let agentCalls = 0;
  const costByModel: Record<string, number> = {};
  const verifiers: RunMetrics["verifier"]["per_node"] = [];
  let candidates = 0;
  let killed = 0;
  const fanNodes: NodeRecord[] = [];
  let workers = 0;
  let failedWorkers = 0;
  const degraded: RunMetrics["fan_out"]["degraded"] = [];
  const compression: RunMetrics["compression"]["per_node"] = [];
  let recordsIn = 0;
  let recordsOut = 0;
  let uniqueTotal = 0;
  let uniqueWorkers = 0;
  const nodeMetrics: NodeMetric[] = [];
  for (const n of nodes) {
    const fa = n.attempts.filter((t) => t.status !== "ok" && t.status !== "cancelled").length;
    attempts += n.attempts.length;
    failedAttempts += fa;
    retries += n.retries;
    agentCalls += n.agent_calls;
    for (const t of n.attempts) if (t.model) costByModel[t.model] = (costByModel[t.model] ?? 0) + (t.cost_usd ?? 0);
    const m: NodeMetric = {
      id: n.id,
      kind: n.kind,
      status: n.status,
      duration_ms: dur.get(n.id) ?? 0,
      attempts: n.attempts.length,
      failed_attempts: fa,
      retries: n.retries,
      repairs: n.repairs,
      cost_usd: n.cost_usd,
      agent_calls: n.agent_calls,
      model: a.nodes[n.id]?.model,
      on_critical_path: cp.includes(n.id),
    };
    if (n.items && n.kind !== "verify") {
      const total = n.items.length;
      const completed = n.items.filter((i) => i.status === "completed").length;
      const failed = n.items.filter((i) => i.status === "failed").length;
      m.items = { total, completed, failed };
      fanNodes.push(n);
      workers += total;
      failedWorkers += failed;
      if (completed < total) degraded.push({ id: n.id, completed, total });
    }
    if (n.verify) {
      m.kill_rate = n.verify.kill_rate;
      candidates += n.verify.total;
      killed += n.verify.killed.length;
      verifiers.push({ id: n.id, candidates: n.verify.total, killed: n.verify.killed.length, kill_rate: n.verify.kill_rate, repair_rounds: n.verify.repair_round });
    }
    const stats = (n.output as { _stats?: { in?: number; out?: number } } | undefined)?._stats;
    if (n.kind === "code" && stats && typeof stats.in === "number" && typeof stats.out === "number") {
      m.compression = { in: stats.in, out: stats.out, ratio: stats.in ? Number((stats.out / stats.in).toFixed(3)) : 1 };
      compression.push({ id: n.id, in: stats.in, out: stats.out });
    }
    const cov = n.output as { unique?: number; workers?: number } | undefined;
    if (n.kind === "code" && cov && typeof cov.unique === "number" && typeof cov.workers === "number" && cov.workers > 0) {
      uniqueTotal += cov.unique;
      uniqueWorkers += cov.workers;
    }
    nodeMetrics.push(m);
  }
  // ---- fold in nested runs (their verifiers, fan-outs, attempts and models are part of THIS graph's behaviour) ----
  for (const child of nested) {
    for (const n of Object.values(child.nodes)) {
      const fa = n.attempts.filter((t) => t.status !== "ok" && t.status !== "cancelled").length;
      attempts += n.attempts.length;
      failedAttempts += fa;
      retries += n.retries;
      agentCalls += n.agent_calls;
      for (const t of n.attempts) if (t.model) costByModel[t.model] = (costByModel[t.model] ?? 0) + (t.cost_usd ?? 0);
      if (n.verify) {
        candidates += n.verify.total;
        killed += n.verify.killed.length;
        verifiers.push({ id: `${child.run.parent?.node_id ?? "nested"}/${n.id}`, candidates: n.verify.total, killed: n.verify.killed.length, kill_rate: n.verify.kill_rate, repair_rounds: n.verify.repair_round });
      }
      if (n.items && n.kind !== "verify") {
        workers += n.items.length;
        failedWorkers += n.items.filter((i) => i.status === "failed").length;
      }
    }
  }

  // Overall compression: peak raw material entering any reducer vs what left the LAST reducer (topological order).
  if (compression.length) {
    const orderIdx = new Map(a.order.map((id, i) => [id, i]));
    const sorted = [...compression].sort((x, y) => (orderIdx.get(x.id) ?? 0) - (orderIdx.get(y.id) ?? 0));
    recordsIn = Math.max(...sorted.map((c) => c.in));
    recordsOut = sorted[sorted.length - 1]!.out;
  }

  // ---- human ----
  const gates = nodes.filter((n) => n.kind === "gate");
  const approved = gates.filter((n) => n.gate?.decision === "approved").length;
  const rejected = gates.filter((n) => n.gate?.decision === "rejected").length;
  const auto = gates.filter((n) => n.gate?.decision === "auto").length;
  const manualTasks = events.filter((e) => e.type === "task.completed" && e.data?.source === "human").length;
  const orchestratorTasks = events.filter((e) => e.type === "task.completed" && e.data?.source !== "human").length;
  const humanGates = gates.filter((n) => n.gate?.decision === "approved" || n.gate?.decision === "rejected").filter((n) => !/^auto/.test(n.gate?.by ?? "")).length;
  const interventions = humanGates + manualTasks;
  const costUnknownCalls = nodes.reduce((s, n) => s + n.attempts.filter((t) => t.status === "ok" && (t.cost_usd ?? 0) === 0 && t.bridge !== "code" && t.bridge !== "subgraph").length, 0);

  const wall = state.run.totals.wall_ms || ms(state.run.started_at, state.run.ended_at ?? state.run.updated_at);
  const active = Math.max(0, wall - humanWait);
  const killRate = candidates ? killed / candidates : 0;
  const hints: string[] = [];
  if (humanWait > 0) hints.push(`${(humanWait / 1000 / 60).toFixed(1)} min of the wall clock was spent waiting for a human at a gate (active time ${(active / 1000).toFixed(0)}s).`);
  if (candidates > 0 && killRate === 0) hints.push("Verifier kill rate is 0%: the verifier may be decoration. Make its objective adversarial or tighten the threshold.");
  if (candidates > 0 && killRate >= 0.8) hints.push(`Verifier kill rate is ${(killRate * 100).toFixed(0)}%: workers may be poorly scoped or the verifier too strict.`);
  if (agentCalls && retries / agentCalls > 0.5) hints.push(`Retry rate ${(retries / Math.max(1, agentCalls) * 100).toFixed(0)}%: a graph that succeeds after many retries is not healthy - check the failing node's prompt/tool.`);
  if (degraded.length) hints.push(`Degraded fan-out: ${degraded.map((d) => `${d.id} ${d.completed}/${d.total}`).join(", ")} - the output is visibly incomplete (never hide missing work).`);
  if (recordsIn > 0 && recordsOut / recordsIn > 0.9) hints.push("Reducers removed <10% of records: synthesis is reading almost raw fan-out output. Consider stronger dedupe/ranking.");
  if (spec.budget?.max_width && peak >= spec.budget.max_width) hints.push(`Peak width hit the budget (${peak}/${spec.budget.max_width}). Raising it only helps if workers add unique coverage.`);
  if (sumNode > 0 && wall > 0 && sumNode / wall < 1.2 && nodes.filter((n) => n.kind === "agent").length > 2) hints.push("Parallel speedup is ~1x: the graph ran as a chain. Re-check which edges carry real data.");
  if (manualTasks + rejected > 0) hints.push(`Humans rescued the system ${manualTasks + rejected} time(s) (manual tasks + rejections): each manual rescue is an architecture target.`);
  if (orchestratorTasks > 0) hints.push(`${orchestratorTasks} task(s) were executed by an orchestrator/subagent worker (inbox bridge).`);
  if (costUnknownCalls > 0) hints.push(`${costUnknownCalls} successful call(s) reported no cost (workers did not pass cost_usd/usage); the cost total is a lower bound.`);

  return {
    run_id: state.run.id,
    graph: state.run.graph,
    status: state.run.status,
    wall_ms: wall,
    human_wait_ms: humanWait,
    active_ms: active,
    nested_runs: nested.length,
    cost_usd: Number(state.run.totals.cost_usd.toFixed(5)),
    agent_calls: agentCalls,
    tokens: {
      input: state.run.totals.usage.input_tokens ?? 0,
      output: state.run.totals.usage.output_tokens ?? 0,
      cache_read: state.run.totals.usage.cache_read_input_tokens ?? 0,
    },
    critical_path: { nodes: cp, ms: Math.max(0, endMs) },
    sum_of_node_ms: sumNode,
    parallel_speedup: endMs > 0 ? Number((sumNode / endMs).toFixed(2)) : 1,
    width: { peak, budget: spec.budget?.max_width ?? null, agent_seconds: Number(agentSeconds.toFixed(1)) },
    node_failure_rate: attempts ? Number((failedAttempts / attempts).toFixed(3)) : 0,
    retry_rate: agentCalls ? Number((retries / agentCalls).toFixed(3)) : 0,
    verifier: { candidates, killed, kill_rate: Number(killRate.toFixed(3)), per_node: verifiers },
    fan_out: { nodes: fanNodes.length, workers, failed_workers: failedWorkers, degraded, unique_per_worker: uniqueWorkers ? Number((uniqueTotal / uniqueWorkers).toFixed(2)) : null },
    compression: { records_in: recordsIn, records_out: recordsOut, ratio: recordsIn ? Number((recordsOut / recordsIn).toFixed(3)) : 1, per_node: compression },
    human: { gates: gates.length, approved, rejected, auto, manual_tasks: manualTasks, orchestrator_tasks: orchestratorTasks, cost_unknown_calls: costUnknownCalls, intervention_rate: nodes.length ? Number((interventions / nodes.length).toFixed(3)) : 0 },
    cost_by_model: costByModel,
    nodes: nodeMetrics,
    hints,
    decisions: state.run.decisions.length,
  };
}

export function formatMetrics(m: RunMetrics): string {
  const L: string[] = [];
  L.push(`Run ${m.run_id} (${m.graph}) - ${m.status}`);
  L.push(`Wall ${(m.wall_ms / 1000).toFixed(1)}s${m.human_wait_ms ? ` (${(m.human_wait_ms / 1000).toFixed(0)}s waiting on humans, ${(m.active_ms / 1000).toFixed(0)}s active)` : ""} | cost $${m.cost_usd} | agent calls ${m.agent_calls}${m.nested_runs ? ` | nested runs ${m.nested_runs}` : ""} | tokens in ${m.tokens.input} out ${m.tokens.output}`);
  L.push(`Critical path ${(m.critical_path.ms / 1000).toFixed(1)}s: ${m.critical_path.nodes.join(" -> ")}`);
  L.push(`Sum of node time ${(m.sum_of_node_ms / 1000).toFixed(1)}s => parallel speedup ${m.parallel_speedup}x | peak width ${m.width.peak}${m.width.budget ? `/${m.width.budget}` : ""}`);
  L.push(`Node failure rate ${(m.node_failure_rate * 100).toFixed(0)}% | retry rate ${(m.retry_rate * 100).toFixed(0)}%`);
  L.push(`Verifier: ${m.verifier.killed}/${m.verifier.candidates} killed (${(m.verifier.kill_rate * 100).toFixed(0)}%)`);
  L.push(`Fan-out: ${m.fan_out.workers} workers over ${m.fan_out.nodes} nodes, ${m.fan_out.failed_workers} failed${m.fan_out.unique_per_worker !== null ? `, ${m.fan_out.unique_per_worker} unique/worker` : ""}`);
  L.push(`Compression: ${m.compression.records_in} -> ${m.compression.records_out} (${(m.compression.ratio * 100).toFixed(0)}% kept)`);
  L.push(`Human: ${m.human.gates} gates (${m.human.approved} approved, ${m.human.rejected} rejected, ${m.human.auto} auto), ${m.human.manual_tasks} manual tasks${m.human.orchestrator_tasks ? `, ${m.human.orchestrator_tasks} orchestrator tasks` : ""}`);
  if (Object.keys(m.cost_by_model).length) L.push(`Cost by model: ${Object.entries(m.cost_by_model).map(([k, v]) => `${k}=$${v.toFixed(4)}`).join(", ")}`);
  L.push("");
  L.push("Nodes:");
  for (const n of m.nodes) {
    L.push(`  ${n.on_critical_path ? "*" : " "} ${n.id.padEnd(22)} ${n.kind.padEnd(8)} ${n.status.padEnd(10)} ${(n.duration_ms / 1000).toFixed(1).padStart(6)}s  $${n.cost_usd.toFixed(4)}  att ${n.attempts}${n.retries ? ` retry ${n.retries}` : ""}${n.items ? ` items ${n.items.completed}/${n.items.total}` : ""}${n.kill_rate !== undefined ? ` kill ${(n.kill_rate * 100).toFixed(0)}%` : ""}${n.compression ? ` ${n.compression.in}->${n.compression.out}` : ""}`);
  }
  if (m.hints.length) {
    L.push("");
    L.push("Hints:");
    for (const h of m.hints) L.push(`  - ${h}`);
  }
  return L.join("\n");
}
