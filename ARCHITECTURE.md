# Guardian architecture

Guardian is a set of graphs on **gren**. gren is a Graph Engineering Runtime. It compiles a YAML graph of bounded nodes into a **Strands Agents** `Graph`. Guardian adds a thin household layer (store, decisions, notifications) and a dashboard. This document explains the mapping, and where the AWS pieces from `BUILD_PLAN.md` attach.

## 1. Runtime: how a Guardian graph runs on Strands

`guardian/graphs/nightly-sweep.yaml` and `intake.yaml` are gren specs (`gren/docs/SPEC.md`). At run time (`gren/gren/engine/runtime.py`):

- Each node becomes a Strands `MultiAgentBase` executor (`GrenNode`). gren adds the executor to a `GraphBuilder`.
- **gren derives the edges from data references.** You do not declare them. `input: { verdicts: $nodes.matcher.outputs }` is an edge from `matcher` to `verdicts`, and the edge carries that value. `gren analyze` shows each edge with the exact data that crosses it. It flags an edge that carries nothing.
- Strands readiness is OR. gren adds an edge condition "all dependencies of the target are complete". Thus, joins are AND.
- **Agent nodes** run a Strands `Agent` with `structured_output_model` (on Bedrock or Anthropic, with tools from `strands_tools`). On the one-shot providers (headless Claude Code, inbox, mock), an agent node makes one structured call. gren validates the output against the JSON schema of the node. If the output is invalid, gren makes one bounded repair call before it counts the attempt as failed. The engine enforces retries, the fallback model, the timeout for each attempt, the quorum on fan-outs, and the spend cap. The engine never suggests these to the model.
- **Verify nodes** are adversarial. `severity_check` examines the triage plan and returns `{verdict, reasons, confidence}`. On a rejection, gren schedules a repair. It resets `triage` and gives it the reasons of the verifier as feedback. Then it runs `triage` again through a conditional back-edge (`reset_on_revisit`, generation guard). This happens at most `max_rounds` times.
- **Gates are Strands interrupts.** A `BeforeNodeCallEvent` hook raises `event.interrupt("gate:household_decision", ...)` when no approval record exists. The run status becomes `paused`. The checkpoint (`state.json` and the output of each node) is on disk. The process can exit. The CLI, the dashboard, the MCP server, or the Guardian API writes an approval file. The approval resumes the same graph with an `interruptResponse`. Completed nodes replay from the checkpoint without new model calls.
- **Side-effect nodes** (`followup`) declare `side_effect: true` and `requires_gate`. The frozen constraint `gate_before_side_effect` makes them unreachable without an approval. The constraint `no_side_effect_retry_without_idempotency` runs them at most one time in each run.
- Each node writes an artifact (system prompt, prompt, schema, raw output, usage, cost) under `var/runs/<run>/artifacts`. `events.jsonl` is the trace that the dashboard streams.

## 2. The nightly sweep

```
feeds_refresh ─┐
               ├─ candidate_gen ─ matcher (map) ─ verdicts ─┐
expiry_scan ───┴─ warranty (map) ────────────────────────────┴─ triage ─ severity_check ─┬─ [household_decision] ─ answers ─ remedy (map) ─ followup
                                                                     ↑ repair ×1 ┘       └─ digest
```

| Stage | Location | Determinism |
|---|---|---|
| Feed fetch, normalization, severity keyword pass | `guardian/feeds/*`, `policy/severity.py` | code |
| Match stages 1 to 3 (UPC, vehicle, and model keys; lexical score of 80 or more with brand overlap; sold window of plus or minus 60 days) | `guardian/matching/candidates.py` | code |
| Stage 4, the ambiguous pairs | `matcher` agent, `MatchVerdict` | model, validated |
| Budget state, warranty windows, quiet categories | `policy/budget.py`, `policy/warranty.py` | code |
| What to surface tonight, and the SMS text | `triage` agent, `SurfacePlan` | model, validated, verified |
| Severity check with rejection authority | `severity_check` verify node | model (haiku) and repair cycle |
| The answer of the household | gate interrupt | human |
| The text of the remedy request | `remedy` agent, `ActionReport` | model, validated |
| Send, record, schedule | `followup` reducer | code, side effect, one time |

Cost profile: a quiet night makes zero model calls. The `when` conditions skip `matcher`, `triage`, and all nodes after them. A night with one ambiguous pair and one decision makes 4 to 6 calls.

## 3. The household layer (`guardian/service.py`)

The graph does not know about phones or dashboards. The `Guardian` service subscribes to the event stream of the engine (`RunControl.emit`). It does this:

