# Handoff notes for the next agent

Date: 2026-09-13. Head of `main` is the gren v2 rebuild on Strands Agents. Tag `v1.0.0` marks the frozen TypeScript version. There is no remote yet.

## 1. What gren is

gren is a Graph Engineering Runtime. A workflow is a YAML graph of bounded nodes. Edges are derived from `$nodes.<id>` data references. The engine runs the graph in parallel where the data allows, validates every output against a JSON schema, lets adversarial verifiers kill weak output, pauses at human gates, enforces budgets, checkpoints every node, and reports graph-shaped metrics. Read `README.md` first, then `docs/SPEC.md`, then `docs/ARCHITECTURE.md`.

## 2. Repository map

| path | what it is |
|---|---|
| `gren/spec/` | pydantic schema (`schema.py`), loader (`load.py`), static analysis and the dependency test (`analyze.py`) |
| `gren/engine/expr.py` | `$ref` resolution, templates, conditions |
| `gren/engine/validate.py` | JSON-schema validation, JSON schema to pydantic model, `$ref` inlining |
| `gren/engine/state.py` | the run store on disk: `runs/<id>/run.json`, `state.json`, `events.jsonl`, `artifacts/`, `inbox/`, `approvals/`, `nested/` |
| `gren/engine/runtime.py` | the Strands runtime: `RunContext`, `GrenNode` executors, `GateHooks`, `GraphRun` (create, resume, fork, run) |
| `gren/models/` | providers as Strands models: `_base.py` (one-shot base), `claude_code.py`, `inbox.py`, `mock.py`, `registry.py` (bedrock and anthropic are Strands' own classes), `pricing.py` |
| `gren/reducers/builtin.py` | the 17 built-in reducers and the Python module loader |
| `gren/metrics/metrics.py` | graph-shaped metrics, deep over nested runs |
| `gren/control.py` | in-process run control shared by the server and the MCP server (threads, approve, cancel, fork) |
| `gren/server/app.py` | FastAPI REST + SSE; `gren/server/ui/index.html` is the dashboard (copied from v1, only the provider names changed) |
| `gren/mcp/server.py` | MCP server on `mcp` 2.x (`MCPServer`), 23 `gren_*` tools |
| `gren/cli.py` | typer CLI; `gren/__main__.py` allows `python -m gren` |
| `gren/shapes.py` | the five shape templates for `gren new` and `gren_scaffold` |
| `graphs/` | 12 example graphs, `graphs/reducers/*.py` (19 Python reducers), `graphs/inputs/` |
| `skills/graph-engineering/` | the skill; `.claude/skills/graph-engineering` must stay an exact copy |
| `docs/` | `SPEC.md`, `ARCHITECTURE.md`, `AWS.md`, this file |
| `kit/` | starter kit: wheel, skill, graphs, `.mcp.json`, `CLAUDE.md`, `README.md`; rebuild with `python scripts/build_kit.py` |
| `tests/` | pytest on the mock provider: engine (20), dashboard API (2), MCP tools (2), reducers (5) |
| `v1/` | the TypeScript version. Read it for reference. Do not edit it. |

## 3. How to run things

```bash
.venv/Scripts/activate                                   # the venv has gren installed in editable mode
python -m pytest -q -p no:cacheprovider                  # 29 tests, about 20 s, no tokens
gren bridges                                             # which providers are available on this machine
gren validate graphs/starter-fork-join.yaml
gren run graphs/starter-fork-join.yaml --bridge mock --auto-approve --input '{"task":"Should a small team adopt graph orchestration?"}'
gren run graphs/starter-fork-join.yaml --bridge claude-code --input '{"task":"..."}'   # live, pauses at the gate
gren ui                                                  # dashboard, http://127.0.0.1:4545
gren mcp                                                 # stdio MCP server (used by .mcp.json)
```

`gren run` executes the graph on a background thread. The main thread prompts for gates when stdin is a terminal. Use `--auto-approve` for demos and `--no-wait` to return `paused` at the first gate.

## 4. What is verified

| item | evidence |
|---|---|
| engine semantics: fan-out with quorum, failure domains, router skips, verify repair cycle, gates with pause and resume, side effects run once, spend cap, discovery loop, schema repair, subgraphs, inbox loop, resume of blocking failures, fork with a replacement spec | `tests/test_engine.py`, all pass |
| all 12 example graphs complete on the mock provider through the Strands engine, including nested loops and mapped subgraphs | sweep on 2026-09-13; the sweep script is in the session scratchpad only, re-create it from `tests/conftest.py` if needed |
| live run on the `claude-code` provider | `starter-fork-join`: 17 calls, $0.25, 221 s, verifier killed 4 of 12 findings |
| dashboard API: start, pause, approve, resume in process, artifacts, fork, reject, validate, scaffold, path confinement, bearer token | `tests/test_server.py` |
| MCP tools over real stdio | 23 tools listed, `gren_list_graphs` and `gren_validate` answered |
| MCP orchestrator loop with the inbox provider | `tests/test_mcp.py` |
| dashboard in a browser | runs list, canvas, node inspector with killed candidates, gate approval |
| starter kit in a fresh folder | install from the wheel, `gren bridges`, validate, mock run, `gren init` into another folder |

## 5. What is not verified

- **Bedrock and Anthropic providers have not made a live call.** This machine has no AWS credentials and no `ANTHROPIC_API_KEY`. The code path is `GrenNode._invoke` in `gren/engine/runtime.py`: it builds a Strands `Agent` with `structured_output_model` and the mapped `strands_tools`. Test it first with a graph without tools, then with `tools: [Read]`.
- **Tool mapping on Bedrock and Anthropic.** `TOOL_MAP` in `gren/engine/runtime.py` maps Claude Code tool names to `strands_tools` modules. `WebSearch` maps to `tavily`, which needs `TAVILY_API_KEY`. `Bash` maps to `shell`, which can run any command; keep such nodes in a worktree.
- **Per-call caps on Bedrock and Anthropic.** `max_turns` and `max_cost_usd` are hard caps only on `claude-code` (the CLI enforces them). On Bedrock and Anthropic only the per-attempt `timeout_ms` and the graph budget (checked after every call) apply. Adding a turn limit to the Strands agent loop is an open item.
- **`effort` on the Anthropic provider** is passed as `params.output_config.effort`. Confirm the Strands `AnthropicModel` forwards it.
- `gren events --follow`, `gren claim`, and the CLI gate prompt were exercised by hand only.

## 6. Open items, in priority order

1. Run one graph on Bedrock. Fix what breaks in `_invoke`. Then run `graphs/research-brief.yaml` with tools.
2. Add a turn cap for Strands agents (a hook that cancels the loop after N tool calls) so `max_turns` means the same thing on every provider.
3. The dashboard `index.html` is the v1 file with provider names changed. It works, but nobody has reviewed it against the v2 API beyond the flows listed above. Design mode save and run were not clicked in the browser this session.
4. `docs/AWS.md` describes AgentCore deployment from the Strands and AgentCore documentation. No deployment has been done. Treat the sample entrypoint as a starting point.
5. The kit `.mcp.json` points at `.venv/Scripts/python.exe`. macOS and Linux users must change it to `.venv/bin/python`. `gren init` writes the absolute path of the running interpreter instead.
6. The old v1 runs under `runs/` (gitignored) still appear in the dashboard. The on-disk layout is the same, so they load. Delete them if they confuse.

## 7. Gotchas that cost time

- The desktop Claude Code session does not share its login with child processes. Run `claude auth login --claudeai` once from a shell with `CLAUDECODE*` and `CLAUDE_CODE_*` unset. The provider strips those variables when it spawns `claude -p`. The binary lives under `%APPDATA%\Claude\claude-code\<version>\claude.exe`; it is not on the bash `PATH`.
- Strands graph readiness is OR. gren adds an edge condition to every edge that requires all dependencies of the target to be completed. Do not remove it.
- Strands evaluates the repair back-edge condition exactly once, right after the verifier's batch. The condition consumes the repair flag. The verifier keeps its old generation until the producer re-runs; downstream nodes with stale inputs return a no-op result and run again later.
- Strands `Agent` with `structured_output_model` makes a forced second model call when the first reply ends without a tool call. One-shot providers therefore call `Model.structured_output()` directly.
- pydantic's `model_json_schema()` emits `$ref`. Providers must receive the spec's own JSON schema (`__gren_schema__` on the generated model, see `schema_of()` in `gren/engine/validate.py`).
- `mcp` 2.x renamed FastMCP: `from mcp.server.mcpserver import MCPServer`. Tools are registered with `@server.tool(name=..., description=...)`.
- Windows: `runs/` files are written with rename retries because the dashboard polls them. Worktrees under `.worktrees/` contain a junction to `.venv`; `git worktree remove --force` follows it and deletes the real folder. Use `graphs/reducers/git-worktree-remove.py`.
- Python buffers stdout when piped. Run smoke scripts with `python -u` and a `timeout`.
- The user writes and expects ASD-STE100 style: short sentences, one instruction each, active voice. Gate prompts must say what happens on approve and on reject in plain words. For demo runs, decide gates yourself: approve local reversible actions, stop only for actions that leave the machine.
