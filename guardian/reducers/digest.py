# Node digest: standard-hazard matches never interrupt anyone. Append them to the weekly digest, close the match
# (it stays visible on the item), and log one activity row per line. No tokens.
from guardian.models import Activity
from guardian.store import Store


def reduce(input, args, ctx):
    store = Store.default()
    plan = input.get("plan") or {}
    lines = plan.get("digest") or []
    appended = 0
    for ln in lines:
        item = store.item(str(ln.get("item_id") or "")) if ln.get("item_id") else None
        m = store.match(str(ln.get("match_id") or "")) if ln.get("match_id") else None
        if m is not None:
            m.state = "closed"
            store.upsert_match(m)
        store.log(Activity(source="Triage", text=str(ln.get("line") or "Added to the weekly digest"), result="digest · no interruption", tone="muted", run_id=ctx.run_id, item_id=item.id if item else None))
        appended += 1
    store.outbox_write("digest", {"run_id": ctx.run_id, "lines": lines, "queued_questions": plan.get("queued") or []})
    return {"appended": appended, "queued": len(plan.get("queued") or []), "_stats": {"in": len(lines), "out": appended}}
