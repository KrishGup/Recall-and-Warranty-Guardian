# AWS setup for Guardian (hackathon edition)

This guide lists what must exist on the AWS side, who does each step, and what goes into `.env`. **You** do the console steps that need the account owner. **Claude or Labubu** do the steps that only need the credentials (buckets, roles, deployment). Keys never go into git. `.env` is gitignored. `.env.example` is the template.

## 0. The tiers, in the order of value

| Tier | What it unlocks | Your time | Our build time after |
|---|---|---|---|
| **1. Bedrock** | The sweep runs on Claude on AWS instead of a laptop login. Judged as "Strands on Bedrock". | 15 min | 0. gren already has the provider. |
| **2. A live URL** | The dashboard reachable by the judges. Optional in the rules, but it "strengthens the Technical Implementation score". | 0 | Done. See section 6. |
| **3. SES email** | The remedy request leaves as email (to a safe address during demos). | 10 min | 0. The code path exists. |
| **Skip** | SNS SMS to US numbers (needs a registered toll-free or 10DLC number, days of lead time), Cognito, Gmail OAuth. The outbox and the dashboard replace SMS in the video. | | |

Do tier 1 first. Everything else needs it.

## 1. Accounts and identities (you, one time)

1. **AWS account.** Sign in at https://console.aws.amazon.com. Turn on MFA for the root user. Write down the 12-digit **account id** (top-right menu).
2. **Region.** Use **us-east-1 (N. Virginia)** for all steps below. Each Claude model that we use is available there through cross-region inference. AgentCore launched there.
3. **AWS Builder ID.** This is a submission requirement, separate from the AWS account. Go to https://profile.aws.amazon.com and create a Builder ID with your email. There is nothing to paste.
4. **The $50 credit.** Hackathon page, Resources tab, credit request form. The form asks for the AWS account id. When the code arrives: console, Billing, Credits, Redeem. There is nothing to paste.

## 2. Credentials that the code uses (you, then Claude)

Choose **A** if you only want Bedrock today. Choose **B** for everything (Bedrock, SES, S3, AgentCore). Both can exist at the same time. **C** is what this repository uses.

### A. Bedrock API key (fastest, models only)

1. Open the console. Go to **Amazon Bedrock**, then **API keys** in the left menu.
2. Click **Generate long-term API key**.
3. Copy the key one time.

```
AWS_BEARER_TOKEN_BEDROCK=<paste>
AWS_REGION=us-east-1
```

gren treats this key as "AWS credentials present" and makes `bedrock` the default provider. The key cannot create buckets or send email.

### B. IAM user access key (full)

1. Open the console. Go to **IAM**, **Users**, **Create user**.
2. Name the user `guardian-hackathon`. Do not give console access.
3. Click **Attach policies directly**. `AdministratorAccess` is the simple choice for a hackathon. Delete the user on Sep 15. If you prefer a smaller scope, attach these policies instead:
   - `AmazonBedrockFullAccess`, `AmazonSESFullAccess`, `AmazonSNSFullAccess`, `AmazonS3FullAccess`
   - `BedrockAgentCoreFullAccess`, `AmazonEC2ContainerRegistryFullAccess`, `AWSCodeBuildAdminAccess`, `CloudWatchLogsFullAccess`
   - An inline policy that permits `iam:CreateRole`, `iam:AttachRolePolicy`, `iam:PutRolePolicy`, `iam:PassRole`, and `iam:GetRole`. The AgentCore CLI creates the execution role of the runtime.
