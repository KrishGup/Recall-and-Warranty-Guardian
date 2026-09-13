/** Bridge registry: name -> executor. Bridges are created lazily from options/env. */
import { ApiBridge } from "./api.js";
import { ClaudeCodeBridge } from "./claude-code.js";
import { InboxBridge } from "./inbox.js";
import { MockBridge, type MockOptions } from "./mock.js";
import type { Bridge } from "./types.js";

export interface BridgeRegistryOptions {
  mock?: MockOptions;
  claudePath?: string;
  cwd?: string;
  inboxPollMs?: number;
}

export const BRIDGE_NAMES = ["claude-code", "api", "inbox", "mock"] as const;
export type BridgeName = (typeof BRIDGE_NAMES)[number];

export class BridgeRegistry {
  private bridges = new Map<string, Bridge>();

  constructor(private opts: BridgeRegistryOptions = {}) {}

  register(bridge: Bridge) {
    this.bridges.set(bridge.name, bridge);
  }

  get(name: string): Bridge {
    const existing = this.bridges.get(name);
    if (existing) return existing;
    let b: Bridge;
    switch (name) {
      case "api":
        b = new ApiBridge();
        break;
      case "claude-code":
        b = new ClaudeCodeBridge({ claudePath: this.opts.claudePath, cwd: this.opts.cwd });
        break;
      case "inbox":
        b = new InboxBridge({ pollMs: this.opts.inboxPollMs });
        break;
      case "mock":
        b = new MockBridge(this.opts.mock ?? {});
        break;
      default:
        throw new Error(`unknown bridge "${name}". Known: ${BRIDGE_NAMES.join(", ")}`);
    }
    this.bridges.set(name, b);
    return b;
  }

  names(): string[] {
    return [...BRIDGE_NAMES];
  }

  async status(): Promise<Array<{ name: string; ok: boolean; reason?: string; description: string }>> {
    const out = [];
    for (const name of BRIDGE_NAMES) {
      const b = this.get(name);
      const a = await b.available();
      out.push({ name, ok: a.ok, reason: a.reason, description: b.describe() });
    }
    return out;
  }
}

/** Pick a sensible default bridge: explicit > env > api key present > claude-code. */
export function defaultBridgeName(explicit?: string): string {
  return defaultBridge(explicit).name;
}

/**
 * Default bridge with its provenance, so callers can log it. Audit finding: an inherited GREN_BRIDGE=mock could
 * silently turn a production run into a no-op - so `mock` is only honoured from the environment when
 * GREN_ALLOW_MOCK=1 is also set, and the source is always reported in `run.started`.
 */
export function defaultBridge(explicit?: string): { name: string; source: "explicit" | "env" | "api-key" | "default"; warning?: string } {
  if (explicit) return { name: explicit, source: "explicit" };
  const env = process.env.GREN_BRIDGE;
  if (env) {
    if (env === "mock" && process.env.GREN_ALLOW_MOCK !== "1") {
      return { name: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "api" : "claude-code", source: "default", warning: "GREN_BRIDGE=mock ignored (set GREN_ALLOW_MOCK=1 to allow the mock bridge from the environment)" };
    }
    if (!(BRIDGE_NAMES as readonly string[]).includes(env)) return { name: "claude-code", source: "default", warning: `GREN_BRIDGE="${env}" is not a known bridge; using claude-code` };
    return { name: env, source: "env" };
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return { name: "api", source: "api-key" };
  return { name: "claude-code", source: "default" };
}
