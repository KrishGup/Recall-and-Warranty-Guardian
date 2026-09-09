/**
 * The graph runtime. Executes a validated GraphSpec as a dependency graph:
 *
 *   - nodes start the moment the data they read exists (readiness = all deps terminal)
 *   - fan-out (`map`) runs items in parallel under per-node and global width budgets
 *   - every node has a failure domain: retries, fallback model/bridge, timeout, quorum, block|continue
 *   - verify nodes have kill authority and may drive a bounded repair cycle
 *   - gates make downstream nodes unreachable until a human decision exists
 *   - routers pick branches deterministically and log the state that produced the decision
 *   - loops repeat a body graph until convergence with hard stops and budgets
 *   - the run checkpoints after every node and can be resumed
 *   - budgets (cost / wall / calls / width) are enforced by the engine, not suggested to the model
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyze, type Analysis } from "../spec/analyze.js";
import {
  effectiveFailure,
  effectiveFrozen,
  gatesOf,
  VERIFY_OUTPUT_SCHEMA,
  type AgentNode,
  type CodeNode,
  type Effort,
  type EffectiveFailure,
  type GateNode,
  type GraphSpec,
  type LoopNode,
  type NodeSpec,
  type RouterNode,
  type SubgraphNode,
  type VerifyNode,
} from "../spec/schema.js";
import { collectNodeRefs, evalCond, isRef, renderTemplate, resolveRef, resolveValue, type NodeView, type Scope } from "./expr.js";
import { RunStore, addUsage, nowIso, type ApprovalRecord, type AttemptRecord, type Decision, type GrenEvent, type ItemRecord, type KilledRecord, type NodeRecord, type RunState } from "./state.js";
import { applyDefaults, validateAgainst } from "./validate.js";
import { BridgeRegistry } from "../bridges/registry.js";
import { BridgeError, type AgentRequest, type AgentResponse, type Bridge } from "../bridges/types.js";
import { getReducer, type Reducer } from "../reducers/builtin.js";
import { resolveModel, sumUsage } from "../models.js";

export class RunFailed extends Error {}
export class BudgetExceeded extends RunFailed {}
export class RunCancelled extends RunFailed {}

class Semaphore {
  private cur = 0;
  private q: Array<() => void> = [];
  constructor(private max: number) {}
  async acquire() {
    if (this.cur < this.max) {
      this.cur++;
      return;
    }
    await new Promise<void>((r) => this.q.push(r));
  }
  release() {
    const next = this.q.shift();
    if (next) next();
    else this.cur--;
  }
  get active() {
    return this.cur;
  }
}

export interface RunnerBaseOptions {
  store: RunStore;
  bridges: BridgeRegistry;
  /** Force every agent call through this bridge (CLI --bridge). */
  bridge?: string;
  /** Bridge used when neither the node nor the spec names one. */
  defaultBridge?: string;
  onEvent?: (e: GrenEvent) => void;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** block (default): wait in-process for human gates. return: come back with status "paused". */
  gateWait?: "block" | "return";
  cwd?: string;
}

export interface CreateRunOptions extends RunnerBaseOptions {
  spec: GraphSpec;
  specFile: string;
  input: unknown;
  runId?: string;
  parent?: { run_id: string; node_id: string; round?: number };
  context?: Record<string, unknown>;
  labels?: Record<string, string>;
}

export interface ResumeRunOptions extends RunnerBaseOptions {
  runId: string;
}

export interface ForkRunOptions extends RunnerBaseOptions {
  /** Run to fork from. */
  runId: string;
  /** Nodes to re-run (they and everything downstream are reset; upstream outputs are reused). */
  from: string[];
  newRunId?: string;
  /** Optional replacement spec (e.g. with edited prompts). Kept nodes must exist in it with the same id. */
  spec?: GraphSpec;
  specFile?: string;
  /** Optional replacement input (only safe when the kept nodes did not read the changed fields). */
  input?: unknown;
}

export class GraphRunner {
  readonly state: RunState;
  readonly analysis: Analysis;
  private readonly spec: GraphSpec;
  private running = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private stopReason: string | undefined;
  private width: Semaphore;
  private gateWaiters = new Map<string, (a: ApprovalRecord) => void>();
  private resetAfterRun = new Set<string>();
  private wallStart = 0;
  private children = new Set<GraphRunner>();

  private constructor(
    private readonly opts: RunnerBaseOptions,
    state: RunState,
  ) {
    this.state = state;
    this.spec = state.run.spec;
    this.analysis = analyze(this.spec);
    this.width = new Semaphore(this.spec.budget?.max_width ?? 8);
    opts.signal?.addEventListener("abort", () => this.cancel("aborted by caller"), { once: true });
  }

  // ---------------------------------------------------------------- construction

  static create(o: CreateRunOptions): GraphRunner {
    const a = analyze(o.spec);
    const errors = a.findings.filter((f) => f.level === "error");
    if (errors.length) throw new RunFailed(`graph "${o.spec.name}" failed validation:\n${errors.map((e) => `  - ${e.code}${e.node ? ` (${e.node})` : ""}: ${e.message}`).join("\n")}`);
    let input = o.input;
    if (o.spec.input_schema) {
      input = applyDefaults(o.spec.input_schema, input ?? {});
      const v = validateAgainst(o.spec.input_schema, input);
      if (!v.ok) throw new RunFailed(`input does not match input_schema:\n${v.errors.map((e) => `  - ${e}`).join("\n")}`);
    }
    const bridge = o.bridge ?? o.spec.defaults?.bridge ?? o.defaultBridge ?? "claude-code";
    const state = o.store.create({
      id: o.runId,
      spec: o.spec,
      specFile: o.specFile,
      input,
      bridge,
      budget: o.spec.budget ?? {},
      frozen: effectiveFrozen(o.spec),
      parent: o.parent,
      labels: o.labels,
    });
    state.run.context = o.context;
    o.store.save(state);
    return new GraphRunner(o, state);
  }

  static resume(o: ResumeRunOptions): GraphRunner {
    const state = o.store.load(o.runId);
    const byId = new Map(state.run.spec.nodes.map((n) => [n.id, n]));
    const reset: string[] = [];
    for (const rec of Object.values(state.nodes)) {
      const node = byId.get(rec.id);
      if (rec.status === "running" || rec.status === "waiting_task") {
        if (node?.side_effect && !rec.side_effect_done) {
          rec.status = "failed";
          rec.error = "interrupted while executing a side effect; not re-run automatically (frozen: no_side_effect_retry_without_idempotency). Inspect and resume manually.";
        } else {
          rec.status = "pending";
          rec.error = undefined;
          if (rec.items) for (const it of rec.items) if (it.status !== "completed") it.status = "pending";
          reset.push(rec.id);
        }
      } else if (rec.status === "failed" && node && !(node.side_effect && rec.side_effect_done) && effectiveFailure(state.run.spec, node).on_failure === "block" && !/interrupted while executing a side effect/.test(rec.error ?? "")) {
        // A blocking failure ended the previous attempt; resuming means trying it again (its retries start over).
        rec.status = "pending";
        rec.error = undefined;
        if (rec.items) for (const it of rec.items) if (it.status !== "completed") it.status = "pending";
        reset.push(rec.id);
      } else if (rec.status === "skipped" && /^upstream /.test(rec.skip_reason ?? "")) {
        // cascaded skips are re-evaluated once their upstream re-runs
        rec.status = "pending";
        rec.skip_reason = undefined;
        reset.push(rec.id);
      }
    }
    if (state.run.status !== "completed" || reset.length) state.run.status = "created";
    state.run.error = undefined;
    o.store.save(state);
    const runner = new GraphRunner(o, state);
    runner.emit("run.resumed", {});
    return runner;
  }

