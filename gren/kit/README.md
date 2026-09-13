# gren starter kit

This folder gives a new project everything it needs to design, run and monitor multi-agent workflows as graphs with gren. gren runs on the Strands Agents SDK. It can call Claude on Amazon Bedrock, on the Anthropic API, through Claude Code, or through the Claude Code session itself.

## 1. What is in this folder

| Item | Purpose |
|---|---|
| `gren-2.0.0-py3-none-any.whl` | The gren runtime as a Python package. |
| `requirements.txt` | Installs the package from the wheel. |
| `.mcp.json` | Registers the `gren` MCP server for Claude Code. The tools have the prefix `gren_`. |
| `.claude/skills/graph-engineering/` | The skill. It teaches Claude how to design, validate, run and monitor a graph. |
| `CLAUDE.md` | Short project notes that Claude reads at the start of each session. |
| `graphs/starter-fork-join.yaml` | A small complete graph: plan, three parallel workers, reducer, verifier, synthesis, human gate. |
| `graphs/*.yaml` | The larger example graphs (research report, code audit, support triage, competitive landscape, release pipeline). |
| `graphs/reducers/` | Deterministic code nodes that the graphs use (dedupe, file writer, git, webhook, and more). They are Python modules. |
| `graphs/inputs/` | Sample inputs. |

## 2. Requirements

- Python 3.11 or newer. Check with `python --version`.
- One of these ways to call Claude:
  - **Amazon Bedrock**. Configure AWS credentials (`aws configure`, environment variables, or an IAM role). Set `AWS_REGION`. Enable the Claude models in the Bedrock console. The `bedrock` provider uses this.
  - **API key**. Set the environment variable `ANTHROPIC_API_KEY`. The `anthropic` provider uses this key.
  - **Claude Code login** (subscription). Run `claude auth login` one time. Check with `claude auth status`. The `claude-code` provider uses this login.
- Claude Code (desktop app or CLI) for the Claude-driven guide. The manual guide does not need it.

## 3. Setup

1. Make a new folder. Example: `C:\work\my-graphs`.
2. Copy all files from this `kit` folder into the new folder. Include the hidden items `.claude`, `.mcp.json` and `.gitignore`.
3. Open a terminal in the new folder.
4. Make a virtual environment: `python -m venv .venv`.
5. Activate it: `.venv\Scripts\activate` on Windows, `source .venv/bin/activate` on macOS or Linux.
6. Run `pip install -r requirements.txt`.
7. Run `gren bridges`. The output shows which providers are available.
8. Run `gren validate graphs/starter-fork-join.yaml`. The output must end with `OK: starter-fork-join is valid`.
9. Optional: run `gren run graphs/starter-fork-join.yaml --bridge mock --auto-approve --input "{\"task\":\"Should a small team adopt graph orchestration?\"}"`. This runs the starter graph with the mock provider. It uses no tokens.

On macOS or Linux, edit `.mcp.json` and change the command to `.venv/bin/python`.

If you install gren in an existing project instead, run `pip install <path to the wheel>` and then `gren init`. The `init` command writes the same files.

## 4. Start a Claude Code session

1. Open Claude Code in the new folder.
2. Claude Code asks you to approve the project MCP server `gren`. Approve it.
3. Paste one of the sample prompts below.

### Sample prompt (Amazon Bedrock)

```
Read README.md and CLAUDE.md in this folder. Then load the /graph-engineering skill and read its references (design-guide.md, spec.md, orchestrator-loop.md, metrics.md).
We use gren with the bedrock provider. AWS credentials and AWS_REGION are set in the environment. Pass bridge: "bedrock" to gren_run.
Confirm the gren MCP tools are loaded: call gren_list_graphs and gren_reference.
Then tell me, in a few short sentences, when you would use each provider (bedrock, anthropic, claude-code, inbox, mock) and each gren_ tool. Wait for my task after that.
```

### Sample prompt (API key)

```
Read README.md and CLAUDE.md in this folder. Then load the /graph-engineering skill and read its references (design-guide.md, spec.md, orchestrator-loop.md, metrics.md).
We use gren with the anthropic provider. ANTHROPIC_API_KEY is set in the environment. Pass bridge: "anthropic" to gren_run.
Confirm the gren MCP tools are loaded: call gren_list_graphs and gren_reference.
Then tell me, in a few short sentences, when you would use each provider (bedrock, anthropic, claude-code, inbox, mock) and each gren_ tool. Wait for my task after that.
```

### Sample prompt (Claude Code login)

```
Read README.md and CLAUDE.md in this folder. Then load the /graph-engineering skill and read its references (design-guide.md, spec.md, orchestrator-loop.md, metrics.md).
We use gren with the claude-code provider. It uses the Claude Code login on this machine, not an API key. Pass bridge: "claude-code" to gren_run.
Confirm the gren MCP tools are loaded: call gren_list_graphs and gren_reference.
Then tell me, in a few short sentences, when you would use each provider (bedrock, anthropic, claude-code, inbox, mock) and each gren_ tool. Wait for my task after that.
```

### Sample prompt (this session does the work, no key needed)

