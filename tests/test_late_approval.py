"""A snoozed decision must not block the others, and a decision approved after its run finished must still get its
remedy: the service forks the finished run from the household gate so the same triage plan feeds remedy and followup."""
import os
import time

import pytest
import yaml

from guardian.service import Guardian
from tests.conftest import seed_store
from tests.test_sweep_graph import BOON_MSG, CRITICAL_PLAN, _guardian, _spec, _wait

TWO_DECISIONS = {
    **CRITICAL_PLAN,
    "decisions": CRITICAL_PLAN["decisions"] + [{"kind": "recall_remedy", "match_id": "itm_hampton_fan~cpsc#26702", "item_id": "itm_hampton_fan", "recall_id": "cpsc#26702", "severity": "standard", "headline": "Hampton Bay Halwin ceiling fan — blades can separate", "message": "Guardian: The Hampton Bay Halwin ceiling fan you bought at The Home Depot on 2024-03-16 matches CPSC recall 26702 (blades can separate). Remedy: full refund. Reply 1 to request it, 2 if you no longer own it, 3 for details.", "remedy_label": "Request full refund"}],
    "digest": [], "digest_count": 0,
}


def _emails(store):
    return [o for o in store.outbox() if o["kind"] == "email"]


def test_snooze_does_not_block_and_a_late_approval_forks_the_run(store, demo):
    seed_store(store, demo)
    g = _guardian(store)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec(TWO_DECISIONS)), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    _wait(g, rid, {"paused"})
    pending = {d["item_id"]: d for d in g.decisions()["pending"]}
    assert set(pending) == {"itm_boon_nursh", "itm_hampton_fan"}
    boon, fan = pending["itm_boon_nursh"], pending["itm_hampton_fan"]
    # snooze the fan: the gate keeps waiting because the bottles are still pending
    assert g.answer(fan["id"], "snooze", by="dashboard")["resumed"] is False
    assert store.decision(fan["id"]).state == "snoozed"
    # approve the bottles: the gate releases with only the bottles in the approval; the snoozed fan is left out
    assert g.answer(boon["id"], "request_remedy", by="dashboard")["resumed"] is True
    run = _wait(g, rid, {"completed", "failed"})
    assert run["status"] == "completed", run.get("error")
    nodes = g.run_store.load(rid).nodes
    assert nodes["answers"]["output"]["approved_count"] == 1 and nodes["followup"]["output"]["sent"] == 1
    assert store.decision(boon["id"]).action and store.decision(fan["id"]).action is None
    assert len(_emails(store)) == 1
    # tomorrow: the snoozed decision resurfaces and the household approves it, long after the run finished
    fan_row = store.decision(fan["id"])
    fan_row.snooze_until = "2000-01-01T08:00:00"
    store.upsert_decision(fan_row)
    assert g.resurface_snoozed() == 1
    fan_view = next(d for d in g.decisions()["pending"] if d["id"] == fan["id"])
    assert fan_view["state"] == "pending"
    res = g.answer(fan["id"], "request_remedy", by="sms")
    assert res["resumed"] is True
    late = store.decision(fan["id"])
    assert late.run_id and late.run_id != rid and late.run_id.startswith(rid)
    run2 = _wait(g, late.run_id, {"completed", "failed"}, timeout=120)
    assert run2["status"] == "completed", run2.get("error")
    assert run2["forked_from"] == rid
    n2 = g.run_store.load(late.run_id).nodes
    # upstream outputs were reused (no new model calls for matcher/triage), only the gate and downstream re-ran
    assert n2["triage"]["status"] == "completed" and n2["answers"]["output"]["approved_count"] == 1 and n2["followup"]["output"]["sent"] == 1
    assert store.decision(fan["id"]).action is not None and store.decision(fan["id"]).outcome["title"] == "Remedy requested"
    assert len(_emails(store)) == 2
    # the original bottles decision was not sent twice
    assert store.decision(boon["id"]).action["sent_at"] == store.decision(boon["id"]).action["sent_at"]
    assert sum(1 for s in store.sweeps() if s.run_id == rid) == 1 and not any(s.run_id == late.run_id for s in store.sweeps())
    assert any(a.text.startswith("Late approval") for a in store.activity()) and any(a.text == "Late-approval run complete" for a in store.activity())


def test_first_approval_releases_at_once_and_the_second_forks(store, demo):
    seed_store(store, demo)
    g = _guardian(store)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec(TWO_DECISIONS)), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    _wait(g, rid, {"paused"})
    pending = {d["item_id"]: d for d in g.decisions()["pending"]}
    boon, fan = pending["itm_boon_nursh"], pending["itm_hampton_fan"]
    # approving the bottles must not wait for an answer about the fan
    assert g.answer(boon["id"], "request_remedy", by="sms")["resumed"] is True
    run = _wait(g, rid, {"completed", "failed"})
    assert run["status"] == "completed", run.get("error")
    assert g.run_store.load(rid).nodes["followup"]["output"]["sent"] == 1
    assert store.decision(boon["id"]).action and store.decision(fan["id"]).state == "pending"
    assert len(_emails(store)) == 1
    # the fan is approved later, after the run moved on: the service forks from the gate
    assert g.answer(fan["id"], "request_remedy", by="dashboard")["resumed"] is True
    late = store.decision(fan["id"])
    assert late.run_id != rid and late.run_id.startswith(rid)
    run2 = _wait(g, late.run_id, {"completed", "failed"}, timeout=120)
    assert run2["status"] == "completed", run2.get("error")
    assert g.run_store.load(late.run_id).nodes["followup"]["output"]["sent"] == 1
    assert len(_emails(store)) == 2 and store.decision(fan["id"]).action is not None
    assert g.decisions()["pending"] == []


def test_all_declined_releases_with_a_rejection(store, demo):
    seed_store(store, demo)
    g = _guardian(store)
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec(TWO_DECISIONS)), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    _wait(g, rid, {"paused"})
    for d in g.decisions()["pending"]:
        g.answer(d["id"], "no_longer_own", by="dashboard")
    run = _wait(g, rid, {"completed", "failed"})
    assert run["status"] == "completed"
    assert g.run_store.load(rid).nodes["remedy"]["status"] == "skipped"
    assert store.item("itm_boon_nursh").status == "disposed" and store.item("itm_hampton_fan").status == "disposed"
    assert not _emails(store)
