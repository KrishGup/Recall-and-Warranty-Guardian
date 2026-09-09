/**
 * API bridge: one bounded structured call through the Anthropic Messages API.
 * Credentials resolve from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
 *
 * - Structured outputs via output_config.format (json_schema); falls back to JSON extraction when a model
 *   rejects the format parameter.
 * - Adaptive thinking + effort on models that support it; omitted on Haiku 4.5.
 * - Errors are classified (auth / rate limit / transport / refusal) so the engine's failure policy can decide.
 */
import Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, modelInfo } from "../models.js";
import { BridgeError, contractPreamble, extractJson, type AgentRequest, type AgentResponse, type Bridge, type BridgeContext } from "./types.js";

export interface ApiBridgeOptions {
  apiKey?: string;
  baseURL?: string;
  maxRetries?: number;
}

function supportsEffort(model: string): boolean {
  return !/haiku/.test(model) && !/claude-3/.test(model) && !/sonnet-4-5/.test(model);
}
function supportsAdaptiveThinking(model: string): boolean {
  return /claude-(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/.test(model);
}

export class ApiBridge implements Bridge {
  readonly name = "api";
  private client: Anthropic | undefined;
  private formatUnsupported = new Set<string>();

  constructor(private opts: ApiBridgeOptions = {}) {}

  describe() {
    return "Anthropic Messages API (structured outputs, adaptive thinking)";
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.opts.apiKey, baseURL: this.opts.baseURL, maxRetries: this.opts.maxRetries ?? 2 });
    }
    return this.client;
  }

  async available() {
    const hasKey = Boolean(this.opts.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    if (hasKey) return { ok: true };
    // The SDK can also resolve an `ant auth login` profile; we cannot cheaply verify it, so report a hint.
    return { ok: false, reason: "no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment (an `ant auth login` profile may still work at call time)" };
  }

  async execute(req: AgentRequest, ctx: BridgeContext): Promise<AgentResponse> {
    const start = Date.now();
    const client = this.getClient();
    const system = [contractPreamble(req), req.system].filter(Boolean).join("\n\n");
    const useFormat = !this.formatUnsupported.has(req.model);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.max_output_tokens ?? 8000,
      system,
      messages: [{ role: "user", content: req.prompt }],
    };
    const outputConfig: Anthropic.OutputConfig = {};
    if (useFormat) outputConfig.format = { type: "json_schema", schema: req.output_schema as Record<string, unknown> } as Anthropic.OutputConfig["format"];
    if (req.effort && supportsEffort(req.model)) outputConfig.effort = req.effort;
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    if (supportsAdaptiveThinking(req.model)) params.thinking = { type: "adaptive" } as Anthropic.ThinkingConfigParam;

    let message: Anthropic.Message;
    try {
      message = await client.messages.create(params, { signal: ctx.signal, timeout: req.timeout_ms });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (ctx.signal.aborted) throw new BridgeError("cancelled", "cancelled", false);
      if (e instanceof Anthropic.AuthenticationError) throw new BridgeError(`authentication failed: ${err.message}`, "auth", false);
      if (e instanceof Anthropic.PermissionDeniedError) throw new BridgeError(`permission denied: ${err.message}`, "auth", false);
      if (e instanceof Anthropic.RateLimitError) throw new BridgeError(`rate limited: ${err.message}`, "rate_limit", true);
      if (e instanceof Anthropic.BadRequestError) {
        // Some models reject output_config.format; retry once without it (JSON extracted from text).
        if (useFormat && /output_config|format|json_schema/i.test(err.message)) {
          this.formatUnsupported.add(req.model);
          ctx.log(`api: ${req.model} rejected structured output format; falling back to JSON extraction`);
          return this.execute(req, ctx);
        }
        throw new BridgeError(`bad request: ${err.message}`, "transport", false);
      }
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new BridgeError(`timeout: ${err.message}`, "timeout", true);
      if (e instanceof Anthropic.APIConnectionError) throw new BridgeError(`connection error: ${err.message}`, "transport", true);
      if (e instanceof Anthropic.InternalServerError) throw new BridgeError(`server error: ${err.message}`, "transport", true);
      throw new BridgeError(`api error: ${err.message}`, "transport", true);
    }

    if (message.stop_reason === "refusal") {
      const details = (message as unknown as { stop_details?: { category?: string; explanation?: string } }).stop_details;
      throw new BridgeError(`model refused: ${details?.category ?? "unknown"} ${details?.explanation ?? ""}`.trim(), "refusal", false);
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (message.stop_reason === "max_tokens") throw new BridgeError("output truncated (max_tokens); raise max_output_tokens", "invalid_output", true);
    const output = extractJson(text);
    const usage = {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      output,
      raw: text,
      usage,
      cost_usd: estimateCostUsd(req.model, usage),
      model: message.model ?? req.model,
      bridge: this.name,
      duration_ms: Date.now() - start,
      source: "api",
    };
  }
}

export function describeModelTier(model: string): string {
  return modelInfo(model).tier;
}
