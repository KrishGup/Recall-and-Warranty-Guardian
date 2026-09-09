# gren graph spec reference

A graph is a YAML (or JSON) document. Nodes are bounded units of work; **edges are derived from data references** — if node B reads `$nodes.A...`, there is an edge A → B and the analysis tells you exactly what crosses it. Anything else is not a dependency.

```yaml
name: my-graph                # required
version: 1
description: one line
goal: what must exist at the end
input_schema: { ... JSON schema for the run input ... }
output: { from: <node id> }   # or a mapping of $refs; default = outputs of sink nodes
output_schema: { ... }        # optional, validated at the end
budget:                       # enforced by the engine (frozen), never suggested to a model
  max_cost_usd: 2.0           # required by default (frozen: spend_cap)
  max_wall_ms: 900000
  max_width: 5                # global concurrent agent calls (width budget)
  max_agent_calls: 200
  max_tokens: 2000000
frozen: [verifier_can_kill, width_budget]   # extra frozen constraints (see below)
defaults: { model: sonnet, effort: low, bridge: claude-code, failure: { retries: 1, timeout_ms: 300000 } }
nodes: [ ... ]
```

## References (how data crosses an edge)

| Reference | Meaning |
|---|---|
| `$input.path` | graph input |
| `$nodes.<id>.output.path` | a node's structured output |
| `$nodes.<id>.outputs` | array of successful item outputs of a `map` node |
| `$nodes.<id>.items` | per-item records `{index,status,output,error}` |
| `$nodes.<id>.count` | `{total, completed, failed}` for a map node — use it to degrade visibly |
| `$nodes.<id>.status` | `completed | failed | skipped | ...` (a status-only edge is flagged as fake) |
| `$nodes.<id>.survivors` / `.killed` / `.kill_rate` | verify node results |
| `$nodes.<id>.route` | router decision |
| `$item`, `$index` | current element inside a `map` or `verify` fan-out |
| `$loop.round/.seen/.collected/.prev` | inside a loop body (also merged into `$input`) |
| `$repair.round/.feedback` | when a producer is re-run by a verify repair cycle |
| `$run.id`, `$graph.name`, `$env.GREN_*` | metadata |

Prompts are templates: `{{ input.topic }}`, `{{ $nodes.a.output.x }}`, `{{ json item }}` (forces JSON). Non-string values render as pretty JSON. Unknown `{{ }}` is left untouched (safe for JSON examples in prompts).

`input:` is an explicit mapping (refs/templates resolved) that is appended to the prompt as an `<input>` JSON block and stored with the artifact — every node has explicit input.

## Node kinds

Common fields: `id`, `description`, `input`, `when` (condition), `after` (ordering-only, discouraged, needs `reason`), `optional` (upstream nodes whose skip/failure this node tolerates), `failure`, `requires_gate`, `side_effect`, `map`, `max_width`, `tags`, `est_ms`.

### agent — one bounded model call, structured output required
```yaml
- id: research
  kind: agent
  model: haiku            # haiku | sonnet | opus | fable | full model id
  effort: low             # low | medium | high | xhigh | max
  bridge: claude-code     # optional override: api | claude-code | inbox | mock
  system: optional system prompt (template)
  prompt: |               # template; {{ item }} inside a map
    ...
  input: { topic: $input.topic, lanes: $nodes.scope.output.lanes }
  output_schema: { type: object, required: [...], properties: {...}, additionalProperties: false }
  map: $nodes.scope.output.lanes     # fan-out: one call per element, $item/$index in scope
  max_width: 5
  tools: [Read, WebSearch]           # claude-code bridge only (default: no tools => pure reasoning)
  max_turns: 12                      # tool nodes default to 30, pure nodes to 3
  max_cost_usd: 0.4                  # hard USD cap for ONE call of this node (tool nodes can burn turns)
  cwd: $input.repo_path              # working directory for tool nodes (ref/template allowed)
  failure: { retries: 1, backoff_ms: 1500, timeout_ms: 300000, fallback: { model: sonnet }, on_failure: block, quorum: 0.6, repair_attempts: 1 }
```
Output is validated against `output_schema`; invalid output triggers a repair call (the model sees the validation errors) up to `repair_attempts`, then counts as a failed attempt.

### code — deterministic plumbing (reducers), no tokens
```yaml
- id: dedupe
  kind: code
  fn: dedupe                       # built-in reducer, or
  module: ./reducers/custom.js     # default export (input, args, ctx) => output
  input: { items: $nodes.flat.output.items }
  args: { key: [claim] }
  output_schema: {...}             # optional
  side_effect: true                # irreversible: needs requires_gate, runs at most once per run
```
Built-ins: `flatten, filter_nulls, dedupe, sort, top_k, group_by, count_votes, normalize_labels, filter, pick, merge, identity, coverage, template, check_fields, classify_regex, record`. Reducers report `_stats: {in, out}` so the compression metric is real.

### verify — adversarial check with kill authority
```yaml
- id: verify
  kind: verify
  target: $nodes.dedupe.output.items   # array (per item) or single value
  mode: agent                          # or code (fn/module returning {verdict, reasons, confidence})
  model: haiku
  prompt: "Candidate: {{ json item }} ... try to falsify it"
  kill_threshold: 0.6                  # kill when verdict=kill AND confidence >= threshold
  min_survivors: 3                     # else the node fails
  tools: [WebFetch]                    # a verifier that must OPEN the source (claude-code bridge); cwd/max_turns/max_cost_usd as for agents
  repair: { node: brief, max_rounds: 2 }   # controlled cycle: reset producer (+descendants) with feedback; the producer must be an ancestor of the target
```
Fixed verifier output: `{ verdict: pass|kill, reasons: [], confidence: 0..1 }`. Results: `$nodes.verify.survivors`, `.killed`, `.kill_rate`, `.output.total`. A verification that did not execute is a kill (never mark passed unless it ran).

