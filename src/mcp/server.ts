/**
 * gren MCP server - the same operations as the CLI/dashboard, as tools any Claude agent can call.
 *
 * The important design point: with the `inbox` bridge the calling agent IS the execution layer.
 *   gren_run -> gren_wait -> gren_tasks -> (execute each task with a cheap subagent) -> gren_complete_task -> gren_wait ...
 * The engine still owns the graph: dependencies, parallelism, validation, retries, budgets, gates.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import YAML from "yaml";
import { RunStore, nowIso, type GrenEvent, type RunState } from "../engine/state.js";
import { analyze, formatAnalysis } from "../spec/analyze.js";
import { loadGraph, parseSpecText, SpecError } from "../spec/load.js";
import { computeMetricsDeep, formatMetrics } from "../metrics/metrics.js";
import { validateAgainst } from "../engine/validate.js";
import { createRunControl, listGraphs } from "../server/server.js";
import { SHAPES, scaffold } from "../cli/shapes.js";
import { FROZEN_CONSTRAINTS } from "../spec/schema.js";
import { builtinReducers } from "../reducers/builtin.js";
import { BRIDGE_NAMES } from "../bridges/registry.js";

export interface McpOptions {
  store: RunStore;
  graphsDir: string;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const jsonOut = (v: unknown) => text(JSON.stringify(v, null, 2));

function statusSummary(store: RunStore, state: RunState) {
  const nodes = Object.values(state.nodes).map((n) => ({
    id: n.id,
    kind: n.kind,
    status: n.status,
    duration_ms: n.duration_ms,
    cost_usd: Number(n.cost_usd.toFixed(5)),
    items: n.items ? `${n.items.filter((i) => i.status === "completed").length}/${n.items.length}` : undefined,
    kill_rate: n.verify?.kill_rate,
    route: n.route,
    gate: n.gate?.decision,
    error: n.error,
    skip_reason: n.skip_reason,
    retries: n.retries || undefined,
    repairs: n.repairs || undefined,
  }));
  const waiting_gates = Object.values(state.nodes)
    .filter((n) => n.status === "waiting_approval")
    .map((n) => {
      const spec = state.run.spec.nodes.find((s) => s.id === n.id);
      const art = n.artifact ? (store.readArtifact(state.run.id, n.artifact) as { title?: string; prompt?: string; show?: unknown; approve_effect?: string; reject_effect?: string } | undefined) : undefined;
      const g = spec as { title?: string; approve_effect?: string; reject_effect?: string } | undefined;
      return { gate: n.id, title: g?.title, prompt: art?.prompt, if_you_approve: g?.approve_effect ?? art?.approve_effect, if_you_reject: g?.reject_effect ?? art?.reject_effect, show: art?.show };
    });
  const tasks = store.listTasksDeep(state.run.id).map((t) => ({ task_id: t.task_id, run_id: t.run_id, node: t.node_id, item: t.item_index, model: t.model, effort: t.effort, role: t.role, status: t.status }));
  return {
    run_id: state.run.id,
    graph: state.run.graph,
    status: state.run.status,
    bridge: state.run.bridge,
    error: state.run.error,
    warnings: state.run.warnings,
    totals: state.run.totals,
    nodes,
    waiting_gates,
    pending_tasks: tasks,
    next_step:
      state.run.status === "completed"
        ? "run is complete: call gren_output / gren_metrics"
        : state.run.status === "failed" || state.run.status === "cancelled"
          ? "run ended: inspect gren_events / gren_node for the failing node, fix the graph, re-run"
          : tasks.length
            ? "execute the pending tasks (gren_tasks for full prompts) and submit each with gren_complete_task, then gren_wait"
            : waiting_gates.length
              ? "a human gate is waiting: decide with gren_approve (only if you are authorised to act as the approver)"
              : "call gren_wait to block until something needs you",
  };
}

export async function startMcpServer(o: McpOptions) {
  const { store } = o;
  const recent: GrenEvent[] = [];
  const log = (m: string) => process.stderr.write(`[gren-mcp] ${m}\n`);
  const control = createRunControl(store, o.graphsDir, {}, (e) => {
    recent.push(e);
    if (recent.length > 2000) recent.splice(0, recent.length - 2000);
  }, log);

  const server = new McpServer({ name: "gren", version: "0.1.0" }, {
    instructions:
      "gren runs graph-engineered multi-agent workflows. Typical loop: gren_validate -> gren_run (bridge inbox means YOU execute agent nodes) -> gren_wait -> gren_tasks -> run each task with a subagent using the task's model -> gren_complete_task -> gren_wait ... -> gren_output/gren_metrics. Load the graph-engineering skill for design guidance.",
  });

  server.registerTool("gren_shapes", { description: "List the five graph shapes (fork/join, escalation ladder, tournament, map-reduce-verify, bounded discovery loop) with diagrams and when to use them." }, async () => jsonOut(SHAPES.map((s) => ({ id: s.id, title: s.title, diagram: s.diagram, use: s.use }))));

  server.registerTool("gren_reference", { description: "Reference for writing graph specs: node kinds, reference syntax, failure policy, frozen constraints, built-in reducers, bridges. Read this before authoring a graph." }, async () => {
    const candidates = [path.resolve(o.graphsDir, "..", "docs", "SPEC.md"), path.resolve(process.cwd(), "docs", "SPEC.md")];
    const doc = candidates.find((f) => fs.existsSync(f));
    const body = doc ? fs.readFileSync(doc, "utf8") : "(docs/SPEC.md not found)";
    return text(`${body}\n\n## Frozen constraints\n${Object.entries(FROZEN_CONSTRAINTS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n## Built-in reducers\n${Object.keys(builtinReducers).join(", ")}\n\n## Bridges\n${BRIDGE_NAMES.join(", ")}`);
  });

  server.registerTool("gren_scaffold", { description: "Generate a starter graph spec (YAML) for a shape.", inputSchema: { shape: z.enum(SHAPES.map((s) => s.id) as [string, ...string[]]), name: z.string() } }, async ({ shape, name }) => text(scaffold(shape, name)));

  server.registerTool(
    "gren_validate",
    { description: "Validate a graph spec (path or YAML text): schema, derived edges (what data crosses each), cycle check, frozen constraints, dependency-test warnings, estimated critical path/cost, checklist. Fix every error before running.", inputSchema: { spec_path: z.string().optional(), spec_yaml: z.string().optional() } },
    async ({ spec_path, spec_yaml }) => {
      try {
        const spec = spec_yaml ? parseSpecText(spec_yaml) : loadGraph(path.isAbsolute(spec_path ?? "") ? spec_path! : path.resolve(o.graphsDir, spec_path ?? "")).spec;
        const a = analyze(spec);
        return text(`${formatAnalysis(a)}\n\nJSON:\n${JSON.stringify({ ok: a.ok, findings: a.findings, edges: a.edges, critical_path: a.critical_path, max_width: a.max_width, est_cost_usd: a.est_cost_usd }, null, 2)}`);
      } catch (e) {
        if (e instanceof SpecError) return text(`INVALID: ${e.message}\n${e.issues.map((i) => `  - ${i}`).join("\n")}`);
        return text(`INVALID: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "gren_write_graph",
    { description: "Validate a YAML graph spec and write it to a file (relative paths resolve inside the graphs dir). Refuses to write specs with errors.", inputSchema: { path: z.string(), spec_yaml: z.string() } },
    async ({ path: p, spec_yaml }) => {
      const spec = parseSpecText(spec_yaml);
      const a = analyze(spec);
      if (!a.ok) return text(`NOT WRITTEN - errors:\n${formatAnalysis(a)}`);
      const file = path.isAbsolute(p) ? p : path.resolve(o.graphsDir, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, spec_yaml, "utf8");
      return text(`wrote ${file}\n${formatAnalysis(a)}`);
    },
  );

  server.registerTool("gren_list_graphs", { description: "List graph specs available in the graphs directory with a validation summary." }, async () => jsonOut(listGraphs(o.graphsDir)));

  server.registerTool(
    "gren_run",
    {
      description:
        "Start a run (in the background, inside this MCP process). bridge: 'inbox' (default) = agent nodes become tasks that YOU execute (gren_wait/gren_tasks/gren_complete_task); 'api' = Anthropic API key; 'claude-code' = headless Claude Code sessions; 'mock' = no tokens. Returns run_id immediately.",
      inputSchema: {
        spec_path: z.string().optional(),
        spec_yaml: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        bridge: z.enum(BRIDGE_NAMES as unknown as [string, ...string[]]).optional(),
        run_id: z.string().optional(),
        auto_approve: z.boolean().optional().describe("auto-approve human gates (demos/tests only)"),
      },
    },
    async ({ spec_path, spec_yaml, input, bridge, run_id, auto_approve }) => {
      const r = await control.start({ specPath: spec_path, specYaml: spec_yaml, input: input ?? {}, bridge: bridge ?? process.env.GREN_BRIDGE ?? "inbox", runId: run_id, autoApprove: auto_approve });
      await new Promise((res) => setTimeout(res, 300));
      return jsonOut({ ...r, ...statusSummary(store, store.load(r.run_id)) });
    },
  );

  server.registerTool("gren_status", { description: "Current state of a run: node table, waiting gates, pending tasks, totals, and the suggested next step.", inputSchema: { run_id: z.string() } }, async ({ run_id }) => jsonOut(statusSummary(store, store.load(run_id))));

  server.registerTool(
    "gren_wait",
    { description: "Block until the run needs attention: pending inbox tasks exist, a gate is waiting, or the run finished. Returns the same summary as gren_status. Use timeout_ms up to 120000.", inputSchema: { run_id: z.string(), timeout_ms: z.number().int().min(100).max(120000).optional() } },
    async ({ run_id, timeout_ms }) => {
      const deadline = Date.now() + (timeout_ms ?? 30000);
      while (true) {
        const st = store.load(run_id);
        const tasks = store.listTasksDeep(run_id);
        const gates = Object.values(st.nodes).some((n) => n.status === "waiting_approval");
        const terminal = st.run.status === "completed" || st.run.status === "failed" || st.run.status === "cancelled";
        if (tasks.length || gates || terminal || Date.now() >= deadline) return jsonOut({ ...statusSummary(store, st), timed_out: !tasks.length && !gates && !terminal });
        await new Promise((r) => setTimeout(r, 400));
      }
    },
  );

  server.registerTool(
    "gren_tasks",
    { description: "Pending inbox tasks (full prompt, system prompt, JSON schema, model, effort) for a run - or all runs. Execute each with the requested model (e.g. spawn a subagent with that model), then gren_complete_task.", inputSchema: { run_id: z.string().optional(), include_claimed: z.boolean().optional() } },
    async ({ run_id }) => jsonOut(run_id ? store.listTasksDeep(run_id) : store.listAllPendingTasks()),
  );

  server.registerTool(
    "gren_claim_task",
    { description: "Mark an inbox task as claimed by a worker (optional bookkeeping so parallel workers do not double-execute).", inputSchema: { run_id: z.string(), task_id: z.string(), worker: z.string().optional() } },
    async ({ run_id, task_id, worker }) => {
      const t = store.readTask(run_id, task_id);
      if (!t) return text(`task ${task_id} not found in ${run_id}`);
      if (store.readTaskResult(run_id, task_id)) return jsonOut({ ok: false, reason: "already has a result" });
      if (t.status !== "pending") return jsonOut({ ok: false, reason: `task is ${t.status}${t.claimed_by ? ` by ${t.claimed_by}` : ""}` });
      t.status = "claimed";
      t.claimed_by = worker ?? "mcp";
      t.claimed_at = nowIso();
      store.writeTask(t);
      const after = store.readTask(run_id, task_id);
      if (after?.claimed_by !== t.claimed_by) return jsonOut({ ok: false, reason: `lost a claim race to ${after?.claimed_by}` });
      return jsonOut({ ok: true, task_id, claimed_by: t.claimed_by });
    },
  );

  server.registerTool(
    "gren_complete_task",
    {
      description: "Submit the result of an inbox task. `output` must validate against the task's output_schema (validated here; the engine validates again). Report cost_usd/model/source honestly so the run's metrics are real. Use `error` to report that the task could not be done (the engine applies the node's failure policy).",
      inputSchema: {
        run_id: z.string(),
        task_id: z.string(),
        output: z.unknown().optional(),
        error: z.string().optional(),
        cost_usd: z.number().optional(),
        model: z.string().optional(),
        source: z.enum(["orchestrator", "subagent", "human", "api"]).optional(),
        worker: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ run_id, task_id, output, error, cost_usd, model, source, worker, force }) => {
      const t = store.readTask(run_id, task_id);
      if (!t) return text(`task ${task_id} not found in ${run_id}`);
      if (t.status === "completed" || store.readTaskResult(run_id, task_id)) return text(`task ${task_id} already has a result; not overwriting`);
      if (t.status === "cancelled") return text(`task ${task_id} was cancelled by the engine (timed out or run ended); do not submit`);
      if (error === undefined) {
        const v = validateAgainst(t.output_schema, output);
        if (!v.ok && !force) return text(`REJECTED - output does not match output_schema:\n${v.errors.map((e) => `  - ${e}`).join("\n")}\nFix the output and submit again (or set force=true to let the engine reject it and apply the failure policy).`);
      }
      store.writeTaskResult(run_id, { task_id, output, error, cost_usd, model: model ?? t.model, source: source ?? "orchestrator", worker: worker ?? "mcp-client", completed_at: nowIso() });
      return jsonOut({ ok: true, task_id, remaining: store.listTasksDeep(run_id.split("/nested/")[0]!).length });
    },
  );

  server.registerTool(
    "gren_approve",
    { description: "Record a human gate decision. Only call this when the human you are acting for has actually decided (or the run was started for a demo with explicit permission).", inputSchema: { run_id: z.string(), gate: z.string(), decision: z.enum(["approved", "rejected"]), by: z.string().optional(), comment: z.string().optional() } },
    async ({ run_id, gate, decision, by, comment }) => {
      control.approve(run_id, gate, decision, by ?? "mcp-client", comment);
      const st = store.load(run_id);
      if (!control.runners.has(run_id) && st.run.status === "paused") await control.resume(run_id);
      return jsonOut({ ok: true, gate, decision });
    },
  );

  server.registerTool("gren_resume", { description: "Resume a checkpointed run (paused/failed/interrupted) inside this process.", inputSchema: { run_id: z.string(), bridge: z.string().optional() } }, async ({ run_id, bridge }) => jsonOut(await control.resume(run_id, bridge)));
  server.registerTool("gren_cancel", { description: "Cancel an in-process run.", inputSchema: { run_id: z.string() } }, async ({ run_id }) => jsonOut({ cancelled: control.cancel(run_id) }));
  server.registerTool(
    "gren_fork",
    { description: "Fork a finished/paused run and re-execute from the given nodes (they and everything downstream re-run; upstream outputs are reused). Optionally supply an edited spec (YAML) - the developer loop for iterating on late nodes without paying for the whole graph again.", inputSchema: { run_id: z.string(), from: z.array(z.string()).min(1), spec_yaml: z.string().optional(), input: z.record(z.string(), z.unknown()).optional(), bridge: z.string().optional(), new_run_id: z.string().optional() } },
    async ({ run_id, from, spec_yaml, input, bridge, new_run_id }) => {
      const { GraphRunner } = await import("../engine/scheduler.js");
      const { BridgeRegistry, defaultBridgeName } = await import("../bridges/registry.js");
      const spec = spec_yaml ? parseSpecText(spec_yaml) : undefined;
      const runner = GraphRunner.fork({ store, bridges: new BridgeRegistry({}), runId: run_id, from, newRunId: new_run_id, spec, input, bridge: bridge ?? process.env.GREN_BRIDGE ?? "inbox", defaultBridge: defaultBridgeName(), onEvent: (e) => recent.push(e), log, gateWait: "block" });
      control.runners.set(runner.id, runner);
      runner.run().catch((err) => log(`fork ${runner.id} crashed: ${(err as Error).message}`)).finally(() => control.runners.delete(runner.id));
      await new Promise((r) => setTimeout(r, 300));
      return jsonOut({ ...statusSummary(store, store.load(runner.id)), forked_from: run_id });
    },
  );
  server.registerTool("gren_list_runs", { description: "List runs (newest first).", inputSchema: { include_nested: z.boolean().optional() } }, async ({ include_nested }) => jsonOut(store.list().filter((r) => include_nested || !r.parent)));
  server.registerTool("gren_output", { description: "Final output of a completed run.", inputSchema: { run_id: z.string() } }, async ({ run_id }) => {
    const st = store.load(run_id);
    return jsonOut({ status: st.run.status, output: st.run.output, warnings: st.run.warnings, error: st.run.error });
  });
  server.registerTool("gren_metrics", { description: "Graph-shaped metrics: critical path, parallel speedup, width, failure/retry rate, verifier kill rate, fan-out efficiency, compression, human intervention, cost by model, hints.", inputSchema: { run_id: z.string(), format: z.enum(["text", "json"]).optional() } }, async ({ run_id, format }) => {
    const st = store.load(run_id);
    const m = computeMetricsDeep(store, run_id);
    return format === "json" ? jsonOut(m) : text(formatMetrics(m));
  });
  server.registerTool("gren_events", { description: "Event log of a run (after a sequence number).", inputSchema: { run_id: z.string(), after: z.number().int().optional(), limit: z.number().int().optional() } }, async ({ run_id, after, limit }) => {
    const evs = store.readEvents(run_id, after ?? 0);
    return jsonOut(evs.slice(-(limit ?? 200)));
  });
  server.registerTool("gren_node", { description: "Full record of one node in a run, including its prompts and raw outputs (artifacts) - for debugging a node.", inputSchema: { run_id: z.string(), node_id: z.string(), include_artifacts: z.boolean().optional() } }, async ({ run_id, node_id, include_artifacts }) => {
    const st = store.load(run_id);
    const rec = st.nodes[node_id];
    if (!rec) return text(`node ${node_id} not found`);
    const artifacts = include_artifacts === false ? undefined : rec.attempts.filter((a) => a.artifact).map((a) => ({ attempt: a.attempt, item: a.item, artifact: store.readArtifact(run_id, a.artifact!) }));
    return jsonOut({ node: rec, spec: st.run.spec.nodes.find((n) => n.id === node_id), decisions: st.run.decisions.filter((d) => d.node === node_id), artifacts });
  });
  server.registerTool("gren_decisions", { description: "Every routing / gate / verify / loop / failure decision of a run with the state that produced it (why did the system choose this route?).", inputSchema: { run_id: z.string() } }, async ({ run_id }) => jsonOut(store.load(run_id).run.decisions));
  server.registerTool("gren_spec", { description: "The frozen spec snapshot of a run as YAML.", inputSchema: { run_id: z.string() } }, async ({ run_id }) => text(YAML.stringify(store.load(run_id).run.spec)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`gren MCP server ready (runs: ${store.root}, graphs: ${o.graphsDir})`);
  await new Promise(() => {});
}
