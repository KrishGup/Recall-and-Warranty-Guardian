"""Feed refresh: pull new records by date window from every source, normalize, upsert. Deterministic; no tokens."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from ..models import RecallRecord, now_iso
from ..store import Store
from . import cpsc, fda, nhtsa
from .http import fixtures_mode


def refresh(store: Store, window_days: int = 45, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    start = today - timedelta(days=window_days)
    prefs = store.prefs()
    allergens = prefs.sensitivities.allergens
    items = store.items()
    records: list[RecallRecord] = []
    counts: dict[str, int] = {"cpsc": 0, "nhtsa": 0, "fda": 0}
    errors: list[str] = []

    try:
        raw = cpsc.fetch(start, today)
        recs = [cpsc.normalize(r, allergens) for r in raw]
        counts["cpsc"] = len(recs)
        records += recs
    except Exception as e:  # noqa: BLE001
        errors.append(f"cpsc: {e}")

    vehicles = [it.vehicle for it in items if it.vehicle]
    seen_keys: set[str] = set()
    for v in vehicles:
        k = nhtsa.vehicle_key(v.make, v.model, v.year)
        if k in seen_keys:
            continue
        seen_keys.add(k)
        try:
            recs = [nhtsa.normalize(r, v) for r in nhtsa.fetch_campaigns(v.make, v.model, v.year)]
            counts["nhtsa"] += len(recs)
            records += recs
        except Exception as e:  # noqa: BLE001
            errors.append(f"nhtsa {k}: {e}")

    try:
        raw = fda.fetch(start, today, "food")
        recs = [fda.normalize(r, "food", allergens) for r in raw]
        counts["fda"] = len(recs)
        records += recs
    except Exception as e:  # noqa: BLE001
        errors.append(f"fda: {e}")

    new_ids = store.upsert_recalls(records)
    st = store.feeds_state()
    st["last_refresh"] = {"at": now_iso(), "window": {"from": start.isoformat(), "to": today.isoformat()}, "counts": counts, "new": len(new_ids), "errors": errors, "mode": "fixtures" if fixtures_mode() else "live"}
    store.save_feeds_state(st)
    return {"cpsc": counts["cpsc"], "nhtsa": counts["nhtsa"], "fda": counts["fda"], "fetched": len(records), "upserted": len(new_ids), "new_recall_ids": new_ids,
            "window": {"from": start.isoformat(), "to": today.isoformat()}, "vehicles": len(seen_keys), "errors": errors, "mode": st["last_refresh"]["mode"],
            "_stats": {"in": len(records), "out": len(new_ids)}}