### gate — human approval as an edge type
```yaml
- id: approve
  kind: gate
  title: Publish?
  prompt: what the approver should consider
  show: { brief: $nodes.brief.output }   # what the human sees
  timeout_ms: 86400000
  on_timeout: reject                      # or wait (default)
  on_reject: { route: brief }             # send comment back as repair feedback (bounded 3) - or { fail_run: false }
  auto_approve_when: { eq: [...] }        # escalation-ladder convenience; recorded as "auto"
```
Nodes declare `requires_gate: approve`; they are structurally unreachable until the approval record exists. The run pauses (`gren approve <run> <gate>`, dashboard, or MCP `gren_approve`) and resumes from the checkpoint.

### router — deterministic, logged route selection
```yaml
- id: route
  kind: router
  routes:
    - { when: { gte: [$nodes.triage.output.confidence, 0.8] }, route: quick, reason: "confident" }
  default: human
```
Downstream branches declare `when: { eq: [$nodes.route.output.route, quick] }`. Unselected branches are `skipped` and the skip cascades to their dependents unless a join lists them under `optional:`. Every decision is recorded with the state that produced it.

### loop — bounded discovery loop
```yaml
- id: discover
  kind: loop
  input: { plan: $input.plan }
  collect: $output.findings     # ref into the body's output, evaluated each round
  seen_key: key                 # dedupe key across ALL rounds
  until: { max_rounds: 5, no_new_for_rounds: 2, max_cost_usd: 1.0, max_wall_ms: 600000, converged: <cond> }
  on_nonconvergence: accept     # or fail
  body: { name: round, budget: {...}, output: { from: keep }, nodes: [...] }   # body input = { ...input, round, seen, collected, prev, dry_rounds }
```
Output: `{ items, rounds, converged, stop_reason, per_round, seen }`. Each round is a nested run (`<run>/nested/<node>/round-N`).

### subgraph — compose graphs
```yaml
- id: child
  kind: subgraph
  graph: ./other.yaml     # or inline spec
  input: { q: $input.q }
  map: $input.tickets     # optional: one nested run per item ($item/$index in `input`), parallel under max_width, quorum applies
```
A mapped subgraph is the "per-item pipeline" pattern: each item gets an isolated graph run (`<run>/nested/<node>/item-N`); `$nodes.child.outputs` / `.count` behave like any fan-out.

## Conditions
`{ eq|neq|gt|gte|lt|lte: [a, b] }`, `{ in: [a, list] }`, `{ contains: [list_or_string, x] }`, `{ matches: [a, regex] }`, `{ exists: a }`, `{ empty: a }`, `{ truthy: a }`, `{ status: [nodeId, status] }`, `{ and: [...] }`, `{ or: [...] }`, `{ not: c }`, a bare `"$ref"` (truthy), `true/false`.

## Failure policy (per node, `defaults.failure` for the graph)
| field | default | meaning |
|---|---|---|
| retries | 1 | extra attempts after the first |
| backoff_ms | 1500 | exponential backoff base |
| timeout_ms | 300000 | per attempt |
| fallback | – | `{ model, bridge }` used on the LAST attempt |
| on_failure | block | `block` fails the run; `continue` records a structured failure and lets dependents decide (they run only if they list the node in `optional`) |
| quorum | 1 | map nodes: fraction of items that must succeed |
| repair_attempts | 1 | schema-repair calls per attempt |

## Frozen constraints (validated by the engine, not suggested to the model)
Default: `gate_before_side_effect`, `spend_cap`, `no_unbounded_loops`, `structured_outputs_only`, `no_side_effect_retry_without_idempotency`. Opt-in: `verifier_can_kill`, `width_budget`, `no_status_only_edges`.

## Bridges
| bridge | what executes the call | auth |
|---|---|---|
| `claude-code` | headless Claude Code session per node via the Agent SDK (isolated context, optional tools, structured output) | Claude Code login (subscription) |
| `api` | Anthropic Messages API with structured outputs | `ANTHROPIC_API_KEY` / `ant auth login` |
| `inbox` | writes a task; an external worker (a Claude Code session with the gren MCP tools, the CLI, or a human) executes it and posts a schema-valid result | none |
| `mock` | schema-driven deterministic output with latency/failure injection | none |

## Developer loop: fork
`gren fork <run_id> --from <node[,node]> [--spec edited.yaml] [--input JSON]` (MCP: `gren_fork`, dashboard: "Fork run from here") copies the run, resets the named nodes and everything downstream, and re-executes only that part - upstream outputs (the expensive research fan-out, say) are reused. Iterate on a late prompt without paying for the whole graph.

## Run state (`runs/<id>/`)
`run.json` (spec snapshot, input, status, totals, approvals, decisions), `state.json` (node checkpoint), `events.jsonl`, `artifacts/` (prompts + raw outputs per attempt), `inbox/` (tasks + results), `approvals/`, `nested/` (loop rounds, subgraphs). `gren resume <id>` continues from the checkpoint; side-effect nodes are never re-run.

## Metrics (`gren metrics <id>`)
critical-path latency (actual), sum of work, parallel speedup, peak width vs budget, node failure rate, retry rate, verifier kill rate, fan-out efficiency (unique/worker), compression ratio, human intervention, cost by model, hints.
