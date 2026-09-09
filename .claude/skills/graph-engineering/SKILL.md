---
name: graph-engineering
description: Design, validate, run and monitor multi-agent workflows as explicit graphs with gren (nodes with one job, edges that carry data, deterministic reducers, adversarial verifiers, human gates, bounded loops, budgets). Use when asked to build a multi-agent pipeline/workflow/graph, orchestrate agents, fan out research or review across workers, add verification or human approval to an agent flow, or run/monitor a gren graph. Also use when the user says "graph engineering", "gren", "orchestrator", "map-reduce agents", "escalation ladder", "tournament", or "discovery loop".
---

# Graph engineering with gren

You are about to turn a job into a **graph**, not a chain. The graph decides what runs in parallel, what data crosses each edge, what gets verified, what happens when a node fails, and where a human holds the key. The model stays fuzzy inside each box; the interface around the box is strict.

gren is the runtime: `gren` CLI, `gren ui` dashboard, and the `gren` MCP server (tools prefixed `gren_`). Prefer the MCP tools when they are available in this session; fall back to the CLI (`npx tsx src/cli/main.ts …` from the gren checkout, or `gren …` when installed).

## 0. Should this be a graph at all?

Use ONE agent (no graph) when the task is small, every step truly needs the previous output, you are still exploring, failure is cheap, or the human wants to steer every step. Say so and stop.

Build a graph when work can run in parallel, nodes need different tools/models/permissions, outputs need independent verification, the job must survive interruption, or cost/authority must be controlled by route.

## 1. Design — write the spec before any prompt

Fill this in (a few lines each). It is the contract you will encode:

```
GOAL:           what must exist at the end (the output schema)
INPUT STATE:    structured input (input_schema)
PARALLEL WORK:  which tasks are truly independent (dependency test: does B read A's output? if not, no edge)
EDGE DATA:      the exact fields crossing each edge (one sentence per edge)
REDUCER:        what code can dedupe / normalize / rank / count before any model reasons
VERIFICATION:   which independent adversarial check may KILL weak output, and what it sends back for repair
FAILURE POLICY: retries, fallback model, quorum, what may fail without killing the run (on_failure: continue + optional)
BUDGET:         max_cost_usd, max_wall_ms, max_width (width budget)
HUMAN GATE:     which irreversible actions require approval (side_effect + requires_gate)
OUTPUT:         output: { from: node } and output_schema
```

Pick the shape (run `gren_shapes` / `gren shapes`): **fork/join**, **escalation ladder**, **tournament**, **map → reduce → verify → synthesize**, **bounded discovery loop** — most real graphs are combinations. `gren_scaffold` / `gren new <shape> <name>` gives a starting YAML.

Model routing rule of thumb: `haiku` for bounded extraction, classification, formatting and per-item verification; `sonnet` for decomposition, judgment, synthesis; `opus`/`fable` only for the hardest synthesis or verification. Put a `code` reducer in front of every expensive node.

Read `references/design-guide.md` for the principles and `references/spec.md` (or `gren_reference`) for the exact YAML.

## 2. Encode — write the YAML

Rules the validator enforces or flags (fix, do not argue with them):

- every `agent`/`verify` node has an `output_schema` (structured state, never free text)
- edges come from `$nodes.<id>.…` references — a node that only reads `$nodes.x.status` has a fake edge; `after:` is ordering-only and needs a reason
- `map:` fan-outs declare `max_width` and `failure.quorum`; the join reads `$nodes.x.outputs` AND `$nodes.x.count` so incompleteness is visible
- a `verify` node's `survivors`/`killed` must be consumed downstream or drive `repair:` — otherwise it is decoration
- `side_effect: true` requires `requires_gate:`; `budget.max_cost_usd` is mandatory; loops need `until.max_rounds` and a convergence rule
- every tool-using node (WebSearch/WebFetch/Read/Grep/Edit/Bash) sets `max_turns` AND `max_cost_usd`; verifiers that must open a source declare `tools: [WebFetch]` or `[Read, Grep]`
- nodes that modify files run in an isolated worktree (`cwd:` from a `git-worktree` code node); commits, pushes, PRs and messages are separate `side_effect` nodes, each behind its own gate
- state that lives OUTSIDE the graph (files on disk, a database, a branch) is invisible to the dependency test: a node that needs "the files after the change" must read a value the producer emitted (e.g. `changed_files: $nodes.implement.output.files_changed`), otherwise it may run first
- routers are deterministic: `routes[].when` conditions over node outputs; downstream branches use `when: { eq: [$nodes.route.output.route, x] }`; joins list the branches under `optional:`

