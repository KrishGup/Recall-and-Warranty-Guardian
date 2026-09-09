/**
 * Durable run state. The graph must be able to answer, at any moment:
 *   What has already happened?  (events.jsonl, node records)
 *   Why did the system choose this route?  (decisions[] with the state that produced them)
 *   Where can execution safely resume?  (state.json checkpoint after every node)
 *
 * Layout: runs/<run_id>/
 *   run.json         run record (spec snapshot, input, status, totals, approvals, decisions)
 *   state.json       node records (checkpoint)
 *   events.jsonl     append-only event log
 *   artifacts/       full prompts/raw outputs per attempt (state stores references, not blobs)
 *   inbox/           tasks for the orchestrator bridge (+ results)
 *   approvals/       human gate decisions
 *   nested/<node>/   loop rounds and subgraph runs (each a full run dir)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Budget, GraphSpec, NodeKind } from "../spec/schema.js";
import { sumUsage, type Usage } from "../models.js";

export type RunStatus = "created" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type NodeStatus = "pending" | "running" | "waiting_approval" | "waiting_task" | "completed" | "failed" | "skipped";

export interface AttemptRecord {
  attempt: number;
  item?: number;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  model?: string;
  bridge?: string;
  status: "ok" | "error" | "invalid_output" | "timeout" | "cancelled";
  error?: string;
  validation_errors?: string[];
  cost_usd?: number;
  usage?: Usage;
  artifact?: string;
  source?: string;
}

export interface ItemRecord {
  index: number;
  status: "pending" | "running" | "completed" | "failed";
  output?: unknown;
  error?: string;
  attempts: number;
  duration_ms?: number;
  cost_usd?: number;
}

export interface KilledRecord {
  index: number;
  item: unknown;
  reasons: string[];
  confidence: number;
}

export interface NodeRecord {
  id: string;
  kind: NodeKind;
  status: NodeStatus;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  output?: unknown;
  /** Map / verify fan-out per-item records. */
  items?: ItemRecord[];
  /** Successful item outputs in order. */
  outputs?: unknown[];
  attempts: AttemptRecord[];
  cost_usd: number;
  usage: Usage;
  agent_calls: number;
  retries: number;
  repairs: number;
  error?: string;
  skip_reason?: string;
  route?: string;
  route_reason?: string;
  verify?: { total: number; survivors: unknown[]; killed: KilledRecord[]; kill_rate: number; repair_round: number };
  gate?: { decision?: "approved" | "rejected" | "auto"; by?: string; comment?: string; at?: string; requested_at?: string };
  loop?: { rounds: number; stop_reason: string; converged: boolean; collected: number; seen: number; cost_usd: number };
  /** Set when a verify repair cycle re-runs this node. */
  repair?: { round: number; feedback: unknown };
  side_effect_done?: boolean;
  /** Which attempt produced `output`. */
  artifact?: string;
  waiting_task?: string;
}

export interface ApprovalRecord {
  gate: string;
  decision: "approved" | "rejected";
  by: string;
  comment?: string;
  at: string;
}

export interface Decision {
  at: string;
  node: string;
  kind: "route" | "gate" | "loop" | "verify" | "failure" | "budget" | "skip" | "repair";
  detail: string;
  state?: Record<string, unknown>;
}

export interface RunTotals {
  cost_usd: number;
  usage: Usage;
  agent_calls: number;
  retries: number;
  wall_ms: number;
}

export interface RunRecord {
  id: string;
  graph: string;
  spec_file: string;
  spec: GraphSpec;
  input: unknown;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  ended_at?: string;
  bridge: string;
  budget: Budget;
  frozen: string[];
  error?: string;
  output?: unknown;
  totals: RunTotals;
  approvals: Record<string, ApprovalRecord>;
  decisions: Decision[];
  parent?: { run_id: string; node_id: string; round?: number };
  labels?: Record<string, string>;
  /** Extra scope for nested runs (e.g. { loop: { round, seen, collected, prev } }). */
  context?: Record<string, unknown>;
  /** Visible degradation: nodes that failed but were tolerated, etc. */
  warnings?: string[];
  /** Set when this run was created by `gren fork` from another run. */
  forked_from?: string;
}

