// Deterministic prioritisation of audit issues: severity weight, then category weight; keep the top k.
// input: { items: [{severity, category, ...}] }  args: { k: 12, weights?: {blocker: 100, major: 30, minor: 8, nit: 1} }
export default async function prioritize(input, args) {
  const items = Array.isArray(input.items) ? input.items : [];
  const w = { blocker: 100, major: 30, minor: 8, nit: 1, ...(args.weights ?? {}) };
  const cat = { security: 5, correctness: 4, reliability: 3, performance: 2, maintainability: 1, tests: 1, docs: 0 };
  const scored = items.map((it) => ({ ...it, priority: (w[String(it.severity).toLowerCase()] ?? 1) + (cat[String(it.category).toLowerCase()] ?? 0) }));
  scored.sort((a, b) => b.priority - a.priority);
  const k = Number(args.k ?? 12);
  const kept = scored.slice(0, k).map((it, i) => ({ rank: i + 1, ...it }));
  return { items: kept, dropped: Math.max(0, scored.length - k), by_severity: countBy(scored, "severity"), _stats: { in: items.length, out: kept.length } };
}

function countBy(list, key) {
  const out = {};
  for (const it of list) out[String(it[key] ?? "unknown")] = (out[String(it[key] ?? "unknown")] ?? 0) + 1;
  return out;
}
