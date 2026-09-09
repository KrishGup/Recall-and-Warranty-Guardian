# gren project notes

- gren = Graph Engineering Runtime. Design multi-agent workflows as graphs (graphs/*.yaml), run them, monitor them.
- CLI: `node node_modules/gren/bin/gren.js <command>` (validate | analyze | run | resume | fork | status | metrics | approve | tasks | complete | ui | mcp). `npx gren` also works once installed.
- MCP: .mcp.json registers the `gren` server (tools gren_*). Skill: .claude/skills/graph-engineering - load it (/graph-engineering) before designing a graph.
- Bridges: claude-code (Claude Code login, default) | api (ANTHROPIC_API_KEY) | inbox (this session executes nodes with subagents) | mock (no tokens).
- Runs are checkpointed under runs/ (gitignored). Dashboard: `node node_modules/gren/bin/gren.js ui` -> http://127.0.0.1:4545
- Reference: node_modules/gren/docs/SPEC.md (or gren_reference). Start from graphs/starter-fork-join.yaml.
