// Deterministic markdown audit report from inventory, verified issues, fix plans and dismissed issues.
// input: { repo, inventory, route, issues (verified, prioritised), fixes (survivors), dismissed (killed), unverified_fixes (killed fix plans), stats }
export default async function auditReport(input, args, ctx) {
  const L = [];
  const inv = input.inventory ?? {};
  const issues = Array.isArray(input.issues) ? input.issues : [];
  const fixes = Array.isArray(input.fixes) ? input.fixes : [];
  const dismissed = Array.isArray(input.dismissed) ? input.dismissed : [];
  const badFixes = Array.isArray(input.unverified_fixes) ? input.unverified_fixes : [];
  L.push(`# Codebase audit: ${input.repo ?? inv.root ?? "repository"}`, "");
  L.push(`> ${inv.file_count ?? "?"} files · ${inv.total_lines ?? "?"} lines · ${Array.isArray(inv.modules) ? inv.modules.length : "?"} modules · route: ${input.route ?? "?"} · ${issues.length} verified issues · ${dismissed.length} dismissed by the verifier · ${fixes.length} fix plans survived review`, "");
  if (input.stats) L.push(`> ${Object.entries(input.stats).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}`, "");
  L.push("## Verified issues (prioritised)", "");
  if (!issues.length) L.push("_No issue survived verification._", "");
  for (const it of issues) {
    L.push(`### ${it.rank ?? ""}. [${String(it.severity).toUpperCase()}] ${it.title}`, "", `**Where:** \`${it.file}${it.line ? `:${it.line}` : ""}\` · **Category:** ${it.category}`, "", String(it.description ?? "").trim(), "");
    if (it.evidence) L.push("```", String(it.evidence).trim(), "```", "");
    if (it.suggested_fix) L.push(`**Suggested fix:** ${it.suggested_fix}`, "");
  }
  L.push("## Fix plans (survived adversarial review)", "");
  if (!fixes.length) L.push("_No fix plan survived review._", "");
  for (const f of fixes) {
    L.push(`### ${f.issue_ref ?? f.title ?? "fix"}`, "", String(f.plan ?? "").trim(), "");
    if (f.patch) L.push("```diff", String(f.patch).trim(), "```", "");
    if (f.risk) L.push(`**Risk:** ${f.risk}`, "");
    if (Array.isArray(f.tests_to_add) && f.tests_to_add.length) L.push("**Tests to add:**", ...f.tests_to_add.map((t) => `- ${t}`), "");
  }
  if (badFixes.length) {
    L.push("## Fix plans rejected by review", "");
    for (const k of badFixes) L.push(`- ${k.item?.issue_ref ?? k.item?.title ?? `#${k.index}`}: ${(k.reasons ?? []).join("; ")}`);
    L.push("");
  }
  if (dismissed.length) {
    L.push("## Reported issues dismissed by the verifier", "");
    for (const k of dismissed) L.push(`- \`${k.item?.file ?? "?"}\` ${k.item?.title ?? ""}: ${(k.reasons ?? []).join("; ")}`);
    L.push("");
  }
  ctx.log(`audit report: ${issues.length} issues, ${fixes.length} fixes, ${dismissed.length} dismissed`);
  return { markdown: L.join("\n"), issues: issues.length, fixes: fixes.length, dismissed: dismissed.length, _stats: { in: issues.length + dismissed.length, out: issues.length } };
}
