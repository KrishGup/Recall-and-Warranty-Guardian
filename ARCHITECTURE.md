# Guardian architecture

Guardian is a set of graphs on **gren**, a Graph Engineering Runtime that compiles a YAML graph of bounded nodes into a **Strands Agents** `Graph`, plus a thin household layer (store, decisions, notifications) and a dashboard. This document explains the mapping and where the AWS pieces from `BUILD_PLAN.md` attach.

## 1. Runtime: how a Guardian graph runs on Strands

`guardian/graphs/nightly-sweep.yaml` and `intake.yaml` are gren specs (`gren/docs/SPEC.md`). At run time (`gren/gren/engine/runtime.py`):

- Every node becomes a Strands `MultiAgentBase` executor (`GrenNode`), added to a `GraphBuilder`.
- **Edges are derived from data references**, not declared. `input: { verdicts: $nodes.matcher.outputs }` is an edge `matcher → verdicts` carrying that value; `gren analyze` prints every edge with the exact data crossing it and flags edges that carry nothing.
- Strands readiness is OR; gren adds an edge condition "all of the target's dependencies completed" so joins are AND.
- **Agent nodes** run a Strands `Agent` with `structured_output_model` (on Bedrock / Anthropic; tools from `strands_tools`), or one structured call on the one-shot providers (headless Claude Code, inbox, mock). Output is validated against the node's JSON schema; invalid output gets one bounded repair call before it counts as a failed attempt. Retries, fallback model, per-attempt timeout, quorum on fan-outs and the spend cap are enforced by the engine, never suggested to the model.
- **Verify nodes** are adversarial: `severity_check` targets the triage plan, returns `{verdict, reasons, confidence}`, and on a kill schedules a repair: triage is reset with the verifier's reasons as feedback and re-executed through a conditional back-edge (`reset_on_revisit`, generation guard) at most `max_rounds` times.
- **Gates are Strands interrupts.** A `BeforeNodeCallEvent` hook raises `event.interrupt("gate:household_decision", …)` when no approval record exists. The run's status becomes `paused`, its checkpoint (`state.json`, every node's output) is on disk, and the process may exit. An approval file written by the CLI, the dashboard, the MCP server or the Guardian API resumes the same graph with an `interruptResponse`; completed nodes replay from the checkpoint without new model calls.
- **Side effects** (`followup`) declare `side_effect: true` and `requires_gate`; the frozen constraint `gate_before_side_effect` makes them unreachable without an approval, and `no_side_effect_retry_without_idempotency` runs them at most once per run.
- Every node writes an artifact (system prompt, prompt, schema, raw output, usage, cost) under `var/runs/<run>/artifacts`; `events.jsonl` is the trace the dashboard streams.

## 2. The nightly sweep

```
feeds_refresh ─┐
               ├─ candidate_gen ─ matcher (map) ─ verdicts ─┐
expiry_scan ───┴─ warranty (map) ────────────────────────────┴─ triage ─ severity_check ─┬─ [household_decision] ─ answers ─ remedy (map) ─ followup
                                                                     ↑ repair ×1 ┘       └─ digest
```

| Stage | Where | Determinism |
|---|---|---|
| Feed fetch, normalization, severity keyword pass | `guardian/feeds/*`, `policy/severity.py` | code |
| Stages 1-3 of matching (UPC / vehicle / model keys, lexical ≥ 80 with brand overlap, sold-window ± 60 days) | `guardian/matching/candidates.py` | code |
| Stage 4, the ambiguous pairs | `matcher` agent, `MatchVerdict` | model, validated |
| Budget state, warranty windows, quiet categories | `policy/budget.py`, `policy/warranty.py` | code |
| What to surface tonight and the SMS text | `triage` agent, `SurfacePlan` | model, validated, verified |
| Severity sanity check with kill authority | `severity_check` verify node | model (haiku) + repair cycle |
| The household's answer | gate interrupt | human |
| The remedy request text | `remedy` agent, `ActionReport` | model, validated |
| Sending, recording, scheduling | `followup` reducer | code, side effect, once |

