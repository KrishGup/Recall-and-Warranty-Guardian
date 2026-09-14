"""Deterministic policy: severity keyword pass, warranty windows, the notification budget."""
from datetime import date, datetime, timezone

from guardian.models import Decision, InventoryItem, Preferences, Warranty
from guardian.policy import budget, warranty
from guardian.policy.severity import classify


def test_severity_keyword_pass():
    assert classify("The fan blades can separate from the flywheel, posing impact and injury hazards")[0] == "standard"
    sev, reasons = classify("Loose pieces of plastic pose a choking hazard to young children")
    assert sev == "critical" and any("choking" in r for r in reasons)
    assert classify("Spot welds may be weak", "nhtsa", {"parkOutSide": True})[0] == "critical"
    assert classify("Product may contain foreign material", "fda_food", {"classification": "Class I"})[0] == "critical"
    assert classify("May contain undeclared milk", "fda_food", {"classification": "Class II"})[0] == "standard"
    assert classify("May contain undeclared milk", "fda_food", {"classification": "Class II"}, allergens=["milk"])[0] == "critical"
    assert classify("Button cell batteries can be ingested, risk of serious injury or death")[0] == "critical"


def test_warranty_from_receipt_and_category_default():
    vit = InventoryItem(name="Ascent A2500", brand="Vitamix", category="Kitchen", purchase_date="2016-10-01", price=449.95, warranty=Warranty(term_months=120, source="receipt"))
    v = warranty.view(vit, today=date(2026, 9, 13))
    assert v["ends_on"] == "2026-10-01" and v["source"] == "receipt" and v["elapsed_pct"] >= 99 and v["label"].startswith("120 mo · ends Oct 01, 2026")
    dehum = InventoryItem(name="50-pint dehumidifier", brand="Frigidaire", category="Appliance", purchase_date="2023-07-21")
    d = warranty.view(dehum, today=date(2026, 9, 13))
    assert d["term_months"] == 12 and d["source"] == "category_default" and "estimate" in d["label"] and d["elapsed_pct"] == 100
    formula = InventoryItem(name="formula", brand="Similac", category="Food", purchase_date="2026-08-30")
    assert warranty.view(formula)["label"] == "n/a"


def test_ending_soon_respects_window_and_threshold():
    today = date(2026, 9, 13)
    vit = InventoryItem(id="v", name="Ascent A2500", brand="Vitamix", category="Kitchen", purchase_date="2016-10-01", price=449.95, warranty=Warranty(term_months=120, source="receipt"))
    cheap = InventoryItem(id="c", name="Stick", brand="Roku", category="Electronics", purchase_date="2025-10-01", price=49.99, warranty=Warranty(term_months=12, source="receipt"))
    soon = warranty.ending_soon([vit, cheap], within_days=60, threshold=200, today=today)
    assert [s["item_id"] for s in soon] == ["v"] and soon[0]["days_left"] == 18
    assert warranty.ask_date(today, 18) == "2026-09-17"
    assert [s["item_id"] for s in warranty.ending_soon([vit, cheap], within_days=60, threshold=None, today=today)] == ["v", "c"]


def test_budget_counts_only_standard_interruptions():
    prefs = Preferences(budget="weekly")
    now = datetime.now(timezone.utc)
    crit = Decision(kind="recall_remedy", severity="critical")
    std = Decision(kind="recall_remedy", severity="standard")
    assert budget.state([crit], prefs, now)["remaining"] == 1
    st = budget.state([crit, std], prefs, now)
    assert st["standard_interruptions_used"] == 1 and st["remaining"] == 0
    assert not budget.allows_standard([std], prefs, now=now)
    assert not budget.allows_standard([], Preferences(budget="weekly", quiet_categories=["Kitchen"]), category="Kitchen", now=now)
    assert budget.state([], Preferences(budget="critical_only"), now)["standard_interruptions_allowed"] == 0
