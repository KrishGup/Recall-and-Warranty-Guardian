# gren — Graph Engineering Runtime for Claude multi-agent systems

> Once you have more than one agent, the hardest problem is no longer making an individual agent smarter. It is deciding how the work itself should move.

gren turns a pile of agents into a system. You describe the work as a **graph** — nodes with one bounded job each, edges that carry explicit data, deterministic reducers, adversarial verifiers with kill authority, human gates that make unsafe transitions impossible, bounded loops, and budgets — and gren runs it: in parallel where the data allows, checkpointed, resumable, observable, and enforced.

```
            pricing ──────┐
                          │
reviews ──────────────────┼──→ dedupe (code) → verify (kill) → brief → [HUMAN] → publish
                          │
      docs ───────────────┘
```

It is built Claude-first and runs on three bridges:

| bridge | executes each node with | needs |
|---|---|---|
| `claude-code` | a headless Claude Code session (Agent SDK): isolated context, optional tools, structured output | your Claude Code login (Pro/Max) |
| `api` | the Anthropic Messages API with structured outputs and adaptive thinking | `ANTHROPIC_API_KEY` / `ant auth login` |
| `inbox` | **you** — a Claude Code session holding the gren MCP tools claims tasks and runs them with its own subagents (haiku/sonnet), a human can be a node too | nothing |
| `mock` | schema-driven deterministic output with latency/failure injection | nothing |

The engine owns the graph in every mode: dependencies, width, validation, retries, fallbacks, quorum, budgets, gates, resume. The bridge only answers one prompt.

## Quick start

```bash
npm install
npx tsx src/cli/main.ts analyze graphs/research-brief.yaml      # dependency test, critical path, cost, checklist
npx tsx src/cli/main.ts run graphs/research-brief.yaml --bridge mock --auto-approve --input '{"topic":"graph engineering"}'
npx tsx src/cli/main.ts ui                                        # dashboard on http://127.0.0.1:4545
```

`npm run build` compiles to `dist/`; `bin/gren.js` then runs the compiled CLI (`npm link` to get a global `gren`).

Run it for real (the graph decides which model each node uses — haiku for extraction, sonnet for judgment):

```bash
gren run graphs/research-brief.yaml --input '{"topic":"...", "audience":"CTO"}'          # claude-code bridge (default)
ANTHROPIC_API_KEY=... gren run graphs/research-brief.yaml --bridge api --input '{...}'
gren run graphs/research-brief.yaml --bridge inbox --no-wait --input '{...}'              # then: gren tasks --json / gren complete ...
```

