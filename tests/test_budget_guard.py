"""GUARDIAN_DAILY_BUDGET_USD is the household's own hard stop on model spend: once today's recorded run cost reaches
it, no new sweep or intake starts until tomorrow. (AWS Budgets alert; gren's cap bounds one run; this bounds the day.)"""
import yaml

from tests.conftest import seed_store
from tests.test_sweep_graph import CRITICAL_PLAN, _guardian, _spec, _wait


def test_daily_budget_blocks_new_runs_and_summary_reports_spend(store, demo, monkeypatch):
    seed_store(store, demo, only={"itm_boon_nursh"})
    g = _guardian(store)
    monkeypatch.delenv("GUARDIAN_DAILY_BUDGET_USD", raising=False)
    assert g.daily_budget() is None and g.spend_today() == 0.0
    # one mock run with real (mock-priced) model calls: the critical plan makes matcher/triage/verify calls
    rid = g.control.start(spec_yaml=yaml.safe_dump(_spec({**CRITICAL_PLAN, "digest": [], "digest_count": 0})), input_={"window_days": 120}, bridge="mock", labels={"kind": "sweep"})
    _wait(g, rid, {"paused", "completed", "failed"})
    spent = g.spend_today()
    assert spent > 0
    monkeypatch.setenv("GUARDIAN_DAILY_BUDGET_USD", f"{spent / 2:.4f}")
    s = g.summary()
    assert s["spend"]["today_usd"] == spent and s["spend"]["daily_budget_usd"] == float(f"{spent / 2:.4f}")
    try:
        g.start_sweep()
        raise AssertionError("start_sweep should have refused")
    except ValueError as e:
        assert "daily model budget reached" in str(e)
    res = g.intake("Amazon order 113-1 · Graco Modes Nest Stroller $379.99", source="paste")
    assert res["item"] is None and "daily model budget reached" in (res["error"] or "")
    monkeypatch.setenv("GUARDIAN_DAILY_BUDGET_USD", "100")
    rid2 = g.start_sweep()
    assert rid2
    _wait(g, rid2, {"paused", "completed", "failed"})
