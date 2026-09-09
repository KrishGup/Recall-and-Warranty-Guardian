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
  if (explicit) return explicit;
  if (process.env.GREN_BRIDGE) return process.env.GREN_BRIDGE;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "api";
  return "claude-code";
}
