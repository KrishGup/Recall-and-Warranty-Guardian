# Deterministic markdown for the competitive landscape brief.
# input: { company, market, brief: {title, summary, competitor_takeaways[], recommended_positioning, risks[], caveats[]}, matrix (markdown), profiles[], positioning (tournament output), discovery }
import json


def reduce(input, args, ctx):
    b = input.get("brief") or {}
    L: list[str] = [f"# {b.get('title') or f'Competitive landscape: {input.get('company')} in {input.get('market')}'}", ""]
    if b.get("summary"):
        L += [str(b["summary"]), ""]
    if input.get("discovery"):
        L += [f"> discovery: {json.dumps(input['discovery'], default=str)}", ""]
    if input.get("matrix"):
        L += ["## Comparison matrix", "", str(input["matrix"]), ""]
    takeaways = b.get("competitor_takeaways") if isinstance(b.get("competitor_takeaways"), list) else []
    if takeaways:
        L += ["## Competitors", ""]
        for t in takeaways:
            L += [f"### {t.get('name')}", "", str(t.get("takeaway") or ""), ""]
            if isinstance(t.get("sources"), list) and t["sources"]:
                L += [f"- {s}" for s in t["sources"]] + [""]
    if b.get("recommended_positioning"):
        L += ["## Recommended positioning", "", str(b["recommended_positioning"]), ""]
    win = input.get("positioning") or {}
    cands = win.get("candidates") if isinstance(win.get("candidates"), list) else []
    idx = win.get("winner_index")
    if isinstance(idx, int) and 0 <= idx < len(cands):
        c = cands[idx]
        votes = ", ".join(f"{t.get('key')}:{t.get('votes')}" for t in (win.get("tally") or []))
        L += [f"**Winning headline ({votes} votes):** {c.get('headline') or c.get('text') or json.dumps(c)}", ""]
    if isinstance(b.get("risks"), list) and b["risks"]:
        L += ["## Risks", ""] + [f"- {r}" for r in b["risks"]] + [""]
    if isinstance(b.get("caveats"), list) and b["caveats"]:
        L += ["## Caveats", ""] + [f"- {r}" for r in b["caveats"]] + [""]
    profiles = input.get("profiles") if isinstance(input.get("profiles"), list) else []
    if profiles:
        L += ["## Profile sources", ""]
        for p in profiles:
            p = p or {}
            urls: list[str] = []
            for u in ((p.get("pricing") or {}).get("source_urls") or []) + ((p.get("product") or {}).get("source_urls") or []) + [n.get("url") for n in ((p.get("news") or {}).get("recent_news") or []) if isinstance(n, dict)]:
                if u and u not in urls:
                    urls.append(u)
            L.append(f"- **{p.get('name') or '?'}**: {', '.join(urls) or '(no sources recorded)'}")
        L.append("")
    ctx.log(f"landscape report: {len(takeaways)} competitors")
    return {"markdown": "\n".join(L), "competitors": len(takeaways)}
