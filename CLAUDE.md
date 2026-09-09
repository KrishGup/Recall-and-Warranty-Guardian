# gren — working notes for Claude Code

- Runtime: Node 22, TypeScript (ESM, NodeNext). Dev: `npx tsx src/cli/main.ts <cmd>`; compiled: `npm run build` then `node bin/gren.js <cmd>` (bin prefers `dist/`, so **rebuild after editing `src/`** or the CLI runs stale code).
- Tests: `npm test` (vitest, mock bridge, no tokens). Typecheck: `npm run typecheck`.
- Dashboard: `npm run ui` (http://127.0.0.1:4545) or the `gren-ui` entry in `.claude/launch.json`. It runs from `src/` via tsx; restart it after engine/server edits.
- MCP server: `.mcp.json` registers `gren` (tools `gren_*`). Skill: `.claude/skills/graph-engineering` (source of truth: `skills/graph-engineering`; keep both in sync).
- Runs live in `runs/` (gitignored). Nested runs (loops/subgraphs) are under `runs/<id>/nested/`.
- Bridges: `claude-code` needs a Claude Code login usable by subprocesses: `claude auth login --claudeai` (binary: `%APPDATA%\Claude\claude-code\<version>\claude.exe`); check with `claude auth status`. Spawn it with the parent session's `CLAUDECODE*`/`CLAUDE_CODE_*` env vars stripped (the bridge does this). `inbox` = a Claude Code session executes tasks with subagents (see the skill's orchestrator loop); `mock` for tests.
- Tool-using nodes (WebSearch/WebFetch/Read/Grep) burn a turn per tool call: always set `max_turns` and `max_cost_usd` on them (haiku with search can cost $0.5/call unbounded).
- Windows: `runs/` files are renamed atomically with EPERM retries because the dashboard polls them; keep that in mind when adding new writers.
- Design rules are in `docs/SPEC.md` and `docs/ARCHITECTURE.md`; the graph analysis (`gren analyze`) is the source of truth for what is enforced.
