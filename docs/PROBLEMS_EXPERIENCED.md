# Problems experienced

This note is for the submission write-up. It records what did not work on the AWS side during the hackathon, what we did instead, and what the code still supports. Dates are 2026, times are EDT.

## 1. Amazon Bedrock was not authorized for the account

**What we planned.** Every agent node in the nightly sweep runs Claude on Amazon Bedrock through the `bedrock` provider of gren. The provider wraps `strands.models.bedrock.BedrockModel` with cross-region inference profiles for Haiku 4.5, Sonnet 5, and Opus 5. The graphs, the tests, and the deployment were built for that path first.

**What happened.** The account (779457758734) was activated on 13 September. Every Bedrock model call, in every region, answered `Operation not allowed`. The model availability API reported `authorizationStatus: NOT_AUTHORIZED` and `agreementAvailability: NOT_AVAILABLE` for each Anthropic model. The Anthropic use-case form in the console could not be submitted; the form itself said "create a support case". We opened support case 178934068800881 (Account and billing, 13 September 19:04 EDT). The account has no support plan, so the case cannot be read by API. The block was still in place at the last check before submission (14 September).

**What we did.** The provider is a configuration choice, not a code path. gren selects the provider from the environment (`GREN_BRIDGE`): `bedrock`, `anthropic` (the Anthropic API through `strands.models.anthropic.AnthropicModel`), `claude-code`, or `mock`. The same graphs, the same structured-output contracts, and the same tests run on each of them. For the live site and the demo recording we set `GUARDIAN_DEPLOY_BRIDGE=anthropic` and `ANTHROPIC_API_KEY` (and, for a gateway, `ANTHROPIC_BASE_URL`) in `.env`, then ran `python scripts/deploy_ec2.py update`. No Guardian or gren code changed for the switch.

**What still works for Bedrock.** The `bedrock` provider is in the code and in the tests (mock provider). The deployment ships the model ids for the inference profiles (`GREN_BEDROCK_HAIKU`, `GREN_BEDROCK_SONNET`, `GREN_BEDROCK_OPUS`) and an instance role with `bedrock:InvokeModel`. When the account is authorized, set `GUARDIAN_DEPLOY_BRIDGE=bedrock` and run the same `update` command. `docs/AWS_SETUP.md` section 3 has the checks.

## 2. Bedrock AgentCore quotas were 0

**What we planned.** `deploy/agentcore` holds the AgentCore Runtime entrypoint (`BedrockAgentCoreApp`; `payload.kind` selects `sweep`, `intake`, `answer`, `status`), the CDK project, and the packaging script (`scripts/package_agent.py`). It was built and tested locally against the same service code.

**What happened.** The account's AgentCore service quotas were 0 for every resource (runtimes, memory, gateway). A quota increase was requested in the same support case. Without a quota, `create_agent_runtime` fails at once.

**What we did.** We deployed the same service on one EC2 instance with Caddy (automatic HTTPS at `guardian.44-214-230-44.sslip.io`). A systemd timer runs the nightly sweep at 06:00 UTC. The store mirrors to an S3 bucket after each change; the release zip and the config live in the same bucket (`scripts/deploy_ec2.py`, `deploy/ec2/install.sh`). The dashboard, the gren run API, and the trace stream run there. The AgentCore path stays in the repository; it deploys when the quotas allow.

## 3. Smaller problems

- **SES.** The remedy request is written to the outbox until a sender identity is verified. The SES call is one switch (`GUARDIAN_SES_SENDER`).
- **SMS.** SNS SMS to US numbers needs a registered number and days of lead time. The dashboard link and the outbox stand in for the SMS in the demo.
- **Headless Claude Code as a provider.** Local dry runs used the `claude-code` provider (the Claude Code login on the developer machine). Its structured-output tool needed a shorter node contract (gren 2.0.1). The live site does not use this provider.

## 4. What this cost

- Model spend for a full sweep is about $0.40 to $0.50 on Opus 5, Sonnet 5, and Haiku 4.5. That covers three ambiguous pairs, triage, a verifier round, and one remedy (recorded in the trace metrics).
- A quiet night costs $0: the agent nodes are skipped when the code stages find nothing.
