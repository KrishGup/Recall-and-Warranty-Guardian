"""Candidate generation, cheapest first:
  1. exact keys: UPC equality, vehicle class (make/model/year) for NHTSA campaigns, model number found in the recall text
  2. lexical: brand overlap plus rapidfuzz token_set_ratio >= 80 on the product text
  3. date window: purchase date more than 60 days outside the stated sold window drops the candidate
Only survivors of stage 2 that stage 3 keeps reach the model. Everything is recorded so the dashboard can show why."""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from rapidfuzz import fuzz, utils

from ..models import InventoryItem, MatchCandidate, RecallRecord

LEXICAL_THRESHOLD = 80
LEXICAL_STRONG = 92
DATE_SLACK_DAYS = 60
STOP = {"the", "and", "of", "for", "with", "a", "an", "in", "on", "to", "by", "inc", "llc", "co", "ltd", "corp", "corporation", "company", "usa"}
SOURCE_FOR_CATEGORY = {"Vehicle": {"nhtsa"}, "Food": {"fda_food"}}


def norm_upc(s: str | None) -> str:
    d = re.sub(r"\D", "", s or "")
    return d.lstrip("0") if d else ""


def tokens(s: str | None) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower()) if t not in STOP and len(t) > 1}


def _model_tokens(s: str | None) -> set[str]:
    return {t for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9\-/]{2,}", s or "") if re.search(r"\d", t)}


def recall_text(r: RecallRecord) -> str:
    parts = [r.title] + [p.name for p in r.products] + [r.description[:600]]
    return " ".join(x for x in parts if x)


def item_text(it: InventoryItem) -> str:
    return " ".join(x for x in (it.brand, it.name, it.model_number or "") if x)