4. Create the user. Open the user. Go to **Security credentials**, **Create access key**, use case "Local code".
5. Copy both values.

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012
```

If you already use IAM Identity Center, run `aws configure sso` on your machine. Then put `AWS_PROFILE=<name>` in `.env` instead of the two keys. The code accepts either.

### C. `aws login` (what this repository uses)

AWS CLI v2 has `aws login --profile guardian`. It signs in through the browser. The credentials last 12 hours. They renew for 90 days without the browser. No keys exist. `.env` holds only `AWS_PROFILE=guardian` and `AWS_REGION`. boto3 needs the CRT extra to read these credentials: `pip install "botocore[crt]"`. The venv already has it. The Agent Toolkit for AWS setup (`aws configure agent-toolkit`) installs the AWS skills and the MCP server for Claude Code on the same profile.

## 3. Bedrock model access (you)

The old **Model access** page is retired. Serverless models become enabled on the first invocation. Anthropic models need one extra step for each account:

1. Open the console. Go to **Amazon Bedrock**, **Model catalog**.
2. Find the yellow banner "Anthropic requires first-time customers to submit use case details". Click **Submit use case details**.
3. Complete the form: company name, website, industry, intended users, and a description of the use case (500 characters).

Until the form is accepted, each call answers `ValidationException: Operation not allowed`. `aws bedrock get-use-case-for-model-access` reports that the form is not complete. After the acceptance, the first invocation by a user with Marketplace permissions (root, or an admin user) creates the Marketplace agreement for the account. Then `aws bedrock get-foundation-model-availability --model-id anthropic.claude-haiku-4-5-20251001-v1:0` shows `authorizationStatus: AUTHORIZED` and `agreementAvailability: AVAILABLE`.

**This account has a block above the form (found 2026-09-13, 23:00 UTC).** Each model on Bedrock, in each region, answers `Operation not allowed`. This includes Nova, Llama, and gpt-oss. `get-foundation-model-availability` reports `authorizationStatus: NOT_AUTHORIZED` for all models. The use case form (console and `aws bedrock put-use-case-for-model-access`) answers "Your account is not authorized to perform this action. Please create a support case with details about your use case." This is the Bedrock authorization review of AWS for accounts that never used Bedrock. No console setting removes it.

The way through is a Support Center interaction. The Basic plan is sufficient. The "Support interactions" chat creates the case. Describe the account, the errors above, the hackathon use case, and the expected spend. Ask AWS to authorize Bedrock model invocation. The AgentCore quotas (section 6b) can go in the same case.

**Case 178934068800881** ("Bedrock model invocation not authorized for account 779457758734") was opened on 2026-09-13 at 19:04 EDT. Category: Account and billing, Account, Other Account Issues. Severity: General question. Contact: Web. AWS promises an answer within 24 hours. Replies arrive at the root email and in Support Center, Your support cases.

Until AWS grants the authorization, the demo can run on the Anthropic API instead. Put `ANTHROPIC_API_KEY` in `.env`. gren selects the `anthropic` bridge. For the live server, set `GUARDIAN_DEPLOY_BRIDGE=anthropic` and the key, then run `python scripts/deploy_ec2.py update`. The hackathon requires Strands Agents, not Bedrock.

**New accounts.** Until AWS completes the activation of the account, Bedrock, S3, SES, and SNS refuse calls with "not signed up" or "subscription required" errors. `aws account get-account-information` shows `PENDING_ACTIVATION`. The console redirects to "Complete your account setup". There is nothing to click except a valid payment method. On 2026-09-13, the activation took a few hours. A newly activated account also has AgentCore quotas of **0** ("Total Agents per Account", "Endpoints per Agent", "Versions per Agent"). The Service Quotas console refuses to raise them, because the requested values are below the defaults. Only a Support case can raise them. `agentcore deploy` fails with `maxAgents limit exceeded` until then.

The model ids that the code uses (cross-region inference profiles; none of these models permit in-region invocation):

| Alias | Profile id | Note |
|---|---|---|
| haiku | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Has a date suffix. gren uses this id by default. |
| sonnet | `global.anthropic.claude-sonnet-5` | |
| opus | `global.anthropic.claude-opus-5` | |

Run the check. It makes one small Haiku call to prove the access:

```bash
.venv/Scripts/python scripts/aws_check.py
```

The check shows each profile id that your account sees. If the ids differ from the table, paste the `GREN_BEDROCK_*` lines that the check prints into `.env`.

## 4. SES email (you, 10 minutes; tier 3)

1. Open the console. Go to **Amazon SES** in region us-east-1.
2. Go to **Identities**, **Create identity**, **Email address**. Enter your address.
3. Confirm the verification email.
4. Do the same for the address that must receive the demo emails (your second address, or the same address).

New SES accounts are in the **sandbox**. Mail can go only to verified identities. This is correct for the hackathon: a test run can never email a real manufacturer.

```
GUARDIAN_SES_FROM=you@example.com
GUARDIAN_SES_TO_OVERRIDE=you@example.com     # Guardian redirects each remedy email here while this is set. The body keeps the real recipient.
```

Leave both values empty to keep the emails in `var/household/outbox`.

## 5. SMS (skip)

US destinations on SNS need a registered origination number. Toll-free verification takes days. 10DLC takes longer. Keep the outbox. The Decisions page is the phone. If you want a live text in the video, a Twilio trial account works with verified numbers in minutes. Labubu can add the branch in `guardian/notify.py` (about 10 lines). It needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM`.

## 6. The live URL (us; tier 2)

