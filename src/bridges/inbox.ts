/**
 * Inbox (orchestrator) bridge.
 *
 * The engine does not call a model. It writes a task file and waits. An external worker - typically a
 * Claude Code session holding the gren MCP tools (or `gren tasks` / `gren complete` on the CLI) - claims
 * the task, executes it with whatever it has (its own Agent tool with a cheap model, a human, an API),
 * and posts a schema-validated result. This is how the graph runs on a Claude Code subscription with no
 * API key, and how a human can act as a node.
 *
 * The engine still owns validation, retries, budgets, timeouts and fan-out width: the worker just answers.
 */
import crypto from "node:crypto";
import { BridgeError, contractPreamble, type AgentRequest, type AgentResponse, type Bridge, type BridgeContext } from "./types.js";
import type { InboxTask } from "../engine/state.js";

export interface InboxOptions {
  pollMs?: number;
  /** Workers are humans or orchestrating agents: never wait less than this (default 30 min) regardless of the node's timeout_ms. */
  minTimeoutMs?: number;
}

export class InboxBridge implements Bridge {
  readonly name = "inbox";
  constructor(private opts: InboxOptions = {}) {}

  describe() {
    return "orchestrator inbox: tasks are executed by an external worker (Claude Code session via MCP, CLI, or a human)";
  }

  async available() {
    return { ok: true };
  }

  async execute(req: AgentRequest, ctx: BridgeContext): Promise<AgentResponse> {
    const start = Date.now();
    const timeoutMs = Math.max(req.timeout_ms, this.opts.minTimeoutMs ?? 30 * 60 * 1000);
    const task_id = `${req.node_id}${req.item_index !== undefined ? `-i${req.item_index}` : ""}-a${req.attempt}-${crypto.randomBytes(2).toString("hex")}`;
    const task: InboxTask = {
      task_id,
      run_id: req.run_id,
      node_id: req.node_id,
      item_index: req.item_index,
      attempt: req.attempt,
      role: req.role,
      model: req.model,
      effort: req.effort,
      system: [req.system, contractPreamble(req)].filter(Boolean).join("\n\n"),
      prompt: req.prompt,
      output_schema: req.output_schema,
      tools: req.tools,
      created_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + timeoutMs).toISOString(),
      status: "pending",
      instructions:
        `Execute this node with model "${req.model}"${req.effort ? ` at effort ${req.effort}` : ""}. ` +
        `Treat "system" as the system prompt and "prompt" as the user message. ` +
        `Return ONLY a JSON object that validates against output_schema via gren_complete_task (or: gren complete ${req.run_id} ${task_id} --result <file>).`,
    };
    ctx.store.writeTask(task);
    ctx.emit("task.created", { task_id, node: req.node_id, item: req.item_index, model: req.model, role: req.role });
    ctx.log(`inbox: task ${task_id} waiting for a worker (model ${req.model})`);

    const poll = this.opts.pollMs ?? 500;
    while (true) {
      if (ctx.signal.aborted) {
        this.cancel(ctx, task);
        throw new BridgeError("cancelled while waiting for inbox task", "cancelled", false);
      }
      if (Date.now() - start > timeoutMs) {
        this.cancel(ctx, task);
        throw new BridgeError(`inbox task ${task_id} timed out after ${timeoutMs}ms with no worker result`, "timeout", true);
      }
      const res = ctx.store.readTaskResult(req.run_id, task_id);
      if (res) {
        const t = ctx.store.readTask(req.run_id, task_id);
        if (t && t.status !== "completed") {
          t.status = "completed";
          ctx.store.writeTask(t);
        }
        ctx.emit("task.completed", { task_id, node: req.node_id, item: req.item_index, source: res.source, worker: res.worker });
        if (res.error) throw new BridgeError(`worker reported failure: ${res.error}`, "transport", true);
        return {
          output: res.output,
          raw: typeof res.output === "string" ? res.output : JSON.stringify(res.output),
          usage: res.usage,
          cost_usd: res.cost_usd,
          model: res.model ?? req.model,
          bridge: this.name,
          duration_ms: Date.now() - start,
          source: res.source ?? "orchestrator",
          worker: res.worker,
        };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  private cancel(ctx: BridgeContext, task: InboxTask) {
    const t = ctx.store.readTask(task.run_id, task.task_id);
    if (t && t.status !== "completed") {
      t.status = "cancelled";
      ctx.store.writeTask(t);
    }
    ctx.emit("task.cancelled", { task_id: task.task_id, node: task.node_id });
  }
}