  /**
   * Fork a run and re-execute from the given nodes, reusing every upstream output.
   * The developer loop: change a late prompt, `gren fork <run> --from brief`, and only the tail re-runs.
   */
  static fork(o: ForkRunOptions): GraphRunner {
    const state = o.store.fork(o.runId, o.newRunId);
    if (o.spec) {
      const a = analyze(o.spec);
      const errors = a.findings.filter((f) => f.level === "error");
      if (errors.length) throw new RunFailed(`replacement spec failed validation:\n${errors.map((e) => `  - ${e.code}${e.node ? ` (${e.node})` : ""}: ${e.message}`).join("\n")}`);
      state.run.spec = o.spec;
      state.run.spec_file = o.specFile ?? state.run.spec_file;
      state.run.budget = o.spec.budget ?? {};
      state.run.frozen = effectiveFrozen(o.spec);
    }
    if (o.input !== undefined) state.run.input = o.spec?.input_schema ? applyDefaults(o.spec.input_schema, o.input) : o.input;
    const analysis = analyze(state.run.spec);
    const ids = new Set(state.run.spec.nodes.map((n) => n.id));
    for (const id of Object.keys(state.nodes)) if (!ids.has(id)) delete state.nodes[id];
    for (const n of state.run.spec.nodes) {
      if (!state.nodes[n.id]) state.nodes[n.id] = { id: n.id, kind: n.kind, status: "pending", attempts: [], cost_usd: 0, usage: {}, agent_calls: 0, retries: 0, repairs: 0 };
    }
    const reset = new Set<string>();
    const stack = [...o.from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (!ids.has(cur)) throw new RunFailed(`fork: unknown node "${cur}"`);
      if (reset.has(cur)) continue;
      reset.add(cur);
      for (const d of analysis.nodes[cur]?.dependents ?? []) stack.push(d);
    }
    // anything not terminal must also be reset (the source run may have been interrupted)
    for (const rec of Object.values(state.nodes)) if (!["completed", "skipped", "failed"].includes(rec.status)) reset.add(rec.id);
    const runner = new GraphRunner(o, state);
    for (const id of reset) {
      const rec = state.nodes[id]!;
      rec.attempts = [];
      rec.cost_usd = 0;
      rec.usage = {};
      rec.agent_calls = 0;
      rec.retries = 0;
      rec.repairs = 0;
      rec.repair = undefined;
      rec.verify = undefined;
      rec.loop = undefined;
      rec.side_effect_done = undefined;
      runner.resetNode(id, `fork from ${o.runId}`);
    }
    // totals: keep only what the kept nodes spent
    const kept = Object.values(state.nodes).filter((n) => !reset.has(n.id));
    state.run.totals = {
      cost_usd: kept.reduce((s, n) => s + n.cost_usd, 0),
      usage: kept.reduce((s, n) => sumUsage(s, n.usage), {} as ReturnType<typeof sumUsage>),
      agent_calls: kept.reduce((s, n) => s + n.agent_calls, 0),
      retries: kept.reduce((s, n) => s + n.retries, 0),
      wall_ms: 0,
    };
    state.run.decisions = state.run.decisions.filter((d) => !reset.has(d.node));
    state.run.started_at = undefined;
    o.store.save(state);
    runner.emit("run.fork_prepared", { from: o.runId, reset: [...reset], kept: kept.map((n) => n.id) });
    return runner;
  }

  get id() {
    return this.state.run.id;
  }

  // ---------------------------------------------------------------- public controls

  /** Record a human decision for a gate (in-process). External callers can also write the approval file. */
  approve(gate: string, decision: "approved" | "rejected", by = "human", comment?: string): ApprovalRecord {
    const node = this.spec.nodes.find((n) => n.id === gate);
    if (!node || node.kind !== "gate") throw new Error(`"${gate}" is not a gate node`);
    const approval: ApprovalRecord = { gate, decision, by, comment, at: nowIso() };
    this.opts.store.writeApproval(this.id, approval);
    const w = this.gateWaiters.get(gate);
    if (w) w(approval);
    return approval;
  }

  cancel(reason = "cancelled") {
    if (this.abort.signal.aborted) return;
    this.stopReason = reason;
    this.abort.abort();
    for (const c of this.children) c.cancel(reason);
  }

  // ---------------------------------------------------------------- main loop

  async run(): Promise<RunState> {
    const run = this.state.run;
    if (run.status === "completed") return this.state;
    run.status = "running";
    run.started_at ??= nowIso();
    this.wallStart = Date.now() - (run.totals.wall_ms ?? 0);
    this.save();
    this.emit("run.started", { graph: run.graph, bridge: run.bridge, nodes: Object.keys(this.state.nodes).length, critical_path_est_ms: this.analysis.critical_path.est_ms });
    try {
      while (true) {
        if (this.abort.signal.aborted) throw new RunCancelled(this.stopReason ?? "cancelled");
        this.checkBudget();
        for (const id of this.readyNodes()) this.launch(id);
        if (this.running.size === 0) {
          const waiting = Object.values(this.state.nodes).filter((n) => n.status === "waiting_approval");
          if (waiting.length) {
            // A decision may already exist on disk (approved while the run was paused / from another process).
            const existing = this.findApproval(waiting.map((w) => w.id));
            if (existing) {
              this.applyGateDecision(existing.gate, existing.approval);
              continue;
            }
            run.status = "paused";
            this.save();
            this.emit("run.paused", { waiting: waiting.map((w) => w.id) });
            if (this.opts.gateWait === "return") return this.state;
            const { gate, approval } = await this.waitForAnyGate(waiting.map((w) => w.id));
            run.status = "running";
            this.save();
            this.emit("run.resumed", { gate });
            this.applyGateDecision(gate, approval);
            continue;
          }
          break;
        }
        await Promise.race([...this.running.values()]);
      }
      await this.finish();
    } catch (e) {
      await this.failRun(e);
    }
    return this.state;
  }

  private async failRun(e: unknown) {
    const run = this.state.run;
    const msg = e instanceof Error ? e.message : String(e);
    this.cancel(msg);
    await Promise.allSettled([...this.running.values()]);
    run.status = e instanceof RunCancelled ? "cancelled" : "failed";
    run.error = msg;
    run.ended_at = nowIso();
    run.totals.wall_ms = Date.now() - this.wallStart;
    this.save();
    this.emit(run.status === "cancelled" ? "run.cancelled" : "run.failed", { error: msg, budget: e instanceof BudgetExceeded });
    if (!(e instanceof RunFailed)) this.log(`run ${run.id} crashed: ${msg}`);
  }

