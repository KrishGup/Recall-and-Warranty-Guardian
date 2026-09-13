"""Severity mapping (BUILD_PLAN.md section 5, "Severity mapping"). Keyword pass first; the triage agent confirms
with structured output and the severity_check verifier can kill a plan that contradicts this pass."""
from __future__ import annotations

import re
from typing import Any

CRITICAL_TERMS: tuple[tuple[str, str], ...] = (
    (r"\bdeath\b|\bfatal|\bdie\b|\bdied\b|\bdeadly", "death"),
    (r"serious injur", "serious injury"),
    (r"\bfire\b|ignite|flame|burn hazard|\bburns?\b|scald", "fire or burn"),
    (r"chok", "choking"),
    (r"strangul", "strangulation"),
    (r"amputat", "amputation"),
    (r"lacerat", "laceration"),
    (r"\blead\b", "lead"),
    (r"electrocut|electric shock|\bshock hazard", "electrocution"),
    (r"ingest|swallow|button cell|coin batter|water bead", "ingestion"),
    (r"suffocat|asphyx|entrap", "suffocation or entrapment"),
    (r"carbon monoxide|\bCO\b poisoning", "carbon monoxide"),
    (r"fall hazard.*(infant|child|crib|bassinet|stroller|high chair)|(infant|child|crib|bassinet|stroller|high chair).*fall hazard", "fall hazard for an infant product"),
    (r"salmonella|listeria|e\. ?coli|botulism|clostridium", "pathogen contamination"),
)


def classify(hazard_text: str, source: str = "cpsc", flags: dict[str, Any] | None = None, allergens: list[str] | None = None) -> tuple[str, list[str]]:
    """Return (severity, reasons). Critical when the hazard text names a critical outcome, FDA class is I,
    or NHTSA flags park-outside / do-not-drive. Undeclared allergens are critical only when the household lists them."""
    flags = flags or {}
    text = hazard_text or ""
    reasons: list[str] = []
    for pattern, label in CRITICAL_TERMS:
        if re.search(pattern, text, re.I):
            reasons.append(f'hazard text mentions {label}')
    if source.startswith("fda") and str(flags.get("classification", "")).strip().lower() in ("class i", "i"):
        reasons.append("FDA Class I")
    if source == "nhtsa" and (flags.get("parkIt") or flags.get("parkOutSide")):
        reasons.append("NHTSA park-outside or do-not-drive")
    if re.search(r"undeclared\s+(\w+)", text, re.I):
        found = [m.lower() for m in re.findall(r"undeclared\s+([a-z ,#0-9and/]+)", text, re.I)]
        if allergens and any(a.lower() in " ".join(found) for a in allergens):
            reasons.append("undeclared allergen the household lists")
        elif not any("pathogen" in r for r in reasons) and not any(r == "FDA Class I" for r in reasons):
            # undeclared allergen alone is standard unless the household is sensitive
            pass
    return ("critical" if reasons else "standard", reasons)


def is_critical(hazard_text: str, source: str = "cpsc", flags: dict[str, Any] | None = None, allergens: list[str] | None = None) -> bool:
    return classify(hazard_text, source, flags, allergens)[0] == "critical"
