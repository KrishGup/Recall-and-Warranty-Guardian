# Node save_item: turn the intake agent's extraction into InventoryItem rows, decode VINs, resolve warranty terms.
import re

from guardian.models import CATEGORIES, Activity, InventoryItem, Warranty
from guardian.policy import warranty as warranty_policy
from guardian.store import Store


def _price(v):
    try:
        return round(float(str(v).replace("$", "").replace(",", "")), 2) if v not in (None, "") else None
    except ValueError:
        return None


def reduce(input, args, ctx):
    store = Store.default()
    ex = input.get("extraction") or {}
    source = str(input.get("source") or "paste")
    raw = str(input.get("raw_text") or "")
    retailer = (ex.get("retailer") or None)
    purchase_date = str(ex.get("purchase_date") or "")[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", purchase_date):
        from datetime import date

        purchase_date = date.today().isoformat()
    created = []
    for row in ex.get("items") or []:
        if not isinstance(row, dict) or not row.get("name"):
            continue
        cat = row.get("category") if row.get("category") in CATEGORIES else "Other"
        months = row.get("warranty_months")
        warranty = Warranty(term_months=int(months), source="receipt") if isinstance(months, (int, float)) and months else Warranty()
        vehicle = None
        vin = (row.get("vin") or "").strip().upper() or None
        if vin:
            try:
                from guardian.feeds.nhtsa import decode_vin

                vehicle = decode_vin(vin)
                cat = "Vehicle"
            except Exception as e:  # noqa: BLE001
                ctx.log(f"VIN {vin} not decoded: {e}")
        item = InventoryItem(
            name=str(row.get("name")).strip(), brand=str(row.get("brand") or "").strip(), model_number=(str(row.get("model_number")).strip() or None) if row.get("model_number") else None,
            upc=(re.sub(r"\D", "", str(row.get("upc"))) or None) if row.get("upc") else None, serial=(str(row.get("serial")).strip() or None) if row.get("serial") else None,
            category=cat, purchase_date=purchase_date, price=_price(row.get("price")), retailer=retailer, receipt_text=raw[:4000] or None, warranty=warranty, vehicle=vehicle,
            source="intake" if source in ("paste", "email") else "manual", notes=(str(row.get("notes")).strip() or None) if row.get("notes") else None,
        )
        item.warranty = warranty_policy.resolve(item)
        store.upsert_item(item)
        wv = warranty_policy.view(item)
        store.log(Activity(source="Intake", text=f"Receipt from {retailer or 'unknown retailer'} parsed: {item.brand} {item.name}".strip() + (f", ${item.price:,.2f}" if item.price else ""),
                           result=f"warranty {wv['label']}", tone="ok", run_id=ctx.run_id, item_id=item.id))
        created.append({"id": item.id, "name": item.name, "brand": item.brand, "category": item.category, "price": item.price, "warranty": wv["label"]})
    ctx.log(f"{len(created)} item(s) saved")
    return {"item_ids": [c["id"] for c in created], "items": created, "retailer": retailer, "purchase_date": purchase_date, "fields_confident": int(ex.get("fields_confident") or 0),
            "fields_total": int(ex.get("fields_total") or 0), "unsure": ex.get("unsure") or [], "_stats": {"in": len(ex.get("items") or []), "out": len(created)}}
