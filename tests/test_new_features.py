"""Case-study seed data, the settlement-claim decision kind, item removal, and label photos."""
from __future__ import annotations

import os

from guardian.case_studies import seed_case_studies
from guardian.models import Decision, DecisionOption, InventoryItem
from guardian.service import Guardian


def _guardian(tmp_path):
    g, _ = Guardian.build(data_dir=str(tmp_path / "household"), runs_dir=str(tmp_path / "runs"), bridge="mock", with_gren_app=False)
    return g


def test_case_studies_seed_a_critical_recall_and_a_settlement_decision(tmp_path):
    g = _guardian(tmp_path)
    counts = seed_case_studies(g)
    assert counts == {"items": 4, "decisions": 2}

    toy = g.item_detail("itm_glowbuddy_toy")
    assert toy is not None and toy["recall"]["state"] == "critical_match"

    decisions = {d.id: d for d in g.store.decisions()}
    toy_dec = decisions["dec_demo_glowbuddy"]
    assert toy_dec.kind == "recall_remedy" and toy_dec.severity == "critical" and toy_dec.state == "pending"
    toy_view = g.decision_view(toy_dec)
    assert toy_view["badge"] == "Critical hazard" and any(o["key"] == "request_remedy" for o in toy_view["options"])

    settlement_dec = decisions["dec_demo_ddr4_settlement"]
    assert settlement_dec.kind == "settlement_claim" and settlement_dec.state == "pending"
    settlement_view = g.decision_view(settlement_dec)
    assert settlement_view["badge"] == "Class action settlement"
    assert {"label": "Claim deadline", "value": "2026-11-02"} in settlement_view["facts"]
    assert [o["key"] for o in settlement_view["options"]] == ["review_and_attest", "skip_claim", "snooze"]

    # two items land inside the 60-day ending-soon window by construction
    from datetime import date

    from guardian.policy import warranty as warranty_policy

    soon = warranty_policy.ending_soon(g.store.items(), 60, today=date.today())
    assert {"itm_demo_brewer", "itm_demo_headphones"} <= {s["item_id"] for s in soon}


def test_answer_settlement_review_and_attest_and_skip(tmp_path):
    g = _guardian(tmp_path)
    seed_case_studies(g)
    res = g.answer("dec_demo_ddr4_settlement", "review_and_attest", by="test")
    assert res["decision"]["outcome"]["title"] == "Claim drafting started"
    assert res["decision"]["past_label"] == "Claim drafted"

    g.store.upsert_decision(Decision(id="dec_skip_test", kind="settlement_claim", severity="standard", state="pending", options=[DecisionOption(key="skip_claim", label="Skip", style="outline")]))
    res2 = g.answer("dec_skip_test", "skip_claim", by="test")
    assert res2["decision"]["outcome"]["title"] == "Settlement skipped"
    assert res2["decision"]["past_label"] == "Closed · skipped"


def test_remove_item_deletes_item_and_closes_pending_decisions(tmp_path):
    g = _guardian(tmp_path)
    seed_case_studies(g)
    assert g.store.item("itm_glowbuddy_toy") is not None
    out = g.remove_item("itm_glowbuddy_toy")
    assert out == {"ok": True, "item_id": "itm_glowbuddy_toy"}
    assert g.store.item("itm_glowbuddy_toy") is None
    assert g.store.matches_for_item("itm_glowbuddy_toy") == []
    dec = g.store.decision("dec_demo_glowbuddy")
    assert dec is not None and dec.state == "answered" and dec.outcome["title"] == "Item removed"


def test_delete_item_removes_matches_too(tmp_path):
    g = _guardian(tmp_path)
    it = InventoryItem(id="itm_x", name="Widget", brand="Acme", category="Other", purchase_date="2026-01-01")
    g.store.upsert_item(it)
    assert g.store.delete_item("itm_x") is True
    assert g.store.item("itm_x") is None
    assert g.store.delete_item("itm_x") is False  # already gone


def test_demo_photos_attach_to_every_seeded_item(tmp_path):
    from guardian.demo_photos import attach_all

    g = _guardian(tmp_path)
    seed_case_studies(g)
    n = attach_all(g)
    assert n == len(g.store.items(include_disposed=True))
    for it in g.store.items(include_disposed=True):
        assert it.photo_filename is not None
        assert g.item_photo_file(it.id) is not None
    # idempotent: a second pass attaches nothing new
    assert attach_all(g) == 0


def test_item_photo_upload_view_and_remove(tmp_path):
    g = _guardian(tmp_path)
    it = InventoryItem(id="itm_photo", name="Widget", brand="Acme", category="Other", purchase_date="2026-01-01")
    g.store.upsert_item(it)
    view = g.save_item_photo("itm_photo", b"\xff\xd8\xff fake jpeg bytes", "label.jpg", "image/jpeg")
    assert view["photo_url"] == "/api/items/itm_photo/photo"
    found = g.item_photo_file("itm_photo")
    assert found is not None and os.path.exists(found[0]) and found[1] == "image/jpeg"
    view2 = g.remove_item_photo("itm_photo")
    assert view2["photo_url"] is None
    assert g.item_photo_file("itm_photo") is None