def _month_date(ym: str | None, end: bool = False) -> date | None:
    if not ym:
        return None
    try:
        y, m = int(ym[:4]), int(ym[5:7])
    except ValueError:
        return None
    if not end:
        return date(y, m, 1)
    nm = date(y + (m // 12), m % 12 + 1, 1)
    return nm - timedelta(days=1)


def date_window_check(it: InventoryItem, r: RecallRecord) -> tuple[bool, str]:
    """(keep, reason). Keeps when there is no sold window or the purchase falls inside it (with slack)."""
    sold_from, sold_to = r.sold_window()
    try:
        bought = date.fromisoformat(it.purchase_date[:10])
    except ValueError:
        return True, "purchase date unknown; window not applied"
    lo, hi = _month_date(sold_from), _month_date(sold_to, end=True)
    if lo and bought < lo - timedelta(days=DATE_SLACK_DAYS):
        return False, f"purchased {bought.isoformat()}, more than {DATE_SLACK_DAYS} days before the sold window starts ({sold_from})"
    if hi and bought > hi + timedelta(days=DATE_SLACK_DAYS):
        return False, f"purchased {bought.isoformat()}, more than {DATE_SLACK_DAYS} days after the sold window ends ({sold_to})"
    if lo or hi:
        return True, f"purchase date inside the sold window {sold_from or '?'} to {sold_to or '?'}"
    return True, "recall states no sold window"


def _source_ok(it: InventoryItem, r: RecallRecord) -> bool:
    allowed = SOURCE_FOR_CATEGORY.get(it.category)
    if allowed is not None:
        return r.source in allowed
    return r.source not in ("nhtsa", "fda_food")


def stage1(it: InventoryItem, r: RecallRecord) -> tuple[str, str] | None:
    """Exact keys. Returns (key, rationale) or None."""
    if it.upc and r.all_upcs():
        u = norm_upc(it.upc)
        for ru in r.all_upcs():
            if u and norm_upc(ru) == u:
                return "upc", f"UPC {it.upc} on the receipt equals UPC {ru} listed in the recall"
    if it.vehicle and r.vehicle_key:
        from ..feeds.nhtsa import vehicle_key

        if vehicle_key(it.vehicle.make, it.vehicle.model, it.vehicle.year) == r.vehicle_key:
            return "vehicle", f"NHTSA campaign {r.native_id} is filed against {it.vehicle.year} {it.vehicle.make} {it.vehicle.model}; a VIN lookup at nhtsa.gov confirms whether this vehicle is included"
    if it.model_number:
        mt = it.model_number.strip().lower()
        if len(mt) >= 4:
            for rm in r.all_models():
                if rm.strip().lower() == mt:
                    return "model", f"model number {it.model_number} appears in the recall's model list"
            if re.search(rf"(?<![a-z0-9]){re.escape(mt)}(?![a-z0-9])", recall_text(r).lower()):
                return "model", f"model number {it.model_number} appears in the recall text"
    return None


def stage2(it: InventoryItem, r: RecallRecord) -> tuple[float, str] | None:
    """Lexical similarity. Returns (score, rationale) or None."""
    brand_tokens = tokens(it.brand)
    rt = recall_text(r)
    rtokens = tokens(rt) | tokens(" ".join(p.brand or "" for p in r.products))
    brand_hit = bool(brand_tokens and brand_tokens & rtokens)
    score = fuzz.token_set_ratio(item_text(it), " ".join(x for x in [r.title] + [p.name for p in r.products] if x), processor=utils.default_process)
    if brand_hit and score >= LEXICAL_THRESHOLD:
        return float(score), f"brand '{it.brand}' appears in the recall and the product text scores {score:.0f}/100"
    if score >= LEXICAL_STRONG:
        return float(score), f"product text scores {score:.0f}/100 (no brand overlap)"
    mt = _model_tokens(it.model_number) | _model_tokens(it.name)
    if mt and mt & _model_tokens(rt):
        return 85.0, f"shared model-like token {sorted(mt & _model_tokens(rt))[0]}"
    return None


def generate(items: list[InventoryItem], recalls: list[RecallRecord], existing: list[MatchCandidate], run_id: str | None = None) -> dict[str, Any]:
    """Run stages 1-3 for every (item, recall) pair not already decided. Returns match records grouped by outcome."""
    done = {m.id for m in existing if m.verdict in ("certain", "yes", "no", "dropped") or m.state != "open"}
    certain: list[MatchCandidate] = []
    candidates: list[MatchCandidate] = []
    dropped: list[MatchCandidate] = []
    checked = 0
    for it in items:
        if it.status != "watched":
            continue
        for r in recalls:
            if not _source_ok(it, r):
                continue
            mid = f"{it.id}~{r.recall_id}"
            if mid in done:
                continue
            checked += 1
            s1 = stage1(it, r)
            if s1:
                key, why = s1
                keep, reason = date_window_check(it, r)
                if not keep and key != "vehicle":
                    dropped.append(MatchCandidate(id=mid, item_id=it.id, recall_id=r.recall_id, stage=3, key=key, score=100, verdict="dropped", rationale=f"{why}; but {reason}", severity=r.severity, run_id=run_id))
                    continue
                certain.append(MatchCandidate(id=mid, item_id=it.id, recall_id=r.recall_id, stage=1, key=key, score=100, verdict="certain", confidence=1.0, rationale=f"{why}. {reason.capitalize()}.", severity=r.severity, run_id=run_id))
                continue
            s2 = stage2(it, r)
            if not s2:
                continue
            score, why = s2
            keep, reason = date_window_check(it, r)
            if not keep:
                dropped.append(MatchCandidate(id=mid, item_id=it.id, recall_id=r.recall_id, stage=3, key=f"lexical:{score:.0f}", score=score, verdict="dropped", rationale=f"{why}; dropped by the date window: {reason}", severity=r.severity, run_id=run_id))
                continue
            candidates.append(MatchCandidate(id=mid, item_id=it.id, recall_id=r.recall_id, stage=2, key=f"lexical:{score:.0f}", score=score, verdict="pending", rationale=f"{why}; {reason}. Needs adjudication.", severity=r.severity, run_id=run_id))
    return {"certain": certain, "candidates": candidates, "dropped": dropped, "checked": checked}


def candidate_payload(m: MatchCandidate, it: InventoryItem, r: RecallRecord) -> dict[str, Any]:
    """What the matcher agent sees for one ambiguous pair: the item, the recall and the deterministic evidence."""
    sold_from, sold_to = r.sold_window()
    return {
        "match_id": m.id,
        "stage": m.stage,
        "key": m.key,
        "score": m.score,
        "deterministic_rationale": m.rationale,
        "item": {"id": it.id, "name": it.name, "brand": it.brand, "model_number": it.model_number, "upc": it.upc, "category": it.category, "purchase_date": it.purchase_date, "retailer": it.retailer, "price": it.price,
                 "receipt_excerpt": (it.receipt_text or "")[:400] or None},
        "recall": {"recall_id": r.recall_id, "source": r.source, "title": r.title, "published_at": r.published_at, "products": [p.model_dump() for p in r.products][:4], "hazard_text": r.hazard_text[:600],
                   "sold_window": {"from": sold_from, "to": sold_to}, "description": r.description[:900], "severity_keyword_pass": r.severity, "severity_reasons": r.severity_reasons},
    }
