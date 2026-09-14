# Agent flow: the trace workbench

The Agent flow tab is where a person checks what the agent did while nobody watched. It is gren's run dashboard rebuilt inside Guardian's shell, and it is meant to answer, in order: *what happened tonight, why is it waiting, what did it cost, and what happens next.* Everything on it is live data from gren (`/gren/api/*`) and Guardian (`/api/events`, `/api/activity`); nothing is illustrative.

This document is the audit behind the 2026-09-13 rebuild: how runs flow through the tab, what a workflow orchestrator's UI does well (Kestra was the reference), what was missing, and what was built.

## 1. How a run moves through the tab

A gren run has one of six statuses: `created`, `running`, `paused`, `completed`, `failed`, `cancelled`. Each node inside it has `pending`, `running`, `waiting_approval` / `waiting_task`, `completed`, `failed` or `skipped`. The tab shows the run in five places that agree with each other:

| Place | Question it answers | Source |
|---|---|---|
| Runs sidebar (row, filter chips, day groups) | Which run, how it started, did it need anyone | `GET /gren/api/runs` (id, status, trigger label, node counts, wall, cost) |
| Canvas (graph + banner + strip) | Where the run is, what it needs from me | `GET /gren/api/run?id=` (nodes, analysis) |
| Overview (drawer) | The run in one sentence, the facts, Guardian's own account | run record + `GET /api/activity` rows with that `run_id` |
| Timeline (drawer) | When each node ran, how long, what waited on a person | node `started_at` / `ended_at`, attempts, gate wait |
| Inspector (side panel) | One node: inputs, structured output, attempts, fan-out items, error | node record + spec |

The shapes a reader meets, and how each shows up:

- **Completed, quiet night** (most nights): sidebar row says `completed · 13/13 nodes · 12 s · $0.00`; Overview says "Completed in 12 s for $0.00. 0 certain matches, 0 sent to the matcher, held for the digest." Timeline shows the skip cascade as rows marked *did not run*.
- **Paused at the household gate**: sidebar row says `needs you`, the *Needs you* chip counts it; the canvas carries an amber banner ("Waiting on you at household_decision for 2 h 14 m") with *Open the gate*; Tasks shows the gate card with the same decisions the household got by SMS; Timeline draws the wait as a hatched amber bar that grows.
- **Failed** (tonight's Bedrock authorization block, a feed outage, a bad prompt): the canvas carries a red banner with the failing node and the error excerpt and one action, *Retry from <node>*, which forks the run from that node; Overview repeats the error in full and explains what a retry keeps.
- **Fork / late approval**: the sidebar row wears a `fork` tag; Overview says "Started by a fork of <run>" with *Open the original run*; the Timeline keeps the original timestamps for the nodes that were kept, so the gap between the first attempt and the resume is visible.
- **Intake**: three nodes (redact → extract → save_item); Overview ends with "added <brand> <item>".
- **Blueprint** (nothing has run yet, or a graph picked from the sidebar): the graph as gren will execute it, every node pending, the strip says *Blueprint · not run yet*; Overview shows the estimated critical path and cost from gren's static analysis, the findings and the checklist, and *Run this graph…*; Timeline shows the estimated schedule (levels in sequence, parallel nodes side by side); Spec shows the YAML.

## 2. What Kestra does that we took

Kestra's execution page (from `ui/src/components/executions/` in github.com/kestra-io/kestra and its docs) has: an **Overview** tab with the state history, inputs, outputs and the actions (restart, replay from a task, kill, pause, set labels); a **Gantt** tab where every task run is a bar on a shared time axis, running bars grow live, attempts are flagged, and clicking a bar opens that task's logs and actions; a **Logs** tab filterable by level and text; a **Topology** tab; and an **Executions** list filterable by state, flow, labels, text and time. The ideas that carried over, and how they landed here:

| Kestra | Guardian's Agent flow |
|---|---|
| Execution Overview (state, inputs, outputs, actions) | Overview panel: one-sentence headline per status, facts (trigger, timing, human wait, cost vs budget, provider and models, node counts), inputs, warnings, error with *Retry from*, plus "What Guardian did" (the activity rows for the run: feeds pulled, matches, triage, gate, remedy) which Kestra has no equivalent for |
| Gantt with live bars and attempt markers | Timeline panel: kind-colored bars, amber hatched human wait, red failed, attempt markers, estimated schedule for blueprints |
| Logs filtered by level and text | Events panel: free text, node, and kind chips (All, Problems, Nodes, Model calls, Gates) |
| Executions list with state filters | Runs sidebar: state chips with counts (All, Live, Needs you, Failed, Done), text search, day groups, trigger tag (nightly, manual, cli, fork), wall clock per run |
| Restart / Replay from task / Kill | *Retry from <node>* on failed runs, *Fork run from here* on any node, *Cancel run* on live runs |
| Execute a flow with inputs | *Run this graph…*: the sweep with its window and scan options, intake with the receipt text, any other graph with a form built from its `input_schema` |
| Task run detail with attempts and outputs | Inspector: started/ended, attempts with model and duration, repair rounds, gate decision, route taken, fan-out table (one row per item: status, tries, time, verdict or error), structured output |

Not taken, on purpose: Kestra's per-task log streams (gren records structured events, not free text), namespaces and flow revisions (one household, two graphs), and its metrics catalogue (ours are the engine's: speedup, kill rate, human wait, cost by model).

