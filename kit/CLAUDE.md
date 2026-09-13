# gren project notes

- gren = Graph Engineering Runtime on Strands Agents. Design multi-agent workflows as graphs (graphs/*.yaml), run them, monitor them.
- CLI: `gren <command>` inside the activated `.venv` (validate | analyze | run | resume | fork | status | metrics | approve | tasks | complete | ui | mcp). Without activation: `.venv/Scripts/python -m gren <command>`.
- MCP: .mcp.json registers the `gren` server (tools gren_*). Skill: .claude/skills/graph-engineering - load it (/graph-engineering) before designing a graph.
- Providers: bedrock (AWS credentials) | anthropic (ANTHROPIC_API_KEY) | claude-code (Claude Code login) | inbox (this session executes nodes with subagents) | mock (no tokens).
- Runs are checkpointed under runs/ (gitignored). Dashboard: `gren ui` -> http://127.0.0.1:4545
- Reference: gren_reference (MCP) or .claude/skills/graph-engineering/references/spec.md. Start from graphs/starter-fork-join.yaml.
