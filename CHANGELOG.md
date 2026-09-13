# Changelog

## 2.0.0 - 2026-09-13

Rebuilt in Python on the Strands Agents SDK. The graph model, the spec, the run store layout, the dashboard, the CLI commands and the MCP tool names are unchanged.

- Engine: gren specs compile into a Strands `Graph`. One executor per node, AND-join edge conditions, repair cycles as conditional back-edges with a generation guard, gates as Strands interrupts, memoised replay for resume and fork.
- Providers as Strands models: `bedrock` (AWS default), `anthropic`, `claude-code`, `inbox`, `mock`.
- Custom reducers are Python modules (`module: ./reducers/name.py` exporting `reduce(input, args, ctx)`). All 19 example reducers ported.
- Dashboard server on FastAPI (REST + SSE), same UI. MCP server on `mcp` 2.x with the same 23 tools. CLI on typer with the same commands.
- New docs: `docs/AWS.md` (Bedrock, IAM, OpenTelemetry, container, Lambda, AgentCore), `docs/HANDOFF.md`.
- Starter kit ships a wheel instead of an npm tarball. `gren init` scaffolds a project from the installed package.
- Tests: 29 pytest tests on the mock provider.

## 1.0.0 - 2026-09-09 (tag `v1.0.0`, frozen under `v1/`)

TypeScript runtime with its own scheduler. Four bridges (claude-code, api, inbox, mock), Lucidchart-style dashboard with Design mode, MCP server, skill, five showcase graphs verified live, starter kit.
