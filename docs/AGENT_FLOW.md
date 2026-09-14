# Agent flow: the trace workbench

The Agent flow tab is where a person examines what the agent did while nobody watched. It is the run dashboard of gren, rebuilt inside the Guardian shell. It answers four questions, in this order: what happened tonight, why does the run wait, what did it cost, and what happens next. All data on the tab is live. It comes from gren (`/gren/api/*`) and from Guardian (`/api/events`, `/api/activity`). Nothing is illustrative.

This document is the audit behind the rebuild of 2026-09-13. It explains how runs move through the tab, what a workflow orchestrator does well (Kestra was the reference), what was missing, and what was built.

## 1. How a run moves through the tab

A gren run has one of six statuses: `created`, `running`, `paused`, `completed`, `failed`, `cancelled`. Each node in the run has one of these statuses: `pending`, `running`, `waiting_approval` or `waiting_task`, `completed`, `failed`, `skipped`. The tab shows the run in five places. The five places agree with each other.

| Place | Question that it answers | Source |
|---|---|---|
| Runs sidebar (rows, filter chips, day groups) | Which run, how it started, did it need a person | `GET /gren/api/runs` (id, status, trigger label, node counts, wall clock, cost) |
| Canvas (graph, banner, strip) | Where the run is, what it needs from me | `GET /gren/api/run?id=` (nodes, analysis) |
| Overview (drawer) | The run in one sentence, the facts, the account of Guardian | The run record and the `GET /api/activity` rows with that `run_id` |
| Timeline (drawer) | When each node ran, how long, what waited on a person | Node `started_at` and `ended_at`, attempts, gate wait |
| Inspector (side panel) | One node: inputs, structured output, attempts, fan-out items, error | The node record and the spec |

These are the run shapes that a reader meets, and how each one shows:

- **Completed, quiet night** (most nights). The sidebar row says `completed · 13/13 nodes · 12 s · $0.00`. The Overview says "Completed in 12 s for $0.00". It adds the outcome: "0 certain matches, 0 sent to the matcher, held for the digest". The Timeline shows the skipped nodes as rows marked *did not run*.
- **Paused at the household gate.** The sidebar row says `needs you`, and the *Needs you* chip counts it. The canvas shows an amber banner ("Waiting on you at household_decision for 2 h 14 m") with the button *Open the gate*. Tasks shows the gate card with the same decisions that the household got by SMS. The Timeline draws the wait as a hatched amber bar that grows.
- **Failed** (the Bedrock authorization block of tonight, a feed outage, a bad prompt). The canvas shows a red banner with the failed node, the error text, and one action: *Retry from <node>*. The action forks the run from that node. The Overview repeats the full error and explains what a retry keeps.
- **Fork or late approval.** The sidebar row has a `fork` tag. The Overview says "Started by a fork of <run>" and offers *Open the original run*. The Timeline keeps the original timestamps of the kept nodes. Thus, the gap between the first attempt and the resume is visible.
- **Intake.** Three nodes (redact, extract, save_item). The Overview ends with "added <brand> <item>".
- **Blueprint** (nothing has run yet, or the user selected a graph in the sidebar). The canvas shows the graph as gren will execute it. Each node is pending. The strip says *Blueprint · not run yet*. The Overview shows the estimated critical path and cost from the static analysis of gren, the findings, the checklist, and *Run this graph…*. The Timeline shows the estimated schedule (levels in sequence, parallel nodes side by side). Spec shows the YAML.

## 2. What Kestra does, and what we took

The execution page of Kestra (`ui/src/components/executions/` in github.com/kestra-io/kestra, and its documentation) has these parts. An **Overview** tab with the state history, inputs, outputs, and the actions (restart, replay from a task, kill, pause, set labels). A **Gantt** tab: each task run is a bar on a shared time axis. A running bar grows live. Attempts are flagged. A click on a bar opens the logs and the actions of that task. A **Logs** tab with a level filter and a text filter. A **Topology** tab. An **Executions** list with filters for state, flow, labels, text, and time.

This table shows the ideas that we took, and how they landed:

