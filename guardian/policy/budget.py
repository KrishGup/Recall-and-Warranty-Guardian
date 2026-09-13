"""The notification budget (BUILD_PLAN.md section 4). At most one unsolicited interruption per week by default;
critical hazards and deadlines inside 72 hours always go through."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..models import Decision, Preferences

WINDOW = {"critical_only": None, "weekly": timedelta(days=7), "daily": timedelta(days=1)}


def interruptions_in_window(decisions: list[Decision], prefs: Preferences, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    win = WINDOW[prefs.budget]
    if win is None:
        return 0
    cutoff = (now - win).strftime("%Y-%m-%dT%H:%M:%S")
    return sum(1 for d in decisions if d.created_at >= cutoff and d.severity != "critical" and d.kind != "advisory")


def state(decisions: list[Decision], prefs: Preferences, now: datetime | None = None) -> dict[str, Any]:
    """What the triage agent is told about the budget. Standard-severity interruptions consume it; critical ones bypass it."""
    used = interruptions_in_window(decisions, prefs, now)
    allowed = {"critical_only": 0, "weekly": 1, "daily": 1}[prefs.budget]
    return {
        "policy": prefs.budget,
        "window": {"critical_only": "never for standard items", "weekly": "7 days", "daily": "1 day"}[prefs.budget],
        "standard_interruptions_used": used,
        "standard_interruptions_allowed": allowed,
        "remaining": max(0, allowed - used),
        "quiet_categories": list(prefs.quiet_categories),
        "critical_bypasses_budget": True,
        "value_threshold": prefs.value_threshold,
    }


def allows_standard(decisions: list[Decision], prefs: Preferences, category: str | None = None, now: datetime | None = None) -> bool:
    if category and category in prefs.quiet_categories:
        return False
    return state(decisions, prefs, now)["remaining"] > 0
