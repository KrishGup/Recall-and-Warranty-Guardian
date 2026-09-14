# Guardian: working notes for Claude Code

- There are two packages. `guardian/` is this product. `gren/` is the graph engine that it runs on. `gren/` is a git subtree of X:/Code/26Projects/gren (remote `gren-local`). Sync it with `git subtree pull --prefix=gren gren-local main`. Never copy files between the two. The notes of gren are in `gren/CLAUDE.md` and `gren/docs/HANDOFF.md`.
- Python 3.11 or later. The venv is `.venv` (`.venv/Scripts/python` on Windows). Install with `pip install -e "./gren[dev]" -e ".[dev]"`. Run the tests with `GREN_ALLOW_MOCK=1 python -m pytest -q -p no:cacheprovider` (40 tests, mock provider, recorded feeds, about 30 s).
- Run the app: `guardian seed`, then `guardian serve --port 8787` (API, the gren API at /gren, and the built dashboard), and `cd web && npm run dev` (port 5173, proxies to 8787). `.claude/launch.json` has both. From a terminal: `guardian sweep`, `guardian answer <id> <choice>`, `guardian intake --file demo/receipt.txt`.
- Runtime state lives under `var/` (gitignored): `var/household` (JSON store, outbox) and `var/runs` (gren run store). `--data` and `--runs`, or `GUARDIAN_DATA` and `GUARDIAN_RUNS`, move both. The service publishes them to the graph reducers.
- The providers come from gren: `bedrock` (AWS credentials), `anthropic` (ANTHROPIC_API_KEY), `claude-code` (headless Claude Code login, the only provider on this machine), `mock` (`GREN_ALLOW_MOCK=1`). `GUARDIAN_FEEDS=fixtures` replays the recorded feeds.
- The graphs are `guardian/graphs/nightly-sweep.yaml` and `intake.yaml`. After an edit, validate with `.venv/Scripts/gren validate <yaml>`. The tests, the activity formatter of the service, and the trace workbench reference the node ids. Keep the node ids stable. In YAML, quote `"yes"` and `"no"` in enums.
- The design rules for the web app are in `design/README.md`. Use exactly three fonts (Roboto Slab, Lora, Habibi, and monospace). Use the five brand hex colors and their listed derivatives. Use logical CSS properties for RTL. Never show a status by color only. Tokens: `web/src/theme/tokens.ts`. API contract: `web/src/api/types.ts`. Keep it in sync with `guardian/api/app.py` and `service.py`.
- The Agent flow tab is the gren trace workbench embedded in the shell (`web/src/trace/*`, page `web/src/app/pages/Flow.tsx`; `/flow/trace` is the full-screen frame). `docs/AGENT_FLOW.md` has the audit, the design decisions, and how each run shape shows.
- Live deployment: `scripts/deploy_ec2.py up|update|status|logs|run|down` (EC2, Caddy, sslip.io). `deploy/ec2/install.sh` runs on the instance. The release zip and `config/env` live in the state bucket. `GUARDIAN_API_TOKEN` gates POST, PUT, and DELETE when it is set. `GUARDIAN_STATE_SYNC=1` (server only) mirrors `var/` to S3. `deploy/agentcore` is the AgentCore path. The account quotas (0) block it.
- Documentation follows ASD-STE100 (Simplified Technical English). Keep sentences short: 20 words in a procedure, 25 in a description. Use the active voice and the present tense. Put one instruction in each step. Use one meaning for each term. Do not use contractions. Use "must" for a requirement and "can" for a possibility. Write new documents and edits in the same style.
- Do not commit anything under `var/`, the zip files, or `web/dist`.
- Handoff: `read_this_labubu.md`. Plan: `BUILD_PLAN.md` (the sections after 3 are the Core tier; milestone 1 covers recalls and warranty windows, not advisories or settlements).

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