export interface RunState {
  run: RunRecord;
  nodes: Record<string, NodeRecord>;
}

export interface GrenEvent {
  ts: string;
  seq: number;
  run_id: string;
  type: string;
  node?: string;
  item?: number;
  data?: Record<string, unknown>;
}

export interface InboxTask {
  task_id: string;
  run_id: string;
  node_id: string;
  item_index?: number;
  attempt: number;
  role: "agent" | "verify";
  model: string;
  effort?: string;
  system?: string;
  prompt: string;
  output_schema: Record<string, unknown>;
  tools?: string[];
  created_at: string;
  timeout_at: string;
  status: "pending" | "claimed" | "completed" | "cancelled";
  claimed_by?: string;
  claimed_at?: string;
  instructions: string;
}

export interface InboxResult {
  task_id: string;
  output: unknown;
  cost_usd?: number;
  usage?: Usage;
  model?: string;
  source?: "orchestrator" | "human" | "subagent" | "api" | "mock";
  worker?: string;
  completed_at: string;
  error?: string;
}

export interface RunSummary {
  id: string;
  graph: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  cost_usd: number;
  bridge: string;
  nodes: { total: number; completed: number; failed: number; skipped: number; waiting: number };
  parent?: RunRecord["parent"];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newRunId(prefix = "run"): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function atomicWrite(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(2).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

export class RunStore {
  private seq = new Map<string, number>();

  constructor(public readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  runDir(runId: string): string {
    // nested runs are addressed as "<parent>/nested/<node>/<child>" - keep path semantics
    return path.join(this.root, runId);
  }

  exists(runId: string): boolean {
    return fs.existsSync(path.join(this.runDir(runId), "run.json"));
  }

  create(opts: {
    id?: string;
    spec: GraphSpec;
    specFile: string;
    input: unknown;
    bridge: string;
    budget: Budget;
    frozen: string[];
    parent?: RunRecord["parent"];
    labels?: Record<string, string>;
  }): RunState {
    const id = opts.id ?? newRunId(opts.spec.name.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 24));
    const dir = this.runDir(id);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    fs.mkdirSync(path.join(dir, "approvals"), { recursive: true });
    const ts = nowIso();
    const run: RunRecord = {
      id,
      graph: opts.spec.name,
      spec_file: opts.specFile,
      spec: opts.spec,
      input: opts.input,
      status: "created",
      created_at: ts,
      updated_at: ts,
      bridge: opts.bridge,
      budget: opts.budget,
      frozen: opts.frozen,
      totals: { cost_usd: 0, usage: {}, agent_calls: 0, retries: 0, wall_ms: 0 },
      approvals: {},
      decisions: [],
      parent: opts.parent,
      labels: opts.labels,
    };
    const nodes: Record<string, NodeRecord> = {};
    for (const n of opts.spec.nodes) {
      nodes[n.id] = { id: n.id, kind: n.kind, status: "pending", attempts: [], cost_usd: 0, usage: {}, agent_calls: 0, retries: 0, repairs: 0 };
    }
    const state: RunState = { run, nodes };
    this.save(state);
    return state;
  }

  load(runId: string): RunState {
    const dir = this.runDir(runId);
    const runFile = path.join(dir, "run.json");
    if (!fs.existsSync(runFile)) throw new Error(`run not found: ${runId}`);
    const run = JSON.parse(fs.readFileSync(runFile, "utf8")) as RunRecord;
    const stateFile = path.join(dir, "state.json");
    const nodes = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { nodes: Record<string, NodeRecord> }).nodes : {};
    return { run, nodes };
  }

  save(state: RunState) {
    state.run.updated_at = nowIso();
    const dir = this.runDir(state.run.id);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, "run.json"), JSON.stringify(state.run, null, 2));
    atomicWrite(path.join(dir, "state.json"), JSON.stringify({ nodes: state.nodes }, null, 2));
  }

  appendEvent(runId: string, evt: Omit<GrenEvent, "ts" | "seq" | "run_id">): GrenEvent {
    const seq = (this.seq.get(runId) ?? this.lastSeq(runId)) + 1;
    this.seq.set(runId, seq);
    const full: GrenEvent = { ts: nowIso(), seq, run_id: runId, ...evt };
    fs.appendFileSync(path.join(this.runDir(runId), "events.jsonl"), JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  private lastSeq(runId: string): number {
    const f = path.join(this.runDir(runId), "events.jsonl");
    if (!fs.existsSync(f)) return 0;
    const lines = fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
    if (!lines.length) return 0;
    try {
      return (JSON.parse(lines[lines.length - 1]!) as GrenEvent).seq ?? lines.length;
    } catch {
      return lines.length;
    }
  }

  readEvents(runId: string, afterSeq = 0): GrenEvent[] {
    const f = path.join(this.runDir(runId), "events.jsonl");
    if (!fs.existsSync(f)) return [];
    const out: GrenEvent[] = [];
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as GrenEvent;
        if (e.seq > afterSeq) out.push(e);
      } catch {
        /* ignore torn line */
      }
    }
    return out;
  }

  writeArtifact(runId: string, name: string, data: unknown): string {
    const rel = path.join("artifacts", `${name}.json`);
    const abs = path.join(this.runDir(runId), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    atomicWrite(abs, JSON.stringify(data, null, 2));
    return rel.replace(/\\/g, "/");
  }

  readArtifact(runId: string, rel: string): unknown {
    const abs = path.join(this.runDir(runId), rel);
    if (!fs.existsSync(abs)) return undefined;
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  }

  // ---- approvals (human gates) ----
  writeApproval(runId: string, approval: ApprovalRecord) {
    atomicWrite(path.join(this.runDir(runId), "approvals", `${approval.gate}.json`), JSON.stringify(approval, null, 2));
  }

  readApproval(runId: string, gate: string): ApprovalRecord | undefined {
    const f = path.join(this.runDir(runId), "approvals", `${gate}.json`);
    if (!fs.existsSync(f)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as ApprovalRecord;
    } catch {
      return undefined;
    }
  }

  // ---- inbox (orchestrator bridge) ----
  writeTask(task: InboxTask) {
    atomicWrite(path.join(this.runDir(task.run_id), "inbox", `${task.task_id}.json`), JSON.stringify(task, null, 2));
  }

  readTask(runId: string, taskId: string): InboxTask | undefined {
    const f = path.join(this.runDir(runId), "inbox", `${taskId}.json`);
    if (!fs.existsSync(f)) return undefined;
    return JSON.parse(fs.readFileSync(f, "utf8")) as InboxTask;
  }

  listTasks(runId: string): InboxTask[] {
    const dir = path.join(this.runDir(runId), "inbox");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^[^.]+\.json$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as InboxTask;
        } catch {
          return undefined;
        }
      })
      .filter((t): t is InboxTask => Boolean(t && typeof t.task_id === "string" && typeof t.created_at === "string"))
      .map((t) => (t.status !== "completed" && fs.existsSync(path.join(dir, `${t.task_id}.result.json`)) ? { ...t, status: "completed" as const } : t))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Tasks for a run and all of its nested runs (loop rounds, subgraphs). */
  listTasksDeep(runId: string, onlyPending = true): InboxTask[] {
    const out: InboxTask[] = [];
    const walk = (id: string, depth: number) => {
      if (depth > 6) return;
      for (const t of this.listTasks(id)) if (!onlyPending || t.status === "pending" || t.status === "claimed") out.push(t);
      const nested = path.join(this.runDir(id), "nested");
      if (!fs.existsSync(nested)) return;
      for (const node of fs.readdirSync(nested, { withFileTypes: true })) {
        if (!node.isDirectory()) continue;
        const nodeDir = path.join(nested, node.name);
        for (const child of fs.readdirSync(nodeDir, { withFileTypes: true })) {
          if (child.isDirectory() && fs.existsSync(path.join(nodeDir, child.name, "run.json"))) walk(`${id}/nested/${node.name}/${child.name}`, depth + 1);
        }
      }
    };
    walk(runId, 0);
    return out;
  }

  /** All pending tasks across every run in the store. */
  listAllPendingTasks(): InboxTask[] {
    const out: InboxTask[] = [];
    for (const r of this.list()) {
      if (r.parent) continue; // nested runs are reached through their parent
      if (r.status !== "running" && r.status !== "paused" && r.status !== "created") continue;
      out.push(...this.listTasksDeep(r.id));
    }
    return out;
  }

  writeTaskResult(runId: string, result: InboxResult) {
    atomicWrite(path.join(this.runDir(runId), "inbox", `${result.task_id}.result.json`), JSON.stringify(result, null, 2));
  }

  readTaskResult(runId: string, taskId: string): InboxResult | undefined {
    const f = path.join(this.runDir(runId), "inbox", `${taskId}.result.json`);
    if (!fs.existsSync(f)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as InboxResult;
    } catch {
      return undefined;
    }
  }

  // ---- listing ----
  list(): RunSummary[] {
    const out: RunSummary[] = [];
    const walk = (dir: string, prefix: string, depth: number) => {
      if (!fs.existsSync(dir) || depth > 4) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const id = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (fs.existsSync(path.join(full, "run.json"))) {
          try {
            out.push(summarize(this.load(id)));
          } catch {
            /* skip corrupt */
          }
          walk(path.join(full, "nested"), `${id}/nested`, depth + 1);
        } else if (entry.name === "nested" || prefix.endsWith("nested")) {
          walk(full, id, depth + 1);
        }
      }
    };
    walk(this.root, "", 0);
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  delete(runId: string) {
    fs.rmSync(this.runDir(runId), { recursive: true, force: true });
  }

  /** Copy a run (state, artifacts, approvals, nested runs - not the inbox) under a new id. */
  fork(srcId: string, newId?: string): RunState {
    const src = this.load(srcId);
    const id = newId ?? newRunId(`${src.run.graph.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 20)}-fork`);
    const from = this.runDir(srcId);
    const to = this.runDir(id);
    if (fs.existsSync(to)) throw new Error(`run ${id} already exists`);
    fs.mkdirSync(to, { recursive: true });
    for (const sub of ["artifacts", "approvals", "nested"]) {
      if (fs.existsSync(path.join(from, sub))) fs.cpSync(path.join(from, sub), path.join(to, sub), { recursive: true });
    }
    fs.mkdirSync(path.join(to, "inbox"), { recursive: true });
    const state: RunState = { run: { ...src.run, id, status: "created", ended_at: undefined, error: undefined, output: undefined, warnings: undefined, forked_from: srcId, created_at: nowIso() }, nodes: src.nodes };
    this.save(state);
    this.appendEvent(id, { type: "run.forked", data: { from: srcId } });
    return state;
  }
}

export function summarize(state: RunState): RunSummary {
  const ns = Object.values(state.nodes);
  return {
    id: state.run.id,
    graph: state.run.graph,
    status: state.run.status,
    created_at: state.run.created_at,
    updated_at: state.run.updated_at,
    cost_usd: state.run.totals.cost_usd,
    bridge: state.run.bridge,
    nodes: {
      total: ns.length,
      completed: ns.filter((n) => n.status === "completed").length,
      failed: ns.filter((n) => n.status === "failed").length,
      skipped: ns.filter((n) => n.status === "skipped").length,
      waiting: ns.filter((n) => n.status === "waiting_approval" || n.status === "waiting_task").length,
    },
    parent: state.run.parent,
  };
}

export function addUsage(rec: { usage: Usage; cost_usd: number; agent_calls: number }, usage: Usage | undefined, cost: number | undefined, calls = 1) {
  rec.usage = sumUsage(rec.usage, usage);
  rec.cost_usd += cost ?? 0;
  rec.agent_calls += calls;
}
