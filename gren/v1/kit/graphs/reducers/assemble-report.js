// Deterministic markdown assembly of a report from written sections, with a citation audit.
// input: { title, summary, sections: [{heading, body, citations[]}], sources: [{url|source|id, title?}], caveats[], meta{} }
export default async function assemble(input, args, ctx) {
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const key = (s) => (typeof s === "string" ? s : (s?.url ?? s?.source ?? s?.id ?? JSON.stringify(s)));
  const sourceKeys = new Set(sources.map((s) => String(key(s)).trim().toLowerCase()));
  const used = new Set();
  const lines = [];
  lines.push(`# ${input.title ?? "Report"}`, "");
  if (input.summary) lines.push(String(input.summary), "");
  if (input.meta && typeof input.meta === "object") {
    lines.push(`> ${Object.entries(input.meta).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}`, "");
  }
  for (const s of sections) {
    lines.push(`## ${s.heading}`, "", String(s.body ?? "").trim(), "");
    if (Array.isArray(s.citations) && s.citations.length) {
      lines.push("Sources:", ...s.citations.map((c) => {
        used.add(String(key(c)).trim().toLowerCase());
        return `- ${key(c)}`;
      }), "");
    }
  }
  if (Array.isArray(input.caveats) && input.caveats.length) lines.push("## Caveats", "", ...input.caveats.map((c) => `- ${c}`), "");
  if (sources.length) lines.push("## Sources", "", ...sources.map((s, i) => `${i + 1}. ${key(s)}${s?.title ? ` — ${s.title}` : ""}`), "");
  const unknown = [...used].filter((u) => sourceKeys.size && !sourceKeys.has(u));
  ctx.log(`assembled ${sections.length} sections, ${used.size} citations (${unknown.length} unknown)`);
  return {
    markdown: lines.join("\n"),
    sections: sections.length,
    citations_used: used.size,
    citations_unknown: unknown,
    _stats: { in: sections.length, out: 1 },
  };
}