| Kestra | Agent flow in Guardian |
|---|---|
| Execution Overview (state, inputs, outputs, actions) | Overview panel: one-sentence headline for each status; facts (trigger, timing, human wait, cost against budget, provider and models, node counts); inputs; warnings; the error with *Retry from*; and "What Guardian did" (the activity rows of the run: feeds pulled, matches, triage, gate, remedy). Kestra has no equivalent for the last part. |
| Gantt with live bars and attempt markers | Timeline panel: kind-colored bars, hatched amber human wait, red failed bars, attempt markers, estimated schedule for blueprints |
| Logs with a level filter and a text filter | Events panel: free text, node, and kind chips (All, Problems, Nodes, Model calls, Gates) |
| Executions list with state filters | Runs sidebar: state chips with counts (All, Live, Needs you, Failed, Done), text search, day groups, a trigger tag (nightly, manual, cli, fork), wall clock for each run |
| Restart, replay from a task, kill | *Retry from <node>* on a failed run, *Fork run from here* on any node, *Cancel run* on a live run |
| Execute a flow with inputs | *Run this graph…*: the sweep with its window and scan options, intake with the receipt text, any other graph with a form built from its `input_schema` |
| Task run detail with attempts and outputs | Inspector: started and ended times, attempts with model and duration, repair rounds, gate decision, route taken, fan-out table (one row for each item: status, tries, time, verdict or error), structured output |

We did not take these parts, by decision:

- The log streams for each task. gren records structured events, not free text.
- Namespaces and flow revisions. Guardian has one household and two graphs.
- The metrics catalogue of Kestra. Our metrics come from the engine: speedup, kill rate, human wait, cost by model.

## 3. What was wrong before this pass

- The tab was the v1 wireframe: a horizontal strip of six node buttons, one detail box, and a dashed "what this view will show" container. The full trace view existed only at a separate URL.
- There was no timeline. Nothing showed that the feeds and the expiry scan run in parallel, that triage took 30 s, or that the household took two hours.
- There was no overview. The outcome of a completed run (matches, channel) was only in the Output JSON. The error of a failed run was a red line in the Output tab, with no way out.
- The runs list had no filters, no groups, no trigger, and no duration. A fork was only a tag.
- The event log had no filter. Problems were hidden among the `call.finished` lines.
- Fan-out nodes (matcher, warranty, remedy) hid the verdicts of each item. The inspector showed only the output blob.
- The status colors had no legend. A paused run showed itself only through a small "1 gate waiting" chip.
- Blueprints did not exist. An empty server showed an empty canvas.

## 4. How to read the tab (for the demo and the video)

1. Open Agent flow. The newest run is selected. The Overview sentence is the summary. If nothing has run, the nightly-sweep blueprint is on screen. Say: "This is the graph before it runs."
2. Click *Timeline*. Point at the two parallel columns at the start (feeds and expiry scan; candidates and warranty), the three items of the matcher, and the amber gate bar.
3. Click the `household_decision` node. The inspector shows the gate, the decisions that the household received, and *Approve*.
4. Click *Events*, then *Problems*. The list is empty on a good night. On a bad night, it shows the exact error.
5. On a failed run, show the red banner and *Retry from <node>*. The new run appears in the sidebar as a fork.
6. *Full screen* opens the same workbench without the dashboard chrome. Use it for a screen recording.

## 5. Where the code is

- `web/src/trace/TraceView.tsx`: the workbench (data hooks, selection, actions). `TraceWorkbench` renders embedded or full screen. `TraceView` is the full-screen frame.
- `web/src/trace/Overview.tsx`, `Timeline.tsx`, `Drawer.tsx` (the tabs and the Events, Metrics, Decisions, Tasks, Spec, and Output panels), `Canvas.tsx` (graph, banner, legend), `Inspector.tsx`, `RunsSidebar.tsx`, `RunDialog.tsx`, `blueprint.ts`, `data.ts` (hooks), `model.ts` (graph model, status styles, event text).
- `web/src/app/pages/Flow.tsx`: the dashboard page that embeds the workbench under its header.
- gren side: the `GET /gren/api/runs` summaries carry `labels`, `wall_ms`, `ended_at`, `forked_from`, and the failure `error` (`gren/gren/engine/state.py::summarize`).

## 6. Open ideas

- Sub-bars for each item in the Timeline for fan-out nodes. This needs start times for each item from the engine. Today, the engine records only durations.
- Cost by night on the Activity page, from the same run summaries.
- A view that compares two runs of the same graph on different nights. Use it in the demo to compare a quiet night with a busy night.
- Blueprint editing. gren already exposes validate and save. A YAML editor with live analysis would close the loop.
