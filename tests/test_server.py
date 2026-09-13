"""Dashboard API on the in-process control: start, pause at a gate, approve, resume, fork."""
import os
import time

from fastapi.testclient import TestClient

from gren.engine.state import RunStore
from gren.models.registry import ModelRegistry
from gren.server.app import create_app

GRAPHS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "graphs")


def _wait(c: TestClient, rid: str, states: tuple[str, ...], timeout: float = 30.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = c.get("/api/run", params={"id": rid}).json()
        if st["run"]["status"] in states:
            return st
        time.sleep(0.1)
    raise AssertionError(f"run {rid} did not reach {states}: {st['run']['status']}")


def test_dashboard_api_flow(tmp_path):
    store = RunStore(os.path.join(str(tmp_path), "runs"))
    app = create_app(store, GRAPHS, ModelRegistry(mock_options={"latency_ms": 5, "jitter_ms": 5}), quiet=True)
    c = TestClient(app)
    assert c.get("/").status_code == 200 and "<html" in c.get("/").text.lower() or "<!doctype" in c.get("/").text.lower()
    graphs = c.get("/api/graphs").json()
    assert graphs and all(g["ok"] for g in graphs)
    assert "default" in c.get("/api/bridges").json()
    assert len(c.get("/api/shapes").json()) == 5
    assert "frozen" in c.get("/api/reference").json()

    r = c.post("/api/runs", json={"graph": "starter-fork-join.yaml", "input": {"task": "Should a small team adopt graph orchestration?"}, "bridge": "mock"})
    assert r.status_code == 200, r.text
    rid = r.json()["run_id"]
    st = _wait(c, rid, ("paused", "completed", "failed"))
    assert st["run"]["status"] == "paused" and st["in_process"] is True
    assert st["nodes"]["approve"]["status"] == "waiting_approval"
    assert st["analysis"]["ok"] and st["metrics"]["critical_path"]["nodes"]
    assert c.get("/api/run/events", params={"id": rid}).json()

    assert c.post("/api/run/approve", json={"id": rid, "gate": "approve", "decision": "approved", "by": "test"}).json() == {"ok": True}
    st = _wait(c, rid, ("completed", "failed"))
    assert st["run"]["status"] == "completed", st["run"].get("error")
    assert st["nodes"]["record"]["status"] == "completed"
    art = st["nodes"]["answer"]["attempts"][0]["artifact"]
    assert c.get("/api/run/artifact", params={"id": rid, "path": art}).json()["request"]["prompt"]

    f = c.post("/api/run/fork", json={"id": rid, "from": ["answer"]}).json()
    st = _wait(c, f["run_id"], ("paused", "completed", "failed"))
    assert st["nodes"]["plan"]["status"] == "completed" and st["nodes"]["approve"]["status"] == "waiting_approval"
    assert c.post("/api/run/approve", json={"id": f["run_id"], "gate": "approve", "decision": "rejected", "by": "test", "comment": "no"}).json()["ok"]
    st = _wait(c, f["run_id"], ("completed", "failed"))
    assert st["run"]["status"] == "failed" and "rejected" in st["run"]["error"]

    v = c.post("/api/graph/validate", json={"spec_yaml": "name: x\nnodes: []\n"}).json()
    assert v["ok"] is False
    assert c.post("/api/graph/scaffold", json={"shape": "tournament", "name": "t"}).json()["yaml"].startswith("name: t")
    assert c.get("/api/graph", params={"path": "../pyproject.toml"}).status_code == 400
    assert c.get("/api/graph", params={"path": "tournament.yaml"}).json()["analysis"]["ok"]


def test_api_token_required(tmp_path):
    store = RunStore(os.path.join(str(tmp_path), "runs"))
    c = TestClient(create_app(store, GRAPHS, token="secret", quiet=True))
    assert c.get("/api/runs").status_code == 401
    assert c.get("/api/runs", headers={"authorization": "Bearer secret"}).status_code == 200
    assert c.get("/").status_code == 200
