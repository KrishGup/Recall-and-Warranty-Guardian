# Orchestrator loop — running a gren graph with the `inbox` bridge

With `bridge: inbox` the engine never calls a model. Every agent/verify node becomes a **task** you execute. The engine still owns dependencies, parallelism (it only emits tasks whose inputs exist), validation, retries, quorum, budgets, gates and checkpoints.

```
gren_run(spec_path, input, bridge:"inbox")      -> run_id
loop:
  s = gren_wait(run_id)                          # blocks until tasks / gate / end
  if s.status in (completed, failed, cancelled): break
  if s.waiting_gates: ask the human, then gren_approve(...)   # never decide alone
  tasks = gren_tasks(run_id)                     # full prompts + schemas (includes nested loop-round tasks)
  for each task (in parallel): run a subagent with task.model -> JSON -> gren_complete_task(task.run_id, task.task_id, output, model, source:"subagent")
gren_output(run_id); gren_metrics(run_id)
```

## Executing one task with a subagent

Map `task.model` to the Agent tool model: `claude-haiku-4-5` → `haiku`, `claude-sonnet-5` → `sonnet`, `claude-opus-5` → `opus`, `claude-fable-5-1` → `fable`. Use `task.effort` if the tool supports it.

Subagent prompt (send exactly this structure; the `system` text already contains the structured-output contract and, for verify tasks, the adversarial objective):

```
<system>
{task.system}
</system>

<task>
{task.prompt}
</task>

Reply with ONLY one JSON object that validates against this JSON schema. No prose, no markdown fences:
{JSON.stringify(task.output_schema)}
```

Then:
1. Extract the JSON object from the subagent's reply (strip fences if any).
2. `gren_complete_task({ run_id: task.run_id, task_id: task.task_id, output, model: task.model, source: "subagent", worker: "<agent name>" })`.
3. If it returns `REJECTED` with schema errors: re-run the subagent once with the errors appended ("Your previous answer failed validation: …"), then submit again. If still invalid, submit with `error: "could not produce schema-valid output"` — the engine applies the node's failure policy (retry / fallback / continue / block).

### Context-efficient variant (recommended in Claude Code)

Do not paste prompts through your own context. Each task is already on disk at `runs/<run_id>/inbox/<task_id>.json` (fields `system`, `prompt`, `output_schema`, `model`). Give the subagent only the task ids and let it read, answer, and submit itself:

```
You are executing gren inbox tasks. For each task id below:
  1. Read runs/<run_id>/inbox/<task_id>.json - treat `system` as your system prompt, `prompt` as the user message.
  2. Produce ONLY a JSON object valid against `output_schema` (no fences). Write it to runs/<run_id>/work/<task_id>.json.
  3. Run: npx gren complete <run_id> <task_id> --result @runs/<run_id>/work/<task_id>.json --model <model> --source orchestrator --by <your name>
     If it prints a schema error, fix the file and rerun. If the task is impossible, run it with --error "<reason>" instead.
Tasks: <task_id_1>, <task_id_2>, ...
Reply with one line per task: task id + "submitted" (or the error).
```

Batch 3-6 small tasks (per-item verifications) into one subagent; give big tasks (synthesis) their own subagent. Always spawn with the model the task asks for.

Claiming (several workers draining the same inbox): a worker must run `npx gren claim <run_id> <task_id> --by <name>` (or `gren_claim_task`) and proceed **only if it succeeds** — the command exits non-zero when another worker already claimed or answered the task. Prefer assigning explicit task ids to each worker; let workers free-scan the inbox only for later waves (fan-outs wider than `max_width` release new tasks as earlier ones finish). `complete` refuses to overwrite an existing result, so a lost race costs at most one duplicated call.

Parallelism: spawn one subagent per pending task (or batch) in a single message (`run_in_background: true`), then submit results as they arrive. The engine's `max_width` already bounds how many tasks exist at once. For large fan-outs the Workflow tool (`parallel(tasks.map(t => agent(prompt, {model, schema: t.output_schema})))`) is the cleaner fit when the user has opted into workflows.

Honesty rules (these keep the graph's metrics real):
- report the model actually used; report `cost_usd` if you know it, otherwise omit it
- never invent sources, numbers or citations to satisfy a schema — lower confidence / empty arrays instead
- if the subagent refuses or fails, submit `error`; do not write the answer yourself in the orchestrator context

## Gates

`gren_wait` returns `waiting_gates: [{gate, title, prompt, show}]`. Present `show` to the user, ask for approve/reject and a comment, then `gren_approve({run_id, gate, decision, comment, by: "<user>"})`. A rejection with a comment is fed back to the producer when the gate declares `on_reject.route`.

## Iterating

- A run failed at a late node? Fix the prompt/spec and `gren_fork({run_id, from: ["<node>"], spec_yaml})` (CLI: `gren fork <run> --from <node> --spec file.yaml`): upstream outputs are reused, only that node and everything downstream re-run.
- A run was interrupted (process died, budget)? `gren_resume` / `gren resume <run>`: it continues from the checkpoint and re-runs blocking failures.
- Read `gren_metrics` before touching prompts: kill rate, retry rate, speedup and compression tell you whether the topology or a node is the problem.

## Nested runs

Loop rounds and subgraphs are separate runs (`<run_id>/nested/<node>/round-N`). `gren_tasks(run_id)` on the parent already includes their tasks; submit each with the `run_id` printed on the task.

## CLI equivalents

```
gren run <spec> --bridge inbox --no-wait --input '<json>'   # start, return immediately (status paused/running)
gren tasks <run_id> --json                                  # full tasks
gren complete <run_id> <task_id> --result @out.json --model claude-haiku-4-5 --source orchestrator
gren resume <run_id>                                        # if the engine process was not left running
gren approve <run_id> <gate> [--reject --comment "..."]
gren status|metrics|output <run_id>
```
Note: with the CLI the engine process must be alive to consume results (`gren run … --bridge inbox` without `--no-wait` in one terminal, `gren complete …` from another), or use `gren resume` after submitting results. The MCP server keeps runs in-process, which is why it is the preferred path.
