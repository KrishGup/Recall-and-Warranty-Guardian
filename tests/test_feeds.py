"""Feed normalizers against recorded responses (feeds/fixtures, captured 2026-09-13)."""
from datetime import date

from guardian.feeds import cpsc, fda, nhtsa
from guardian.feeds.http import load_fixture
from guardian.feeds.refresh import refresh


def _cpsc(number: str):
    raw = next(r for r in load_fixture("cpsc_chosen.json") if r["RecallNumber"] == number)
    return cpsc.normalize(raw)


def test_cpsc_boon_bottles_upc_sold_window_and_severity():
    r = _cpsc("26530")
    assert r.recall_id == "cpsc#26530"
    assert "669028116546" in r.all_upcs()
    assert r.sold_window() == ("2025-11", "2026-05")
    assert r.severity == "critical" and any("choking" in x for x in r.severity_reasons)
    assert r.contact.phone or r.contact.url or r.contact.email
    assert r.products[0].brand and "TOMY" in r.products[0].brand


def test_cpsc_ceiling_fan_is_standard_with_upcs():
    r = _cpsc("26702")
    assert r.severity == "standard"
    assert set(r.all_upcs()) >= {"840059614922", "840059615370"}
    assert r.sold_window() == ("2023-01", "2025-10")


def test_cpsc_finger_lights_critical_no_upc_brand_from_title():
    r = _cpsc("26761")
    assert r.severity == "critical"
    assert r.all_upcs() == []
    assert r.products[0].brand and "Cade" in r.products[0].brand
    assert r.sold_window() == ("2015-03", "2026-07")
    assert r.contact.email == "ccecamazonservice@gmail.com"


def test_nhtsa_campaigns_normalize_for_vehicle_class():
    v = nhtsa.decode_vin("4S4BSANC2K3372741")
    assert (v.make, v.model, v.year) == ("Subaru", "Outback", 2019)
    raws = nhtsa.fetch_campaigns("Subaru", "Outback", 2019)
    assert len(raws) == 3
    recs = [nhtsa.normalize(r, v) for r in raws]
    assert {r.recall_id for r in recs} == {"nhtsa#19V493000", "nhtsa#21V587000", "nhtsa#20V218000"}
    assert all(r.vehicle_key == "subaru|outback|2019" for r in recs)
    assert all(r.severity == "standard" for r in recs)  # none flagged park-outside / do-not-drive
    assert recs[0].published_at == "2019-06-26"


def test_fda_upc_and_class_extraction():
    raws = load_fixture("fda_food_window.json")["results"]
    pop = next(r for r in raws if r["recall_number"] == "H-1166-2026")
    r = fda.normalize(pop, "food")
    assert r.recall_id == "fda_food#H-1166-2026"
    assert "827912008548" in r.all_upcs()
    assert r.flags["classification"] == "Class I" and r.severity == "critical"
    assert r.published_at.startswith("2026-")


def test_refresh_upserts_and_is_idempotent(store, demo):
    from tests.conftest import seed_store

    seed_store(store, demo, only={"itm_subaru_outback", "itm_boon_nursh"})
    out = refresh(store, window_days=120, today=date(2026, 9, 13))
    assert out["mode"] == "fixtures"
    assert out["cpsc"] >= 3 and out["nhtsa"] == 3 and out["fda"] >= 10
    assert out["upserted"] == out["fetched"]
    again = refresh(store, window_days=120, today=date(2026, 9, 13))
    assert again["upserted"] == 0
    assert store.recall("cpsc#26530") is not None
