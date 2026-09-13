# AWS setup for Guardian (hackathon edition)

What has to exist on the AWS side, who does each step, and what to paste into `.env`. Written for the two of us:
**you** do the console clicks that need the account owner, **Claude/Labubu** do everything that can be done with the
credentials afterwards (buckets, roles, deployment). Keys never go into git: `.env` is gitignored, and
`.env.example` is the template.

## 0. The tiers, in the order they pay off

| Tier | What it unlocks | Your time | Our build time after |
|---|---|---|---|
| **1. Bedrock** | The sweep runs on Claude on AWS instead of a laptop login. Judged as "Strands on Bedrock". | 15 min | 0 (gren already has the provider) |
| **2. AgentCore Runtime + a live URL** | The nightly sweep deployed as an AgentCore agent, the dashboard reachable by judges. Optional in the rules but "strengthens the Technical Implementation score". | 10 min | 2 to 4 h (entrypoint, S3-backed store, container, deploy) |
| **3. SES email** | The remedy request actually leaves as email (to a safe address during demos). | 10 min | 0 (code path exists) |
| **Skip** | SNS SMS to US numbers (needs a registered toll-free or 10DLC number, days of lead time), Cognito, Gmail OAuth. The outbox and the dashboard stand in for SMS in the video. | | |

Do tier 1 now; it is the one everything else needs.

## 1. Accounts and identities (you, once)

1. **AWS account.** Sign in at https://console.aws.amazon.com. Turn on MFA for the root user. Note the 12-digit **account id** (top-right menu).
2. **Region.** Use **us-east-1 (N. Virginia)** everywhere below. Every Claude model we use is available there through cross-region inference and AgentCore launched there.
3. **AWS Builder ID** (a submission requirement, separate from the AWS account): https://profile.aws.amazon.com → Create Builder ID with your email. Nothing to paste; just note that it exists.
4. **The $50 credit.** Hackathon page → Resources tab → credit request form. It asks for the AWS account id. When the code arrives: console → Billing → Credits → Redeem. Nothing to paste.

## 2. Credentials the code will use (you → Claude)

Pick **A** if you only want Bedrock today; pick **B** for everything (Bedrock, SES, S3, AgentCore). Both can coexist.

### A. Bedrock API key (fastest, models only)

Console → **Amazon Bedrock** → left menu **API keys** → **Generate long-term API key** → copy it once.

```
AWS_BEARER_TOKEN_BEDROCK=<paste>
AWS_REGION=us-east-1
```

gren treats this as "AWS credentials present" and makes `bedrock` the default provider. It cannot create buckets or send email.

### B. IAM user access key (full)

Console → **IAM** → Users → **Create user** → name `guardian-hackathon` → no console access → **Attach policies directly**:

