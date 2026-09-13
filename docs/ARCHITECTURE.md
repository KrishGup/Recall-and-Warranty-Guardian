# gren architecture (v2, on Strands Agents)

```
 spec (YAML) -> pydantic schema -> analyze (dependency test, cycles, critical path, frozen rules)
                                      |
                                      v
                 compile: gren spec -> strands.multiagent.Graph
                   - one GrenNode(MultiAgentBase) executor per gren node
                   - one Strands edge per derived dependency, condition = "all deps of the target completed" (AND-join)
                   - verify.repair / gate.on_reject.route -> conditional back-edge, reset_on_revisit, generation guard
                   - gates -> BeforeNodeCallEvent hook raises an interrupt; the run pauses; resume = interruptResponse
                   - budgets, retries, fallbacks, quorum, timeouts, replay, fork, cancel -> gren (inside the executors)
                                      |
                                      v
                 RunStore (runs/<id>: run.json, state.json, events.jsonl, artifacts, inbox, approvals, nested)
                                      |
                                      v
                 Strands Model providers                                  (every provider is a strands.models.Model)
                   bedrock       BedrockModel      -> Agent(structured_output_model=..., tools=strands_tools)
                   anthropic     AnthropicModel    -> Agent(structured_output_model=..., tools=strands_tools)
                   claude-code   ClaudeCodeModel   -> one structured call (claude -p --json-schema)
                   inbox         InboxModel        -> task file -> external worker -> result file
                   mock          MockModel         -> schema-driven generator with latency/failure/kill injection
                                      |
   metrics (critical path actual, speedup, width, failure/retry, kill rate, fan-out, compression, human wait)
                                      |
   surfaces: CLI (gren/cli.py) - dashboard (gren/server + gren/server/ui, REST + SSE) - MCP server (gren/mcp)
```

## What Strands owns, what gren owns

| concern | owner | how |
|---|---|---|
| graph traversal, parallel batches, readiness | Strands `Graph` | `GraphBuilder` with one node per gren node; entry points = nodes without deps |
| AND-joins | gren | Strands readiness is OR; every edge into `B` carries the condition "all of B's dependencies are in `completed_nodes`" |
| agent loop, tools, streaming, hooks, telemetry | Strands `Agent` | `bedrock`/`anthropic` nodes run `Agent(model, tools, system_prompt, structured_output_model)` |
| structured output | both | the spec's JSON schema becomes a Pydantic model (`json_schema_to_model`); the original schema is what providers send; gren validates the plain output against the JSON schema and runs its repair loop |
| one-shot providers | gren | `OneShotModel` implements `Model.stream()` and `Model.structured_output()`; the runtime calls `structured_output()` directly to avoid Strands' forced second call |
| retries, backoff, fallback model/provider, timeouts, quorum | gren | inside `GrenNode._call_model` / `_fan_out` |
| verify kill + bounded repair | gren + Strands | the verifier schedules a repair (resets the producer and its descendants in gren state, sets a flag); the conditional back-edge fires once (the flag is consumed when the edge is evaluated); `reset_on_revisit` lets Strands re-execute; a generation guard (`required_gen` / `node_gen`) makes stale downstream nodes no-op until fresh inputs exist; `set_max_node_executions` is the hard stop |
| human gates | Strands interrupt + gren files | `GateHooks.before_node` raises `event.interrupt(...)` for a gate without a decision; the run status becomes `paused`; the approval is a file (`approvals/<gate>.json`), written by CLI/dashboard/MCP; the run resumes by invoking the same Graph with the interrupt responses |
| checkpoints, resume, fork | gren | every node writes to `state.json`; a resumed run compiles a fresh Strands graph and completed nodes replay instantly (memoised on gren state); `fork` copies a run and resets a subtree |
| nested runs (loops, subgraphs) | gren | ordinary runs under `runs/<id>/nested/...` with their own budgets; deep metrics fold them in |
| budgets | gren | checked before and after every call; `BudgetExceeded` fails the run regardless of node policies |
| cancel | gren | a flag checked between calls and in the gate wait; `run.cancel()` is thread-safe |

## Design decisions kept from v1

- **Edges are derived, not declared.** `input`, `prompt`, `when`, `map`, `target`, `show`, `routes` are scanned for `$nodes.<id>` (and `{{ nodes.<id> }}`) references. The analysis answers "what crosses this edge?" and flags fake edges.
- **The model is fuzzy inside the box; the box is strict.** Every agent/verify call carries a JSON schema; outputs are validated; invalid outputs go through a bounded repair loop before counting as a failed attempt.
- **Verifiers have authority.** Fixed output contract; `survivors`/`killed` are first-class views; a verification that did not execute is a kill; `repair:` is the only sanctioned back-edge and it is bounded.
- **Gates are edge conditions.** `requires_gate` blocks scheduling until an approval record exists; side effects sit behind gates and execute at most once (`side_effect_done`, never re-run on resume).
- **Budgets are enforced by the engine.** Not suggested to the model.
- **Observability is graph-shaped.** Events feed the metrics; decisions carry the state that produced them.
- **Providers are dumb on purpose.** A provider answers one prompt with JSON + usage. Retries, fallbacks, width, timeouts and validation live in the engine, so a human completing an inbox task behaves exactly like Bedrock.

## AWS-native choices

- `bedrock` is the default provider when AWS credentials are present and no `ANTHROPIC_API_KEY` is set; model aliases map to cross-region inference profiles.
- Tool names use the Claude Code vocabulary in specs (`Read`, `Grep`, `WebFetch`, `Bash`...). On `bedrock`/`anthropic` they map to `strands_tools` modules (`file_read`, `editor`, `http_request`, `shell`, `python_repl`, `use_aws`, `retrieve`); on `claude-code` they are passed to the CLI's `--tools` / `--allowedTools`.
- The engine is a plain Python library with a FastAPI server, so it deploys anywhere Strands does: a container on ECS/Fargate, Lambda for short graphs, or Bedrock AgentCore Runtime (see `docs/AWS.md`).

## Extending

- New reducer: add to `gren/reducers/builtin.py` (or ship a module and use `module:`).
- New provider: subclass `OneShotModel` (one structured call) or return any `strands.models.Model` from `ModelRegistry.create`.
- New node kind: extend the pydantic schema, `REF_FIELDS` in `gren/spec/analyze.py`, and add a `_run_<kind>` method on `GrenNode`.
