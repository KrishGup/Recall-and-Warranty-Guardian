# Deterministic flattening of competitor profiles into table rows (objects -> readable cells).
# input: { items: [profile] }  profile = { name, url, pricing{...}, product{...}, news{recent_news[]}, lanes{...} }


def _lane(p, lane, value):
    lanes = p.get("lanes") or {}
    if value is not None:
        return value
    return "unknown" if lanes.get(lane) == "completed" else f"({lanes.get(lane) or 'missing'})"


def reduce(input, args, ctx):
    items = input.get("items") if isinstance(input.get("items"), list) else []
    rows = []
    for p in items:
        p = p or {}
        pricing, product, news, lanes = p.get("pricing") or {}, p.get("product") or {}, p.get("news") or {}, p.get("lanes") or {}
        rows.append({
            "name": p.get("name") or "?", "url": p.get("url") or "",
            "pricing_model": _lane(p, "pricing", pricing.get("pricing_model")),
            "price_points": "; ".join(str(x) for x in pricing["price_points"][:4]) if isinstance(pricing.get("price_points"), list) else "",
            "free_tier": pricing.get("free_tier") if pricing.get("free_tier") is not None else "unknown",
            "target_segment": _lane(p, "product", product.get("target_segment")),
            "differentiator": product.get("claimed_differentiator") or "",
            "key_features": "; ".join(str(x) for x in product["key_features"][:5]) if isinstance(product.get("key_features"), list) else "",
            "recent_news": " · ".join(f"{n.get('date')}: {n.get('headline')}" for n in news["recent_news"][:3] if isinstance(n, dict)) if isinstance(news.get("recent_news"), list) else "",
            "lanes_ok": f"{sum(1 for v in lanes.values() if v == 'completed')}/{len(lanes)}" if lanes else "",
        })
    return {"items": rows, "fields": ["name", "pricing_model", "free_tier", "price_points", "target_segment", "differentiator", "recent_news", "lanes_ok"], "_stats": {"in": len(items), "out": len(rows)}}
