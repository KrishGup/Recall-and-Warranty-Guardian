"""Warranty terms and windows (BUILD_PLAN.md section 10). Term from the receipt when known, else a category default
with the source flagged so the UI can say "estimate"."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from ..models import InventoryItem, Warranty

# Months. Conservative manufacturer-warranty defaults; the receipt or the Best Buy API override these.
CATEGORY_DEFAULT_MONTHS: dict[str, int | None] = {
    "Juvenile": 12, "Kitchen": 12, "Appliance": 12, "Vehicle": 36, "Tools": 36, "Food": None, "Electronics": 12, "Toys": None, "Home": 12, "Other": 12,
}


def _add_months(d: date, months: int) -> date:
    y, m = d.year + (d.month - 1 + months) // 12, (d.month - 1 + months) % 12 + 1
    day = min(d.day, [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1])
    return date(y, m, day)


def resolve(item: InventoryItem) -> Warranty:
    """Fill ends_on/source from the item's term or the category default."""
    w = item.warranty
    try:
        bought = date.fromisoformat(item.purchase_date[:10])
    except ValueError:
        return Warranty(term_months=w.term_months, ends_on=None, source=w.source if w.term_months else "none", extended=w.extended)
    if w.term_months:
        return Warranty(term_months=w.term_months, ends_on=_add_months(bought, w.term_months).isoformat(), source=w.source if w.source != "none" else "receipt", extended=w.extended)
    default = CATEGORY_DEFAULT_MONTHS.get(item.category)
    if not default:
        return Warranty(term_months=None, ends_on=None, source="none", extended=False)
    return Warranty(term_months=default, ends_on=_add_months(bought, default).isoformat(), source="category_default", extended=False)


def view(item: InventoryItem, today: date | None = None) -> dict[str, Any]:
    """The warranty as the dashboard shows it: elapsed share, label and note."""
    today = today or date.today()
    w = resolve(item)
    if not w.term_months or not w.ends_on:
        note = "Consumables have no warranty; watched for FDA enforcement by lot code." if item.category == "Food" else "No warranty term on file."
        return {"term_months": None, "ends_on": None, "source": "none", "extended": False, "elapsed_pct": None, "label": "n/a", "note": note}
    bought = date.fromisoformat(item.purchase_date[:10])
    ends = date.fromisoformat(w.ends_on)
    total = max(1, (ends - bought).days)
    pct = int(round(100 * min(1.0, max(0.0, (today - bought).days / total))))
    ended = today > ends
    src = {"receipt": "receipt", "category_default": "estimate", "manufacturer": "manufacturer", "none": ""}[w.source]
    full_date = ends.strftime("%b %d, %Y")
    label = f"{w.term_months} mo · " + (f"ended {full_date}" if ended else f"ends {full_date}") + (f" · {src}" if src and src != "receipt" else "")
    if w.source == "category_default":
        note = "Category default: receipt had no warranty line. Shown as an estimate."
    elif w.source == "manufacturer":
        note = "Term from the manufacturer's published warranty."
    else:
        note = "Term read from receipt."
    if ended:
        note += f" Expired {full_date}."
    return {"term_months": w.term_months, "ends_on": w.ends_on, "source": w.source, "extended": w.extended, "elapsed_pct": pct, "label": label, "note": note}


def ending_soon(items: list[InventoryItem], within_days: int = 60, threshold: float | None = None, today: date | None = None) -> list[dict[str, Any]]:
    """Items whose warranty ends within `within_days` (and has not ended), optionally above a price threshold."""
    today = today or date.today()
    out = []
    for it in items:
        v = view(it, today)
        if not v["ends_on"]:
            continue
        ends = date.fromisoformat(v["ends_on"])
        days_left = (ends - today).days
        if days_left < 0 or days_left > within_days:
            continue
        if threshold is not None and (it.price or 0) < threshold:
            continue
        out.append({"item_id": it.id, "name": f"{it.brand} {it.name}".strip(), "ends_on": v["ends_on"], "pct": v["elapsed_pct"], "days_left": days_left, "price": it.price,
                    "source": v["source"], "note": v["note"], "category": it.category})
    out.sort(key=lambda x: x["days_left"])
    return out


def ask_date(today: date, days_left: int) -> str:
    """When to ask "anything wrong with it?": about two weeks before expiry, never in the past."""
    return max(today, today + timedelta(days=max(0, days_left - 14))).isoformat()
