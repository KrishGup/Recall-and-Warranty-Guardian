/**
 * Claude Code bridge: runs each node as a headless Claude Code session through the Agent SDK.
 * Uses the machine's Claude Code login (Pro/Max subscription) - no API key required.
 *
 * Every node call is a fresh, isolated session: its own context window, its own (optional) tools,
 * structured output enforced by the SDK (`outputFormat: json_schema`), a hard turn cap and a USD cap.
 * By default nodes get NO tools (pure reasoning over the data that crossed the edge); a node may
 * opt into tools it needs (`tools: [Read, WebSearch, ...]`).
 *
 * Resolution of the Claude Code binary: GREN_CLAUDE_PATH env, then the SDK's bundled/auto-resolved
 * binary, then well-known desktop install locations.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateCostUsd } from "../models.js";
import { BridgeError, contractPreamble, extractJson, type AgentRequest, type AgentResponse, type Bridge, type BridgeContext } from "./types.js";

export interface ClaudeCodeBridgeOptions {
  claudePath?: string;
  /** Extra tools always allowed (e.g. ["Read"]). */
  defaultTools?: string[];
  cwd?: string;
  /** Hard per-call USD cap passed to the SDK (default 1.0). */
  maxBudgetUsd?: number;
}

/** Find a Claude Code binary if the SDK cannot resolve one itself. */
export function findClaudeBinary(explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.GREN_CLAUDE_PATH) candidates.push(process.env.GREN_CLAUDE_PATH);
  const home = os.homedir();
  const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  // Desktop-app managed installs: %APPDATA%/Claude/claude-code/<version>/claude.exe (newest first)
  const managed = path.join(appdata, "Claude", "claude-code");
  if (fs.existsSync(managed)) {
    for (const v of fs.readdirSync(managed).sort().reverse()) {
      for (const bin of ["claude.exe", "claude"]) candidates.push(path.join(managed, v, bin));
    }
  }
  candidates.push(
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".claude", "local", "claude"),
    path.join(appdata, "npm", "claude.cmd"),
    path.join(local, "Programs", "claude", "claude.exe"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  );
  return candidates.find((c) => c && fs.existsSync(c));
}

function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // A node must not inherit the parent Claude Code session's identity / sockets.
    if (/^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|HOST_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SDK_.*|EMIT_.*|REPORT_FINDINGS)|CLAUDE_PID)$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export class ClaudeCodeBridge implements Bridge {
  readonly name = "claude-code";
  constructor(private opts: ClaudeCodeBridgeOptions = {}) {}

  describe() {
    return "Claude Code headless sessions via the Agent SDK (subscription login; isolated context per node)";
  }

  async available() {
    const bin = findClaudeBinary(this.opts.claudePath);
    try {
      await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      return { ok: false, reason: "@anthropic-ai/claude-agent-sdk is not installed" };
    }
    if (!bin) return { ok: true, reason: "no explicit claude binary found; relying on the SDK's own resolution" };
    return { ok: true, reason: `binary: ${bin}` };
  }

  async execute(req: AgentRequest, ctx: BridgeContext): Promise<AgentResponse> {
    const start = Date.now();
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const bin = findClaudeBinary(this.opts.claudePath);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), req.timeout_ms);
    const tools = [...new Set([...(this.opts.defaultTools ?? []), ...(req.tools ?? [])])];
    const stderr: string[] = [];
    let result: Record<string, unknown> | undefined;
    try {
      const q = sdk.query({
        prompt: req.prompt,
        options: {
          model: req.model,
          effort: req.effort,
          systemPrompt: [contractPreamble(req), req.system].filter(Boolean).join("\n\n"),
          outputFormat: { type: "json_schema", schema: req.output_schema },
          tools,
          allowedTools: tools,
          permissionMode: "dontAsk",
          maxTurns: req.max_turns ?? (tools.length ? 12 : 2),
          maxBudgetUsd: this.opts.maxBudgetUsd ?? 1.0,
          cwd: req.cwd ?? this.opts.cwd ?? process.cwd(),
          env: sanitizedEnv(),
          settingSources: [],
          persistSession: false,
          strictMcpConfig: true,
          abortController: abort,
          pathToClaudeCodeExecutable: bin,
          stderr: (d: string) => stderr.push(d),
        },
      });
      for await (const msg of q) {
        const m = msg as { type: string } & Record<string, unknown>;
        if (m.type === "result") result = m;
      }
    } catch (e) {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      if (ctx.signal.aborted) throw new BridgeError("cancelled", "cancelled", false);
      if (abort.signal.aborted) throw new BridgeError(`claude-code call timed out after ${req.timeout_ms}ms`, "timeout", true);
      const msg = (e as Error).message ?? String(e);
      const tail = stderr.slice(-5).join("").trim();
      throw new BridgeError(`claude-code failed: ${msg}${tail ? ` | ${tail.slice(0, 400)}` : ""}`, /auth|login|credential/i.test(msg + tail) ? "auth" : "transport", true);
    }
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    if (!result) throw new BridgeError("claude-code returned no result message", "transport", true);

    const subtype = String(result.subtype ?? "");
    const isError = Boolean(result.is_error);
    const text = typeof result.result === "string" ? result.result : "";
    if (isError || subtype !== "success") {
      const kind = /authenticate|oauth|login/i.test(text) ? "auth" : subtype === "error_max_budget_usd" ? "transport" : "transport";
      throw new BridgeError(`claude-code ${subtype || "error"}: ${text.slice(0, 500)}`, kind, kind !== "auth");
    }
    const output = result.structured_output !== undefined ? result.structured_output : extractJson(text);
    const u = (result.usage ?? {}) as Record<string, number>;
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    };
    const cost = typeof result.total_cost_usd === "number" && result.total_cost_usd > 0 ? result.total_cost_usd : estimateCostUsd(req.model, usage);
    return {
      output,
      raw: text,
      usage,
      cost_usd: cost,
      model: req.model,
      bridge: this.name,
      duration_ms: Date.now() - start,
      session_id: typeof result.session_id === "string" ? result.session_id : undefined,
      source: "model",
    };
  }
}
