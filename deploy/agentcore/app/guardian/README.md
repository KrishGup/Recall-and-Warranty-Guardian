# Guardian agent (AgentCore Runtime code location)

`main.py` is the runtime entrypoint (see its docstring for the payload kinds). The `guardian` and `gren` packages and the
demo household are vendored here by `python scripts/package_agent.py` from the repository root; they are gitignored in
this directory because the repository copies are the source of truth.

Local run (no AWS needed for `status`/`seed`; Bedrock credentials needed for a sweep):

```bash
python scripts/package_agent.py            # from the repo root: vendor guardian/, gren/, demo/
cd deploy/agentcore && agentcore dev       # serves http://0.0.0.0:8080
curl -X POST http://localhost:8080/invocations -H "Content-Type: application/json" -d '{"kind":"seed"}'
curl -X POST http://localhost:8080/invocations -H "Content-Type: application/json" -d '{"kind":"status"}'
```

Deploy (account and region in `../../agentcore/aws-targets.json`, runtime settings in `../../agentcore/agentcore.json`):

```bash
cd deploy/agentcore && agentcore deploy -y && agentcore invoke '{"kind":"seed"}' && agentcore invoke '{"kind":"sweep"}'
```
