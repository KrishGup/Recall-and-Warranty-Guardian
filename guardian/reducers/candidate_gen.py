# Node candidate_gen: matching stages 1-3 for every watched item against the recalls that need checking.
# Records every candidate in the household store so the dashboard can show why. No tokens.
from guardian.matching.candidates import candidate_payload, generate
from guardian.store import Store


def reduce(input, args, ctx):
    store = Store.default()
    items = store.items()
    recalls = store.recalls()
    existing = store.matches()
    new_ids = set(input.get("new_recall_ids") or [])
    full = bool(input.get("full_scan"))
    fresh_items = any(i.sweeps == 0 for i in items if i.status == "watched")
    # An item that has never been swept must be compared against everything on file; otherwise only the new records.
    subset = recalls if (full or fresh_items) else [r for r in recalls if r.recall_id in new_ids]
    res = generate(items, subset, existing, run_id=ctx.run_id)
    for m in res["certain"] + res["candidates"] + res["dropped"]:
        store.upsert_match(m)
    watched = [i for i in items if i.status == "watched"]
    store.bump_sweeps([i.id for i in watched])
    by_item = {i.id: i for i in items}
    by_recall = {r.recall_id: r for r in subset}
    certain = [candidate_payload(m, by_item[m.item_id], by_recall[m.recall_id]) for m in res["certain"]]
    candidates = [candidate_payload(m, by_item[m.item_id], by_recall[m.recall_id]) for m in res["candidates"]]
    ctx.log(f"{len(watched)} items × {len(subset)} recalls: {len(certain)} certain, {len(candidates)} candidates, {len(res['dropped'])} dropped")
    return {
        "certain": certain,
        "certain_count": len(certain),
        "candidates": candidates,
        "candidate_count": len(candidates),
        "dropped": len(res["dropped"]),
        "dropped_examples": [{"match_id": m.id, "rationale": m.rationale} for m in res["dropped"][:5]],
        "checked_pairs": res["checked"],
        "items_watched": len(watched),
        "recalls_checked": len(subset),
        "_stats": {"in": res["checked"], "out": len(certain) + len(candidates)},
    }