- On `gate.waiting` for `household_decision`, it turns `show.decisions` of the gate into `Decision` rows (one row for each surfaced item). It sends each SMS through `Notifier` (SNS, or the outbox). It marks the match as `surfaced`. It writes the activity row.
- On `POST /api/decisions/{id}/answer` (or `guardian answer`), it records the answer. For a decline, it applies the immediate effects (closes the match, marks the item as disposed). When each decision of the plan has an answer, it writes the gate approval with the answers as JSON in the comment. Then it resumes the run if the run is not in process. The `answers` reducer turns that comment back into the list that `remedy` maps over.
- On each `node.completed`, it formats the output of the node into the activity log that the dashboard shows. Examples: "Pulled 42 CPSC recalls", "Adjudicated 1 ambiguous pair", "Triage chose channel sms_now".
- It keeps a `SweepRecord` for each sweep. Home uses them for "last sweep", "sweeps run", and the quiet score.

The store (`guardian/store.py`) keeps one JSON file for each entity under `var/household` (items, recalls, matches, decisions, activity, preferences, sweeps, outbox). The shape follows the DynamoDB single-table design in the plan. A move to DynamoDB is a driver change.

## 4. API and dashboard

`guardian/api/app.py` (FastAPI) serves `/api/*` for the dashboard. It streams `/api/events` (Guardian events and each engine event). It mounts the run API of gren at `/gren/api/*` (runs, run state with analysis and metrics, events, artifacts, approve, fork, cancel, graphs). It hosts the built dashboard. `web/src/api/types.ts` is the contract.

When `GUARDIAN_API_TOKEN` is set, each POST, PUT, or DELETE on `/api` and `/gren/api` needs the token (a `Bearer` header, a `?token=` query one time, or the cookie that the query sets). Reads stay open. When `GUARDIAN_STATE_SYNC=1` and `GUARDIAN_S3_BUCKET` are set, the service pulls the state from the bucket at start and pushes it after each change.

The **Agent flow** page of the dashboard is the gren trace workbench. It has these parts:

- The run graph, laid out by `analysis.levels`. The edges are colored by kind (data, gate, repair, route, critical path). The node status is live over SSE.
- A drawer with the overview, the timeline, the events, the metrics, the decisions, the tasks, the spec, and the output.
- An inspector with the inputs, the structured output, the attempts, and the fan-out items of each node.

`/flow/trace` is the same workbench in full screen. An approval of the household gate from the workbench goes through the Guardian decision API. Thus, both surfaces stay consistent. `docs/AGENT_FLOW.md` describes the workbench.

## 5. Where AWS attaches

| Plan component | Attachment point | State |
|---|---|---|
| EC2 live server | `scripts/deploy_ec2.py` and `deploy/ec2/install.sh`: one instance, Caddy with automatic HTTPS, systemd timer for the nightly sweep, state mirrored to S3 | deployed |
| Bedrock | The `bedrock` provider of gren (`BedrockModel`, cross-region inference profiles for `haiku`, `sonnet`, `opus`) | code path exists. The account waits for Bedrock authorization. |
| AgentCore Runtime | `deploy/agentcore`: the `BedrockAgentCoreApp` entrypoint. `payload.kind` selects `sweep`, `intake`, `answer`, `status`, `seed`, or `sync` | built and tested locally. Account quotas block the deployment. |
| AgentCore Memory | preferences and household facts. Today: `prefs.json` and the store | not started |
| AgentCore Gateway | the recall feed tools as MCP. gren ships an MCP server. The feed functions are plain Python | not started |
| EventBridge Scheduler | would call `POST /api/sweep` each night. Today: the systemd timer on the EC2 server | replaced by the timer |
| SES and SNS | `guardian/notify.py` uses boto3 when `GUARDIAN_SES_FROM` or `GUARDIAN_SNS=1` is set. Otherwise, the outbox | code path exists |
| DynamoDB and S3 | `Store` driver, receipt evidence. Today: S3 mirrors the JSON store | partial |
| Observability | `events.jsonl` and the artifacts of each run, the trace workbench | local |

## 6. Security and privacy notes

- The `redact` node removes card numbers (Luhn check) before any model call. The store keeps the redacted text as evidence.
- Agent nodes run without tools unless the spec lists tools. No Guardian node uses tools.
- The API binds to 127.0.0.1 by default. On a public server, set `GUARDIAN_API_TOKEN`.
- Guardian never holds credentials for retailers, banks, or payment apps. The payout and claim flows in the Expanded tier of the plan use addresses and human attestation, not logins.
