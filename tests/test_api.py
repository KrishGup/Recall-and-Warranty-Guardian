"""The Guardian HTTP API on the mock provider, with the gren API mounted under /gren."""
import os
import time

from fastapi.testclient import TestClient

from guardian.api.app import create_guardian_app


def _client(tmp_path):
    app = create_guardian_app(data_dir=str(tmp_path / "household"), runs_dir=str(tmp_path / "runs"), bridge="mock", web_dist=str(tmp_path / "nodist"))
    return TestClient(app)


def test_inventory_summary_decisions_and_preferences(tmp_path, demo, monkeypatch):
    monkeypatch.setenv("GUARDIAN_DATA", str(tmp_path / "household"))
    c = _client(tmp_path)
    r = c.post("/api/items/import", json={"items": demo["items"]})
    assert r.status_code == 200 and r.json()["created"] == len(demo["items"])
    s = c.get("/api/summary").json()
    assert s["items_watched"] == len(demo["items"]) and s["agent_status"] == "idle" and s["decisions_pending"] == 0
    assert s["provider"]["bridge"] == "mock"
    page = c.get("/api/items", params={"q": "boon"}).json()
    assert page["total"] == 1 and page["items"][0]["id"] == "itm_boon_nursh" and page["items"][0]["recall"]["state"] == "unchecked"
    detail = c.get("/api/items/itm_subaru_outback").json()
    assert detail["vehicle"]["make"] == "Subaru" and detail["warranty"]["term_months"] == 60
    assert c.get("/api/items/nope").status_code == 404
    assert c.get("/api/decisions").json() == {"pending": [], "past": []}
    assert c.post("/api/decisions/nope/answer", json={"choice": "snooze"}).status_code == 404
    p = c.get("/api/preferences").json()
    p["value_threshold"] = 150
    assert c.put("/api/preferences", json=p).json()["value_threshold"] == 150
    assert c.post("/api/items", json={"name": "Kettle", "brand": "Fellow", "category": "Kitchen", "purchase_date": "2026-01-02", "price": 165}).json()["warranty"]["source"] == "category_default"
    assert c.get("/api/health").json()["ok"] is True
    assert c.get("/api/activity").json()["nights"][0]["rows"]


def test_sweep_runs_through_the_mounted_gren_api(tmp_path, demo, monkeypatch):
    monkeypatch.setenv("GUARDIAN_DATA", str(tmp_path / "household"))
    c = _client(tmp_path)
    c.post("/api/items/import", json={"items": [i for i in demo["items"] if i["id"] in ("itm_graco_stroller", "itm_roku_stick")]})
    rid = c.post("/api/sweep", json={"window_days": 120}).json()["run_id"]
    for _ in range(300):
        run = c.get("/gren/api/run", params={"id": rid}).json()
        if run["run"]["status"] in ("completed", "paused", "failed"):
            break
        time.sleep(0.1)
    assert run["run"]["status"] == "completed", run["run"].get("error")
    assert run["analysis"]["ok"] and run["metrics"]["agent_calls"] == 0
    assert any(r["id"] == rid for r in c.get("/gren/api/runs").json())
    assert c.get("/gren/api/run/events", params={"id": rid}).json()
    s = c.get("/api/summary").json()
    assert s["sweeps_run"] == 1 and s["last_sweep"]["run_id"] == rid and s["recalls_screened_30d"] > 0
