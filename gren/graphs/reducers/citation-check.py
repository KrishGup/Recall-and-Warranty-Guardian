# Code-mode verifier: kill a section whose citations are not among the allowed (verified) sources.
# input: { item: {heading, body, citations[]}, allowed: [source strings or {url|source_url|source|id}] }
#
# URLs are canonicalised before comparison (protocol, www, trailing slash, arXiv abs/pdf variants, .pdf suffix),
# because writers legitimately cite https://arxiv.org/pdf/x for a source verified at https://arxiv.org/abs/x.
# Meta sections ("Limits of this evidence", caveats, methodology) are allowed to have no citations.
import json
import re


def canonical_url(s) -> str:
    u = str(s or "").strip().lower()
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    u = re.sub(r"[?#].*$", "", u)
    u = re.sub(r"/+$", "", u)
    u = re.sub(r"^arxiv\.org/pdf/", "arxiv.org/abs/", u)
    u = re.sub(r"\.pdf$", "", u)
    u = re.sub(r"(arxiv\.org/abs/\d{4}\.\d{4,5})v\d+$", r"\1", u)
    return u


def _norm(s) -> str:
    if isinstance(s, str):
        return canonical_url(s)
    if isinstance(s, dict):
        return canonical_url(s.get("url") or s.get("source_url") or s.get("source") or s.get("id") or "")
    return ""


def reduce(input, args, ctx):
    item = input.get("item") or {}
    allowed = {k for k in (_norm(a) for a in (input.get("allowed") if isinstance(input.get("allowed"), list) else [])) if k}
    cites = item.get("citations") if isinstance(item.get("citations"), list) else []
    meta = re.search(r"limit|caveat|method|scope|about this", str(item.get("heading") or ""), re.IGNORECASE) is not None
    reasons: list[str] = []
    if not cites and not meta:
        reasons.append("section has no citations")
    for c in cites:
        if _norm(c) not in allowed:
            reasons.append(f"citation is not a verified source: {(c if isinstance(c, str) else json.dumps(c))[:140]}")
    body = item.get("body")
    if isinstance(body, str) and len(body.strip()) < 80:
        reasons.append("section body is too short to be a real section")
    return {"verdict": "kill" if reasons else "pass", "reasons": reasons, "confidence": 1 if reasons else 0}