  private async finish() {
    const run = this.state.run;
    const scope = this.scope();
    const out = this.spec.output;
    if (out && "from" in out && typeof out.from === "string") {
      const v = scope.nodes[out.from];
      run.output = v?.output !== undefined ? v.output : v?.outputs;
    } else if (out) {
      run.output = resolveValue(out, scope);
    } else {
      const sinks = Object.values(this.analysis.nodes).filter((n) => n.dependents.length === 0).map((n) => n.id);
      const o: Record<string, unknown> = {};
      for (const id of sinks) {
        const v = scope.nodes[id];
        if (v && v.status === "completed") o[id] = v.output !== undefined ? v.output : v.outputs;
      }
      run.output = o;
    }
    if (this.spec.output_schema) {
      const v = validateAgainst(this.spec.output_schema, run.output);
      if (!v.ok) throw new RunFailed(`graph output does not match output_schema: ${v.errors.join("; ")}`);
    }
    const failed = Object.values(this.state.nodes).filter((n) => n.status === "failed").map((n) => n.id);
    const skipped = Object.values(this.state.nodes).filter((n) => n.status === "skipped").map((n) => n.id);
    run.warnings = [];
    if (failed.length) run.warnings.push(`degraded: nodes failed and were tolerated: ${failed.join(", ")}`);
    run.status = "completed";
    run.ended_at = nowIso();
    run.totals.wall_ms = Date.now() - this.wallStart;
    this.save();
    this.emit("run.completed", { cost_usd: run.totals.cost_usd, wall_ms: run.totals.wall_ms, failed, skipped, degraded: failed.length > 0 });
  }

  // ---------------------------------------------------------------- readiness / activation

  private isTerminal(status: string) {
    return status === "completed" || status === "failed" || status === "skipped";
  }

  private readyNodes(): string[] {
    const out: string[] = [];
    for (const [id, rec] of Object.entries(this.state.nodes)) {
      if (rec.status !== "pending" || this.running.has(id)) continue;
      const deps = this.analysis.nodes[id]?.deps ?? [];
      if (deps.every((d) => this.isTerminal(this.state.nodes[d]?.status ?? "pending"))) out.push(id);
    }
    return out;
  }

  private launch(id: string) {
    const p = this.executeNode(id).finally(() => {
      this.running.delete(id);
      if (this.resetAfterRun.has(id)) {
        this.resetAfterRun.delete(id);
        this.resetNode(id, "stale after repair");
      }
    });
    this.running.set(id, p);
  }

  private nodeSpec(id: string): NodeSpec {
    const n = this.spec.nodes.find((x) => x.id === id);
    if (!n) throw new RunFailed(`unknown node ${id}`);
    return n;
  }

  /** Decide skip/run for a node whose deps are all terminal. Returns a skip reason or undefined. */
  private activationSkip(node: NodeSpec): string | undefined {
    const optional = new Set(node.optional ?? []);
    for (const d of this.analysis.nodes[node.id]?.deps ?? []) {
      const st = this.state.nodes[d]?.status;
      if ((st === "skipped" || st === "failed") && !optional.has(d)) {
        const dn = this.nodeSpec(d);
        if (dn.kind === "gate") return `gate "${d}" was not approved`;
        return `upstream "${d}" ${st}${this.state.nodes[d]?.skip_reason ? ` (${this.state.nodes[d]!.skip_reason})` : ""}`;
      }
    }
    for (const g of gatesOf(node)) {
      const gr = this.state.nodes[g];
      if (gr?.status !== "completed" || !(gr.gate?.decision === "approved" || gr.gate?.decision === "auto")) return `gate "${g}" not approved`;
    }
    if (node.when !== undefined) {
      const scope = this.scope();
      let ok: boolean;
      try {
        ok = evalCond(node.when, scope);
      } catch (e) {
        throw new RunFailed(`node ${node.id}: cannot evaluate when: ${(e as Error).message}`);
      }
      if (!ok) return "when: condition false (route not selected)";
    }
    return undefined;
  }

  // ---------------------------------------------------------------- node execution

