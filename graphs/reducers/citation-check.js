// Code-mode verifier: kill a section whose citations are not among the allowed (verified) sources.
// input: { item: {heading, body, citations[]}, allowed: [source strings or {url|source|id}] }
export default async function citationCheck(input) {
  const item = input.item ?? {};
  const norm = (s) => String(typeof s === "string" ? s : (s?.url ?? s?.source_url ?? s?.source ?? s?.id ?? "")).trim().toLowerCase().replace(/\/+$/, "");
  const allowed = new Set((Array.isArray(input.allowed) ? input.allowed : []).map(norm));
  const cites = Array.isArray(item.citations) ? item.citations : [];
  const reasons = [];
  if (!cites.length) reasons.push("section has no citations");
  for (const c of cites) {
    const k = norm(c);
    if (!allowed.has(k)) reasons.push(`citation is not a verified source: ${k.slice(0, 140)}`);
  }
  if (typeof item.body === "string" && item.body.trim().length < 80) reasons.push("section body is too short to be a real section");
  return { verdict: reasons.length ? "kill" : "pass", reasons, confidence: reasons.length ? 1 : 0 };
}
