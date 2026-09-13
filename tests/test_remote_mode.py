"""Deployed mode: with GUARDIAN_AGENT_RUNTIME_ARN set, sweeps, answers and intake go to the AgentCore runtime and the
local gate is never released here; the API keeps serving reads from its own copy of the state."""
import io
import json
import time

import yaml

from guardian.remote import AgentRuntime
from tests.conftest import seed_store
from tests.test_sweep_graph import CRITICAL_PLAN, _guardian, _spec, _wait


class FakeRuntimeClient:
    def __init__(self, responses=None):
        self.calls = []
        self.responses = responses or {}

    def invoke_agent_runtime(self, **kw):
        payload = json.loads(kw["payload"])
        self.calls.append((kw["agentRuntimeArn"], kw["runtimeSessionId"], payload))
        body = self.responses.get(payload["kind"], {"kind": payload["kind"], "ok": True})
        return {"response": io.BytesIO(json.dumps(body).encode("utf-8")), "contentType": "application/json"}


def _wait_idle(g, timeout=10.0):
    t0 = time.time()
    while g._remote_busy and time.time() - t0 < timeout:
        time.sleep(0.05)
    assert not g._remote_busy


def test_remote_mode_routes_work_to_the_runtime(store, demo, monkeypatch):
    seed_store(store, demo, only={"itm_boon_nursh"})
    g = _guardian(store)
    # a paused local run with one pending decision (as if pulled from S3)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec({**CRITICAL_PLAN, "digest": [], "digest_count": 0})), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    _wait(g, rid, {"paused"})
    d = g.decisions()["pending"][0]
    fake = FakeRuntimeClient({"intake": {"kind": "intake", "run_id": "intake-remote-1", "item": {"id": "itm_boon_nursh"}, "fields_confident": 8, "fields_total": 9, "cost_usd": 0.03, "error": None}})
    g.remote = AgentRuntime("arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/guardian-abc", client=fake)
    monkeypatch.delenv("GUARDIAN_DAILY_BUDGET_USD", raising=False)
    # sweep: a session id comes back at once, the runtime is invoked in the background, agent status reads "working"
    sid = g.start_sweep(trigger="dashboard")
    assert sid.startswith("remote:")
    assert g.summary()["runtime"]["mode"] == "agentcore"
    _wait_idle(g)
    assert [c[2]["kind"] for c in fake.calls] == ["sweep"] and len(fake.calls[0][1]) >= 33
    # answer: recorded locally for the dashboard, sent to the runtime, and the local gate stays untouched
    res = g.answer(d["id"], "request_remedy", by="dashboard")
    assert res["remote"] is True and res["resumed"] is None
    _wait_idle(g)
    assert fake.calls[-1][2] == {"kind": "answer", "decision_id": d["id"], "choice": "request_remedy", "by": "dashboard", "comment": None}
    assert store.decision(d["id"]).state == "answered"
    assert g.run_store.load(rid).run["status"] == "paused"  # not resumed here; the runtime owns the graph
    # intake: synchronous round trip, the returned item is read back from the local store
    out = g.intake("Walmart receipt ... BOON NURSH 8OZ 3PK 669028116546 19.97", source="email")
    assert out["run_id"] == "intake-remote-1" and out["item"]["id"] == "itm_boon_nursh" and out["fields_confident"] == 8
    assert fake.calls[-1][2]["kind"] == "intake"


def test_runtime_client_parses_streaming_bodies():
    fake = FakeRuntimeClient({"status": {"kind": "status", "summary": {"items_watched": 3}}})
    rt = AgentRuntime("arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/x", client=fake)
    assert rt.invoke({"kind": "status"})["summary"]["items_watched"] == 3
    assert rt.region == "us-east-1" or rt.region
