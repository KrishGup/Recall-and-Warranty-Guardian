// Deterministic flattening of competitor profiles into table rows (objects -> readable cells).
// input: { items: [profile] }  profile = { name, url, pricing{...}, product{...}, news{recent_news[]}, lanes{...} }
export default async function flattenProfiles(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  const rows = items.map((p) => ({
    name: p?.name ?? "?",
    url: p?.url ?? "",
    pricing_model: p?.pricing?.pricing_model ?? (p?.lanes?.pricing === "completed" ? "unknown" : `(${p?.lanes?.pricing ?? "missing"})`),
    price_points: Array.isArray(p?.pricing?.price_points) ? p.pricing.price_points.slice(0, 4).join("; ") : "",
    free_tier: p?.pricing?.free_tier ?? "unknown",
    target_segment: p?.product?.target_segment ?? (p?.lanes?.product === "completed" ? "unknown" : `(${p?.lanes?.product ?? "missing"})`),
    differentiator: p?.product?.claimed_differentiator ?? "",
    key_features: Array.isArray(p?.product?.key_features) ? p.product.key_features.slice(0, 5).join("; ") : "",
    recent_news: Array.isArray(p?.news?.recent_news) ? p.news.recent_news.map((n) => `${n.date}: ${n.headline}`).slice(0, 3).join(" · ") : "",
    lanes_ok: p?.lanes ? Object.entries(p.lanes).filter(([, v]) => v === "completed").length + "/" + Object.keys(p.lanes).length : "",
  }));
  return { items: rows, fields: ["name", "pricing_model", "free_tier", "price_points", "target_segment", "differentiator", "recent_news", "lanes_ok"], _stats: { in: items.length, out: rows.length } };
}
