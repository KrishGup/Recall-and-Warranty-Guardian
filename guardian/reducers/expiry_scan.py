# Node expiry_scan: items whose warranty ends within N days and whose price exceeds the household threshold,
# plus the budget and preferences the triage agent reasons with. No tokens.
from datetime import date, datetime, timedelta, timezone

from guardian.policy import budget as budget_policy
from guardian.policy import warranty as warranty_policy
from guardian.store import Store


def reduce(input, args, ctx):
    store = Store.default()
    prefs = store.prefs()
    items = store.items()
    decisions = store.decisions()
    within = int(input.get("within_days") or 30)
    today = date.today()
    soon = warranty_policy.ending_soon(items, within, threshold=prefs.value_threshold, today=today)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    asked = {d.item_id for d in decisions if d.kind == "warranty_checkin" and d.created_at >= cutoff}
    soon = [dict(s, ask_on=warranty_policy.ask_date(today, s["days_left"])) for s in soon if s["item_id"] not in asked]
    return {
        "items": soon,
        "count": len(soon),
        "today": today.isoformat(),
        "budget": budget_policy.state(decisions, prefs),
        "prefs": {"value_threshold": prefs.value_threshold, "quiet_categories": prefs.quiet_categories, "budget": prefs.budget,
                  "auto_request_standard": prefs.auto_request_standard, "sensitivities": prefs.sensitivities.model_dump()},
        "_stats": {"in": len(items), "out": len(soon)},
    }
