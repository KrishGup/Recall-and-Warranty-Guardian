# read_this_labubu.md

**Where things are (three lines):**

1. Guardian runs end to end on gren + Strands: `guardian seed` → `guardian serve` → click the logo (or `guardian sweep`) pulls live CPSC/NHTSA/openFDA recalls, matches them in code, adjudicates the ambiguous pairs with Opus, verifies the plan, pauses on the household gate, and after "Request full refund" in the dashboard drafts and "sends" the remedy (to `var/household/outbox` until SES/SNS are configured), then schedules the follow-up. Verified live on 2026-09-13 with real recalls (Boon NURSH bottles, Cade finger lights, Hampton Bay fan, 2019 Outback campaigns); 27 pytest tests cover it on the mock provider.
2. The web app (`web/`, Vite + React) implements the whole design handoff: the six dashboard pages with the shell, panels, dark/RTL/mobile, and `/flow/trace`, the full gren trace view (runs, canvas, drawer, inspector, gate approval) live over SSE; `npm run build` and `guardian serve` host it at http://127.0.0.1:8787, `VITE_MOCK=1 npm run dev` runs it with no backend.
3. Not built yet, in order of value for the submission: AWS deployment (AgentCore Runtime + Bedrock; gren's `bedrock` provider exists but has never made a live call from this machine because there are no AWS credentials here), SES/SNS delivery (`GUARDIAN_SES_FROM`, `GUARDIAN_SNS=1`), the demo video and the `docs/architecture.png` export of the README diagram, and the plan's Expanded tier (mailroom photos, grocery advisories, settlements).

Everything else you need is in `README.md` (quickstart, node table), `ARCHITECTURE.md` (how the graphs sit on Strands, where AWS attaches), `CLAUDE.md` (repo conventions for Claude sessions), and gren's own `gren/docs/HANDOFF.md`.
