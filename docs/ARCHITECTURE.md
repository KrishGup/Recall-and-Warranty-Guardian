# gren architecture

```
 spec (YAML)  ─►  zod schema  ─►  analyze (dependency test, cycles, critical path, frozen rules)
                                      │
                                      ▼
                     GraphRunner (scheduler) ──► RunStore (runs/<id>: run.json, state.json, events.jsonl, artifacts, inbox, approvals, nested)
                       │  readiness loop: all deps terminal → activation (skip cascade, when:, gates) → execute
                       │  width semaphore (budget.max_width) + per-node max_width for fan-out
                       │  failure domains: retries → fallback → structured failure → quorum → block/continue
                       │  verify (kill) → bounded repair (reset producer + descendants with feedback)
                       │  gates: waiting_approval → pause → approval file / in-process approve → resume
                       │  router: deterministic route + state snapshot in decisions[]
                       │  loop/subgraph: nested runs (own dirs, own budgets), dedupe against everything seen
                       ▼
                     Bridge.execute(AgentRequest) → AgentResponse   (one bounded structured call)
                       ├─ api          @anthropic-ai/sdk  (output_config.format json_schema, adaptive thinking, effort)
                       ├─ claude-code  @anthropic-ai/claude-agent-sdk query() (outputFormat json_schema, tools, maxTurns, maxBudgetUsd)
                       ├─ inbox        task file → external worker (MCP tools / CLI / human) → result file
                       └─ mock         schema-driven generator with latency/failure/kill injection
                                      │
   metrics (critical path actual, speedup, width, failure/retry, kill rate, fan-out, compression, human)
                                      │
   surfaces: CLI (src/cli) · dashboard (src/server + src/ui, REST + SSE) · MCP server (src/mcp)
```

## Design decisions

- **Edges are derived, not declared.** A node's `input`, `prompt`, `when`, `map`, `target`, `show`, `routes` are scanned for `$nodes.<id>` references. That makes "what crosses this edge?" answerable by the tool, and makes fake edges visible (`status_only_edge`, `ordering_only_edge`).
- **The model is fuzzy inside the box; the box is strict.** Every agent/verify call carries a JSON schema; outputs are validated by Ajv; invalid outputs go through a bounded repair loop with the validation errors before counting as a failed attempt.
- **Verifiers have authority.** Their output contract is fixed (`verdict/reasons/confidence`); `survivors`/`killed` are first-class views; a verification that did not execute is a kill; `repair:` is the only sanctioned back-edge and it is bounded by `max_rounds`.
- **Gates are edge conditions.** `requires_gate` blocks scheduling until an approval record (file) exists; side effects are validated to sit behind gates and are executed at most once (`side_effect_done`, never re-run on resume).
- **Budgets are enforced by the engine.** Cost/wall/calls/tokens are checked before and after every call; exceeding the spend cap fails the run regardless of node policies.
- **Durable by default.** State is checkpointed after every node and every fan-out item; `resume` resets in-flight nodes (except side effects) and continues. Nested runs (loops/subgraphs) are ordinary runs under `runs/<id>/nested/`.
- **Observability is graph-shaped.** Events (`call.started/finished`, `item.*`, `verify.kill`, `route.selected`, `gate.*`, `repair.scheduled`, `loop.round.*`, `task.*`) feed the metrics; decisions carry the state that produced them.
- **Bridges are dumb on purpose.** A bridge executes one prompt and returns JSON + usage. Retries, fallbacks, width, timeouts and validation live in the engine so all bridges behave identically — including a human completing an inbox task.

## Claude-specific choices

- Model aliases (`haiku → claude-haiku-4-5`, `sonnet → claude-sonnet-5`, `opus → claude-opus-5`, `fable → claude-fable-5-1`) with a pricing table for cost accounting; the `claude-code` bridge uses the SDK's own cost estimate when present.
- API bridge: structured outputs via `output_config.format`, adaptive thinking on 4.6+ models, `effort` where supported, refusal stop reason surfaced as a non-retryable error, typed error classes mapped to retryable/non-retryable.
- Claude Code bridge: each node is an isolated headless session (`settingSources: []`, `strictMcpConfig`, `persistSession: false`, sanitized env), `tools` default to none (pure reasoning over the edge data), hard `maxTurns` and `maxBudgetUsd`, structured output enforced by the SDK.
- MCP server: the operations any Claude agent needs to design (`gren_reference`, `gren_scaffold`, `gren_validate`, `gren_write_graph`), run (`gren_run`, `gren_wait`, `gren_tasks`, `gren_complete_task`, `gren_approve`), and observe (`gren_status`, `gren_metrics`, `gren_node`, `gren_decisions`, `gren_events`).

## Extending

- New reducer: add to `src/reducers/builtin.ts` (or ship a module and use `module:`).
- New bridge: implement `Bridge` (`src/bridges/types.ts`) and register it in `BridgeRegistry`.
- New node kind: extend the zod schema, `refCarryingFields` in `analyze.ts`, and add a `run<Kind>` method in the scheduler.
