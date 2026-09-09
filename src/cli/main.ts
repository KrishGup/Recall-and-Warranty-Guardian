#!/usr/bin/env node
/**
 * gren CLI - validate, analyze, run, resume, approve, monitor, and serve graphs.
 *
 *   gren validate <spec>                 schema + static analysis (exit 1 on errors)
 *   gren analyze <spec> [--json]         dependency test, critical path, width, cost, checklist
 *   gren run <spec> [--input JSON|@file] [--bridge X] [--id ID] [--no-wait] [--auto-approve] [--quiet] [--json]
 *   gren resume <run_id> [--bridge X] [--no-wait] [--auto-approve]
 *   gren status <run_id> [--json]        node table + waiting gates + pending tasks
 *   gren events <run_id> [--follow]
 *   gren approve <run_id> <gate> [--reject] [--by NAME] [--comment TEXT]
 *   gren tasks [run_id] [--json]         pending inbox tasks (orchestrator bridge)
 *   gren claim <run_id> <task_id> [--by NAME]
 *   gren complete <run_id> <task_id> --result JSON|@file [--cost USD] [--model M] [--source S] [--error TEXT]
 *   gren metrics <run_id> [--json]
 *   gren output <run_id>
 *   gren list [--json]
 *   gren delete <run_id>
 *   gren ui [--port 4545]
 *   gren mcp
 *   gren bridges
 *   gren shapes | reducers | new <shape> <name>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import YAML from "yaml";
import { loadGraph, SpecError } from "../spec/load.js";
import { analyze, formatAnalysis } from "../spec/analyze.js";
import { GraphRunner } from "../engine/scheduler.js";
import { RunStore, nowIso, type GrenEvent, type RunState } from "../engine/state.js";
import { validateAgainst } from "../engine/validate.js";
import { BridgeRegistry, defaultBridgeName } from "../bridges/registry.js";
import { computeMetricsDeep, formatMetrics } from "../metrics/metrics.js";
import { builtinReducers } from "../reducers/builtin.js";
import { FROZEN_CONSTRAINTS } from "../spec/schema.js";
import { SHAPES, scaffold } from "./shapes.js";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (a.startsWith("--no-")) {
        flags[a.slice(5)] = false;
        flags[a.slice(2)] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else flags[a.slice(2)] = true;
      }
    } else positional.push(a);
  }
  const cmd = positional.shift() ?? "help";
  return { cmd, positional, flags };
}

function str(f: Flags, k: string): string | undefined {
  const v = f[k];
  return typeof v === "string" ? v : undefined;
}

function runsDir(flags: Flags): string {
  return path.resolve(str(flags, "runs") ?? process.env.GREN_RUNS ?? "runs");
}

function parseInput(raw: string | undefined): unknown {
  if (!raw) return {};
  if (raw.startsWith("@")) {
    const p = raw.slice(1);
    return YAML.parse(fs.readFileSync(p, "utf8"));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return YAML.parse(raw);
  }
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

const t0 = Date.now();
function fmtEvent(e: GrenEvent): string {
  const t = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  const node = e.node ? ` ${e.node}${e.item !== undefined ? `#${e.item}` : ""}` : "";
  const d = e.data ?? {};
  let detail = "";
  switch (e.type) {
    case "run.started": detail = `${d.graph} via ${d.bridge}, ${d.nodes} nodes, est. critical path ${((d.critical_path_est_ms as number) / 1000).toFixed(0)}s`; break;
    case "node.completed": detail = `${((d.duration_ms as number) / 1000).toFixed(1)}s $${Number(d.cost_usd ?? 0).toFixed(4)}${d.items ? ` items ${(d.items as { completed: number; total: number }).completed}/${(d.items as { total: number }).total}` : ""}`; break;
    case "node.failed": detail = String(d.error ?? ""); break;
    case "node.skipped": detail = String(d.reason ?? ""); break;
    case "node.retry": detail = `attempt ${d.attempt}${d.fallback ? " (fallback)" : ""}: ${d.error}`; break;
    case "call.started": detail = `${d.model} via ${d.bridge} (attempt ${d.attempt}, ${d.width_active} active)`; break;
    case "call.finished": detail = d.ok ? `${((d.duration_ms as number) / 1000).toFixed(1)}s $${Number(d.cost_usd ?? 0).toFixed(4)}${d.repairs ? ` repairs ${d.repairs}` : ""}` : `FAILED ${d.error}`; break;
    case "call.invalid_output": detail = `schema errors: ${(d.errors as string[]).slice(0, 3).join("; ")}`; break;
    case "fanout.started": detail = `${d.pending}/${d.total} items, width ${d.width ?? "-"}`; break;
    case "fanout.finished": detail = `${d.completed}/${d.total} completed, ${d.failed} failed (quorum ${d.quorum})`; break;
    case "verify.kill": detail = `KILL (${Number(d.confidence).toFixed(2)}): ${(d.reasons as string[])[0] ?? ""}`; break;
    case "verify.finished": detail = `${d.killed}/${d.total} killed (${(Number(d.kill_rate) * 100).toFixed(0)}%)`; break;
    case "repair.scheduled": detail = `round ${d.round} -> ${d.producer}; reset ${(d.reset as string[]).join(",")}`; break;
    case "route.selected": detail = `-> ${d.route} (${d.reason})`; break;
    case "gate.waiting": detail = `WAITING: ${d.title}`; break;
    case "gate.approved": case "gate.auto_approved": case "gate.rejected": detail = `${d.by ?? ""}${d.comment ? `: ${d.comment}` : ""}`; break;
    case "task.created": detail = `inbox task ${d.task_id} (${d.model}) - waiting for a worker`; break;
    case "task.completed": detail = `task ${d.task_id} by ${d.worker ?? d.source}`; break;
    case "loop.round.finished": detail = `round ${d.round}: ${d.items} found, ${d.fresh} new, dry ${d.dry_rounds}`; break;
    case "loop.finished": detail = `${d.rounds} rounds, ${d.collected} items, ${d.converged ? "converged" : "NOT converged"}: ${d.stop_reason}`; break;
    case "run.completed": detail = `$${Number(d.cost_usd).toFixed(4)} in ${((d.wall_ms as number) / 1000).toFixed(1)}s${d.degraded ? ` DEGRADED (failed: ${(d.failed as string[]).join(",")})` : ""}`; break;
    case "run.failed": detail = String(d.error ?? ""); break;
    case "run.paused": detail = `waiting on ${(d.waiting as string[]).join(", ")}`; break;
    default: detail = Object.keys(d).length ? JSON.stringify(d).slice(0, 160) : "";
  }
  return `${t} ${e.type.padEnd(20)}${node}  ${detail}`;
}

function printStatus(state: RunState, store: RunStore) {
  const r = state.run;
  console.log(`Run ${r.id}  graph=${r.graph}  status=${r.status}  bridge=${r.bridge}  cost=$${r.totals.cost_usd.toFixed(4)}  calls=${r.totals.agent_calls}  wall=${(r.totals.wall_ms / 1000).toFixed(1)}s`);
  if (r.error) console.log(`  error: ${r.error}`);
  if (r.warnings?.length) for (const w of r.warnings) console.log(`  warning: ${w}`);
  console.log("");
  console.log(`  ${"node".padEnd(22)} ${"kind".padEnd(9)} ${"status".padEnd(17)} ${"dur".padStart(7)}  ${"cost".padStart(8)}  detail`);
  for (const n of Object.values(state.nodes)) {
    let detail = "";
    if (n.items) detail = `items ${n.items.filter((i) => i.status === "completed").length}/${n.items.length}`;
    if (n.verify) detail += ` kill ${(n.verify.kill_rate * 100).toFixed(0)}% (${n.verify.killed.length}/${n.verify.total})`;
    if (n.route) detail += ` route=${n.route}`;
    if (n.gate?.decision) detail += ` ${n.gate.decision} by ${n.gate.by}`;
    if (n.loop) detail += ` ${n.loop.rounds} rounds, ${n.loop.collected} items, ${n.loop.stop_reason}`;
    if (n.error) detail += ` ERR ${n.error.slice(0, 80)}`;
    if (n.skip_reason) detail += ` ${n.skip_reason}`;
    if (n.retries) detail += ` retries=${n.retries}`;
    if (n.repairs) detail += ` repairs=${n.repairs}`;
    console.log(`  ${n.id.padEnd(22)} ${n.kind.padEnd(9)} ${n.status.padEnd(17)} ${((n.duration_ms ?? 0) / 1000).toFixed(1).padStart(6)}s  $${n.cost_usd.toFixed(4).padStart(7)}  ${detail.trim()}`);
  }
  const waiting = Object.values(state.nodes).filter((n) => n.status === "waiting_approval");
  if (waiting.length) {
    console.log("");
    for (const g of waiting) {
      const spec = r.spec.nodes.find((n) => n.id === g.id) as { title?: string; approve_effect?: string; reject_effect?: string } | undefined;
      console.log(`  GATE WAITING: ${g.id} - ${spec?.title ?? ""}`);
      if (spec?.approve_effect) console.log(`    If you approve: ${spec.approve_effect}`);
      if (spec?.reject_effect) console.log(`    If you reject:  ${spec.reject_effect}`);
      console.log(`    gren approve ${r.id} ${g.id} [--reject] [--comment "..."]`);
    }
  }
  const nested = store.nestedRunIds(r.id);
  if (nested.length) {
    console.log("");
    console.log(`  nested runs (${nested.length}):`);
    for (const id of nested.slice(-12)) {
      try {
        const s = store.load(id);
        const done = Object.values(s.nodes).filter((n) => n.status === "completed").length;
        const running = Object.values(s.nodes).filter((n) => n.status === "running").map((n) => n.id);
        console.log(`    ${id.split("/nested/").slice(1).join(" > ").padEnd(34)} ${s.run.status.padEnd(10)} ${done}/${Object.keys(s.nodes).length} done  $${s.run.totals.cost_usd.toFixed(4)}${running.length ? `  running: ${running.join(", ")}` : ""}`);
      } catch {
        /* torn */
      }
    }
    if (nested.length > 12) console.log(`    … ${nested.length - 12} more (gren list --all)`);
  }
  const tasks = store.listTasksDeep(r.id);
  if (tasks.length) {
    console.log("");
    console.log(`  ${tasks.length} pending inbox task(s):  gren tasks ${r.id} --json`);
    for (const t of tasks) console.log(`    ${t.task_id.padEnd(32)} ${t.node_id}${t.item_index !== undefined ? `#${t.item_index}` : ""}  ${t.model}  ${t.status}`);
  }
}