The `claude-code` bridge needs a login the subprocess can use: run `claude auth login --claudeai` once (the desktop app's own session is not shared with child processes); `claude auth status` should report `loggedIn: true`.

When a human gate is reached the run pauses. Approve from the dashboard, `gren approve <run> <gate> [--reject --comment "..."]`, or the MCP tool; `gren resume <run>` continues from the checkpoint.

## What the platform gives you

- **Spec** (`docs/SPEC.md`): 7 node kinds — `agent`, `code`, `verify`, `gate`, `router`, `loop`, `subgraph`. Edges are derived from `$nodes.<id>...` references, so every edge answers "what exact data crosses this arrow?". Status-only edges are flagged. Ordering-only edges need a stated reason.
- **Static analysis** (`gren analyze`): derived edges with their data, cycle check, estimated critical path vs sum of work, width, cost range, frozen-constraint validation, design lint (compress-before-you-reason, verifier-is-decoration, unbounded loops, fan-out without quorum…) and the pre-ship checklist.
- **Engine**: readiness-driven parallel scheduler with per-node and global width budgets; failure domains (retry → fallback model/bridge → structured failure → quorum → block only if critical); schema validation with a bounded repair loop; verify nodes with kill authority and bounded repair cycles back to the producer; gates as edge conditions; deterministic, logged routing; bounded discovery loops that dedupe against everything seen; durable checkpoints and resume; side effects executed at most once.
- **Frozen constraints**: spend cap, gate-before-side-effect, no unbounded loops, structured outputs only, no side-effect re-runs (default) plus opt-in verifier-can-kill, width budget, no status-only edges. They are validated by the engine, not suggested to a model.
- **Metrics** (`gren metrics`): critical-path latency, parallel speedup, peak width vs budget, node failure rate, retry rate, verifier kill rate, fan-out efficiency (unique per worker), compression ratio, human intervention, cost by model — with hints ("verifier rejects 0%: decoration?").
- **Dashboard** (`gren ui`): live graph with status, critical path, what-crosses-each-edge tooltips; node inspector with prompts, raw outputs, attempts, killed candidates and reasons; events; metrics; decisions with the state that produced them; inbox task console; gate approval.
- **MCP server** (`gren mcp`): the same operations as tools (`gren_validate`, `gren_run`, `gren_wait`, `gren_tasks`, `gren_complete_task`, `gren_approve`, `gren_metrics`, …) so any Claude agent can design, run, work, and monitor graphs. With the `inbox` bridge the calling agent is the execution layer.
- **Skill** (`skills/graph-engineering/`): teaches an agent to design a graph with the dependency test, write the spec, validate, run it through the orchestrator loop with cheap subagents, read the metrics and iterate.

## Examples (`graphs/`)

| graph | shape | what it proves |
|---|---|---|
| `research-brief.yaml` | map → reduce → verify → synthesize → gate → publish | fan-out with quorum + fallback, deterministic dedupe/rank, adversarial per-finding verifier, brief checker with bounded repair, human gate guarding a side effect |
| `code-review-router.yaml` | router + diamond | classifier is probabilistic, routes are deterministic and logged; quick path vs parallel specialist audit vs human; joins tolerate the branch that did not run |
| `escalation-ladder.yaml` | escalation ladder | regex → haiku → sonnet → human, each rung structurally skipped unless the one below was unsure |
| `tournament.yaml` | tournament | candidates → independent judges → votes counted by code |
| `discovery-loop.yaml` | bounded discovery loop | search/verify rounds until no new verified findings for 2 rounds, hard stops and a spend cap, dedupe against everything seen |
| `failure-domains.yaml` | fork/join | retries, fallback models, quorum joins, optional branches, blocking critical nodes — run with `--bridge mock --mock-fail-rate 0.35` |

`gren new <fork-join|escalation|tournament|map-reduce-verify|discovery-loop> <name>` scaffolds a new spec.

### Showcase graphs (real tools, real side effects)

| graph | what it does | shapes composed |
|---|---|---|
| `deep-research-report.yaml` | question → lanes → **bounded source-discovery loop** (search, then open and vet every URL) → per-source extraction with verbatim quotes → per-finding verification by re-opening the source → outline → parallel section writers that each see only their evidence → code citation check → adversarial editor → gate → writes `out/research-report-*.md` | loop, map-reduce-verify, fork/join, controlled cycle, gate |
| `codebase-audit.yaml` | deterministic inventory → triage with Read/Grep → **router** (single vs parallel) → one sonnet auditor per module in its own context → dedupe/normalize → verifier that must open the file and find the evidence → prioritise → fix plans with diffs → adversarial fix review → report → gate → writes `out/codebase-audit-*.md`. Run it on gren itself: `--input '{"repo_path":".","include":["src"]}'` | router, diamond, verify+repair, gate |
| `support-triage-batch.yaml` | a per-ticket **subgraph** (regex → haiku → sonnet escalation ladder, legal/security router, drafted reply, deterministic policy check, adversarial reply reviewer) fanned out over a batch with a quorum, then auto/human queues and two gates in front of the only irreversible action | mapped subgraph, escalation ladder, router, gates |
| `competitive-landscape.yaml` | **discovery loop** for competitors (vetted by opening their sites) → per-competitor **subgraph** with three parallel research lanes that degrade visibly → comparison matrix (code) → **reused `tournament.yaml`** for positioning → synthesis → verifier → report → gate → file | loop, mapped subgraph, graph reuse, tournament, verify+repair, gate |

Inputs for the batch example live in `graphs/inputs/`. Every tool-using node carries `max_turns` and `max_cost_usd`; the run's `budget.max_cost_usd` is passed down so a single session can never exceed what is left.

### Developer loop

`gren fork <run> --from <node> [--spec edited.yaml]` re-runs from a node with upstream outputs reused (also in the dashboard's node inspector and as the `gren_fork` MCP tool). Iterate on the editor prompt without paying for the research again.

## Orchestrator mode (Claude Code runs the nodes)

1. Add the MCP server to the project: `.mcp.json` → `{"mcpServers":{"gren":{"command":"node","args":["<path>/bin/gren.js","mcp"]}}}` (or `npx tsx src/cli/main.ts mcp` from this checkout).
2. In Claude Code: `gren_run(spec_path, input, bridge: "inbox")` → `gren_wait` → `gren_tasks` → run each task with a subagent using the task's model → `gren_complete_task` → repeat. The engine validates every result, applies failure policies, and enforces budgets and gates; the dashboard shows it all live.

See `skills/graph-engineering/SKILL.md` for the full loop and `docs/ARCHITECTURE.md` for how the pieces fit.

## Layout

```
src/spec        schema (zod), loader, static analysis (dependency test)
src/engine      expressions/templating, durable state, scheduler, validation
src/bridges     api, claude-code, inbox, mock + registry
src/reducers    deterministic built-ins
src/metrics     graph-shaped metrics
src/server      REST + SSE dashboard server;  src/ui  the dashboard
src/mcp         MCP server;  src/cli  the CLI
graphs/         examples;  docs/  spec + architecture;  skills/  the graph-engineering skill
tests/          vitest engine tests (mock bridge)
```

## Tests

```bash
npm test          # engine semantics: dependency test, fan-out/quorum, failure domains, router skips, repair cycle, gates & resume, spend cap, loops, subgraphs
npm run typecheck
```
