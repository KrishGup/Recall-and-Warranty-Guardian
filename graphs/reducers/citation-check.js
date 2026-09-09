// Code-mode verifier: kill a section whose citations are not among the allowed (verified) sources.
// input: { item: {heading, body, citations[]}, allowed: [source strings or {url|source_url|source|id}] }
//
// URLs are canonicalised before comparison (protocol, www, trailing slash, arXiv abs/pdf variants, .pdf suffix),
// because writers legitimately cite https://arxiv.org/pdf/x for a source verified at https://arxiv.org/abs/x.
// Meta sections ("Limits of this evidence", caveats, methodology) are allowed to have no citations.
export function canonicalUrl(s) {
  let u = String(s ?? "").trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.replace(/[?#].*$/, "");
  u = u.replace(/\/+$/, "");
  u = u.replace(/^arxiv\.org\/pdf\//, "arxiv.org/abs/").replace(/\.pdf$/, "").replace(/(arxiv\.org\/abs\/\d{4}\.\d{4,5})v\d+$/, "$1");
  return u;
}

export default async function citationCheck(input) {
  const item = input.item ?? {};
  const norm = (s) => canonicalUrl(typeof s === "string" ? s : (s?.url ?? s?.source_url ?? s?.source ?? s?.id ?? ""));
  const allowed = new Set((Array.isArray(input.allowed) ? input.allowed : []).map(norm).filter(Boolean));
  const cites = Array.isArray(item.citations) ? item.citations : [];
  const meta = /limit|caveat|method|scope|about this/i.test(String(item.heading ?? ""));
  const reasons = [];
  if (!cites.length && !meta) reasons.push("section has no citations");
  for (const c of cites) {
    const k = norm(c);
    if (!allowed.has(k)) reasons.push(`citation is not a verified source: ${String(typeof c === "string" ? c : JSON.stringify(c)).slice(0, 140)}`);
  }
  if (typeof item.body === "string" && item.body.trim().length < 80) reasons.push("section body is too short to be a real section");
  return { verdict: reasons.length ? "kill" : "pass", reasons, confidence: reasons.length ? 1 : 0 };
}
