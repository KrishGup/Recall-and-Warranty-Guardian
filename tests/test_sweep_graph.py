"""The nightly sweep end to end on the Strands engine with gren's mock provider: feeds (fixtures) -> stages 1-3 ->
mock matcher -> mock triage -> verifier -> gate (pause) -> household answer -> remedy -> followup (side effect)."""
import copy
import os
import time

import pytest
import yaml
from gren.control import RunControl
from gren.engine.state import RunStore
from gren.models.registry import ModelRegistry

from guardian.service import GRAPHS_DIR, Guardian
from tests.conftest import seed_store

BOON_MSG = "Guardian: The Boon NURSH 8 oz reusable silicone pouch bottles you bought at Walmart on 2026-02-11 match CPSC recall 26530 (outer shell can peel, choking hazard). Remedy: full refund from TOMY. Reply 1 to request it, 2 if you no longer own it, 3 for details."


def _spec(mock_triage: dict | None = None, mock_matcher: dict | None = None, kill_threshold: float | None = None):
    with open(os.path.join(GRAPHS_DIR, "nightly-sweep.yaml"), encoding="utf-8") as f:
        spec = yaml.safe_load(f)
    nodes = {n["id"]: n for n in spec["nodes"]}
    if kill_threshold is not None:
        nodes["severity_check"]["kill_threshold"] = kill_threshold
    props = nodes["triage"]["output_schema"]["properties"]
    for k, v in (mock_triage or {}).items():
        props[k]["x-mock"] = v
    mprops = nodes["matcher"]["output_schema"]["properties"]
    for k, v in (mock_matcher or {"match_id": "itm_finger_lights~cpsc#26761", "is_match": "yes", "confidence": 0.9, "rationale": "mock: brand and product line agree; nothing in the recall excludes the item"}).items():
        mprops[k]["x-mock"] = v
    rprops = nodes["remedy"]["output_schema"]["properties"]
    for k, v in {"decision_id": "unknown", "item_id": "itm_boon_nursh", "recall_id": "cpsc#26530", "type": "email_remedy_request", "to": "recalls@example.test", "subject": "Refund request: Boon NURSH bottles, CPSC recall 26530",
                 "body": "mock body " * 12, "attachments": ["receipt-2026-02-11.pdf"], "next_check_days": 10}.items():
        rprops[k]["x-mock"] = v
    return spec


CRITICAL_PLAN = {
    "channel": "sms_now", "severity": "critical",
    "decisions": [{"kind": "recall_remedy", "match_id": "itm_boon_nursh~cpsc#26530", "item_id": "itm_boon_nursh", "recall_id": "cpsc#26530", "severity": "critical", "headline": "Boon NURSH bottles — outer shell can peel and pose a choking hazard", "message": BOON_MSG, "remedy_label": "Request full refund"}],
    "digest": [{"match_id": "itm_hampton_fan~cpsc#26702", "item_id": "itm_hampton_fan", "recall_id": "cpsc#26702", "line": "Hampton Bay Halwin ceiling fan matches CPSC 26702 (blade separation, standard hazard); added to the weekly digest."}],
    "digest_count": 1, "queued": [], "rationale": "mock rationale",
}


def _guardian(store, kill_rate: float = 0.0):
    runs = RunStore(os.path.join(store.root, "..", "runs"))
    control = RunControl(runs, GRAPHS_DIR, ModelRegistry(mock_options={"latency_ms": 1, "jitter_ms": 1, "kill_rate": kill_rate}))
    return Guardian(store, runs, control, bridge="mock")


