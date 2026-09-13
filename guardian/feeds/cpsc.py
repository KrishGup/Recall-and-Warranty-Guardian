"""CPSC SaferProducts Recall API. No key, no pagination; query by RecallDate window.

Verified 2026-09-13: `Products[].Model` is empty on every recall in the last four months and UPCs live in a
top-level `ProductUPCs[]` array, so model numbers are mined from the description text and UPC equality uses ProductUPCs."""
from __future__ import annotations

import re
from datetime import date
from typing import Any

from ..models import RecallContact, RecallProduct, RecallRecord
from ..policy.severity import classify
from .http import fixtures_mode, get_json, load_fixture

BASE = "https://www.saferproducts.gov/RestWebServices/Recall"
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
_SOLD = re.compile(r"from\s+([A-Za-z]+)\s+(\d{4})\s+(?:through|to|until)\s+([A-Za-z]+)\s+(\d{4})", re.I)
_MODEL = re.compile(r"model(?:s|\s+numbers?|\s+no\.?|\s+number)?\s*[:#]?\s*((?:[A-Z0-9][A-Z0-9\-/]{2,}(?:\s*(?:,|and|or)\s*)?)+)", re.I)
_PHONE = re.compile(r"(?:\+?1[\s\-.]?)?\(?\b\d{3}\)?[\s\-.]\d{3}[\s\-.]\d{4}\b")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_URL = re.compile(r"(?:https?://|www\.)[^\s,;)]+", re.I)
_BRAND = re.compile(r"^(.*?)\s+(?:Recalls?|Expands?\s+Recall|Announces)\b", re.I)


def fetch(start: date, end: date) -> list[dict[str, Any]]:
    if fixtures_mode():
        chosen = load_fixture("cpsc_chosen.json")
        window = load_fixture("cpsc_window.json")
        seen = {r["RecallNumber"] for r in chosen}
        return chosen + [r for r in window if r["RecallNumber"] not in seen]
    data = get_json(BASE, {"format": "json", "RecallDateStart": start.isoformat(), "RecallDateEnd": end.isoformat()})
    return data if isinstance(data, list) else []


def _month(s: str) -> str | None:
    m = MONTHS.get(s.lower())
    return f"{m:02d}" if m else None


def sold_window(texts: list[str]) -> tuple[str | None, str | None]:
    for t in texts:
        m = _SOLD.search(t or "")
        if m:
            a, b = _month(m.group(1)), _month(m.group(3))
            if a and b:
                return f"{m.group(2)}-{a}", f"{m.group(4)}-{b}"
    return None, None


def model_numbers(text: str) -> list[str]:
    out: list[str] = []
    for m in _MODEL.finditer(text or ""):
        for tok in re.split(r"\s*(?:,|\band\b|\bor\b)\s*", m.group(1)):
            tok = tok.strip().strip(".")
            if 3 <= len(tok) <= 20 and re.search(r"\d", tok) and tok.upper() not in ("THE", "AND"):
                out.append(tok)
    return list(dict.fromkeys(out))[:12]


def brand_of(raw: dict[str, Any]) -> str | None:
    for key in ("Manufacturers", "Importers", "Distributors"):
        for x in raw.get(key) or []:
            name = (x.get("Name") or "").strip()
            if name and "Sold At" not in name:
                return re.sub(r",?\s+(?:of|dba)\s+.*$", "", name, flags=re.I).strip()
    m = _BRAND.match(raw.get("Title") or "")
    return m.group(1).strip() if m else None


def contact_of(text: str) -> RecallContact:
    text = text or ""
    phone, email, url = _PHONE.search(text), _EMAIL.search(text), _URL.search(text)
    return RecallContact(
        phone=phone.group(0).strip() if phone else None,
        email=email.group(0).rstrip(".,;") if email else None,
        url=url.group(0).rstrip(".,;") if url else None,
        text=text.strip() or None,
    )


def normalize(raw: dict[str, Any], allergens: list[str] | None = None) -> RecallRecord:
    number = str(raw.get("RecallNumber") or raw.get("RecallID"))
    title = (raw.get("Title") or "").strip()
    desc = (raw.get("Description") or "").strip()
    hazard = " ".join((h.get("Name") or "").strip() for h in raw.get("Hazards") or [])
    remedy = " ".join((r.get("Name") or "").strip() for r in raw.get("Remedies") or [])
    retail_texts = [(r.get("Name") or "") for r in raw.get("Retailers") or []]
    sold_from, sold_to = sold_window(retail_texts + [desc])
    upcs = [str(u.get("UPC")).strip() for u in raw.get("ProductUPCs") or [] if u.get("UPC")]
    brand = brand_of(raw)
    retailers = [re.sub(r"^Sold At:\s*", "", t.replace("\n", " ")).strip() for t in retail_texts if t]
    products = [
        RecallProduct(name=(p.get("Name") or title).strip(), brand=brand, model_numbers=[m for m in [p.get("Model")] if m] + model_numbers(desc + " " + (p.get("Description") or "")),
                      upcs=upcs, sold_from=sold_from, sold_to=sold_to, retailers=retailers, units=(p.get("NumberOfUnits") or None))
        for p in raw.get("Products") or [{}]
    ]
    severity, reasons = classify(hazard + " " + title, "cpsc", {}, allergens)
    return RecallRecord(
        recall_id=f"cpsc#{number}", source="cpsc", native_id=number, title=title, published_at=str(raw.get("RecallDate") or "")[:10], url=raw.get("URL"),
        products=products, hazard_text=hazard, remedy_text=remedy, severity=severity, severity_reasons=reasons, contact=contact_of(raw.get("ConsumerContact") or ""),
        description=desc[:2000], flags={"units": (products[0].units if products else None), "remedy_options": [o.get("Option") for o in raw.get("RemedyOptions") or []]},
    )