async function askGate(runner: GraphRunner, gate: string, title: string, prompt: string | undefined, show: unknown, effects?: { approve?: string; reject?: string }): Promise<void> {
  console.log("");
  console.log(`=== HUMAN GATE: ${gate} - ${title} ===`);
  if (prompt) console.log(prompt);
  if (effects?.approve) console.log(`If you approve: ${effects.approve}`);
  if (effects?.reject) console.log(`If you reject:  ${effects.reject}`);
  if (show !== undefined) console.log(JSON.stringify(show, null, 2).slice(0, 4000));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(`Approve "${gate}"? [y]es / [n]o / n <comment>: `, res));
  rl.close();
  const a = answer.trim();
  if (/^y(es)?$/i.test(a)) runner.approve(gate, "approved", "cli", undefined);
  else runner.approve(gate, "rejected", "cli", a.replace(/^n(o)?\s*/i, "") || undefined);
}

async function cmdRun(positional: string[], flags: Flags, resume: boolean | "fork" = false) {
  const store = new RunStore(runsDir(flags));
  const bridges = new BridgeRegistry({
    mock: {
      failRate: Number(str(flags, "mock-fail-rate") ?? 0),
      invalidRate: Number(str(flags, "mock-invalid-rate") ?? 0),
      killRate: Number(str(flags, "mock-kill-rate") ?? 0.25),
      latencyMs: Number(str(flags, "mock-latency") ?? 60),
      seed: str(flags, "seed"),
      alwaysFail: str(flags, "mock-fail-nodes")?.split(",").filter(Boolean),
    },
    claudePath: str(flags, "claude-path"),
  });
  const quiet = Boolean(flags.quiet) || Boolean(flags.json);
  const onEvent = quiet ? undefined : (e: GrenEvent) => console.log(fmtEvent(e));
  const log = quiet ? undefined : (m: string) => console.error(`  | ${m}`);
  const gateWait: "block" | "return" = flags.wait === false || flags["no-wait"] ? "return" : "block";
  let runner: GraphRunner;
  if (resume === "fork") {
    const id = positional[0] ?? fail("usage: gren fork <run_id> --from node[,node] [--spec file] [--input JSON] [--id new_id]");
    const from = (str(flags, "from") ?? fail("--from <node[,node]> is required")).split(",").map((s) => s.trim()).filter(Boolean);
    const loaded = str(flags, "spec") ? loadGraph(str(flags, "spec")!) : undefined;
    runner = GraphRunner.fork({
      store,
      bridges,
      runId: id,
      from,
      newRunId: str(flags, "id"),
      spec: loaded?.spec,
      specFile: loaded?.file,
      input: flags.input !== undefined ? parseInput(str(flags, "input")) : undefined,
      bridge: str(flags, "bridge"),
      defaultBridge: defaultBridgeName(),
      onEvent,
      log,
      gateWait,
      cwd: loaded?.dir ?? process.cwd(),
    });
  } else if (resume) {
    const id = positional[0] ?? fail("usage: gren resume <run_id>");
    runner = GraphRunner.resume({ store, bridges, runId: id, bridge: str(flags, "bridge"), onEvent, log, gateWait, cwd: process.cwd() });
  } else {
    const specPath = positional[0] ?? fail("usage: gren run <spec.yaml> [--input '{...}'] [--bridge claude-code|api|inbox|mock]");
    const { spec, file, dir } = loadGraph(specPath);
    const a = analyze(spec);
    if (!a.ok) {
      console.error(formatAnalysis(a));
      fail(`graph has ${a.findings.filter((f) => f.level === "error").length} error(s); fix them before running`);
    }
    const input = parseInput(str(flags, "input"));
    runner = GraphRunner.create({
      store,
      bridges,
      spec,
      specFile: file,
      input,
      bridge: str(flags, "bridge"),
      defaultBridge: defaultBridgeName(),
      runId: str(flags, "id"),
      onEvent,
      log,
      gateWait,
      cwd: dir,
      labels: str(flags, "label") ? { label: str(flags, "label")! } : undefined,
    });
  }
  const autoApprove = Boolean(flags["auto-approve"]);
  const interactive = process.stdin.isTTY && !autoApprove && gateWait === "block" && !flags.json;
  // Gate handling: --auto-approve, or interactive prompt when attached to a terminal.
  const origOnEvent = onEvent;
  const gateHook = (e: GrenEvent) => {
    origOnEvent?.(e);
    if (e.type === "gate.waiting" && e.node) {
      if (autoApprove) {
        setTimeout(() => runner.approve(e.node!, "approved", "cli:auto-approve", "auto-approved by --auto-approve"), 10);
      } else if (interactive) {
        void askGate(runner, e.node, String(e.data?.title ?? e.node), e.data?.prompt as string | undefined, e.data?.show, { approve: e.data?.approve_effect as string | undefined, reject: e.data?.reject_effect as string | undefined });
      } else {
        console.error(`gate "${e.node}" is waiting. Approve from another terminal: gren approve ${runner.id} ${e.node}`);
      }
    }
  };
  (runner as unknown as { opts: { onEvent?: (e: GrenEvent) => void } }).opts.onEvent = gateHook;
  process.on("SIGINT", () => {
    console.error("\ninterrupted - checkpointing; resume with: gren resume " + runner.id);
    runner.cancel("SIGINT");
  });
  if (!quiet) console.log(`run ${runner.id} started (runs dir ${store.root})`);
  const state = await runner.run();
  if (flags.json) {
    console.log(JSON.stringify({ run: { ...state.run, spec: undefined }, nodes: state.nodes, metrics: computeMetricsDeep(store, state.run.id) }, null, 2));
  } else {
    console.log("");
    printStatus(state, store);
    if (state.run.status === "completed") {
      console.log("");
      console.log(formatMetrics(computeMetricsDeep(store, state.run.id)));
      console.log("");
      console.log("Output:");
      console.log(JSON.stringify(state.run.output, null, 2).slice(0, 6000));
    }
  }
  process.exit(state.run.status === "completed" ? 0 : state.run.status === "paused" ? 2 : 1);
}