## 3. What was wrong before this pass

- The tab was the v1 wireframe: a horizontal strip of six node buttons, one detail box, and a dashed "what this view will show" container. The full trace view existed only at a separate URL.
- No timeline: nothing showed that feeds and the expiry scan run in parallel, that triage took 30 s, or that the household took two hours.
- No overview: a completed run's outcome (matches, channel) was buried in the Output JSON; a failed run's error was a red line in the Output tab with no way out.
- The runs list had no filters or grouping, no trigger, no duration; a fork was a bare tag.
- The event log could not be filtered; problems drowned among `call.finished` lines.
- Fan-out nodes (matcher, warranty, remedy) hid their per-item verdicts; the inspector showed the output blob only.
- The status colors had no legend; a paused run announced itself only through a small "1 gate waiting" chip.
- Blueprints did not exist: an empty server showed an empty canvas.

## 4. Reading the tab (for the demo and the video)

1. Open Agent flow. The newest run is selected; the Overview sentence is the summary. If nothing has run, the nightly-sweep blueprint is on screen: say "this is the graph before it runs".
2. Click *Timeline*. Point at the two parallel columns at the start (feeds and expiry scan; candidates and warranty), the matcher's three items, the amber gate bar.
3. Click the `household_decision` node. The inspector shows the gate, the decisions the household received, and *Approve*.
4. Click *Events*, press *Problems*: an empty list on a good night, the exact error on a bad one.
5. On a failed run: the red banner, *Retry from <node>*, and the new run appears in the sidebar as a fork.
6. *Full screen* opens the same workbench without the dashboard chrome for a screen recording.

## 5. Where the code is

- `web/src/trace/TraceView.tsx`: the workbench (data hooks, selection, actions) with `TraceWorkbench` (embedded or full-screen) and `TraceView` (full-screen frame).
- `web/src/trace/Overview.tsx`, `Timeline.tsx`, `Drawer.tsx` (tabs and the Events/Metrics/Decisions/Tasks/Spec/Output panels), `Canvas.tsx` (graph, banner, legend), `Inspector.tsx`, `RunsSidebar.tsx`, `RunDialog.tsx`, `blueprint.ts`, `data.ts` (hooks), `model.ts` (graph model, status styles, event text).
- `web/src/app/pages/Flow.tsx`: the dashboard page that embeds the workbench under its header.
- gren side: `GET /gren/api/runs` summaries now carry `labels`, `wall_ms`, `ended_at`, `forked_from` and the failure `error` (`gren/gren/engine/state.py::summarize`).

## 6. Open ideas

- Per-item sub-bars in the Timeline for fan-out nodes (needs per-item start times from the engine; only durations are recorded today).
- Cost by night on the Activity page from the same run summaries.
- A "compare two runs" view (same graph, different nights) for the demo of a quiet night against a busy one.
- Blueprint editing: gren already exposes validate/save; a YAML editor with live analysis would close the loop.
