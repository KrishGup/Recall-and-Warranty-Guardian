# gren - Graph Engineering Runtime on Strands Agents

> Once you have more than one agent, the hardest problem is no longer making an individual agent smarter. It is deciding how the work itself should move.

gren turns a pile of agents into a system. You describe the work as a **graph**: nodes with one bounded job each, edges that carry explicit data, deterministic reducers, adversarial verifiers with kill authority, human gates that make unsafe transitions impossible, bounded loops, and budgets. gren compiles the graph into a [Strands Agents](https://strandsagents.com) graph and runs it: in parallel where the data allows, checkpointed, resumable, observable, and enforced.

```
            pricing ------+
                          |
reviews ------------------+--> dedupe (code) -> verify (kill) -> brief -> [HUMAN] -> publish
                          |
      docs ---------------+
```

Version 2 is a Python rebuild of gren on the Strands Agents SDK and AWS. Version 1 (TypeScript, its own scheduler) is frozen under `v1/` and tagged `v1.0.0`. `docs/HANDOFF.md` lists what is verified, what is not, and the open items; `CHANGELOG.md` has the version history.

## Providers

Every provider is a Strands `Model`. The engine owns the graph in every mode: dependencies, width, validation, retries, fallbacks, quorum, budgets, gates, resume. The provider only answers one prompt.

| provider (`--bridge`) | executes each node with | needs |
|---|---|---|
| `bedrock` | Claude on Amazon Bedrock through the Strands agent loop (tools from `strands_tools`) | AWS credentials and `AWS_REGION` |
| `anthropic` | the Anthropic API through the same Strands agent loop | `ANTHROPIC_API_KEY` |
| `claude-code` | one headless Claude Code session per node: isolated context, optional tools, structured output, real cost | a Claude Code login |
| `inbox` | **you**: a Claude Code session with the gren MCP tools claims tasks and runs them with its own subagents; a human can be a node too | nothing |
| `mock` | schema-driven deterministic output with latency and failure injection | nothing |

The default provider is `anthropic` when `ANTHROPIC_API_KEY` is set, then `bedrock` when AWS credentials exist, then `claude-code`.

## Quick start

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows;  source .venv/bin/activate on macOS/Linux
pip install -e ".[dev]"
gren bridges                      # which providers are available
gren analyze graphs/research-brief.yaml
gren run graphs/starter-fork-join.yaml --bridge mock --auto-approve --input '{"task":"Should a small team adopt graph orchestration?"}'
gren ui                           # dashboard on http://127.0.0.1:4545
```

Run it for real. The graph decides which model each node uses: haiku for extraction, sonnet for judgment.

```bash
gren run graphs/research-brief.yaml --bridge bedrock --input '{"topic":"...", "audience":"CTO"}'
gren run graphs/research-brief.yaml --bridge anthropic --input '{...}'
gren run graphs/research-brief.yaml --bridge claude-code --input '{...}'
gren run graphs/research-brief.yaml --bridge inbox --no-wait --input '{...}'     # then: gren tasks --json / gren complete ...
```

When a human gate is reached, the run pauses. Approve in the terminal (`y`/`n`), from the dashboard, with `gren approve <run> <gate> [--reject --comment "..."]`, or with the MCP tool. `gren resume <run>` continues from the checkpoint.

## Use it in a new project

Copy the `kit/` folder into a new project folder. It contains the gren wheel, the `gren` MCP server config, the `graph-engineering` skill, project notes, the starter graph and the example graphs. `kit/README.md` has the setup steps, sample prompts for a fresh Claude Code session, and two step-by-step guides (by hand, and with Claude). Rebuild the kit after changes with `python scripts/build_kit.py`.

## What the platform gives you

- **Spec** (`docs/SPEC.md`): 7 node kinds: `agent`, `code`, `verify`, `gate`, `router`, `loop`, `subgraph`. Edges are derived from `$nodes.<id>...` references, so every edge answers "what exact data crosses this arrow?". Status-only edges are flagged. Ordering-only edges need a stated reason.
- **Static analysis** (`gren analyze`): derived edges with their data, cycle check, estimated critical path vs sum of work, width, cost range, frozen-constraint validation, design lint (compress-before-you-reason, verifier-is-decoration, unbounded loops, fan-out without quorum) and the pre-ship checklist.
- **Engine on Strands** (`docs/ARCHITECTURE.md`): each gren node is a Strands multi-agent node; each derived dependency is a Strands edge with an AND-join condition; verify repair cycles are conditional back-edges with a generation guard; gates are Strands interrupts; nodes memoise on the gren checkpoint so resume and fork replay finished work instantly. Failure domains (retry, fallback model or provider, structured failure, quorum, block or continue), schema validation with a bounded repair loop, deterministic logged routing, bounded discovery loops, side effects executed at most once.
- **Frozen constraints**: spend cap, gate-before-side-effect, no unbounded loops, structured outputs only, no side-effect re-runs (default), plus opt-in verifier-can-kill, width budget, no status-only edges. The engine validates them. No model is asked to respect them.
- **Metrics** (`gren metrics`): critical-path latency, parallel speedup, peak width vs budget, node failure rate, retry rate, verifier kill rate, fan-out efficiency, compression ratio, human intervention and waiting time, cost by model, with hints.
- **Dashboard** (`gren ui`): a light, Lucidchart-style canvas. Pan, zoom, drag nodes, click to highlight upstream and downstream, hover an edge to see the data that crosses it, critical path overlay, nested-run drill-down. Node inspector with prompts, raw outputs, attempts, killed candidates and reasons, gate approval with plain "if you approve / if you reject" lines, and "fork run from here". Drawer with live events, metrics, decisions, inbox task console, analysis, spec and output. Design mode: YAML editor with live validation, preview of the derived graph, save, and run.
- **MCP server** (`gren mcp`): the same operations as 23 tools (`gren_validate`, `gren_run`, `gren_wait`, `gren_tasks`, `gren_complete_task`, `gren_approve`, `gren_fork`, `gren_metrics`, ...) so any Claude agent can design, run, work, and monitor graphs. With the `inbox` provider the calling agent is the execution layer.
- **Skill** (`skills/graph-engineering/`): teaches an agent to design a graph with the dependency test, write the spec, validate, run it through the orchestrator loop with cheap subagents, read the metrics and iterate.
- **AWS** (`docs/AWS.md`): Bedrock setup, IAM, model aliases, OpenTelemetry to CloudWatch, and deployment as a container, on Lambda, or on Bedrock AgentCore Runtime.

## Examples (`graphs/`)

| graph | shape | what it proves |
|---|---|---|
| `starter-fork-join.yaml` | plan -> 3 workers -> dedupe -> verify -> answer -> gate -> record | the smallest complete graph |
| `research-brief.yaml` | map -> reduce -> verify -> synthesize -> gate -> publish | fan-out with quorum and fallback, deterministic dedupe/rank, adversarial per-finding verifier, brief checker with bounded repair, human gate guarding a side effect |
| `code-review-router.yaml` | router + diamond | classifier is probabilistic, routes are deterministic and logged; quick path vs parallel specialist audit vs human |
| `escalation-ladder.yaml` | escalation ladder | regex -> haiku -> sonnet -> human, each rung structurally skipped unless the one below was unsure |
| `tournament.yaml` | tournament | candidates -> independent judges -> votes counted by code |
| `discovery-loop.yaml` | bounded discovery loop | search and verify rounds until no new verified findings for 2 rounds, hard stops and a spend cap, dedupe against everything seen |
| `failure-domains.yaml` | fork/join | retries, fallback models, quorum joins, optional branches, blocking critical nodes; run with `--bridge mock --mock-fail-rate 0.35` |
| `deep-research-report.yaml` | loop + map-reduce-verify + fork/join + controlled cycle + gate | question -> lanes -> source-discovery loop -> per-source extraction -> per-finding verification -> outline -> section writers -> code citation check -> adversarial editor -> gate -> report file |
| `codebase-audit.yaml` | router + diamond + verify with repair + gate | deterministic inventory -> triage -> one auditor per module -> verifier that must open the file -> prioritise -> fix plans -> adversarial fix review -> report -> gate -> file. Run it on gren itself: `--input '{"repo_path":".","include":["gren"]}'` |
| `support-triage-batch.yaml` | mapped subgraph + escalation ladder + router + gates | a per-ticket pipeline fanned out over a batch with a quorum, then auto and human queues and two gates in front of the only irreversible action |
| `competitive-landscape.yaml` | loop + mapped subgraph + graph reuse + tournament + verify + gate | competitor discovery -> per-competitor research lanes -> comparison matrix -> reused `tournament.yaml` -> synthesis -> verifier -> report -> gate -> file |
| `release-pipeline.yaml` | chain with explicit state + verify with repair + three gated side effects | incident -> locate code -> baseline tests -> git worktree -> implement -> diff -> tests -> adversarial diff review -> changelog -> gate commit -> gate PR -> gate webhook |

All twelve graphs run end to end on the Strands engine with the mock provider (`python -m pytest` covers the engine semantics; the sweep is in the commit history). Live on the `claude-code` provider, 2026-09-13:

| run | outcome | cost |
|---|---|---|
| starter-fork-join | 3 workers, 12 findings, verifier killed 4 (33%), answer built from the 8 survivors, gate, record; wall 221 s, parallel speedup 2.0x, width 3/3 | $0.25 |

Custom reducers are Python modules in `graphs/reducers/` (file writer, repo inventory, citation check, policy check, git worktree, commit, diff, GitHub PR, webhook, and more).

### Developer loop

`gren fork <run> --from <node> [--spec edited.yaml]` re-runs from a node with upstream outputs reused (also in the dashboard's node inspector and as the `gren_fork` MCP tool). Iterate on the editor prompt without paying for the research again.

## Orchestrator mode (Claude Code runs the nodes)

1. `.mcp.json` registers the MCP server: `{"mcpServers":{"gren":{"command":"<python>","args":["-m","gren","mcp"],"env":{"GREN_RUNS":"runs"}}}}`.
2. In Claude Code: `gren_run(spec_path, input, bridge: "inbox")` -> `gren_wait` -> `gren_tasks` -> run each task with a subagent using the task's model -> `gren_complete_task` -> repeat. The engine validates every result, applies failure policies, and enforces budgets and gates; the dashboard shows it all live.

See `skills/graph-engineering/SKILL.md` for the full loop.

## Security notes

- The dashboard binds to `127.0.0.1`. To expose it, set `GREN_API_TOKEN` (every `/api` route then requires `Authorization: Bearer <token>`; open the page as `/?token=<token>` once). `/api/graph` only reads files inside the graphs directory.
- Agent nodes get no tools unless the spec lists them. A node with `Bash`/`Edit` can do anything the process can, inside its `cwd`; treat `tools:` as a permission grant and keep file-modifying nodes in a worktree.
- `GREN_BRIDGE=mock` is ignored unless `GREN_ALLOW_MOCK=1`, and every run reports where its default provider came from.
- Regex conditions (`matches`, `classify_regex`) are length-capped and refuse nested quantifiers.
- `gren_approve` (MCP) records who approved; authorising an agent to act as an approver is an operator decision, not something the tool can verify.

## Layout

```
gren/spec        schema (pydantic), loader, static analysis (dependency test)
gren/engine      expressions, JSON-schema validation, durable state, the Strands runtime (compile + executors)
gren/models      providers as Strands Models: bedrock, anthropic, claude-code, inbox, mock; pricing; registry
gren/reducers    deterministic built-ins;  gren/metrics  graph-shaped metrics
gren/server      FastAPI REST + SSE dashboard server; gren/server/ui the dashboard
gren/mcp         MCP server;  gren/cli.py  the CLI;  gren/control.py  in-process run control
graphs/          examples + Python reducers;  docs/  spec, architecture, AWS;  skills/  the graph-engineering skill
tests/           pytest (mock provider): engine semantics, dashboard API, MCP loop, reducers
kit/             starter kit for a new project;  v1/  the frozen TypeScript version
```

## Tests

```bash
python -m pytest -q     # dependency test, fan-out/quorum, failure domains, router skips, repair cycle, gates & resume, spend cap, loops, subgraphs, inbox loop, fork, dashboard API, MCP tools, reducers
```