There are two ways to put Guardian on AWS. The first way needs nothing from Support. It runs today. The second way is AgentCore. This new account cannot use AgentCore until Support raises three quotas that AWS sets to 0.

### 6a. EC2 and Caddy: one instance, a real HTTPS address (deployed 2026-09-13)

```bash
.venv/Scripts/python scripts/deploy_ec2.py up        # about 8 minutes the first time
.venv/Scripts/python scripts/deploy_ec2.py status    # instance, URL, health, provider
.venv/Scripts/python scripts/deploy_ec2.py update    # sends the current code: builds the dashboard, installs, restarts
.venv/Scripts/python scripts/deploy_ec2.py logs      # bootstrap log and service journal, over SSM (no SSH key)
.venv/Scripts/python scripts/deploy_ec2.py down --yes
```

`up` creates these resources in us-east-1, all tagged `Project=guardian`:

- An IAM role `guardian-ec2` (Bedrock invoke, the state bucket, SES send, SSM).
- A security group `guardian-web` (ports 80 and 443 only).
- An elastic IP.
- One `t3.small` Amazon Linux 2023 instance. Its user-data downloads the release zip from the state bucket and runs `deploy/ec2/install.sh`.

`install.sh` does these steps on the instance:

1. Makes a Python 3.12 venv with `gren` and `guardian`.
2. Installs Caddy with an automatic Let's Encrypt certificate for `guardian.<ip-with-dashes>.sslip.io`. This is wildcard DNS, so no domain is necessary.
3. Starts `guardian.service` on 127.0.0.1:8787 behind Caddy.
4. Starts `guardian-sweep.timer`. The timer posts `/api/sweep` each night at 06:00 UTC (02:00 New York).
5. Loads the demo household one time.

The deploy script uploads the runtime environment (model ids, daily budget, SES settings, the API token) to `s3://<state bucket>/config/env` from your `.env`. To change the server, change `.env` and run `update`. The server mirrors the store to the bucket after each change (`GUARDIAN_STATE_SYNC=1`). A replaced instance starts where the old one stopped.

The current deployment: **https://guardian.44-214-230-44.sslip.io**. Reads are open. Each action (sweep, answer, intake, preferences, gren approve, fork, cancel) needs `GUARDIAN_API_TOKEN` from `.env`. Open `https://guardian.44-214-230-44.sslip.io/?token=<token>` one time in a browser. This sets a cookie for two weeks. Or send `Authorization: Bearer <token>`. Cost: about $0.60 each day for the instance, plus the model calls. `down` removes everything except the bucket.

### 6b. AgentCore Runtime (bonus; needs a Support case first)

`agentcore deploy -y` was tried on 2026-09-13. It failed with `maxAgents limit exceeded` (402). The account quotas L-F4575653 (agents), L-9B442722 (endpoints), and L-61A3A6D8 (versions) are 0. The Service Quotas API refuses a request below the defaults (1000, 10, 1000). Only a Support case can raise them. Path: Support Center, Create case, Service limit increase, Bedrock AgentCore, us-east-1. Text: "new account, quotas applied at 0, need agents=1, endpoints=1, versions=5 for a hackathon".

The deployment project is in `deploy/agentcore/`. The AgentCore CLI made it (`npm install -g @aws/agentcore`, Node 18 or later, `uv` on the PATH):

- `deploy/agentcore/app/guardian/main.py` is the runtime entrypoint (`BedrockAgentCoreApp`). The `kind` field of the payload selects `sweep`, `answer`, `intake`, `status`, `seed`, or `sync`. The container disk is not permanent. Each invocation pulls the household store and the gren run store from S3 first, and pushes them back after. A gate stops the graph safely. The answer of the household is a later invocation.
- `deploy/agentcore/agentcore/agentcore.json` declares the runtime (CodeZip build, Python 3.13, the environment variables, the IAM policy in `app/guardian/agent-policy.json`: Bedrock invoke, the state bucket, SES send). `aws-targets.json` holds the account and the region.
- `python scripts/package_agent.py` copies `guardian/`, `gren/`, and `demo/` into the code location (gitignored copies) before a package or a deployment.

Steps after the quotas are above 0 (the credentials from `aws login --profile guardian` are sufficient; the state bucket exists):

```bash
python scripts/package_agent.py
cd deploy/agentcore && agentcore deploy -y                       # CDK: execution role, runtime, endpoint
agentcore invoke '{"kind":"seed"}' && agentcore invoke '{"kind":"sweep"}'
agentcore status --json                                          # copy the runtime ARN
```

