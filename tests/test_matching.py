"""Matching stages 1-3 on the demo household against the recorded feeds."""
from datetime import date

from guardian.feeds.refresh import refresh
from guardian.matching.candidates import candidate_payload, date_window_check, generate, norm_upc
from guardian.models import InventoryItem
from tests.conftest import seed_store


def _run(store, demo, only=None):
    seed_store(store, demo, only=only)
    refresh(store, window_days=120, today=date(2026, 9, 13))
    return generate(store.items(), store.recalls(), store.matches())


def _by(res, key):
    return {m.item_id: m for m in res[key]}


def test_stage1_upc_matches_are_certain(store, demo):
    res = _run(store, demo)
    certain = _by(res, "certain")
    boon = certain["itm_boon_nursh"]
    assert boon.recall_id == "cpsc#26530" and boon.key == "upc" and boon.severity == "critical"
    fan = certain["itm_hampton_fan"]
    assert fan.recall_id == "cpsc#26702" and fan.key == "upc" and fan.severity == "standard"


def test_vehicle_campaigns_are_certain_for_the_vehicle_class(store, demo):
    res = _run(store, demo, only={"itm_subaru_outback"})
    ids = {m.recall_id for m in res["certain"] if m.item_id == "itm_subaru_outback"}
    assert ids == {"nhtsa#19V493000", "nhtsa#21V587000", "nhtsa#20V218000"}
    assert all(m.key == "vehicle" and m.severity == "standard" for m in res["certain"])


def test_stage2_lexical_candidate_needs_adjudication(store, demo):
    res = _run(store, demo, only={"itm_finger_lights"})
    cands = [m for m in res["candidates"] if m.item_id == "itm_finger_lights"]
    assert cands and cands[0].recall_id == "cpsc#26761" and cands[0].stage == 2 and cands[0].verdict == "pending"
    payload = candidate_payload(cands[0], store.item("itm_finger_lights"), store.recall("cpsc#26761"))
    assert payload["recall"]["severity_keyword_pass"] == "critical" and payload["item"]["brand"] == "Cade California Electronic"


def test_no_candidates_for_unrelated_items(store, demo):
    res = _run(store, demo, only={"itm_graco_stroller", "itm_roku_stick", "itm_dewalt_drill"})
    assert not res["certain"]
    assert all(m.item_id not in ("itm_roku_stick", "itm_dewalt_drill") for m in res["candidates"])


def test_date_window_drops_purchases_outside_the_sold_window(store, demo):
    seed_store(store, demo, only={"itm_boon_nursh"})
    refresh(store, window_days=120, today=date(2026, 9, 13))
    old = InventoryItem(id="itm_old_bottles", name="NURSH bottles", brand="Boon", upc="669028116546", category="Juvenile", purchase_date="2021-01-05")
    store.upsert_item(old)
    res = generate(store.items(), store.recalls(), [])
    dropped = {m.item_id: m for m in res["dropped"]}
    assert "itm_old_bottles" in dropped and dropped["itm_old_bottles"].stage == 3
    keep, reason = date_window_check(old, store.recall("cpsc#26530"))
    assert not keep and "before the sold window" in reason


def test_generate_skips_pairs_already_decided(store, demo):
    seed_store(store, demo, only={"itm_boon_nursh"})
    refresh(store, window_days=120, today=date(2026, 9, 13))
    first = generate(store.items(), store.recalls(), [])
    for m in first["certain"]:
        store.upsert_match(m)
    second = generate(store.items(), store.recalls(), store.matches())
    assert not second["certain"]


def test_norm_upc_handles_leading_zeros_and_dashes():
    assert norm_upc("0-47406-17122-4") == norm_upc("047406171224") == "47406171224"
