# gren - working notes for Claude Code

- Runtime: Python 3.11+, Strands Agents SDK. Package `gren/` (installed editable in `.venv`): `.venv/Scripts/python -m gren <cmd>` or `.venv/Scripts/gren <cmd>`.
- Tests: `.venv/Scripts/python -m pytest -q` (mock provider, no tokens; `-p no:cacheprovider` avoids a stray cache dir). The engine suite is `tests/test_engine.py`.
- Dashboard: `gren ui` (http://127.0.0.1:4545) or the `gren-ui` entry in `.claude/launch.json`. Restart it after engine/server edits.
- MCP server: `.mcp.json` registers `gren` (tools `gren_*`). Skill: `.claude/skills/graph-engineering` (source of truth: `skills/graph-engineering`; keep both in sync).
- Runs live in `runs/` (gitignored). Nested runs (loops/subgraphs) are under `runs/<id>/nested/`.
- Providers ("bridges"): `bedrock` (AWS credentials; default when present), `anthropic` (ANTHROPIC_API_KEY), `claude-code` (headless `claude -p`; login with `claude auth login --claudeai`, binary under `%APPDATA%\Claude\claude-code\<version>\claude.exe`, spawned with `CLAUDECODE*`/`CLAUDE_CODE_*` env stripped), `inbox` (a Claude Code session executes tasks with subagents), `mock` (tests; needs `GREN_ALLOW_MOCK=1` to be the default).
- Tool-using nodes (WebSearch/WebFetch/Read/Grep) burn a turn per tool call: always set `max_turns` and `max_cost_usd` on them.
- Windows: `runs/` files are written atomically with EPERM retries because the dashboard polls them; keep that in mind when adding writers.
- **Worktrees (`.worktrees/`) contain a junction to `.venv`/`node_modules`. NEVER `git worktree remove --force` them** - it deletes the real folder. Use `graphs/reducers/git-worktree-remove.py` or `cmd /c rmdir <worktree>\.venv` first.
- v1 (TypeScript, tag `v1.0.0`) is frozen under `v1/` for reference; do not edit it.
- Design rules: `docs/SPEC.md`, `docs/ARCHITECTURE.md` (Strands mapping), `docs/AWS.md`; `gren analyze` is the source of truth for what is enforced.
- Handoff state, verified vs unverified items and open work: `docs/HANDOFF.md`. Version history: `CHANGELOG.md`.