Save with `gren_write_graph` (validates first) or write the file and run `gren validate`.

## 3. Validate — read the analysis, then fix the topology

`gren_validate` / `gren analyze <spec>` prints: derived edges with the data that crosses them, estimated critical path vs sum of work (parallel speedup), max width, cost range, findings, and the checklist. Resolve every `error`; treat each `warning` as a design question (status-only edge? compress before reason? unbounded width?). Re-run until clean.

## 4. Run — choose the bridge

| situation | bridge |
|---|---|
| this Claude Code session should do the work with its own subagents (no API key needed) | `inbox` — follow the orchestrator loop below |
| the machine has a Claude Code login and you want isolated headless sessions per node | `claude-code` |
| `ANTHROPIC_API_KEY` is set | `api` |
| dry run / testing failure policies | `mock` (`--mock-fail-rate 0.3`, `--mock-fail-nodes x`) |

Start: `gren_run({spec_path, input, bridge})` (returns `run_id` immediately) or `gren run <spec> --bridge <b> --input '<json>'`. Open the dashboard (`gren ui`, http://127.0.0.1:4545) to watch it.

### Orchestrator loop (bridge `inbox`)

The engine schedules nodes, validates every result, applies failure policies and budgets; **you** execute the model calls:

1. `gren_wait({run_id})` — returns when tasks are pending, a gate is waiting, or the run ended.
2. `gren_tasks({run_id})` — each task has `model`, `effort`, `system`, `prompt`, `output_schema`.
3. For every pending task, spawn a subagent **with the task's model** (Agent tool `model: haiku|sonnet|opus`; run them in parallel — one message, several Agent calls, `run_in_background`). Prompt template in `references/orchestrator-loop.md`. Do not do the reasoning yourself in the main context: that is exactly the "one giant context" anti-pattern the graph exists to avoid.
4. Parse the subagent's JSON, then `gren_complete_task({run_id, task_id, output, model, source: "subagent"})`. If the output is rejected by the schema, fix it or re-run the subagent with the validation errors. If a task cannot be done, `gren_complete_task({…, error})` so the failure policy applies — never fabricate.
5. Repeat from 1 until `status` is `completed`/`failed`. `pending_tasks` may include tasks from nested loop rounds (their `run_id` differs) — submit each to its own `run_id`.

Gates: `waiting_gates` means a human must decide. Ask in plain language (short sentences, one idea each, ASD-STE100 style): what the system is about to do, what happens if they approve, what happens if they reject, and a compact summary of the payload (counts and a few rows, not raw JSON). Only call `gren_approve` with what they decided (or when they explicitly pre-authorised auto-approval for a demo). When you author a gate, always fill `approve_effect` and `reject_effect`.

## 5. Monitor and iterate

`gren_metrics({run_id})` / `gren metrics <run>`: critical path latency, parallel speedup, peak width vs budget, node failure rate, retry rate, verifier kill rate, fan-out efficiency, compression ratio, human intervention, cost by model, and hints. Read them as architecture signals (see `references/metrics.md`): kill rate 0% → verifier is decoration; 80% → workers poorly scoped; retry rate high → brittle prompt/tool; speedup ≈ 1× → fake edges; compression ≈ 100% → reducers missing. Change the topology, re-validate, re-run.

`gren_node({run_id, node_id})` shows the exact prompt and raw output of any attempt; `gren_decisions` answers "why did it take this route?".

## 6. Deliver

Report: run id, dashboard link, the final output (`gren_output`), the metrics that matter (cost, wall vs critical path, kill rate, degraded fan-outs), and any gate decisions. Keep the spec in the repo (`graphs/<name>.yaml`) — the spec is the product; prompts are just node internals.
