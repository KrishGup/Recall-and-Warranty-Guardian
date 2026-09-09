/**
 * gren dashboard server: REST + Server-Sent Events over the run store, plus in-process run control.
 *
 *   GET  /                                  dashboard
 *   GET  /api/runs?all=1                    run summaries (nested runs when all=1)
 *   GET  /api/run?id=                       run state + analysis + metrics + tasks + spec yaml
 *   GET  /api/run/events?id=&after=         events after seq
 *   GET  /api/run/artifact?id=&path=        an artifact (prompt / raw output)
 *   GET  /api/run/tasks?id=                 pending inbox tasks (deep)
 *   POST /api/run/approve   {id, gate, decision, by?, comment?}
 *   POST /api/run/task      {id, task_id, output?, error?, cost_usd?, model?, source?, worker?}
 *   POST /api/run/resume    {id}            resume a checkpointed run in this process
 *   POST /api/run/cancel    {id}
 *   POST /api/runs          {graph|spec_yaml, input, bridge?, auto_approve?, mock?}   start a run here
 *   GET  /api/graphs                        graphs in the graphs dir with analysis summaries
 *   GET  /api/graph?path=                   full analysis + yaml
 *   GET  /api/bridges | /api/shapes | /api/events (SSE)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { RunStore, nowIso, type GrenEvent } from "../engine/state.js";
import { GraphRunner } from "../engine/scheduler.js";
import { analyze } from "../spec/analyze.js";
import { loadGraph, loadGraphFromObject, parseSpecText } from "../spec/load.js";
import { computeMetrics } from "../metrics/metrics.js";
import { BridgeRegistry, defaultBridgeName, type BridgeRegistryOptions } from "../bridges/registry.js";
import { validateAgainst } from "../engine/validate.js";
import { SHAPES } from "../cli/shapes.js";
import { FROZEN_CONSTRAINTS } from "../spec/schema.js";
import { builtinReducers } from "../reducers/builtin.js";

export interface ServerOptions {
  store: RunStore;
  port: number;
  host?: string;
  graphsDir: string;
  bridgeOptions?: BridgeRegistryOptions;
  /** Called for every event from in-process runs (in addition to SSE). */
  onEvent?: (e: GrenEvent) => void;
  quiet?: boolean;
}

export interface RunControl {
  start(o: { specPath?: string; specYaml?: string; input: unknown; bridge?: string; runId?: string; autoApprove?: boolean }): Promise<{ run_id: string }>;
  resume(runId: string, bridge?: string): Promise<{ run_id: string }>;
  approve(runId: string, gate: string, decision: "approved" | "rejected", by: string, comment?: string): void;
  cancel(runId: string): boolean;
  runners: Map<string, GraphRunner>;
}