def _wait(g: Guardian, rid: str, until: set[str], timeout: float = 90) -> dict:
    """Wait for a run status. For terminal states also wait for the run thread to exit, so the completion event
    (which fires just after the checkpoint is written) has been handled."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        run = g.run_store.load(rid).run
        if run["status"] in until and (run["status"] == "paused" or not g.control.is_running(rid)):
            return run
        time.sleep(0.1)
    pytest.fail(f"run {rid} did not reach {until}: {g.run_store.load(rid).run['status']} {g.run_store.load(rid).run.get('error')}")


def test_critical_match_pauses_at_the_gate_then_remedy_runs_after_approval(store, demo):
    seed_store(store, demo)
    g = _guardian(store)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec(CRITICAL_PLAN)), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    run = _wait(g, rid, {"paused", "completed", "failed"})
    assert run["status"] == "paused", run.get("error")
    nodes = g.run_store.load(rid).nodes
    assert nodes["feeds_refresh"]["status"] == "completed" and nodes["candidate_gen"]["output"]["certain_count"] >= 2
    assert nodes["matcher"]["status"] == "completed" and nodes["household_decision"]["status"] == "waiting_approval"
    assert nodes["digest"]["status"] == "completed" and nodes["remedy"]["status"] == "pending"
    # the gate became one household decision, an SMS went to the outbox, the match is marked surfaced
    dec = g.decisions()
    assert len(dec["pending"]) == 1
    d = dec["pending"][0]
    assert d["item_id"] == "itm_boon_nursh" and d["severity"] == "critical" and d["message"] == BOON_MSG and d["options"][0]["label"] == "Request full refund"
    assert d["recall"]["native_id"] == "26530" and any(f["label"] == "Match confidence" and "Certain" in f["value"] for f in d["facts"])
    assert any(o["kind"] == "sms" for o in store.outbox())
    assert store.match("itm_boon_nursh~cpsc#26530").state == "surfaced"
    assert store.match("itm_finger_lights~cpsc#26761").verdict == "yes"
    assert store.match("itm_hampton_fan~cpsc#26702").state == "closed"
    sources = {a.source for a in store.activity()}
    assert {"CPSC", "NHTSA", "FDA", "Matcher", "Triage"} <= sources
    assert g.summary()["agent_status"] == "pending" and g.summary()["quiet_days"] == 0
    # the household approves from the dashboard
    res = g.answer(d["id"], "request_remedy", by="dashboard")
    assert res["resumed"] is True
    run = _wait(g, rid, {"completed", "failed"})
    assert run["status"] == "completed", run.get("error")
    nodes = g.run_store.load(rid).nodes
    assert nodes["answers"]["output"]["approved_count"] == 1
    assert nodes["remedy"]["status"] == "completed" and nodes["followup"]["status"] == "completed" and nodes["followup"].get("side_effect_done")
    d2 = store.decision(d["id"])
    assert d2.state == "answered" and d2.action and d2.action["to"] == "recalls@example.test" and d2.outcome["title"] == "Remedy requested"
    assert any(o["kind"] == "email" and o["to"] == "recalls@example.test" for o in store.outbox())
    assert store.match("itm_boon_nursh~cpsc#26530").state == "closed"
    assert g.item_view(store.item("itm_boon_nursh"))["recall"]["state"] == "resolved"
    assert g.decisions()["past"][0]["past_label"] == "Remedy sent"
    sweep = next(s for s in store.sweeps() if s.run_id == rid)
    assert sweep.status == "completed" and sweep.surfaced == 1


def test_household_can_decline_and_the_run_completes_without_a_remedy(store, demo):
    seed_store(store, demo, only={"itm_boon_nursh", "itm_graco_stroller"})
    g = _guardian(store)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec({**CRITICAL_PLAN, "digest": [], "digest_count": 0})), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    _wait(g, rid, {"paused"})
    d = g.decisions()["pending"][0]
    g.answer(d["id"], "not_mine", by="sms")
    run = _wait(g, rid, {"completed", "failed"})
    assert run["status"] == "completed"
    nodes = g.run_store.load(rid).nodes
    assert nodes["household_decision"]["status"] == "skipped" and nodes["remedy"]["status"] == "skipped" and nodes["followup"]["status"] == "skipped"
    m = store.match("itm_boon_nursh~cpsc#26530")
    assert m.state == "closed" and m.verdict == "no"
    assert store.decision(d["id"]).outcome["title"] == "Match closed"
    assert not any(o["kind"] == "email" for o in store.outbox())


def test_quiet_night_skips_every_agent(store, demo):
    seed_store(store, demo, only={"itm_graco_stroller", "itm_roku_stick"})
    g = _guardian(store)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec()), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    run = _wait(g, rid, {"completed", "failed"})
    assert run["status"] == "completed", run.get("error")
    nodes = g.run_store.load(rid).nodes
    assert nodes["matcher"]["status"] == "skipped" and nodes["triage"]["status"] == "skipped" and nodes["household_decision"]["status"] == "skipped"
    assert run["totals"]["agent_calls"] == 0 and run["totals"]["cost_usd"] == 0
    assert g.decisions()["pending"] == []
    assert next(s for s in store.sweeps() if s.run_id == rid).summary == "Quiet"
    assert any(a.text == "Sweep complete" and a.result.startswith("Nothing to report") for a in store.activity())


def test_verifier_kill_triggers_one_repair_round(store, demo):
    seed_store(store, demo, only={"itm_boon_nursh"})
    g = _guardian(store, kill_rate=1.0)
    # the mock verifier's kill confidence is 0.6-1.0; a 0.5 threshold makes every kill count
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec({**CRITICAL_PLAN, "digest": [], "digest_count": 0}, kill_threshold=0.5)), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    run = _wait(g, rid, {"paused", "completed", "failed"})
    assert run["status"] == "paused", run.get("error")
    nodes = g.run_store.load(rid).nodes
    assert nodes["severity_check"]["verify"]["repair_round"] == 1 and nodes["triage"]["repairs"] >= 1
    assert any(a.source == "Verifier" and "killed" in a.text for a in store.activity())
    assert len(g.decisions()["pending"]) == 1
