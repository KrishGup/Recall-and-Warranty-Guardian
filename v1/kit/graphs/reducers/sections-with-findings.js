// Deterministic join: attach to each outline section the verified findings it references (by index), so each
// section writer sees ONLY its evidence. input: { sections: [{heading, goal, finding_ids: [i...]}], findings: [...] }
export default async function sectionsWithFindings(input, args, ctx) {
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const out = sections.map((s, i) => {
    const ids = Array.isArray(s.finding_ids) ? s.finding_ids : [];
    const own = ids.map((id) => findings[Number(id)]).filter(Boolean);
    return { index: i, heading: s.heading, goal: s.goal ?? "", key_points: s.key_points ?? [], findings: own, source_urls: [...new Set(own.map((f) => f.source_url).filter(Boolean))] };
  });
  const empty = out.filter((s) => s.findings.length === 0).map((s) => s.heading);
  if (empty.length) ctx.log(`sections without findings: ${empty.join(", ")}`);
  return { sections: out, sections_without_findings: empty, _stats: { in: findings.length, out: out.length } };
}
