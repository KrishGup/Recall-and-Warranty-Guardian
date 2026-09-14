"""The Guardian HTTP API on the mock provider, with the gren API mounted under /gren."""
import os
import time

from fastapi.testclient import TestClient

from guardian.api.app import create_guardian_app


def _client(tmp_path):
    app = create_guardian_app(data_dir=str(tmp_path / "household"), runs_dir=str(tmp_path / "runs"), bridge="mock", web_dist=str(tmp_path / "nodist"))
    return TestClient(app)


def test_inventory_summary_decisions_and_preferences(tmp_path, demo):
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


def test_sweep_runs_through_the_mounted_gren_api(tmp_path, demo):
    # no GUARDIAN_DATA in the environment here: the app must publish its own data dir to the graph's reducers
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
    assert os.path.exists(os.path.join(str(tmp_path / "household"), "recalls.json"))  # the reducers wrote to the app's store, not the default one


def test_public_deployment_token_gates_actions_but_not_reads(tmp_path, monkeypatch):
    monkeypatch.setenv("GUARDIAN_API_TOKEN", "s3cret-token")
    c = _client(tmp_path)
    item = {"name": "Kettle", "brand": "Fellow", "category": "Kitchen", "purchase_date": "2026-01-02"}
    assert c.get("/api/summary").status_code == 200  # reads stay open
    assert c.post("/api/sweep", json={}).status_code == 401  # anything that spends or changes needs the token
    assert c.put("/api/preferences", json={}).status_code == 401
    assert c.post("/gren/api/runs/x/approve", json={}).status_code == 401  # the mounted gren API too
    assert c.post("/api/items", json=item, headers={"authorization": "Bearer nope"}).status_code == 401
    assert c.post("/api/items", json=item, headers={"authorization": "Bearer s3cret-token"}).status_code == 200
    r = c.get("/?token=s3cret-token")  # the link you open once: sets the cookie the dashboard's calls then carry
    assert r.status_code == 200 and c.cookies.get("guardian_token") == "s3cret-token"
    assert c.post("/api/items", json={**item, "name": "Grinder"}).status_code == 200
    assert c.get("/api/items").json()["total"] == 2


def test_without_a_token_everything_is_open(tmp_path, monkeypatch):
    monkeypatch.delenv("GUARDIAN_API_TOKEN", raising=False)
    c = _client(tmp_path)
    assert c.post("/api/items", json={"name": "Kettle", "purchase_date": "2026-01-02"}).status_code == 200


def test_delete_item_and_photo_round_trip(tmp_path):
    c = _client(tmp_path)
    item = c.post("/api/items", json={"name": "Kettle", "brand": "Fellow", "category": "Kitchen", "purchase_date": "2026-01-02"}).json()
    item_id = item["id"]
    assert item["photo_url"] is None

    up = c.post(f"/api/items/{item_id}/photo", files={"file": ("label.jpg", b"\xff\xd8\xff fake", "image/jpeg")})
    assert up.status_code == 200 and up.json()["photo_url"] == f"/api/items/{item_id}/photo"
    got = c.get(f"/api/items/{item_id}/photo")
    assert got.status_code == 200 and got.headers["content-type"] == "image/jpeg"
    assert c.post(f"/api/items/{item_id}/photo", files={"file": ("x.txt", b"not an image", "text/plain")}).status_code == 400

    assert c.delete(f"/api/items/{item_id}/photo").json()["photo_url"] is None
    assert c.get(f"/api/items/{item_id}/photo").status_code == 404

    assert c.delete(f"/api/items/{item_id}").json() == {"ok": True, "item_id": item_id}
    assert c.get(f"/api/items/{item_id}").status_code == 404
    assert c.get("/api/items").json()["total"] == 0


def test_gmail_status_without_configuration(tmp_path):
    c = _client(tmp_path)
    st = c.get("/api/gmail/status").json()
    assert st == {"configured": False, "connected": False, "email": None, "last_sync": None}
    assert c.get("/api/gmail/connect").status_code == 400


def test_dashboard_hosting_serves_the_pwa_entry_points(tmp_path):
    # A stand-in for `npm run build`: the shell, the service worker, the manifest, and one hashed asset.
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Guardian</title>", encoding="utf-8")
    (dist / "sw.js").write_text("self.addEventListener('fetch', () => {})", encoding="utf-8")
    (dist / "workbox-abc123.js").write_text("// workbox", encoding="utf-8")
    (dist / "manifest.webmanifest").write_text('{"name":"Guardian"}', encoding="utf-8")
    (dist / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
    app = create_guardian_app(data_dir=str(tmp_path / "household"), runs_dir=str(tmp_path / "runs"), bridge="mock", web_dist=str(dist))
    c = TestClient(app)

    sw = c.get("/sw.js")
    assert sw.status_code == 200 and "javascript" in sw.headers["content-type"] and sw.headers["cache-control"] == "no-cache"
    assert c.get("/workbox-abc123.js").headers["cache-control"] == "no-cache"
    man = c.get("/manifest.webmanifest")
    assert man.status_code == 200 and man.headers["content-type"].startswith("application/manifest+json") and man.json()["name"] == "Guardian"
    assert c.get("/assets/index-abc.js").status_code == 200
    # Client-side routes fall back to the shell, and the shell itself is never held by an intermediate cache.
    for route in ("/", "/decisions", "/flow/trace"):
        r = c.get(route)
        assert r.status_code == 200 and "Guardian" in r.text and r.headers["cache-control"] == "no-cache"
    # The API and the gren mount are not the SPA.
    assert c.get("/api/health").json()["ok"] is True
    assert c.get("/api/nope").status_code == 404
    assert c.get("/../pyproject.toml").status_code in (200, 404) and "[project]" not in c.get("/../pyproject.toml").text