  private async executeNode(id: string) {
    const node = this.nodeSpec(id);
    const rec = this.state.nodes[id]!;
    const skip = this.activationSkip(node);
    if (skip) {
      rec.status = "skipped";
      rec.skip_reason = skip;
      rec.ended_at = nowIso();
      this.save();
      this.decision(id, "skip", skip);
      this.emit("node.skipped", { reason: skip }, id);
      return;
    }
    rec.status = "running";
    rec.started_at = nowIso();
    rec.ended_at = undefined;
    rec.error = undefined;
    this.save();
    this.emit("node.started", { kind: node.kind, repair_round: rec.repair?.round }, id);
    try {
      switch (node.kind) {
        case "agent":
          await this.runAgent(node, rec);
          break;
        case "code":
          await this.runCode(node, rec);
          break;
        case "verify":
          await this.runVerify(node, rec);
          break;
        case "gate":
          await this.runGate(node, rec);
          break;
        case "router":
          this.runRouter(node, rec);
          break;
        case "loop":
          await this.runLoop(node, rec);
          break;
        case "subgraph":
          await this.runSubgraph(node, rec);
          break;
      }
      if (rec.status === "running") rec.status = "completed";
      if (rec.status === "completed" || rec.status === "skipped") {
        rec.ended_at = nowIso();
        rec.duration_ms = new Date(rec.ended_at).getTime() - new Date(rec.started_at!).getTime();
      }
      this.save();
      if (rec.status === "completed") this.emit("node.completed", { duration_ms: rec.duration_ms, cost_usd: rec.cost_usd, items: rec.items ? { total: rec.items.length, completed: rec.items.filter((i) => i.status === "completed").length } : undefined }, id);
      else if (rec.status === "waiting_approval") this.emit("node.waiting", { gate: id }, id);
      else if (rec.status === "pending") this.emit("node.reset", { reason: "repair" }, id);
      else if (rec.status === "skipped") this.emit("node.skipped", { reason: rec.skip_reason }, id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rec.status = "failed";
      rec.error = msg;
      rec.ended_at = nowIso();
      rec.duration_ms = new Date(rec.ended_at).getTime() - new Date(rec.started_at!).getTime();
      this.save();
      this.emit("node.failed", { error: msg }, id);
      if (e instanceof RunFailed || this.abort.signal.aborted) throw e;
      const f = effectiveFailure(this.spec, node);
      this.decision(id, "failure", `${msg} -> policy ${f.on_failure}`);
      if (f.on_failure === "block") throw new RunFailed(`node "${id}" failed: ${msg}`);
      this.log(`node ${id} failed but on_failure=continue: ${msg}`);
    }
  }

  // ---- agent ----

  private async runAgent(node: AgentNode, rec: NodeRecord) {
    const scope = this.scope();
    if (node.map) {
      const arr = resolveRef(node.map, scope);
      if (!Array.isArray(arr)) throw new Error(`map: ${node.map} did not resolve to an array (got ${arr === undefined ? "undefined" : typeof arr})`);
      await this.fanOut(node, rec, arr, async (item, index) => {
        const s = this.scope({ item, index, repair: rec.repair });
        const r = await this.callModel(node, rec, s, "agent", node.output_schema, index);
        return r.output;
      });
    } else {
      const r = await this.callModel(node, rec, this.scope({ repair: rec.repair }), "agent", node.output_schema);
      rec.output = r.output;
      rec.artifact = r.artifact;
    }
  }

  private buildPrompt(node: AgentNode | VerifyNode, scope: Scope, rec: NodeRecord): { system?: string; prompt: string } {
    let prompt = node.prompt ? renderTemplate(node.prompt, scope) : "";
    if (node.kind === "verify" && !node.prompt) {
      prompt = ["Candidate to verify:", JSON.stringify(scope.item, null, 2), "", "Try to falsify this candidate. Check that every claim is supported by its evidence, that sources are plausible and dated, and look for internal contradictions or missing fields. Kill it if you find a disqualifying problem."].join("\n");
    }
    const system = node.system ? renderTemplate(node.system, scope) : undefined;
    const parts = [prompt];
    if (node.input) parts.push("", "<input>", JSON.stringify(resolveValue(node.input, scope), null, 2), "</input>");
    if (rec.repair && !/\$repair\b|\{\{\s*(json\s+)?repair\b/.test(node.prompt ?? "")) {
      parts.push("", `<repair_feedback round="${rec.repair.round}">`, JSON.stringify(rec.repair.feedback, null, 2), "</repair_feedback>", "An independent verifier rejected parts of your previous output for the reasons above. Produce a corrected output that addresses every reason.");
    }
    return { system, prompt: parts.join("\n") };
  }

  private bridgeFor(node: AgentNode | VerifyNode): Bridge {
    const name = this.opts.bridge ?? node.bridge ?? this.spec.defaults?.bridge ?? this.state.run.bridge;
    return this.opts.bridges.get(name);
  }

  /** One logical model call with the node's failure policy: retries, fallback, timeout, validation repair. */
  private async callModel(
    node: AgentNode | VerifyNode,
    rec: NodeRecord,
    scope: Scope,
    role: "agent" | "verify",
    schema: Record<string, unknown>,
    itemIndex?: number,
  ): Promise<{ output: unknown; artifact: string; response: AgentResponse }> {
    const f = effectiveFailure(this.spec, node);
    const { system, prompt } = this.buildPrompt(node, scope, rec);
    const primaryModel = resolveModel(node.model ?? this.spec.defaults?.model);
    const effort: Effort | undefined = node.effort ?? this.spec.defaults?.effort;
    const base: AgentRequest = {
      run_id: this.id,
      node_id: node.id,
      item_index: itemIndex,
      attempt: 0,
      role,
      model: primaryModel,
      effort,
      system,
      prompt,
      output_schema: schema,
      tools: node.tools,
      max_turns: node.max_turns,
      max_output_tokens: node.kind === "agent" ? node.max_output_tokens : undefined,
      timeout_ms: f.timeout_ms,
      cwd: node.cwd ? path.resolve(this.opts.cwd ?? process.cwd(), String(resolveValue(node.cwd, scope))) : this.opts.cwd,
    };
    const maxAttempts = 1 + f.retries;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const useFallback = Boolean(f.fallback) && attempt === maxAttempts && attempt > 1;
      const model = useFallback && f.fallback?.model ? resolveModel(f.fallback.model) : primaryModel;
      const bridge = useFallback && f.fallback?.bridge && !this.opts.bridge ? this.opts.bridges.get(f.fallback.bridge) : this.bridgeFor(node);
      this.checkBudget();
      const attemptRec: AttemptRecord = { attempt, item: itemIndex, started_at: nowIso(), model, bridge: bridge.name, status: "ok" };
      rec.attempts.push(attemptRec);
      if (attempt > 1) {
        rec.retries++;
        this.state.run.totals.retries++;
        this.emit("node.retry", { attempt, model, bridge: bridge.name, fallback: useFallback, error: lastErr instanceof Error ? lastErr.message : String(lastErr) }, node.id, itemIndex);
        await this.sleep(f.backoff_ms * Math.pow(2, attempt - 2));
      }
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), f.timeout_ms);
      await this.width.acquire();
      const ctx = { signal: ac.signal, store: this.opts.store, log: (m: string) => this.log(m), emit: (t: string, d?: Record<string, unknown>) => this.emit(t, d, node.id, itemIndex) };
      const t0 = Date.now();
      this.emit("call.started", { attempt, model, bridge: bridge.name, role, width_active: this.width.active }, node.id, itemIndex);
      try {
        const cap = this.spec.budget?.max_cost_usd;
        const remaining = cap !== undefined ? Math.max(0, cap - this.state.run.totals.cost_usd) : undefined;
        const perCall = node.max_cost_usd !== undefined && remaining !== undefined ? Math.min(node.max_cost_usd, remaining) : (node.max_cost_usd ?? remaining);
        let req: AgentRequest = { ...base, model, attempt, max_cost_usd: perCall };
        let res = await bridge.execute(req, ctx);
        this.account(rec, attemptRec, res);
        let v = validateAgainst(schema, res.output);
        let repairs = 0;
        while (!v.ok && repairs < f.repair_attempts && !ac.signal.aborted) {
          repairs++;
          rec.repairs++;
          this.emit("call.invalid_output", { attempt, repair: repairs, errors: v.errors }, node.id, itemIndex);
          req = { ...req, repair_errors: v.errors };
          res = await bridge.execute(req, ctx);
          this.account(rec, attemptRec, res);
          v = validateAgainst(schema, res.output);
        }
        if (!v.ok) {
          attemptRec.validation_errors = v.errors;
          throw new BridgeError(`output failed schema validation after ${repairs} repair attempt(s): ${v.errors.slice(0, 5).join("; ")}`, "invalid_output", true);
        }
        attemptRec.status = "ok";
        attemptRec.ended_at = nowIso();
        attemptRec.duration_ms = Date.now() - t0;
        const artifact = this.opts.store.writeArtifact(this.id, `${node.id}${itemIndex !== undefined ? `.i${itemIndex}` : ""}.a${attempt}`, {
          node: node.id,
          item: itemIndex,
          attempt,
          model,
          bridge: bridge.name,
          request: { system, prompt, output_schema: schema, effort, repair_rounds: repairs },
          response: { output: res.output, raw: res.raw, usage: res.usage, cost_usd: res.cost_usd, duration_ms: res.duration_ms, source: res.source, worker: res.worker, session_id: res.session_id },
        });
        attemptRec.artifact = artifact;
        attemptRec.source = res.source;
        this.emit("call.finished", { attempt, ok: true, duration_ms: attemptRec.duration_ms, cost_usd: res.cost_usd, model, source: res.source, repairs }, node.id, itemIndex);
        return { output: res.output, artifact, response: res };
      } catch (e) {
        const timedOut = ac.signal.aborted && !this.abort.signal.aborted;
        const msg = e instanceof Error ? e.message : String(e);
        attemptRec.ended_at = nowIso();
        attemptRec.duration_ms = Date.now() - t0;
        attemptRec.status = this.abort.signal.aborted ? "cancelled" : timedOut ? "timeout" : e instanceof BridgeError && e.kind === "invalid_output" ? "invalid_output" : "error";
        attemptRec.error = timedOut ? `timed out after ${f.timeout_ms}ms` : msg;
        if (e instanceof BridgeError && (e.cost_usd || e.usage)) {
          // a failed attempt still spent money - keep budgets honest
          attemptRec.usage = sumUsage(attemptRec.usage, e.usage);
          attemptRec.cost_usd = (attemptRec.cost_usd ?? 0) + (e.cost_usd ?? 0);
          addUsage(rec, e.usage, e.cost_usd, 1);
          addUsage(this.state.run.totals, e.usage, e.cost_usd, 1);
        }
        this.emit("call.finished", { attempt, ok: false, error: attemptRec.error, duration_ms: attemptRec.duration_ms, model, cost_usd: attemptRec.cost_usd }, node.id, itemIndex);
        lastErr = timedOut ? new BridgeError(attemptRec.error, "timeout", true) : e;
        if (this.abort.signal.aborted) throw new RunCancelled(this.stopReason ?? "cancelled");
        if (e instanceof BudgetExceeded) throw e;
        if (e instanceof BridgeError && !e.retryable) break;
      } finally {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", onAbort);
        this.width.release();
        this.save();
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private account(rec: NodeRecord, attemptRec: AttemptRecord, res: AgentResponse) {
    attemptRec.usage = sumUsage(attemptRec.usage, res.usage);
    attemptRec.cost_usd = (attemptRec.cost_usd ?? 0) + (res.cost_usd ?? 0);
    addUsage(rec, res.usage, res.cost_usd, 1);
    addUsage(this.state.run.totals, res.usage, res.cost_usd, 1);
    this.checkBudget();
  }

  // ---- fan-out ----

  private async fanOut(node: NodeSpec, rec: NodeRecord, arr: unknown[], fn: (item: unknown, index: number) => Promise<unknown>) {
    const f = effectiveFailure(this.spec, node);
    if (!rec.items || rec.items.length !== arr.length) rec.items = arr.map((_, i) => ({ index: i, status: "pending", attempts: 0 }));
    const perNode = new Semaphore(Math.max(1, Math.min(node.max_width ?? Infinity, this.spec.budget?.max_width ?? Infinity, 64)));
    const todo = rec.items.filter((it) => it.status !== "completed");
    this.emit("fanout.started", { total: arr.length, pending: todo.length, width: node.max_width ?? this.spec.budget?.max_width ?? null }, node.id);
    await Promise.all(
      todo.map(async (it) => {
        await perNode.acquire();
        const t0 = Date.now();
        try {
          if (this.abort.signal.aborted) throw new RunCancelled(this.stopReason ?? "cancelled");
          it.status = "running";
          it.attempts++;
          this.emit("item.started", {}, node.id, it.index);
          const out = await fn(arr[it.index], it.index);
          it.status = "completed";
          it.output = out;
          it.error = undefined;
          it.duration_ms = Date.now() - t0;
          this.emit("item.completed", { duration_ms: it.duration_ms }, node.id, it.index);
        } catch (e) {
          if (e instanceof RunFailed) throw e;
          it.status = "failed";
          it.error = e instanceof Error ? e.message : String(e);
          it.duration_ms = Date.now() - t0;
          this.emit("item.failed", { error: it.error }, node.id, it.index);
        } finally {
          perNode.release();
          this.save();
        }
      }),
    );
    const completed = rec.items.filter((i) => i.status === "completed");
    const failed = rec.items.filter((i) => i.status === "failed");
    rec.outputs = completed.map((i) => i.output);
    this.emit("fanout.finished", { total: arr.length, completed: completed.length, failed: failed.length, quorum: f.quorum }, node.id);
    if (failed.length) this.decision(node.id, "failure", `fan-out completed ${completed.length}/${arr.length} (quorum ${f.quorum}); failed: ${failed.map((i) => `#${i.index}: ${i.error}`).join(" | ")}`);
    if (arr.length > 0 && (completed.length === 0 || completed.length / arr.length < f.quorum)) {
      throw new Error(`quorum not met: ${completed.length}/${arr.length} items completed (need ${Math.ceil(f.quorum * arr.length)}). Failures: ${failed.map((i) => i.error).join(" | ")}`);
    }
  }

  // ---- code ----

  private async loadReducer(node: CodeNode | VerifyNode): Promise<Reducer> {
    if (node.fn) return getReducer(node.fn);
    if (node.module) {
      const abs = path.isAbsolute(node.module) ? node.module : path.resolve(this.opts.cwd ?? process.cwd(), node.module);
      const mod = (await import(pathToFileURL(abs).href)) as { default?: Reducer; reducer?: Reducer };
      const fn = mod.default ?? mod.reducer;
      if (typeof fn !== "function") throw new Error(`module ${node.module} must export a default function (input, args, ctx)`);
      return fn;
    }
    return getReducer("identity");
  }

  private async runCode(node: CodeNode, rec: NodeRecord) {
    const f = effectiveFailure(this.spec, node);
    if (node.side_effect && rec.side_effect_done) {
      this.log(`code ${node.id}: side effect already executed; reusing recorded output`);
      return;
    }
    const reducer = await this.loadReducer(node);
    const ctx = { runId: this.id, nodeId: node.id, log: (m: string) => this.log(`[${node.id}] ${m}`) };
    const runOnce = async (scope: Scope) => {
      const input = resolveValue(node.input ?? {}, scope) as Record<string, unknown>;
      const t0 = Date.now();
      const output = await reducer(input, node.args ?? {}, ctx);
      const v = validateAgainst(node.output_schema, output);
      if (!v.ok) throw new Error(`code node output failed schema validation: ${v.errors.join("; ")}`);
      this.emit("code.executed", { duration_ms: Date.now() - t0, stats: (output as { _stats?: unknown })?._stats }, node.id);
      return { input, output };
    };
    const retries = node.side_effect ? 0 : f.retries;
    const withRetries = async (scope: Scope) => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 1 + retries; attempt++) {
        const a: AttemptRecord = { attempt, started_at: nowIso(), status: "ok", bridge: "code" };
        rec.attempts.push(a);
        try {
          const r = await runOnce(scope);
          a.ended_at = nowIso();
          return r;
        } catch (e) {
          a.status = "error";
          a.error = e instanceof Error ? e.message : String(e);
          a.ended_at = nowIso();
          lastErr = e;
          if (attempt <= retries) {
            rec.retries++;
            this.emit("node.retry", { attempt: attempt + 1, error: a.error }, node.id);
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };
    if (node.map) {
      const arr = resolveRef(node.map, this.scope());
      if (!Array.isArray(arr)) throw new Error(`map: ${node.map} did not resolve to an array`);
      await this.fanOut(node, rec, arr, async (item, index) => (await withRetries(this.scope({ item, index }))).output);
    } else {
      const r = await withRetries(this.scope({ repair: rec.repair }));
      rec.output = r.output;
      rec.artifact = this.opts.store.writeArtifact(this.id, `${node.id}.a${rec.attempts.length}`, { node: node.id, input: r.input, output: r.output });
    }
    if (node.side_effect) {
      rec.side_effect_done = true;
      this.emit("side_effect.executed", { gates: gatesOf(node) }, node.id);
    }
  }

  // ---- verify ----

  private async runVerify(node: VerifyNode, rec: NodeRecord) {
    const scope = this.scope();
    const target = resolveRef(node.target, scope);
    const items = Array.isArray(target) ? target : target === undefined || target === null ? [] : [target];
    const threshold = node.kill_threshold ?? 0.5;
    const mode = node.mode ?? "agent";
    const verdicts = new Map<number, { verdict: string; reasons: string[]; confidence: number }>();
    const reducer = mode === "code" ? await this.loadReducer(node) : undefined;
    rec.items = items.map((_, i) => ({ index: i, status: "pending", attempts: 0 }));
    const f = effectiveFailure(this.spec, node);
    // A verification that did not execute is not a pass. Quorum does not apply: unverified = killed.
    const relaxed: NodeSpec = { ...node, failure: { ...(node.failure ?? {}), quorum: 0 } } as NodeSpec;
    await this.fanOut(relaxed, rec, items, async (item, index) => {
      const s = this.scope({ item, index });
      let out: unknown;
      if (mode === "code") {
        const input = { ...(resolveValue(node.input ?? {}, s) as Record<string, unknown>), item, index };
        out = await reducer!(input, node.args ?? {}, { runId: this.id, nodeId: node.id, log: (m) => this.log(m) });
      } else {
        out = (await this.callModel(node, rec, s, "verify", VERIFY_OUTPUT_SCHEMA as unknown as Record<string, unknown>, index)).output;
      }
      const v = validateAgainst(VERIFY_OUTPUT_SCHEMA as unknown as Record<string, unknown>, out);
      if (!v.ok) throw new Error(`verifier output invalid: ${v.errors.join("; ")}`);
      const o = out as { verdict: string; reasons: string[]; confidence: number };
      verdicts.set(index, o);
      return o;
    });
    void f;
    const survivors: unknown[] = [];
    const killed: KilledRecord[] = [];
    items.forEach((item, i) => {
      const it = rec.items![i]!;
      const v = verdicts.get(i);
      if (!v || it.status !== "completed") {
        killed.push({ index: i, item, reasons: [`verification did not execute: ${it.error ?? "unknown error"}`], confidence: 1 });
      } else if (v.verdict === "kill" && v.confidence >= threshold) {
        killed.push({ index: i, item, reasons: v.reasons, confidence: v.confidence });
        this.emit("verify.kill", { reasons: v.reasons, confidence: v.confidence }, node.id, i);
      } else survivors.push(item);
    });
    const killRate = items.length ? killed.length / items.length : 0;
    const round = rec.verify?.repair_round ?? 0;
    rec.verify = { total: items.length, survivors, killed, kill_rate: Number(killRate.toFixed(3)), repair_round: round };
    rec.output = { total: items.length, survivors, killed, kill_rate: rec.verify.kill_rate, verified: verdicts.size };
    this.decision(node.id, "verify", `${killed.length}/${items.length} killed (threshold ${threshold})${killed.length ? `: ${killed.map((k) => `#${k.index} ${k.reasons[0] ?? ""}`).join(" | ").slice(0, 400)}` : ""}`);
    this.emit("verify.finished", { total: items.length, killed: killed.length, kill_rate: rec.verify.kill_rate }, node.id);
    if (killed.length && node.repair && round < node.repair.max_rounds) {
      this.scheduleRepair(node.repair.node, node.id, round + 1, killed.map((k) => ({ index: k.index, item: k.item, reasons: k.reasons })));
      rec.verify.repair_round = round + 1;
      rec.repairs++;
      return;
    }
    if (survivors.length < (node.min_survivors ?? 0)) throw new Error(`only ${survivors.length} survivor(s) < min_survivors ${node.min_survivors}`);
    if (killed.length && node.repair && round >= node.repair.max_rounds) {
      this.decision(node.id, "repair", `repair budget exhausted after ${round} round(s); ${killed.length} item(s) remain killed - proceeding with survivors only`);
    }
  }

  /** Controlled cycle: reset the producer and everything downstream of it (bounded by max_rounds). */
  private scheduleRepair(producerId: string, verifierId: string, round: number, feedback: unknown) {
    const descendants = new Set<string>();
    const stack = [producerId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (descendants.has(cur)) continue;
      descendants.add(cur);
      for (const d of this.analysis.nodes[cur]?.dependents ?? []) stack.push(d);
    }
    for (const id of descendants) {
      if (this.running.has(id) && id !== verifierId) {
        this.resetAfterRun.add(id);
        continue;
      }
      this.resetNode(id, `repair round ${round} from ${verifierId}`);
    }
    const prod = this.state.nodes[producerId]!;
    prod.repair = { round, feedback };
    prod.repairs++;
    this.decision(verifierId, "repair", `round ${round}: sending ${Array.isArray(feedback) ? feedback.length : 1} rejection(s) back to "${producerId}"; reset ${[...descendants].join(", ")}`);
    this.emit("repair.scheduled", { producer: producerId, round, reset: [...descendants] }, verifierId);
    this.save();
  }

  resetNode(id: string, reason: string) {
    const rec = this.state.nodes[id]!;
    const node = this.nodeSpec(id);
    if (node.side_effect && rec.side_effect_done) return; // never re-run a side effect
    rec.status = "pending";
    rec.output = undefined;
    rec.outputs = undefined;
    rec.items = undefined;
    rec.error = undefined;
    rec.skip_reason = undefined;
    rec.route = undefined;
    rec.started_at = undefined;
    rec.ended_at = undefined;
    rec.duration_ms = undefined;
    if (node.kind === "gate") {
      rec.gate = undefined;
      delete this.state.run.approvals[id];
      this.opts.store.writeApproval(this.id, { gate: id, decision: "rejected", by: "system", comment: `reset: ${reason}`, at: nowIso() });
      // an approval file from a previous round must not auto-approve the new round
      this.clearApproval(id);
    }
    if (node.kind === "verify" && rec.verify) rec.verify = { ...rec.verify, survivors: [], killed: [] };
    this.emit("node.reset", { reason }, id);
  }

  private clearApproval(gate: string) {
    try {
      fs.rmSync(path.join(this.opts.store.runDir(this.id), "approvals", `${gate}.json`), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ---- gate ----

  private async runGate(node: GateNode, rec: NodeRecord) {
    const scope = this.scope();
    rec.gate ??= {};
    rec.gate.requested_at ??= nowIso();
    if (node.auto_approve_when !== undefined && evalCond(node.auto_approve_when, scope)) {
      const approval: ApprovalRecord = { gate: node.id, decision: "approved", by: "auto", comment: "auto_approve_when condition held", at: nowIso() };
      this.opts.store.writeApproval(this.id, approval);
      this.applyGateDecision(node.id, approval, true);
      return;
    }
    const existing = this.opts.store.readApproval(this.id, node.id);
    if (existing && existing.by !== "system" && existing.at >= rec.gate.requested_at) {
      this.applyGateDecision(node.id, existing);
      return;
    }
    const show = node.show !== undefined ? resolveValue(node.show, scope) : undefined;
    const prompt = node.prompt ? renderTemplate(node.prompt, scope) : undefined;
    rec.status = "waiting_approval";
    rec.output = undefined;
    rec.artifact = this.opts.store.writeArtifact(this.id, `${node.id}.gate`, { title: node.title, prompt, show, approve_effect: node.approve_effect, reject_effect: node.reject_effect });
    this.emit("gate.waiting", { title: node.title, prompt, show, approve_effect: node.approve_effect, reject_effect: node.reject_effect, timeout_ms: node.timeout_ms }, node.id);
    this.log(`gate "${node.id}" (${node.title}) is waiting for approval: gren approve ${this.id} ${node.id}`);
  }

  private applyGateDecision(gateId: string, approval: ApprovalRecord, auto = false) {
    const node = this.nodeSpec(gateId) as GateNode;
    const rec = this.state.nodes[gateId]!;
    rec.gate = { ...(rec.gate ?? {}), decision: auto ? "auto" : approval.decision, by: approval.by, comment: approval.comment, at: approval.at };
    this.state.run.approvals[gateId] = approval;
    rec.ended_at = nowIso();
    rec.duration_ms = rec.started_at ? new Date(rec.ended_at).getTime() - new Date(rec.started_at).getTime() : 0;
    rec.output = { decision: approval.decision, by: approval.by, comment: approval.comment ?? null, auto };
    this.decision(gateId, "gate", `${approval.decision} by ${approval.by}${approval.comment ? `: ${approval.comment}` : ""}`);
    if (approval.decision === "approved") {
      rec.status = "completed";
      this.emit(auto ? "gate.auto_approved" : "gate.approved", { by: approval.by, comment: approval.comment }, gateId);
      this.save();
      return;
    }
    rec.status = "skipped";
    rec.skip_reason = `rejected by ${approval.by}${approval.comment ? `: ${approval.comment}` : ""}`;
    this.emit("gate.rejected", { by: approval.by, comment: approval.comment }, gateId);
    this.save();
    if (node.on_reject?.route) {
      const round = (rec.repairs ?? 0) + 1;
      if (round > 3) throw new RunFailed(`gate "${gateId}" rejected ${round - 1} times; repair budget exhausted`);
      rec.repairs = round;
      this.scheduleRepair(node.on_reject.route, gateId, round, { rejected_by: approval.by, comment: approval.comment ?? "" });
      return;
    }
    if (node.on_reject?.fail_run !== false) throw new RunFailed(`gate "${gateId}" rejected by ${approval.by}${approval.comment ? `: ${approval.comment}` : ""}`);
  }

  /** A usable (non-system, not stale) approval record for any of the given gates. */
  private findApproval(gateIds: string[]): { gate: string; approval: ApprovalRecord } | undefined {
    for (const g of gateIds) {
      const rec = this.state.nodes[g]!;
      const a = this.opts.store.readApproval(this.id, g);
      if (a && a.by !== "system" && (!rec.gate?.requested_at || a.at >= rec.gate.requested_at)) return { gate: g, approval: a };
    }
    return undefined;
  }

  private waitForAnyGate(gateIds: string[]): Promise<{ gate: string; approval: ApprovalRecord }> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (gate: string, approval: ApprovalRecord) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        for (const g of gateIds) this.gateWaiters.delete(g);
        this.abort.signal.removeEventListener("abort", onAbort);
        resolve({ gate, approval });
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        reject(new RunCancelled(this.stopReason ?? "cancelled while waiting for approval"));
      };
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      for (const g of gateIds) this.gateWaiters.set(g, (a) => finish(g, a));
      const poll = () => {
        for (const g of gateIds) {
          const rec = this.state.nodes[g]!;
          const a = this.opts.store.readApproval(this.id, g);
          if (a && a.by !== "system" && (!rec.gate?.requested_at || a.at >= rec.gate.requested_at)) return finish(g, a);
          const node = this.nodeSpec(g) as GateNode;
          if (node.timeout_ms && rec.gate?.requested_at && Date.now() - new Date(rec.gate.requested_at).getTime() > node.timeout_ms && (node.on_timeout ?? "wait") === "reject") {
            const t: ApprovalRecord = { gate: g, decision: "rejected", by: "timeout", comment: `no decision within ${node.timeout_ms}ms`, at: nowIso() };
            this.opts.store.writeApproval(this.id, t);
            return finish(g, t);
          }
        }
      };
      const timer = setInterval(poll, 500);
      poll();
    });
  }

  // ---- router ----

  private runRouter(node: RouterNode, rec: NodeRecord) {
    const scope = this.scope();
    let route = node.default;
    let reason = "default";
    for (const [i, r] of node.routes.entries()) {
      if (evalCond(r.when, scope)) {
        route = r.route;
        reason = r.reason ?? `route[${i}] condition matched`;
        break;
      }
    }
    const snapshot: Record<string, unknown> = {};
    const refs = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string" && isRef(v)) refs.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(node.routes);
    for (const r of refs) snapshot[r] = resolveRef(r, scope);
    rec.route = route;
    rec.route_reason = reason;
    rec.output = { route, reason, snapshot };
    this.decision(node.id, "route", `selected "${route}" (${reason})`, snapshot);
    this.emit("route.selected", { route, reason, snapshot }, node.id);
  }

  // ---- loop / subgraph ----

  private childOptions(): RunnerBaseOptions {
    return {
      store: this.opts.store,
      bridges: this.opts.bridges,
      bridge: this.opts.bridge,
      defaultBridge: this.state.run.bridge,
      onEvent: this.opts.onEvent,
      log: this.opts.log,
      gateWait: this.opts.gateWait,
      cwd: this.opts.cwd,
    };
  }

  private async runChild(spec: GraphSpec, childId: string, input: unknown, nodeId: string, round?: number, context?: Record<string, unknown>): Promise<RunState> {
    const child = GraphRunner.create({ ...this.childOptions(), spec, specFile: `${this.state.run.spec_file}#${nodeId}`, input, runId: childId, parent: { run_id: this.id, node_id: nodeId, round }, context });
    this.children.add(child);
    try {
      const st = await child.run();
      if (st.run.status !== "completed") throw new RunFailed(`nested run ${childId} ${st.run.status}${st.run.error ? `: ${st.run.error}` : ""}`);
      return st;
    } finally {
      this.children.delete(child);
    }
  }

  private async runSubgraph(node: SubgraphNode, rec: NodeRecord) {
    const spec = node.graph as GraphSpec;
    const runOne = async (scope: Scope, childId: string, index?: number) => {
      const input = resolveValue(node.input ?? {}, scope);
      const attempt: AttemptRecord = { attempt: rec.attempts.length + 1, item: index, started_at: nowIso(), status: "ok", bridge: "subgraph" };
      rec.attempts.push(attempt);
      this.emit("subgraph.started", { run_id: childId, graph: spec.name }, node.id, index);
      try {
        const st = await this.runChild(spec, childId, input, node.id, index);
        addUsage(rec, st.run.totals.usage, st.run.totals.cost_usd, st.run.totals.agent_calls);
        addUsage(this.state.run.totals, st.run.totals.usage, st.run.totals.cost_usd, st.run.totals.agent_calls);
        attempt.ended_at = nowIso();
        attempt.cost_usd = st.run.totals.cost_usd;
        this.emit("subgraph.finished", { run_id: childId, cost_usd: st.run.totals.cost_usd }, node.id, index);
        return st.run.output;
      } catch (e) {
        attempt.status = "error";
        attempt.error = e instanceof Error ? e.message : String(e);
        attempt.ended_at = nowIso();
        throw e;
      }
    };
    if (node.map) {
      const arr = resolveRef(node.map, this.scope());
      if (!Array.isArray(arr)) throw new Error(`map: ${node.map} did not resolve to an array`);
      // one nested run per item, in parallel under the node's width budget; a failed item is a failed item, not a failed run
      await this.fanOut(node, rec, arr, async (item, index) => {
        try {
          return await runOne(this.scope({ item, index, repair: rec.repair }), `${this.id}/nested/${node.id}/item-${index}`, index);
        } catch (e) {
          if (e instanceof RunCancelled || e instanceof BudgetExceeded) throw e;
          throw new Error(e instanceof Error ? e.message : String(e));
        }
      });
      return;
    }
    rec.output = await runOne(this.scope({ repair: rec.repair }), `${this.id}/nested/${node.id}/${rec.attempts.length + 1}`);
  }

  private async runLoop(node: LoopNode, rec: NodeRecord) {
    const base = resolveValue(node.input ?? {}, this.scope()) as Record<string, unknown>;
    const seen = new Set<string>();
    const collected: unknown[] = [];
    const perRound: Array<{ round: number; run_id: string; items: number; fresh: number; cost_usd: number; duration_ms: number }> = [];
    const keyOf = (it: unknown) => {
      if (!node.seen_key) return JSON.stringify(it);
      let cur: unknown = it;
      for (const seg of node.seen_key.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
      return typeof cur === "string" ? cur.trim().toLowerCase() : JSON.stringify(cur ?? it);
    };
    let dry = 0;
    let stop = "max_rounds";
    let converged = false;
    let prev: unknown = undefined;
    let cost = 0;
    const t0 = Date.now();
    let round = 0;
    for (round = 1; round <= node.until.max_rounds; round++) {
      if (node.until.max_cost_usd && cost >= node.until.max_cost_usd) {
        stop = `loop cost budget reached ($${cost.toFixed(4)} >= $${node.until.max_cost_usd})`;
        round--;
        break;
      }
      if (node.until.max_wall_ms && Date.now() - t0 >= node.until.max_wall_ms) {
        stop = `loop wall budget reached (${Date.now() - t0}ms)`;
        round--;
        break;
      }
      const loopCtx = { round, seen: [...seen], collected: [...collected], prev, dry_rounds: dry };
      const input = { ...base, ...loopCtx };
      const childId = `${this.id}/nested/${node.id}/round-${round}`;
      this.emit("loop.round.started", { round, seen: seen.size, collected: collected.length, run_id: childId }, node.id);
      const rt0 = Date.now();
      const st = await this.runChild(node.body, childId, input, node.id, round, { loop: loopCtx });
      cost += st.run.totals.cost_usd;
      addUsage(rec, st.run.totals.usage, st.run.totals.cost_usd, st.run.totals.agent_calls);
      addUsage(this.state.run.totals, st.run.totals.usage, st.run.totals.cost_usd, st.run.totals.agent_calls);
      const collectScope: Scope = { input, nodes: {}, output: st.run.output, loop: loopCtx };
      const found = resolveRef(node.collect, collectScope);
      const items = Array.isArray(found) ? found : found === undefined || found === null ? [] : [found];
      const fresh: unknown[] = [];
      for (const it of items) {
        const k = keyOf(it);
        if (seen.has(k)) continue; // dedupe against everything seen - and within the round
        seen.add(k);
        fresh.push(it);
      }
      collected.push(...fresh);
      dry = fresh.length === 0 ? dry + 1 : 0;
      prev = st.run.output;
      perRound.push({ round, run_id: childId, items: items.length, fresh: fresh.length, cost_usd: st.run.totals.cost_usd, duration_ms: Date.now() - rt0 });
      this.emit("loop.round.finished", { round, items: items.length, fresh: fresh.length, dry_rounds: dry, cost_usd: st.run.totals.cost_usd }, node.id);
      this.decision(node.id, "loop", `round ${round}: ${items.length} found, ${fresh.length} new, ${dry} dry round(s)`);
      if (node.until.converged !== undefined && evalCond(node.until.converged, { ...collectScope, loop: { ...loopCtx, fresh: fresh.length, collected: [...collected], dry_rounds: dry } })) {
        converged = true;
        stop = "converged condition held";
        break;
      }
      if (node.until.no_new_for_rounds && dry >= node.until.no_new_for_rounds) {
        converged = true;
        stop = `no new findings for ${dry} round(s)`;
        break;
      }
      this.checkBudget();
    }
    const rounds = Math.min(round, node.until.max_rounds);
    rec.loop = { rounds, stop_reason: stop, converged, collected: collected.length, seen: seen.size, cost_usd: Number(cost.toFixed(5)) };
    rec.output = { items: collected, rounds, converged, stop_reason: stop, per_round: perRound, seen: [...seen] };
    this.decision(node.id, "loop", `stopped after ${rounds} round(s): ${stop}; ${collected.length} unique item(s)`);
    this.emit("loop.finished", { rounds, converged, stop_reason: stop, collected: collected.length }, node.id);
    if (!converged && (node.on_nonconvergence ?? "accept") === "fail") throw new Error(`loop did not converge: ${stop}`);
  }

  // ---------------------------------------------------------------- scope / views

  private view(rec: NodeRecord): NodeView {
    return {
      status: rec.status,
      output: rec.output,
      outputs: rec.outputs,
      items: rec.items?.map((i) => ({ index: i.index, status: i.status, output: i.output, error: i.error })),
      survivors: rec.verify?.survivors,
      killed: rec.verify?.killed,
      kill_rate: rec.verify?.kill_rate,
      route: rec.route,
      error: rec.error,
      count: rec.items ? { total: rec.items.length, completed: rec.items.filter((i) => i.status === "completed").length, failed: rec.items.filter((i) => i.status === "failed").length } : undefined,
      feedback: rec.repair?.feedback,
    };
  }

  private scope(extra: Partial<Scope> = {}): Scope {
    const nodes: Record<string, NodeView> = {};
    for (const [id, rec] of Object.entries(this.state.nodes)) nodes[id] = this.view(rec);
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("GREN_")) env[k] = v;
    return {
      input: this.state.run.input,
      nodes,
      run: { id: this.id },
      graph: { name: this.spec.name },
      loop: this.state.run.context?.loop,
      env,
      ...extra,
    };
  }

  // ---------------------------------------------------------------- budgets / bookkeeping

  private checkBudget() {
    const b = this.spec.budget ?? {};
    const t = this.state.run.totals;
    if (b.max_cost_usd !== undefined && t.cost_usd >= b.max_cost_usd) {
      this.decision("<run>", "budget", `spend cap: $${t.cost_usd.toFixed(4)} >= $${b.max_cost_usd}`);
      throw new BudgetExceeded(`spend cap exceeded: $${t.cost_usd.toFixed(4)} >= budget.max_cost_usd $${b.max_cost_usd} (frozen: spend_cap)`);
    }
    if (b.max_wall_ms !== undefined && this.wallStart && Date.now() - this.wallStart >= b.max_wall_ms) {
      throw new BudgetExceeded(`wall-clock budget exceeded: ${Date.now() - this.wallStart}ms >= ${b.max_wall_ms}ms`);
    }
    if (b.max_agent_calls !== undefined && t.agent_calls >= b.max_agent_calls) {
      throw new BudgetExceeded(`agent call budget exceeded: ${t.agent_calls} >= ${b.max_agent_calls}`);
    }
    if (b.max_tokens !== undefined && (t.usage.input_tokens ?? 0) + (t.usage.output_tokens ?? 0) >= b.max_tokens) {
      throw new BudgetExceeded(`token budget exceeded: ${(t.usage.input_tokens ?? 0) + (t.usage.output_tokens ?? 0)} >= ${b.max_tokens}`);
    }
  }

  private decision(node: string, kind: Decision["kind"], detail: string, state?: Record<string, unknown>) {
    this.state.run.decisions.push({ at: nowIso(), node, kind, detail, state });
  }

  private save() {
    this.state.run.totals.wall_ms = this.wallStart ? Date.now() - this.wallStart : this.state.run.totals.wall_ms;
    this.opts.store.save(this.state);
  }

  private emit(type: string, data?: Record<string, unknown>, node?: string, item?: number) {
    const evt = this.opts.store.appendEvent(this.id, { type, node, item, data });
    try {
      this.opts.onEvent?.(evt);
    } catch {
      /* listeners must not break the run */
    }
  }

  private log(msg: string) {
    this.opts.log?.(msg);
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}

/** Collect refs used by a node's `when` - exported for tooling/UI explanations. */
export function whenRefs(node: NodeSpec): string[] {
  return [...new Set(collectNodeRefs(node.when).map((r) => `$nodes.${r.node}${r.path}`))];
}
