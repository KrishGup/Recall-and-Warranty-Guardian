// Deterministic markdown for the competitive landscape brief.
// input: { company, market, brief: {title, summary, competitor_takeaways[], recommended_positioning, risks[], caveats[]}, matrix (markdown), profiles[], positioning (tournament output), discovery }
export default async function landscapeReport(input, args, ctx) {
  const b = input.brief ?? {};
  const L = [];
  L.push(`# ${b.title ?? `Competitive landscape: ${input.company} in ${input.market}`}`, "");
  if (b.summary) L.push(String(b.summary), "");
  if (input.discovery) L.push(`> discovery: ${JSON.stringify(input.discovery)}`, "");
  if (input.matrix) L.push("## Comparison matrix", "", String(input.matrix), "");
  if (Array.isArray(b.competitor_takeaways) && b.competitor_takeaways.length) {
    L.push("## Competitors", "");
    for (const t of b.competitor_takeaways) {
      L.push(`### ${t.name}`, "", String(t.takeaway ?? ""), "");
      if (Array.isArray(t.sources) && t.sources.length) L.push(...t.sources.map((s) => `- ${s}`), "");
    }
  }
  if (b.recommended_positioning) L.push("## Recommended positioning", "", String(b.recommended_positioning), "");
  const win = input.positioning;
  if (win && Array.isArray(win.candidates) && typeof win.winner_index === "number" && win.candidates[win.winner_index]) {
    const c = win.candidates[win.winner_index];
    L.push(`**Winning headline (${(win.tally ?? []).map((t) => `${t.key}:${t.votes}`).join(", ")} votes):** ${c.headline ?? c.text ?? JSON.stringify(c)}`, "");
  }
  if (Array.isArray(b.risks) && b.risks.length) L.push("## Risks", "", ...b.risks.map((r) => `- ${r}`), "");
  if (Array.isArray(b.caveats) && b.caveats.length) L.push("## Caveats", "", ...b.caveats.map((r) => `- ${r}`), "");
  if (Array.isArray(input.profiles) && input.profiles.length) {
    L.push("## Profile sources", "");
    for (const p of input.profiles) {
      const urls = [...new Set([...(p?.pricing?.source_urls ?? []), ...(p?.product?.source_urls ?? []), ...(p?.news?.recent_news ?? []).map((n) => n.url)].filter(Boolean))];
      L.push(`- **${p?.name ?? "?"}**: ${urls.join(", ") || "(no sources recorded)"}`);
    }
    L.push("");
  }
  ctx.log(`landscape report: ${(b.competitor_takeaways ?? []).length} competitors`);
  return { markdown: L.join("\n"), competitors: (b.competitor_takeaways ?? []).length };
}
