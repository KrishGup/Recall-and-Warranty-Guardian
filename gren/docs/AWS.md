# gren on AWS

gren v2 is built on the Strands Agents SDK. The `bedrock` provider is the AWS-native path; the engine, dashboard and MCP server are plain Python, so they run in any AWS compute service.

## 1. Run graphs on Amazon Bedrock

1. Enable Anthropic Claude models in the Bedrock console for your region (Model access).
2. Give the machine credentials. Use one of these:
   - `aws configure` (a profile in `~/.aws/credentials`), then `export AWS_PROFILE=<name>`;
   - environment variables `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN`);
   - an IAM role (EC2, ECS task role, Lambda execution role, AgentCore runtime role).
3. Set `AWS_REGION` (for example `us-east-1`).
4. Check the provider: `gren bridges` prints `bedrock available`.
5. Run a graph: `gren run graphs/research-brief.yaml --bridge bedrock --input '{"topic":"..."}'`. When AWS credentials exist and `ANTHROPIC_API_KEY` is not set, `bedrock` is already the default.

Model aliases map to cross-region inference profiles:

| alias | Bedrock model id (default) | override |
|---|---|---|
| `haiku` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | `GREN_BEDROCK_HAIKU` |
| `sonnet` | `global.anthropic.claude-sonnet-5` | `GREN_BEDROCK_SONNET` |
| `opus` | `global.anthropic.claude-opus-5` | `GREN_BEDROCK_OPUS` |
| `fable` | `global.anthropic.claude-fable-5-1` | `GREN_BEDROCK_FABLE` |

A full Bedrock model id in `model:` is used as is. Set the override variables when your region uses a different inference profile prefix (`us.`, `eu.`, `apac.`).

The IAM policy a runner needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": "*" }
  ]
}
```

Tool-using nodes on Bedrock use `strands_tools`. `Read`/`Grep`/`Glob` map to `file_read`, `Edit` to `editor`, `Write` to `file_write`, `Bash` to `shell`, `WebFetch` to `http_request`, `Python` to `python_repl`, `AWS` to `use_aws`, `Retrieve` to `retrieve` (Bedrock Knowledge Bases). Tool nodes still need `max_turns` and `max_cost_usd`; costs are estimated from token usage with the pricing table in `gren/models/pricing.py`.

## 2. Observability

Strands emits OpenTelemetry traces for every agent call. To send them to CloudWatch or X-Ray:

```bash
pip install "strands-agents[otel]"
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # an OTEL collector / ADOT sidecar
export STRANDS_OTEL_ENABLE_CONSOLE_EXPORT=false
```

gren's own run store (`runs/<id>/events.jsonl`, `state.json`, `artifacts/`) is the graph-shaped record: critical path, kill rate, human wait, cost by model. Ship `runs/` to S3 for retention, or point `GREN_RUNS` at an EFS mount when several containers share runs.

## 3. Deploy the engine

### Container (ECS / Fargate / EC2)

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir .
ENV GREN_RUNS=/data/runs AWS_REGION=us-east-1 GREN_API_TOKEN=change-me
EXPOSE 4545
CMD ["gren", "ui", "--host", "0.0.0.0", "--port", "4545", "--graphs", "/app/graphs"]
```

- Mount `/data` on EFS so runs survive restarts and the CLI, dashboard and MCP server see the same runs.
- Set `GREN_API_TOKEN`. Every `/api` route then requires `Authorization: Bearer <token>`; the dashboard page is served without it.
- Give the task role the Bedrock policy above.
- Start runs over HTTP: `POST /api/runs {"graph": "research-brief.yaml", "input": {...}, "bridge": "bedrock"}`; approve gates with `POST /api/run/approve`.

### Lambda (short graphs)

Package the repository with the `gren` package and call `GraphRun.create(...).run()` from the handler with `GREN_RUNS=/tmp/runs` (or an EFS mount). Keep `budget.max_wall_ms` below the function timeout. Gates do not fit Lambda well: use `gate_wait="return"` and resume from a second invocation after the approval file exists.

### Bedrock AgentCore Runtime

AgentCore Runtime hosts a Strands application as a long-running HTTP service with sessions, identity and observability managed by AWS. gren fits as one entrypoint that starts and resumes graph runs:

```python
# agentcore_app.py
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from gren.control import RunControl
from gren.engine.state import RunStore

app = BedrockAgentCoreApp()
store = RunStore("/tmp/runs")               # or an EFS/S3-backed path
control = RunControl(store, "graphs")

@app.entrypoint
def invoke(payload, context=None):
    action = payload.get("action", "run")
    if action == "run":
        rid = control.start(spec_path=payload["graph"], input_=payload.get("input", {}), bridge="bedrock")
        return {"run_id": rid}
    if action == "approve":
        control.approve(payload["run_id"], payload["gate"], payload.get("decision", "approved"), by=payload.get("by", "agentcore"))
        return {"ok": True}
    st = store.load(payload["run_id"])
    return {"status": st.run["status"], "output": st.run.get("output")}

if __name__ == "__main__":
    app.run()
```

Deploy with the AgentCore starter toolkit (`agentcore configure --entrypoint agentcore_app.py`, then `agentcore launch`). The runtime role needs the Bedrock policy. Gates pause the run inside the container; the approval arrives as a second invocation with `action: approve`.

## 4. Cost control that AWS does not do for you

- `budget.max_cost_usd` is a frozen constraint: the run fails when the estimate reaches the cap, whatever the nodes want.
- `max_width` bounds concurrent Bedrock calls; align it with your account's requests-per-minute quota for the model.
- Put a `code` reducer (`top_k`, `filter`) in front of every verify fan-out. Verification is the most expensive step.
- `defaults.model: haiku` for extraction and per-item verification, `sonnet` for judgment and synthesis.