/** Shared run-control used by the HTTP server and the MCP server (both keep runs in-process). */
export function createRunControl(store: RunStore, graphsDir: string, bridgeOptions: BridgeRegistryOptions, emit: (e: GrenEvent) => void, log: (m: string) => void): RunControl {
  const runners = new Map<string, GraphRunner>();
  const bridges = new BridgeRegistry(bridgeOptions);
  const autoApproveRuns = new Set<string>();
  const onEvent = (e: GrenEvent) => {
    emit(e);
    if (e.type === "gate.waiting" && e.node && autoApproveRuns.has(e.run_id)) {
      const r = runners.get(e.run_id);
      if (r) setTimeout(() => r.approve(e.node!, "approved", "auto-approve", "auto-approved (run started with auto_approve)"), 10);
    }
  };
  const track = (runner: GraphRunner) => {
    runners.set(runner.id, runner);
    runner
      .run()
      .catch((err) => log(`run ${runner.id} crashed: ${(err as Error).message}`))
      .finally(() => {
        runners.delete(runner.id);
        autoApproveRuns.delete(runner.id);
      });
  };
  return {
    runners,
    async start(o) {
      let loaded;
      if (o.specYaml) loaded = loadGraphFromObject(YAML.parse(o.specYaml), graphsDir);
      else if (o.specPath) loaded = loadGraph(path.isAbsolute(o.specPath) ? o.specPath : path.resolve(graphsDir, o.specPath));
      else throw new Error("graph (path) or spec_yaml is required");
      const runner = GraphRunner.create({
        store,
        bridges,
        spec: loaded.spec,
        specFile: loaded.file,
        input: o.input ?? {},
        bridge: o.bridge,
        defaultBridge: defaultBridgeName(),
        runId: o.runId,
        onEvent,
        log,
        gateWait: "block",
        cwd: loaded.dir,
      });
      if (o.autoApprove) autoApproveRuns.add(runner.id);
      track(runner);
      return { run_id: runner.id };
    },
    async resume(runId, bridge) {
      if (runners.has(runId)) return { run_id: runId };
      const runner = GraphRunner.resume({ store, bridges, runId, bridge, onEvent, log, gateWait: "block" });
      track(runner);
      return { run_id: runId };
    },
    approve(runId, gate, decision, by, comment) {
      const r = runners.get(runId);
      if (r) r.approve(gate, decision, by, comment);
      else store.writeApproval(runId, { gate, decision, by, comment, at: nowIso() });
    },
    cancel(runId) {
      const r = runners.get(runId);
      if (!r) return false;
      r.cancel("cancelled from dashboard");
      return true;
    },
  };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export function listGraphs(graphsDir: string) {
  if (!fs.existsSync(graphsDir)) return [];
  return fs
    .readdirSync(graphsDir)
    .filter((f) => /\.(ya?ml|json)$/.test(f))
    .map((f) => {
      const file = path.join(graphsDir, f);
      try {
        const { spec } = loadGraph(file);
        const a = analyze(spec);
        return { path: f, file, name: spec.name, description: spec.description, goal: spec.goal, nodes: spec.nodes.length, ok: a.ok, errors: a.findings.filter((x) => x.level === "error").length, warnings: a.findings.filter((x) => x.level === "warning").length, input_schema: spec.input_schema, budget: spec.budget, defaults: spec.defaults };
      } catch (e) {
        return { path: f, file, name: f, error: (e as Error).message, ok: false, nodes: 0, errors: 1, warnings: 0 };
      }
    });
}

export async function startServer(o: ServerOptions): Promise<http.Server> {
  const { store } = o;
  const clients = new Set<http.ServerResponse>();
  const log = o.quiet ? () => {} : (m: string) => console.error(`[gren] ${m}`);
  const broadcast = (e: GrenEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(line);
    o.onEvent?.(e);
  };
  const control = createRunControl(store, o.graphsDir, o.bridgeOptions ?? {}, broadcast, log);

  // Tail events of runs executed by OTHER processes (CLI / MCP) so the dashboard stays live.
  const lastSeq = new Map<string, number>();
  setInterval(() => {
    try {
      for (const r of store.list()) {
        if (control.runners.has(r.id)) continue;
        const active = r.status === "running" || r.status === "paused" || r.status === "created";
        const seen = lastSeq.get(r.id);
        if (!active && seen === undefined) {
          // finished before we ever saw it (fast mock runs, runs from before startup): register silently, announce once
          const evs = store.readEvents(r.id, 0);
          lastSeq.set(r.id, evs.length ? evs[evs.length - 1]!.seq : 0);
          lastSeq.set(`${r.id}:final`, 1);
          if (Date.now() - new Date(r.updated_at).getTime() < 15000) broadcast({ ts: nowIso(), seq: 0, run_id: r.id, type: "run.discovered", data: { status: r.status, graph: r.graph } });
          continue;
        }
        if (!active && seen !== undefined && seen >= 0 && !lastSeq.has(`${r.id}:final`)) {
          // one last flush after the run ended
          for (const e of store.readEvents(r.id, seen)) {
            lastSeq.set(r.id, e.seq);
            broadcast(e);
          }
          lastSeq.set(`${r.id}:final`, 1);
          continue;
        }
        if (!active) continue;
        if (seen === undefined) {
          const evs = store.readEvents(r.id, 0);
          lastSeq.set(r.id, evs.length ? evs[evs.length - 1]!.seq : 0);
          broadcast({ ts: nowIso(), seq: 0, run_id: r.id, type: "run.discovered", data: { status: r.status, graph: r.graph } });
          continue;
        }
        for (const e of store.readEvents(r.id, seen)) {
          lastSeq.set(r.id, e.seq);
          broadcast(e);
        }
      }
    } catch (e) {
      log(`poll error: ${(e as Error).message}`);
    }
  }, 1000).unref();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDir = [path.join(here, "..", "ui"), path.join(here, "..", "..", "src", "ui")].find((d) => fs.existsSync(path.join(d, "index.html"))) ?? path.join(here, "..", "ui");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
        return res.end();
      }
      if (p === "/" || p === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(path.join(uiDir, "index.html")));
      }
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(`data: ${JSON.stringify({ type: "hello", ts: nowIso(), seq: 0, run_id: "" })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (p === "/api/runs" && req.method === "GET") {
        const all = q("all") === "1";
        const runs = store.list().filter((r) => all || !r.parent).map((r) => ({ ...r, in_process: control.runners.has(r.id) }));
        return json(res, 200, runs);
      }
      if (p === "/api/runs" && req.method === "POST") {
        const body = await readBody(req);
        const r = await control.start({
          specPath: typeof body.graph === "string" ? body.graph : undefined,
          specYaml: typeof body.spec_yaml === "string" ? body.spec_yaml : undefined,
          input: body.input ?? {},
          bridge: typeof body.bridge === "string" && body.bridge ? body.bridge : undefined,
          runId: typeof body.run_id === "string" ? body.run_id : undefined,
          autoApprove: Boolean(body.auto_approve),
        });
        return json(res, 200, r);
      }
      if (p === "/api/run" && req.method === "GET") {
        const id = q("id");
        if (!id) return json(res, 400, { error: "id required" });
        const state = store.load(id);
        const events = store.readEvents(id);
        return json(res, 200, {
          run: state.run,
          nodes: state.nodes,
          analysis: analyze(state.run.spec),
          metrics: computeMetrics(state, events),
          tasks: store.listTasksDeep(id),
          spec_yaml: YAML.stringify(state.run.spec),
          in_process: control.runners.has(id),
          events_count: events.length,
        });
      }
      if (p === "/api/run/events") {
        const id = q("id");
        if (!id) return json(res, 400, { error: "id required" });
        return json(res, 200, store.readEvents(id, Number(q("after") ?? 0)));
      }
      if (p === "/api/run/artifact") {
        const id = q("id");
        const rel = q("path");
        if (!id || !rel || rel.includes("..")) return json(res, 400, { error: "id and path required" });
        return json(res, 200, store.readArtifact(id, rel) ?? null);
      }
      if (p === "/api/run/tasks") {
        const id = q("id");
        return json(res, 200, id ? store.listTasksDeep(id) : store.listAllPendingTasks());
      }
      if (p === "/api/run/approve" && req.method === "POST") {
        const b = await readBody(req);
        const id = String(b.id ?? "");
        const gate = String(b.gate ?? "");
        const decision = b.decision === "rejected" ? "rejected" : "approved";
        control.approve(id, gate, decision, String(b.by ?? "dashboard"), typeof b.comment === "string" ? b.comment : undefined);
        // If nobody is running this run in-process, resume it here so the decision takes effect.
        const st = store.load(id);
        if (!control.runners.has(id) && (st.run.status === "paused" || st.run.status === "created")) await control.resume(id);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/run/task" && req.method === "POST") {
        const b = await readBody(req);
        const id = String(b.id ?? "");
        const taskId = String(b.task_id ?? "");
        const task = store.readTask(id, taskId);
        if (!task) return json(res, 404, { error: `task ${taskId} not found` });
        if (b.error === undefined) {
          const v = validateAgainst(task.output_schema, b.output);
          if (!v.ok && !b.force) return json(res, 400, { error: "output does not match output_schema", details: v.errors });
        }
        store.writeTaskResult(id, {
          task_id: taskId,
          output: b.output,
          error: typeof b.error === "string" ? b.error : undefined,
          cost_usd: typeof b.cost_usd === "number" ? b.cost_usd : undefined,
          model: typeof b.model === "string" ? b.model : undefined,
          source: (b.source as "human" | "orchestrator" | undefined) ?? "human",
          worker: typeof b.worker === "string" ? b.worker : "dashboard",
          completed_at: nowIso(),
        });
        return json(res, 200, { ok: true });
      }
      if (p === "/api/run/resume" && req.method === "POST") {
        const b = await readBody(req);
        return json(res, 200, await control.resume(String(b.id ?? ""), typeof b.bridge === "string" ? b.bridge : undefined));
      }
      if (p === "/api/run/fork" && req.method === "POST") {
        const b = await readBody(req);
        const from = Array.isArray(b.from) ? (b.from as string[]) : String(b.from ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!from.length) return json(res, 400, { error: "from (node ids) required" });
        const runner = GraphRunner.fork({ store, bridges: new BridgeRegistry(o.bridgeOptions ?? {}), runId: String(b.id ?? ""), from, newRunId: typeof b.new_id === "string" ? b.new_id : undefined, bridge: typeof b.bridge === "string" && b.bridge ? b.bridge : undefined, defaultBridge: defaultBridgeName(), onEvent: broadcast, log, gateWait: "block" });
        control.runners.set(runner.id, runner);
        runner.run().catch((err) => log(`fork ${runner.id} crashed: ${(err as Error).message}`)).finally(() => control.runners.delete(runner.id));
        return json(res, 200, { run_id: runner.id });
      }
      if (p === "/api/run/cancel" && req.method === "POST") {
        const b = await readBody(req);
        return json(res, 200, { ok: control.cancel(String(b.id ?? "")) });
      }
      if (p === "/api/run/delete" && req.method === "POST") {
        const b = await readBody(req);
        const id = String(b.id ?? "");
        if (control.runners.has(id)) return json(res, 409, { error: "run is executing in this process; cancel it first" });
        store.delete(id);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/graphs") return json(res, 200, listGraphs(o.graphsDir));
      if (p === "/api/graph") {
        const gp = q("path");
        if (!gp) return json(res, 400, { error: "path required" });
        const file = path.isAbsolute(gp) ? gp : path.resolve(o.graphsDir, gp);
        const { spec } = loadGraph(file);
        return json(res, 200, { spec, analysis: analyze(spec), yaml: fs.readFileSync(file, "utf8") });
      }
      if (p === "/api/graph/validate" && req.method === "POST") {
        const b = await readBody(req);
        try {
          const spec = parseSpecText(String(b.spec_yaml ?? ""));
          return json(res, 200, { ok: true, analysis: analyze(spec) });
        } catch (e) {
          return json(res, 200, { ok: false, error: (e as Error).message, issues: (e as { issues?: string[] }).issues ?? [] });
        }
      }
      if (p === "/api/bridges") {
        const reg = new BridgeRegistry(o.bridgeOptions ?? {});
        return json(res, 200, { default: defaultBridgeName(), bridges: await reg.status() });
      }
      if (p === "/api/shapes") return json(res, 200, SHAPES.map((s) => ({ id: s.id, title: s.title, diagram: s.diagram, use: s.use })));
      if (p === "/api/reference") return json(res, 200, { frozen: FROZEN_CONSTRAINTS, reducers: Object.keys(builtinReducers) });
      json(res, 404, { error: `no route ${req.method} ${p}` });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(o.port, o.host ?? "127.0.0.1", resolve));
  if (!o.quiet) console.log(`gren dashboard: http://${o.host ?? "127.0.0.1"}:${o.port}  (runs: ${store.root}, graphs: ${o.graphsDir})`);
  return server;
}