Local test without a deployment: `cd deploy/agentcore && agentcore dev`, then send `POST http://localhost:8082/invocations` with `{"kind":"status"}`.

To run the dashboard in deployed mode, add these lines to `.env`:

```
GUARDIAN_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:779457758734:runtime/guardian-xxxx
GUARDIAN_S3_BUCKET=guardian-779457758734-state
```

Then `guardian serve` sends sweeps, answers, and intake to the runtime. It serves reads from the copy of the state that it pulls back from S3. The nightly trigger would be an EventBridge Scheduler rule (03:00 household-local) that invokes the runtime with `{"kind":"sweep"}` through a universal target on `bedrock-agentcore:InvokeAgentRuntime`.

## 7. Fill-in sheet

Copy `.env.example` to `.env`. Fill the rows that you have. Send the same values to Labubu privately (not in git, not in a public chat).

| Variable | Necessary for | Source | Have it? |
|---|---|---|---|
| `AWS_REGION` | everything | `us-east-1` | |
| `AWS_ACCOUNT_ID` | deployment names | console, top right | |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock only (option A) | Bedrock, API keys, long-term | |
| `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` | everything (option B) | IAM, user, access key | |
| `GREN_BEDROCK_HAIKU`, `GREN_BEDROCK_SONNET`, `GREN_BEDROCK_OPUS` | only if `aws_check.py` prints different ids | the check script | |
| `GUARDIAN_SES_FROM` | real email | SES verified identity | |
| `GUARDIAN_SES_TO_OVERRIDE` | safe demos | a verified address of yours | |
| `OPENFDA_API_KEY` | optional, higher feed limit | https://open.fda.gov/apis/authentication/ (free, immediate) | |
| `GUARDIAN_S3_BUCKET` | deployment | we create it (`guardian-779457758734-state` exists) | |
| `GUARDIAN_API_TOKEN` and `GUARDIAN_URL` | the public dashboard | `deploy_ec2.py up` writes them into `.env` | |
| `GUARDIAN_AGENT_RUNTIME_ARN` | AgentCore mode only | `agentcore deploy` output | |

## 8. Verify

```bash
.venv/Scripts/python scripts/aws_check.py     # identity, Bedrock profiles and a live call, SES, SNS, S3, AgentCore, the default provider of gren
.venv/Scripts/gren bridges                    # must show: bedrock available
guardian sweep --bridge bedrock --data var/bedrock-test --runs var/bedrock-test/runs   # one real sweep on Bedrock, isolated store
```

## 9. Cost limits (what really caps the spend)

AWS has no hard cap for the whole account. These layers exist, from weakest to strongest:

| Layer | What it does | Caps the spend? |
|---|---|---|
| AWS Budgets (Billing, Budgets) | Sends an email when the actual or forecast spend crosses a threshold. The `$50 monthly` budget exists. | No. Alerts only. |
| Budget **action** (Budgets, the budget, Actions) | When the threshold is crossed, attaches an IAM policy (for example the AWS managed `AWSDenyAll`) to an IAM user, group, or role, or an SCP to an OU. | Yes, for that IAM principal only. It cannot restrict the root user. Run the CLI as an IAM user if you want this cap. |
| gren `budget.max_cost_usd` in `guardian/graphs/nightly-sweep.yaml` | The engine fails the run when the model spend of the run exceeds the cap (`$3.00`). | Yes, for each run. |
| `GUARDIAN_DAILY_BUDGET_USD` in `.env` | `guardian serve`, `sweep`, and `intake` refuse new model work when the recorded run cost of the day reaches it (`10` in the template). Home shows the spend of the day. | Yes, for each day, for everything that Guardian starts. |
| Bedrock service quotas (Service Quotas, Amazon Bedrock) | Tokens for each minute and requests for each minute, for each model. A decrease needs a support case. | No. It throttles. It does not cap dollars. |

Recommended for the hackathon:

1. Keep the budget alert.
2. Set `GUARDIAN_DAILY_BUDGET_USD` to the amount that you accept for one day.
3. If you move the CLI to an IAM user, add a budget action. The action attaches `AWSDenyAll` to that user at 90 percent of the monthly budget.

## 10. After the hackathon

1. Run `python scripts/deploy_ec2.py down --yes`. This removes the instance, the elastic IP, the security group, and the role.
2. Delete the S3 bucket.
3. Delete the access key of the IAM user and the Bedrock API key, if you made them.
4. Delete the AgentCore runtime, the CDK bootstrap stack, and the ECR repository, if they exist.

Nothing else costs money at rest.
