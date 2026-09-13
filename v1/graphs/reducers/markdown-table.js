// Deterministic comparison matrix: rows = records, columns = fields. input: { items: [...], fields?: [...] } args: { fields?: [...] }
export default async function markdownTable(input, args) {
  const items = Array.isArray(input.items) ? input.items : [];
  const fields = Array.isArray(input.fields) ? input.fields : Array.isArray(args.fields) ? args.fields : Object.keys(items[0] ?? {});
  const cell = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [`| ${fields.join(" | ")} |`, `| ${fields.map(() => "---").join(" | ")} |`];
  for (const it of items) lines.push(`| ${fields.map((f) => cell(it?.[f])).join(" | ")} |`);
  return { markdown: lines.join("\n"), rows: items.length, columns: fields.length, _stats: { in: items.length, out: items.length } };
}
