# Deterministic prioritisation of audit issues: severity weight, then category weight; keep the top k.
# input: { items: [{severity, category, ...}] }  args: { k: 12, weights?: {blocker: 100, major: 30, minor: 8, nit: 1} }
from collections import Counter

CATEGORY = {"security": 5, "correctness": 4, "reliability": 3, "performance": 2, "maintainability": 1, "tests": 1, "docs": 0}


def reduce(input, args, ctx):
    items = input.get("items") if isinstance(input.get("items"), list) else []
    w = {"blocker": 100, "major": 30, "minor": 8, "nit": 1, **(args.get("weights") or {})}
    scored = [{**it, "priority": w.get(str(it.get("severity")).lower(), 1) + CATEGORY.get(str(it.get("category")).lower(), 0)} for it in items if isinstance(it, dict)]
    scored.sort(key=lambda it: -it["priority"])
    k = int(args.get("k", 12))
    kept = [{"rank": i + 1, **it} for i, it in enumerate(scored[:k])]
    by_sev = Counter(str(it.get("severity") or "unknown") for it in scored)
    return {"items": kept, "dropped": max(0, len(scored) - k), "by_severity": dict(by_sev), "_stats": {"in": len(items), "out": len(kept)}}
