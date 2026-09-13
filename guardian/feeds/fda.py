"""openFDA enforcement reports (food, drug, device). Free; 1,000 requests/day without a key, 120,000 with one
(`OPENFDA_API_KEY`). Data is published weekly, so the window is generous."""
from __future__ import annotations

import os
import re
from datetime import date
from typing import Any

from ..models import RecallContact, RecallProduct, RecallRecord
from ..policy.severity import classify
from .http import fixtures_mode, get_json, load_fixture

BASE = "https://api.fda.gov/{kind}/enforcement.json"
_UPC = re.compile(r"UPC\s*(?:code|codes|#|:|number)?\s*[:#]?\s*(\d(?:[\d-]{9,13})\d)(?!\d)", re.I)
_LOT = re.compile(r"(?:lot|lot code|lot #|lot number|lots?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/ ,]{2,40})", re.I)


def fetch(start: date, end: date, kind: str = "food", limit: int = 100, max_pages: int = 5) -> list[dict[str, Any]]:
    if fixtures_mode():
        return list(load_fixture("fda_food_window.json").get("results") or []) if kind == "food" else []
    out: list[dict[str, Any]] = []
    params: dict[str, Any] = {"search": f"report_date:[{start.strftime('%Y%m%d')}+TO+{end.strftime('%Y%m%d')}]", "limit": limit}
    key = os.environ.get("OPENFDA_API_KEY")
    if key:
        params["api_key"] = key
    for page in range(max_pages):
        params["skip"] = page * limit
        # httpx would percent-encode the brackets and plus signs the API expects verbatim, so build the query by hand
        q = "&".join(f"{k}={v}" for k, v in params.items())
        try:
            data = get_json(BASE.format(kind=kind) + "?" + q)
        except RuntimeError as e:
            if "404" in str(e) and page > 0:
                break
            if "404" in str(e):
                return out
            raise
        results = data.get("results") or []
        out.extend(results)
        total = int((data.get("meta") or {}).get("results", {}).get("total") or 0)
        if len(out) >= total or not results:
            break
    return out


def _d(s: str | None) -> str:
    s = (s or "").strip()
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 else s


def normalize(raw: dict[str, Any], kind: str = "food", allergens: list[str] | None = None) -> RecallRecord:
    src = {"food": "fda_food", "drug": "fda_drug", "device": "fda_device"}[kind]
    number = str(raw.get("recall_number") or raw.get("event_id"))
    desc = (raw.get("product_description") or "").strip()
    reason = (raw.get("reason_for_recall") or "").strip()
    code = (raw.get("code_info") or "").strip()
    upcs = list(dict.fromkeys(re.sub(r"-", "", m) for m in _UPC.findall(desc) + _UPC.findall(code)))
    lots = [m.strip(" ,") for m in _LOT.findall(code)][:8]
    firm = (raw.get("recalling_firm") or "").strip()
    flags = {"classification": raw.get("classification"), "status": raw.get("status"), "distribution": (raw.get("distribution_pattern") or "")[:300], "voluntary": raw.get("voluntary_mandated")}
    severity, reasons = classify(reason, src, flags, allergens)
    title = desc.split("\n")[0][:140] or f"{firm} recall {number}"
    return RecallRecord(
        recall_id=f"{src}#{number}", source=src, native_id=number, title=title, published_at=_d(raw.get("report_date")) or _d(raw.get("recall_initiation_date")),
        url=f"https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event={raw.get('event_id')}" if raw.get("event_id") else None,
        products=[RecallProduct(name=desc[:300] or title, brand=firm or None, upcs=upcs, lot_codes=lots, retailers=[])],
        hazard_text=reason, remedy_text="Do not consume. Return to the place of purchase for a refund, or discard." if kind == "food" else "Stop using and contact the recalling firm.",
        severity=severity, severity_reasons=reasons, contact=RecallContact(text=firm or None), description=(desc + "\n" + code)[:2000], flags=flags,
    )
