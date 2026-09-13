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

## 3. Bedrock model access (you, 5 minutes)

Console → **Amazon Bedrock** → **Model catalog** (or **Model access** in the left menu) → filter Anthropic → open **Claude Haiku 4.5**, **Claude Sonnet 5** and **Claude Opus 5**. If a model shows *Request access* / *Available to request*, submit the one-time use-case form (company: your name; use case: "household recall-monitoring agent, hackathon prototype, low volume"). Access is usually granted within minutes; some accounts get it automatically on first use.

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

## 6. AgentCore Runtime and the live URL (mostly us; tier 2)

What we do with the tier-B key:

1. `npm install -g @aws/agentcore` (Node 18+). Write `agent/app.py` with `BedrockAgentCoreApp` (`from bedrock_agentcore.runtime import BedrockAgentCoreApp`; `pip install bedrock-agentcore aws-opentelemetry-distro`) that routes `payload["kind"]` to `start_sweep`, `intake`, `answer` and `status`.
2. Move the household store off the container disk: `GUARDIAN_S3_BUCKET` (we create `guardian-<account>-household` with the CLI; nothing for you to do).
3. `agentcore create` → `agentcore deploy` (builds the ARM64 container in CodeBuild, creates the ECR repo and the execution role, registers the runtime) → `agentcore invoke '{"kind":"sweep"}'`. The runtime role gets Bedrock invoke, S3 on the bucket and SES send.
4. The dashboard for judges: App Runner from the same container (HTTPS URL in minutes), or a Cloudflare Tunnel from the laptop for the video. We add `GUARDIAN_API_TOKEN` before anything is public.

What we paste back into `.env` when it exists:

```
GUARDIAN_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:<account>:runtime/guardian-xxxx
GUARDIAN_AGENT_ROLE_ARN=arn:aws:iam::<account>:role/AmazonBedrockAgentCoreSDKRuntime-us-east-1-xxxx
GUARDIAN_S3_BUCKET=guardian-<account>-household
```

You may get one prompt from the CLI asking to confirm role creation. That is all.

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
| `GUARDIAN_S3_BUCKET` | deployment | we create it | |
| `GUARDIAN_AGENT_RUNTIME_ARN` | deployment | `agentcore deploy` output | |

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

Delete the IAM user's access key and the Bedrock API key, the S3 bucket, the AgentCore runtime and ECR repository, and any App Runner service. Nothing else costs money at rest.
