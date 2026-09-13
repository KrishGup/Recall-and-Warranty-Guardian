"""Talk to Guardian deployed on AgentCore Runtime (deploy/agentcore) from the dashboard's API server.

When GUARDIAN_AGENT_RUNTIME_ARN is set, the API keeps a local copy of the state (pulled from S3 after every remote
invocation) for reads, and sends every piece of model work (sweep, answer, intake) to the runtime."""
from __future__ import annotations

import json
import os
import uuid
from typing import Any


class AgentRuntime:
    def __init__(self, arn: str, region: str | None = None, client: Any | None = None, timeout_s: float = 1800):
        self.arn, self.timeout_s = arn, timeout_s
        self.region = region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or arn.split(":")[3]
        self._client = client

    @classmethod
    def from_env(cls) -> "AgentRuntime | None":
        arn = os.environ.get("GUARDIAN_AGENT_RUNTIME_ARN", "").strip()
        return cls(arn) if arn else None

    def client(self) -> Any:
        if self._client is None:
            import boto3  # type: ignore
            from botocore.config import Config  # type: ignore

            self._client = boto3.client("bedrock-agentcore", region_name=self.region, config=Config(read_timeout=int(self.timeout_s), connect_timeout=30, retries={"max_attempts": 0}))
        return self._client

    @staticmethod
    def session_id(seed: str | None = None) -> str:
        # AgentCore requires a runtime session id of at least 33 characters
        return (seed or "guardian") + "-" + uuid.uuid4().hex

    def invoke(self, payload: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        resp = self.client().invoke_agent_runtime(agentRuntimeArn=self.arn, runtimeSessionId=session_id or self.session_id(payload.get("kind")), contentType="application/json", accept="application/json", payload=json.dumps(payload).encode("utf-8"))
        body = resp.get("response")
        raw = body.read() if hasattr(body, "read") else body
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8", "replace")
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data = {"raw": str(raw)[:2000]}
        if not isinstance(data, dict):
            data = {"result": data}
        return data
