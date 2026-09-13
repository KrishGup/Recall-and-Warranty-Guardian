# Guardian agent (AgentCore Runtime code location)

`main.py` is the runtime entrypoint (see its docstring for the payload kinds). The `guardian` and `gren` packages and the
demo household are vendored here by `python scripts/package_agent.py` from the repository root; they are gitignored in
this directory because the repository copies are the source of truth.

Local run (no AWS needed for `status`/`seed`; Bedrock credentials needed for a sweep):

```bash
python scripts/package_agent.py            # from the repo root: vendor guardian/, gren/, demo/
cd deploy/agentcore/app/guardian && uv sync --python 3.13 && cd ../..
agentcore dev                              # chat UI on 8081; the agent itself listens on the port printed in agentcore/.cli/logs/dev/*.log (8082 here)
curl -X POST http://127.0.0.1:8082/invocations -H "Content-Type: application/json" -d '{"kind":"seed"}'
curl -X POST http://127.0.0.1:8082/invocations -H "Content-Type: application/json" -d '{"kind":"status"}'
```

Verified 2026-09-13: `/ping` healthy, `seed` loads the 12-item demo household in 1.5 s, `status` returns the summary with provider `bedrock`; without `GUARDIAN_S3_BUCKET` the sync steps are no-ops.

Deploy (account and region in `../../agentcore/aws-targets.json`, runtime settings in `../../agentcore/agentcore.json`):

```bash
cd deploy/agentcore && agentcore deploy -y && agentcore invoke '{"kind":"seed"}' && agentcore invoke '{"kind":"sweep"}'
```