```
Read README.md and CLAUDE.md in this folder. Then load the /graph-engineering skill and read references/orchestrator-loop.md carefully.
We use gren with the inbox provider. You are the worker: run each task with a subagent that uses the model the task asks for, then submit the result with gren_complete_task.
Confirm the gren MCP tools are loaded with gren_list_graphs. Wait for my task after that.
```

## 5. Guide A: build and run a simple flow by hand

This guide uses the terminal only. Activate the virtual environment first.

1. Make a new graph from a shape. Run `gren new fork-join my-flow --out graphs/my-flow.yaml`.
2. Open `graphs/my-flow.yaml` in an editor. Change the prompts to your task. Keep the `output_schema` blocks.
3. Validate the graph. Run `gren validate graphs/my-flow.yaml`. Fix every line marked `ERROR`. Read each `WARNING`.
4. Read the analysis. Run `gren analyze graphs/my-flow.yaml`. The output shows each edge and the data that crosses it, the critical path and the cost estimate.
5. Do a dry run. Run `gren run graphs/my-flow.yaml --bridge mock --auto-approve --input "{\"task\":\"your task text\"}"`. This uses no tokens.
6. Do a live run. Run `gren run graphs/my-flow.yaml --bridge bedrock --input "{\"task\":\"your task text\"}"`. Use `--bridge anthropic` for an API key or `--bridge claude-code` for a Claude Code login.
7. Wait for the gate. The terminal shows `HUMAN GATE`. It shows what happens if you approve and if you reject. Type `y` to approve or `n` to reject. In a second terminal you can also run `gren approve <run_id> <gate>`.
8. Read the result. Run `gren output <run_id>`.
9. Read the metrics. Run `gren metrics <run_id>`. Look at the parallel speedup, the verifier kill rate and the cost by model.
10. Open the dashboard. Run `gren ui`. Open http://127.0.0.1:4545 in a browser. Click a node to see its prompt, output and attempts. Hover an edge to see the data that crosses it.
11. Change one late prompt and run only the tail. Run `gren fork <run_id> --from <node> --spec graphs/my-flow.yaml`. The upstream results are reused.

Useful commands: `gren list`, `gren status <run_id>`, `gren events <run_id> --follow`, `gren resume <run_id>`, `gren shapes`, `gren reducers`.

## 6. Guide B: build and run a flow with Claude

This guide uses Claude Code with the `gren` MCP server and the skill.

1. Start the session with a sample prompt from section 4. Wait for Claude to confirm the tools.
2. Give the task. Example:

```
Build a gren graph that answers this question with verified findings: "Which three risks matter most for a small team that adopts multi-agent LLM workflows?"
Use the map-reduce-verify shape. Use haiku for the workers and the verifier, sonnet for the synthesis. Put a human gate before the final output is recorded.
Validate the graph, fix every error, then show me the analysis (edges, critical path, cost estimate) before you run anything.
```

3. Claude designs the spec, writes it with `gren_write_graph`, and shows the analysis. Read the edges. Each edge must carry real data.
4. Tell Claude to run it. Example: `Run it with the bedrock provider.` Claude calls `gren_run` and then `gren_wait`.
5. When a gate waits, Claude tells you what the system will do if you approve and if you reject. Answer `approve` or `reject`. Add a comment if you reject.
6. Ask for the result and the metrics. Example: `Show me the output and the metrics. What would you change in the topology?`
7. To change one node, say: `Change the synthesis prompt to ... and fork the run from the synthesis node.` Claude calls `gren_fork`. Only the tail runs again.
8. Open the dashboard at any time. Run `gren ui` in a terminal.

With the `inbox` provider, Claude also executes the nodes. It spawns one subagent per task with the model the task asks for, then submits each result. The engine still validates every result and enforces the budgets and the gates.

## 7. Where the data is

- `runs/<run_id>/` holds the checkpoint, the events, the prompts and raw outputs (`artifacts/`), the inbox tasks and the approvals.
- `out/` holds files that the graphs write, for example reports.
- `.worktrees/` holds git worktrees that the release pipeline makes. Remove them with `python graphs/reducers/git-worktree-remove.py <worktree>`. Do not use `git worktree remove --force` on Windows. It follows the `.venv` link and deletes the real folder.

## 8. Problems and solutions

| Problem | Solution |
|---|---|
| `bedrock unavailable` | Configure AWS credentials. Set `AWS_REGION`. Enable the Claude models in the Bedrock console. |
| `claude-code unavailable` or `not logged in` | Run `claude auth login`. Then run `claude auth status`. |
| `spend cap exceeded` | Raise `budget.max_cost_usd` in the graph, or cap a fan-out with a `top_k` code node before the verifier. |
| A node hit `max_turns` | Raise `max_turns` on that node. Set `max_cost_usd` on the node. Tell the node how many tool calls it may use. |
| The MCP tools are not visible in Claude Code | Check that `.mcp.json` is in the project root and points at the virtual environment's Python. Restart the session. Approve the server when asked. |
| The dashboard shows no runs | The dashboard reads `runs/` in the folder where you started it. Start it in the project folder. |
| `gren` is not found | Activate the virtual environment, or run `.venv\Scripts\python -m gren <command>`. |