- `AdministratorAccess` is the honest hackathon shortcut (the user is deleted on Sep 15). If you would rather scope it: `AmazonBedrockFullAccess`, `AmazonSESFullAccess`, `AmazonSNSFullAccess`, `AmazonS3FullAccess`, `BedrockAgentCoreFullAccess`, `AmazonEC2ContainerRegistryFullAccess`, `AWSCodeBuildAdminAccess`, `CloudWatchLogsFullAccess`, and an inline policy allowing `iam:CreateRole`, `iam:AttachRolePolicy`, `iam:PutRolePolicy`, `iam:PassRole`, `iam:GetRole` (the AgentCore CLI creates the runtime's execution role).

Create the user → open it → **Security credentials** → **Create access key** → use case "Local code" → copy both values.

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012
```

Alternative if you already use IAM Identity Center: `aws configure sso` on your machine and put `AWS_PROFILE=<name>` in `.env` instead of the two keys (the code picks either up).

### C. `aws login` (what this repo actually uses)

AWS CLI v2's `aws login --profile guardian` signs in through the browser (12-hour credentials, renewable for 90 days without the browser) and needs no keys at all; `.env` then holds only `AWS_PROFILE=guardian` and `AWS_REGION`. boto3 needs the CRT extra to read those credentials: `pip install "botocore[crt]"` (already in the venv). The Agent Toolkit for AWS setup (`aws configure agent-toolkit`) installs the AWS skills and MCP server for Claude Code on top of the same profile.

## 3. Bedrock model access (you, 5 minutes)

The old **Model access** page is retired: serverless models are enabled on first invocation. Anthropic models need one extra step per account: Console → **Amazon Bedrock** → **Model catalog** → the yellow banner "Anthropic requires first-time customers to submit use case details" → **Submit use case details** (company name, website, industry, intended users, a 500-character description of the use case). Until it is submitted, every call answers `ValidationException: Operation not allowed`, and `aws bedrock get-use-case-for-model-access` says the form has not been filled out. After it is accepted, the first invocation by a user with Marketplace permissions (root, or an admin user) creates the Marketplace agreement for the account; `aws bedrock get-foundation-model-availability --model-id anthropic.claude-haiku-4-5-20251001-v1:0` then shows `authorizationStatus: AUTHORIZED` and `agreementAvailability: AVAILABLE`.

**Brand-new accounts.** Until AWS finishes activating the account (`aws account get-account-information` shows `PENDING_ACTIVATION`, the console redirects to "Complete your account setup"), Bedrock, S3, SES and SNS all refuse calls with "not signed up" or "subscription required" errors, and there is nothing to click beyond a valid payment method; it took a few hours on 2026-09-13. A freshly activated account also carries AgentCore quotas of **0** ("Total Agents per Account", "Endpoints per Agent", "Versions per Agent") that the Service Quotas console refuses to raise because they are below the defaults; only a Support case (Basic plan is enough, console only) lifts them. `agentcore deploy` fails with `maxAgents limit exceeded` until then.

Model ids the code uses (cross-region inference profiles; none of these models allow in-region invocation):

| alias | profile id | note |
|---|---|---|
| haiku | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | carries a date suffix; gren's default is set to this |
| sonnet | `global.anthropic.claude-sonnet-5` | |
| opus | `global.anthropic.claude-opus-5` | |

Then run the check (it makes one tiny Haiku call to prove access):

```bash
.venv/Scripts/python scripts/aws_check.py
```

It prints every profile id your account sees; if they differ from the table, paste the printed `GREN_BEDROCK_*` lines into `.env`.

## 4. SES email (you, 10 minutes; tier 3)

Console → **Amazon SES** (region us-east-1) → **Identities** → **Create identity** → *Email address* → your address → confirm the verification email. Do the same for **the address that should receive demo emails** (your own second address, or the same one). New SES accounts are in the **sandbox**: mail can only go to verified identities, which is exactly what we want during the hackathon so a test run never emails a real manufacturer.

```
GUARDIAN_SES_FROM=you@example.com
GUARDIAN_SES_TO_OVERRIDE=you@example.com     # every remedy email is redirected here while set; the real recipient is kept in the body header
```

Leave both empty to keep emails in `var/household/outbox`.

## 5. SMS (skip)

US destinations on SNS need a registered origination number (toll-free verification takes days; 10DLC longer). Keep the outbox: the Decisions page is the phone. If you want a live text in the video, a Twilio trial account works with verified numbers in minutes; Labubu can add the branch in `guardian/notify.py` (ten lines) and we would need `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.

## 6. The live URL (us; tier 2)

Two ways to put Guardian on AWS. The first needs nothing from Support and is what runs today; the second is the AgentCore path, which this brand-new account cannot use until Support raises three quotas that AWS ships at 0.

### 6a. EC2 + Caddy: one instance, a real HTTPS address, no quota, no Docker, no domain (deployed 2026-09-13)

```bash
.venv/Scripts/python scripts/deploy_ec2.py up        # ~8 minutes the first time
.venv/Scripts/python scripts/deploy_ec2.py status    # instance, URL, health, provider
.venv/Scripts/python scripts/deploy_ec2.py update    # push the current code (rebuilds the dashboard, reinstalls, restarts)
.venv/Scripts/python scripts/deploy_ec2.py logs      # bootstrap log + service journal, over SSM (no SSH key anywhere)
.venv/Scripts/python scripts/deploy_ec2.py down --yes
```

What `up` creates, all tagged `Project=guardian` in us-east-1: an IAM role `guardian-ec2` (Bedrock invoke, the state bucket, SES send, SSM), a security group `guardian-web` (80 and 443 only), an elastic IP, and one `t3.small` Amazon Linux 2023 instance whose user-data downloads the release zip from the state bucket and runs `deploy/ec2/install.sh`: a Python 3.12 venv with `gren` and `guardian` installed, Caddy with an automatic Let's Encrypt certificate for `guardian.<ip-with-dashes>.sslip.io` (wildcard DNS, so no domain to buy), `guardian.service` on 127.0.0.1:8787 behind it, a `guardian-sweep.timer` that POSTs `/api/sweep` every night at 06:00 UTC (02:00 New York), and the demo household seeded once. The runtime environment (model ids, daily budget, SES settings, the API token) is uploaded to `s3://<state bucket>/config/env` from your `.env`, so change `.env` and run `update` to change the server. The store is mirrored to the bucket after every change (`GUARDIAN_STATE_SYNC=1`), so a replaced instance starts where the old one stopped.

The current deployment: **https://guardian.44-214-230-44.sslip.io**. Reads are open; every action (sweep, answer, intake, preferences, gren approve/fork) needs `GUARDIAN_API_TOKEN` from `.env`: open `https://guardian.44-214-230-44.sslip.io/?token=<token>` once in a browser (it sets a cookie for two weeks) or send `Authorization: Bearer <token>`. Cost: about $0.60 a day for the instance while it runs, plus model calls; `down` removes everything but the bucket.

### 6b. AgentCore Runtime (bonus; needs a Support case first)

`agentcore deploy -y` was tried on 2026-09-13 and failed with `maxAgents limit exceeded` (402): the account's AgentCore quotas L-F4575653 (agents), L-9B442722 (endpoints) and L-61A3A6D8 (versions) are applied at 0, and the Service Quotas API refuses a request below the defaults (1000 / 10 / 1000), so only a Support case (Support Center → Create case → Service limit increase → Bedrock AgentCore, us-east-1: "new account, quotas applied at 0, need agents=1, endpoints=1, versions=5 for a hackathon") can lift them.

The deployment project is in the repository under `deploy/agentcore/` (created with the AgentCore CLI, `npm install -g @aws/agentcore`, Node 18+, `uv` on the PATH):

- `deploy/agentcore/app/guardian/main.py` is the runtime entrypoint (`BedrockAgentCoreApp`); the payload's `kind` selects `sweep`, `answer`, `intake`, `status`, `seed` or `sync`. The container disk is ephemeral, so every invocation pulls the household store and the gren run store from S3 first and pushes them back after; a gate pauses the graph durably and the household's answer is a later invocation.
- `deploy/agentcore/agentcore/agentcore.json` declares the runtime (CodeZip build, Python 3.13, the env vars, the IAM policy in `app/guardian/agent-policy.json`: Bedrock invoke, the state bucket, SES send); `aws-targets.json` holds the account and region.
- `python scripts/package_agent.py` vendors `guardian/`, `gren/` and `demo/` into the code location (gitignored copies) before packaging or deploying.

Steps once the quotas are above 0 (the credentials from `aws login --profile guardian` are enough; the state bucket already exists):

```bash
python scripts/package_agent.py
cd deploy/agentcore && agentcore deploy -y                       # CDK: execution role, runtime, endpoint
agentcore invoke '{"kind":"seed"}' && agentcore invoke '{"kind":"sweep"}'
agentcore status --json                                          # copy the runtime ARN
```

Local test without deploying: `cd deploy/agentcore && agentcore dev`, then `POST http://localhost:8082/invocations` with `{"kind":"status"}`.

The dashboard then runs in deployed mode by adding to `.env`:

```
GUARDIAN_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:779457758734:runtime/guardian-xxxx
GUARDIAN_S3_BUCKET=guardian-779457758734-state
```

`guardian serve` then sends sweeps, answers and intake to the runtime and serves reads from the copy of the state it pulls back from S3. The nightly trigger would be an EventBridge Scheduler rule (03:00 household-local) that invokes the runtime with `{"kind":"sweep"}` through a universal target on `bedrock-agentcore:InvokeAgentRuntime`.

## 7. Fill-in sheet

Copy `.env.example` to `.env` and fill the rows you have. Send the same values to Labubu privately (not in git, not in a public chat).

| Variable | Needed for | Where it comes from | Have it? |
|---|---|---|---|
| `AWS_REGION` | everything | `us-east-1` | |
| `AWS_ACCOUNT_ID` | deployment names | console top-right | |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock only (option A) | Bedrock → API keys → long-term | |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | everything (option B) | IAM → user → access key | |
| `GREN_BEDROCK_HAIKU/SONNET/OPUS` | only if `aws_check.py` prints different ids | the check script | |
| `GUARDIAN_SES_FROM` | real email | SES verified identity | |
| `GUARDIAN_SES_TO_OVERRIDE` | safe demos | a verified address of yours | |
| `OPENFDA_API_KEY` | optional, higher feed limit | https://open.fda.gov/apis/authentication/ (free, instant) | |
| `GUARDIAN_S3_BUCKET` | deployment | we create it (`guardian-779457758734-state` exists) | |
| `GUARDIAN_API_TOKEN` + `GUARDIAN_URL` | the public dashboard | written into `.env` by `deploy_ec2.py up` | |
| `GUARDIAN_AGENT_RUNTIME_ARN` | AgentCore mode only | `agentcore deploy` output | |

## 8. Verify

```bash
.venv/Scripts/python scripts/aws_check.py     # identity, Bedrock profiles + live call, SES, SNS, S3, AgentCore, gren's default provider
.venv/Scripts/gren bridges                    # must say: bedrock available
guardian sweep --bridge bedrock --data var/bedrock-test --runs var/bedrock-test/runs   # one real sweep on Bedrock, isolated store
```

## 9. Cost limits (what actually caps spend)

AWS has no account-wide hard cap. What exists, from weakest to strongest:

| Layer | What it does | Caps spend? |
|---|---|---|
| AWS Budgets (Billing → Budgets) | Emails when actual or forecasted spend crosses a threshold; the `$50 monthly` budget already exists | No, alerts only |
| Budget **action** (Budgets → the budget → Actions) | When the threshold is crossed, attaches an IAM policy (for example the AWS managed `AWSDenyAll`) to an IAM user, group or role, or an SCP to an OU | Yes, for that IAM principal only. It cannot restrict the root user, so run the CLI as an IAM user if you want this to bite |
| gren `budget.max_cost_usd` in `guardian/graphs/nightly-sweep.yaml` | The engine fails the run once its own model spend exceeds the cap (`$3.00`) | Yes, per run |
| `GUARDIAN_DAILY_BUDGET_USD` in `.env` | `guardian serve`/`sweep`/`intake` refuse to start new model work once today's recorded run cost reaches it (`10` by default in the template; Home shows today's spend) | Yes, per day, for everything Guardian starts |
| Bedrock service quotas (Service Quotas → Amazon Bedrock) | Tokens per minute and requests per minute per model; lowering them needs a support case | Throttles, does not cap dollars |

Recommended for the hackathon: keep the budget alert, set `GUARDIAN_DAILY_BUDGET_USD` to what you are willing to spend in a day, and if you switch the CLI to an IAM user, add a budget action that attaches `AWSDenyAll` to it at, say, 90 % of the monthly budget.

## 10. After the hackathon

`python scripts/deploy_ec2.py down --yes` (instance, elastic IP, security group, role), then delete the S3 bucket, the IAM user's access key and the Bedrock API key if you made them, and the AgentCore runtime plus the CDK bootstrap stack and ECR repository if those ever got created. Nothing else costs money at rest.