Cost profile: a quiet night makes zero model calls (`matcher`, `triage` and everything downstream are skipped by their `when` conditions); a night with one ambiguous pair and one decision runs 4 to 6 calls.

## 3. The household layer (`guardian/service.py`)

The graph does not know about phones or dashboards. The `Guardian` service subscribes to the engine's event stream (`RunControl.emit`) and:

- on `gate.waiting` for `household_decision`, turns the gate's `show.decisions` into `Decision` rows (one per surfaced item), sends each SMS through `Notifier` (SNS, or the outbox), marks the match `surfaced`, and logs the activity row;
- on `POST /api/decisions/{id}/answer` (or `guardian answer`), records the answer, applies the immediate effects of a decline (close the match, mark the item disposed), and once every decision of that plan is answered writes the gate approval with the per-decision answers as JSON in the comment, then resumes the run if it is not in process. The `answers` reducer turns that comment back into the list `remedy` maps over;
- on every `node.completed`, formats the node's output into the activity log the dashboard shows ("Pulled 42 CPSC recalls…", "Adjudicated 1 ambiguous pair…", "Triage chose channel sms_now…");
- keeps `SweepRecord`s so Home can show "last sweep", "sweeps run" and the quiet score.

The store (`guardian/store.py`) is one JSON file per entity under `var/household`, shaped like the DynamoDB single-table design in the plan (items, recalls, matches, decisions, activity, preferences, sweeps, outbox). Swapping it for DynamoDB is a driver change.

## 4. API and dashboard

`guardian/api/app.py` (FastAPI) serves `/api/*` for the dashboard, streams `/api/events` (Guardian events plus every engine event), mounts gren's own run API at `/gren/api/*` (runs, run state + analysis + metrics, events, artifacts, approve, fork) and hosts the built dashboard. `web/src/api/types.ts` is the contract.

The dashboard's **Agent flow** page shows the latest run as node cards; the **full trace view** (`/flow/trace`) is gren's run dashboard rebuilt in Guardian's design: the run graph laid out by `analysis.levels`, edges colored by kind (data, gate, repair, route, critical path), live node status over SSE, a drawer with events, metrics, decisions, tasks, spec and output, and an inspector with each node's inputs, structured output, attempts and prompts. Approving the household gate from the trace view goes through the Guardian decision API so both surfaces stay consistent.

## 5. Where AWS attaches (from the plan, not built yet)

| Plan component | Attachment point | State |
|---|---|---|
| AgentCore Runtime | `gren/docs/AWS.md` shows the `BedrockAgentCoreApp` entrypoint; `payload.kind` routes to `start_sweep` / `intake` / `answer` | documented |
| Bedrock | gren's `bedrock` provider (`BedrockModel`, cross-region inference profiles for `haiku`/`sonnet`/`opus`) | code path exists; needs credentials |
| AgentCore Memory | preferences and household facts; today `prefs.json` and the store | not started |
| AgentCore Gateway | the recall feed tools as MCP (gren ships an MCP server; the feed functions are plain Python) | not started |
| EventBridge Scheduler | calls `POST /api/sweep` nightly; locally the logo button or `guardian sweep` | not started |
| SES / SNS | `guardian/notify.py` uses boto3 when `GUARDIAN_SES_FROM` / `GUARDIAN_SNS=1`; otherwise the outbox | code path exists |
| DynamoDB / S3 | `Store` driver; receipt evidence | not started |
| Observability | gren's `events.jsonl` and artifacts per run; the trace view | local |

## 6. Security and privacy notes

- Card numbers are removed by the `redact` node (Luhn-checked) before any model call; the redacted text is what the store keeps as evidence.
- Agent nodes run with no tools unless the spec lists them; none of Guardian's nodes use tools.
- The API binds to 127.0.0.1 by default; gren's API supports `GREN_API_TOKEN` when exposed.
- Guardian never holds credentials for retailers, banks or payment apps; the payout and claim-filing flows in the plan's Expanded tier are designed around addresses and human attestation, not logins.