function cmdApprove(positional: string[], flags: Flags) {
  const [runId, gate] = positional;
  if (!runId || !gate) fail("usage: gren approve <run_id> <gate> [--reject] [--by NAME] [--comment TEXT]");
  const store = new RunStore(runsDir(flags));
  const state = store.load(runId);
  const node = state.run.spec.nodes.find((n) => n.id === gate);
  if (!node || node.kind !== "gate") fail(`"${gate}" is not a gate node in run ${runId}`);
  const approval = { gate, decision: flags.reject ? ("rejected" as const) : ("approved" as const), by: str(flags, "by") ?? process.env.USER ?? process.env.USERNAME ?? "human", comment: str(flags, "comment"), at: nowIso() };
  store.writeApproval(runId, approval);
  console.log(`${approval.decision} gate "${gate}" on ${runId} (by ${approval.by}). ${state.run.status === "paused" ? "If no engine process is attached, continue with: gren resume " + runId : ""}`);
}

function cmdTasks(positional: string[], flags: Flags) {
  const store = new RunStore(runsDir(flags));
  const tasks = positional[0] ? store.listTasksDeep(positional[0]) : store.listAllPendingTasks();
  if (flags.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (!tasks.length) {
    console.log("no pending tasks");
    return;
  }
  for (const t of tasks) {
    console.log(`${t.run_id}  ${t.task_id}  node=${t.node_id}${t.item_index !== undefined ? `#${t.item_index}` : ""}  model=${t.model}${t.effort ? ` effort=${t.effort}` : ""}  role=${t.role}  status=${t.status}  timeout=${t.timeout_at}`);
  }
  console.log(`\n${tasks.length} task(s). Full prompts/schemas: gren tasks [run_id] --json`);
}

function cmdClaim(positional: string[], flags: Flags) {
  const [runId, taskId] = positional;
  if (!runId || !taskId) fail("usage: gren claim <run_id> <task_id> [--by NAME]");
  const store = new RunStore(runsDir(flags));
  const t = store.readTask(runId, taskId) ?? fail(`task ${taskId} not found in ${runId}`);
  if (store.readTaskResult(runId, taskId)) fail(`task ${taskId} already has a result; nothing to claim`, 3);
  if (t.status !== "pending" && !flags.force) fail(`task ${taskId} is ${t.status}${t.claimed_by ? ` by ${t.claimed_by}` : ""}; pick another task (or --force)`, 3);
  t.status = "claimed";
  t.claimed_by = str(flags, "by") ?? "worker";
  t.claimed_at = nowIso();
  store.writeTask(t);
  // re-read to detect a lost race (two workers writing within the same instant)
  const after = store.readTask(runId, taskId);
  if (after?.claimed_by !== t.claimed_by) fail(`task ${taskId} was claimed by ${after?.claimed_by} at the same time; pick another task`, 3);
  console.log(`claimed ${taskId} by ${t.claimed_by}`);
}

function cmdComplete(positional: string[], flags: Flags) {
  const [runId, taskId] = positional;
  if (!runId || !taskId) fail("usage: gren complete <run_id> <task_id> --result JSON|@file [--cost USD] [--model M] [--source orchestrator|human] [--error TEXT] [--force]");
  const store = new RunStore(runsDir(flags));
  const t = store.readTask(runId, taskId) ?? fail(`task ${taskId} not found in ${runId}`);
  if (store.readTaskResult(runId, taskId) && !flags.force) fail(`task ${taskId} already has a result (submitted by ${store.readTaskResult(runId, taskId)?.worker ?? "another worker"}); not overwriting (use --force)`, 3);
  if (t.status === "cancelled") fail(`task ${taskId} was cancelled by the engine (timed out or run ended); do not submit`, 3);
  const errorText = str(flags, "error");
  let output: unknown = undefined;
  if (!errorText) {
    output = parseInput(str(flags, "result") ?? fail("--result is required (JSON string or @file)"));
    const v = validateAgainst(t.output_schema, output);
    if (!v.ok && !flags.force) fail(`result does not match the task's output_schema:\n  - ${v.errors.join("\n  - ")}\n(use --force to submit anyway; the engine will reject it and retry)`);
  }
  store.writeTaskResult(runId, {
    task_id: taskId,
    output,
    error: errorText,
    cost_usd: flags.cost !== undefined ? Number(flags.cost) : undefined,
    model: str(flags, "model"),
    source: (str(flags, "source") as "orchestrator" | "human" | undefined) ?? "orchestrator",
    worker: str(flags, "by"),
    completed_at: nowIso(),
  });
  console.log(`submitted result for ${taskId}${errorText ? " (as failure)" : ""}`);
}

function cmdAnalyze(positional: string[], flags: Flags, strict: boolean) {
  const specPath = positional[0] ?? fail(`usage: gren ${strict ? "validate" : "analyze"} <spec.yaml>`);
  try {
    const { spec } = loadGraph(specPath);
    const a = analyze(spec);
    if (flags.json) console.log(JSON.stringify(a, null, 2));
    else console.log(formatAnalysis(a));
    if (!a.ok) process.exit(1);
    if (strict && !flags.json) console.log(`\nOK: ${spec.name} is valid (${a.findings.filter((f) => f.level === "warning").length} warning(s)).`);
  } catch (e) {
    if (e instanceof SpecError) fail(`${e.message}\n  - ${e.issues.join("\n  - ")}`);
    throw e;
  }
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "validate":
      return cmdAnalyze(positional, flags, true);
    case "analyze":
      return cmdAnalyze(positional, flags, false);
    case "run":
      return cmdRun(positional, flags, false);
    case "resume":
      return cmdRun(positional, flags, true);
    case "fork":
      return cmdRun(positional, flags, "fork");
    case "approve":
      return cmdApprove(positional, flags);
    case "tasks":
      return cmdTasks(positional, flags);
    case "claim":
      return cmdClaim(positional, flags);
    case "complete":
      return cmdComplete(positional, flags);
    case "status": {
      const store = new RunStore(runsDir(flags));
      const state = store.load(positional[0] ?? fail("usage: gren status <run_id>"));
      if (flags.json) console.log(JSON.stringify({ run: { ...state.run, spec: undefined }, nodes: state.nodes, tasks: store.listTasksDeep(state.run.id) }, null, 2));
      else printStatus(state, store);
      return;
    }
    case "output": {
      const store = new RunStore(runsDir(flags));
      const state = store.load(positional[0] ?? fail("usage: gren output <run_id>"));
      console.log(JSON.stringify(state.run.output ?? null, null, 2));
      return;
    }
    case "events": {
      const store = new RunStore(runsDir(flags));
      const id = positional[0] ?? fail("usage: gren events <run_id> [--follow] [--json]");
      let last = 0;
      const dump = () => {
        for (const e of store.readEvents(id, last)) {
          last = e.seq;
          console.log(flags.json ? JSON.stringify(e) : `${e.ts} ${fmtEvent(e)}`);
        }
      };
      dump();
      if (flags.follow) {
        setInterval(() => {
          dump();
          const st = store.load(id).run.status;
          if (st === "completed" || st === "failed" || st === "cancelled") process.exit(0);
        }, 700);
      }
      return;
    }
    case "metrics": {
      const store = new RunStore(runsDir(flags));
      const id = positional[0] ?? fail("usage: gren metrics <run_id> [--json]");
      const m = computeMetricsDeep(store, id);
      console.log(flags.json ? JSON.stringify(m, null, 2) : formatMetrics(m));
      return;
    }
    case "list": {
      const store = new RunStore(runsDir(flags));
      const runs = store.list().filter((r) => flags.all || !r.parent);
      if (flags.json) return console.log(JSON.stringify(runs, null, 2));
      for (const r of runs) console.log(`${r.id.padEnd(44)} ${r.graph.padEnd(22)} ${r.status.padEnd(10)} $${r.cost_usd.toFixed(4).padStart(8)}  ${r.nodes.completed}/${r.nodes.total} done${r.nodes.waiting ? ` ${r.nodes.waiting} waiting` : ""}  ${r.created_at}`);
      if (!runs.length) console.log("no runs yet");
      return;
    }
    case "delete": {
      const store = new RunStore(runsDir(flags));
      const id = positional[0] ?? fail("usage: gren delete <run_id>");
      store.delete(id);
      console.log(`deleted ${id}`);
      return;
    }
    case "bridges": {
      const reg = new BridgeRegistry({});
      for (const b of await reg.status()) console.log(`${b.name.padEnd(12)} ${b.ok ? "available" : "unavailable"}  ${b.description}${b.reason ? `  (${b.reason})` : ""}`);
      console.log(`\ndefault: ${defaultBridgeName()}  (override with --bridge or GREN_BRIDGE)`);
      return;
    }
    case "reducers": {
      for (const name of Object.keys(builtinReducers)) console.log(name);
      return;
    }
    case "frozen": {
      for (const [k, v] of Object.entries(FROZEN_CONSTRAINTS)) console.log(`${k.padEnd(42)} ${v}`);
      return;
    }
    case "shapes": {
      for (const s of SHAPES) console.log(`${s.id.padEnd(14)} ${s.title}\n${s.diagram}\n  use for: ${s.use}\n`);
      return;
    }
    case "new": {
      const [shape, name] = positional;
      if (!shape || !name) fail(`usage: gren new <${SHAPES.map((s) => s.id).join("|")}> <name> [--out file.yaml]`);
      const yaml = scaffold(shape, name);
      const out = str(flags, "out");
      if (out) {
        fs.writeFileSync(out, yaml, "utf8");
        console.log(`wrote ${out}`);
      } else console.log(yaml);
      return;
    }
    case "ui": {
      const { startServer } = await import("../server/server.js");
      const port = Number(str(flags, "port") ?? process.env.GREN_PORT ?? 4545);
      await startServer({ store: new RunStore(runsDir(flags)), port, graphsDir: path.resolve(str(flags, "graphs") ?? "graphs"), bridgeOptions: { claudePath: str(flags, "claude-path") } });
      return;
    }
    case "mcp": {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer({ store: new RunStore(runsDir(flags)), graphsDir: path.resolve(str(flags, "graphs") ?? "graphs") });
      return;
    }
    case "help":
    default:
      console.log(`gren - Graph Engineering Runtime for Claude multi-agent systems

  gren validate <spec>                    schema + static analysis
  gren analyze <spec> [--json]            dependency test, critical path, width, cost, checklist
  gren run <spec> [--input JSON|@file] [--bridge claude-code|api|inbox|mock] [--auto-approve] [--no-wait] [--json]
  gren resume <run_id>                    continue from the last checkpoint
  gren fork <run_id> --from node[,node] [--spec file] [--input JSON]   re-run from those nodes, reuse upstream outputs
  gren status|events|metrics|output <run_id>
  gren approve <run_id> <gate> [--reject] [--comment TEXT]
  gren tasks [run_id] [--json]            pending inbox tasks for the orchestrator bridge
  gren complete <run_id> <task_id> --result JSON|@file
  gren list | delete <run_id>
  gren ui [--port 4545]                   dashboard + live monitoring + approvals
  gren mcp                                MCP server (stdio) exposing the same operations as tools
  gren bridges | reducers | frozen | shapes | new <shape> <name>

Runs live in ./runs (override: --runs DIR or GREN_RUNS). Mock knobs: --mock-fail-rate --mock-invalid-rate --mock-kill-rate --mock-fail-nodes a,b --seed`);
  }
}

main().catch((e) => {
  if (e instanceof SpecError) fail(`${e.message}\n  - ${e.issues.join("\n  - ")}`);
  fail(e instanceof Error ? (process.env.GREN_DEBUG ? e.stack ?? e.message : e.message) : String(e));
});
