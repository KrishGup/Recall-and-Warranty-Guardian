# Guardian agent (AgentCore Runtime code location)

`main.py` is the runtime entrypoint. Its docstring lists the payload kinds. `python scripts/package_agent.py` copies the `guardian` and `gren` packages and the demo household into this directory from the repository root. The copies are gitignored here. The repository copies are the source of truth.

Local run. `status` and `seed` need no AWS. A sweep needs Bedrock credentials.

1. From the repository root, copy the packages: `python scripts/package_agent.py`
2. Install the agent: `cd deploy/agentcore/app/guardian && uv sync --python 3.13 && cd ../..`
3. Start the local runtime: `agentcore dev`. The chat UI is on port 8081. The agent listens on the port that `agentcore/.cli/logs/dev/*.log` shows (8082 here).
4. Send a request:

```bash
curl -X POST http://127.0.0.1:8082/invocations -H "Content-Type: application/json" -d '{"kind":"seed"}'
curl -X POST http://127.0.0.1:8082/invocations -H "Content-Type: application/json" -d '{"kind":"status"}'
```

Verified on 2026-09-13: `/ping` is healthy. `seed` loads the 12-item demo household in 1.5 s. `status` returns the summary with provider `bedrock`. Without `GUARDIAN_S3_BUCKET`, the sync steps do nothing.

Deployment. The account and the region are in `../../agentcore/aws-targets.json`. The runtime settings are in `../../agentcore/agentcore.json`. The account quotas for AgentCore must be above 0 first (see `docs/AWS_SETUP.md`, section 6b).

```bash
cd deploy/agentcore && agentcore deploy -y && agentcore invoke '{"kind":"seed"}' && agentcore invoke '{"kind":"sweep"}'
```
