# Guardian — working notes for Claude Code

- Two packages: `guardian/` (this product) and `gren/` (the graph engine it runs on; a git subtree of X:/Code/26Projects/gren, remote `gren-local`; sync with `git subtree pull --prefix=gren gren-local main`, never copy files). gren's own notes: `gren/CLAUDE.md`, `gren/docs/HANDOFF.md`.
- Python 3.11+, venv at `.venv` (`.venv/Scripts/python` on Windows): `pip install -e "./gren[dev]" -e ".[dev]"`. Tests: `GREN_ALLOW_MOCK=1 python -m pytest -q -p no:cacheprovider` (32 tests, mock provider, recorded feeds; about 15 s).
- Run it: `guardian seed` → `guardian serve --port 8787` (API + gren API at /gren + built dashboard) and `cd web && npm run dev` (5173, proxies to 8787). `.claude/launch.json` has both. `guardian sweep` / `guardian answer <id> <choice>` / `guardian intake --file demo/receipt.txt` from a terminal.
- Runtime state lives under `var/` (gitignored): `var/household` (JSON store, outbox) and `var/runs` (gren run store). `--data/--runs` or `GUARDIAN_DATA/GUARDIAN_RUNS` relocate both; the service publishes them to the graph reducers.
- Providers come from gren: `bedrock` (AWS creds), `anthropic` (ANTHROPIC_API_KEY), `claude-code` (headless Claude Code login; the only one available on this machine), `mock` (`GREN_ALLOW_MOCK=1`). `GUARDIAN_FEEDS=fixtures` replays the recorded feeds.
- The graphs are `guardian/graphs/nightly-sweep.yaml` and `intake.yaml`; validate with `.venv/Scripts/gren validate <yaml>` after any edit. Node ids are referenced by the tests, the service's activity formatter and the trace view: keep them stable. In YAML, quote `"yes"`/`"no"` in enums.
- Design rules for the web app are in `design/README.md`: exactly three fonts (Roboto Slab, Lora, Habibi + monospace), five brand hexes and their listed derivatives, logical CSS properties for RTL, status never color-only. Tokens: `web/src/theme/tokens.ts`; API contract: `web/src/api/types.ts` (keep in sync with `guardian/api/app.py` and `service.py`).
- Agent flow tab = the gren trace workbench embedded in the shell (`web/src/trace/*`, page `web/src/app/pages/Flow.tsx`; `/flow/trace` is the full-screen frame). Audit, design decisions and how each run shape shows up: `docs/AGENT_FLOW.md`.
- Live deployment: `scripts/deploy_ec2.py up|update|status|logs|run|down` (EC2 + Caddy + sslip.io; `deploy/ec2/install.sh` runs on the box; the release zip and `config/env` live in the state bucket). `GUARDIAN_API_TOKEN` gates POST/PUT/DELETE when set; `GUARDIAN_STATE_SYNC=1` (server only) mirrors `var/` to S3. `deploy/agentcore` is the AgentCore path, blocked by account quotas at 0.
- Do not commit anything under `var/`, the zips, or `web/dist`.
- Handoff: `read_this_labubu.md`. Plan: `BUILD_PLAN.md` (sections after 3 are the Core tier; milestone 1 covers recalls + warranty windows, not advisories or settlements).

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance

- Where these AWS rules conflict with the project's own instructions, the
  project's instructions take precedence.
- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.
<!-- END AWS Agent Toolkit rules -->
