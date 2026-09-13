# Deterministic join: attach to each outline section the verified findings it references (by index), so each
# section writer sees ONLY its evidence. input: { sections: [{heading, goal, finding_ids: [i...]}], findings: [...] }


def reduce(input, args, ctx):
    sections = input.get("sections") if isinstance(input.get("sections"), list) else []
    findings = input.get("findings") if isinstance(input.get("findings"), list) else []
    out = []
    for i, s in enumerate(sections):
        ids = s.get("finding_ids") if isinstance(s.get("finding_ids"), list) else []
        own = []
        for fid in ids:
            try:
                idx = int(fid)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(findings) and findings[idx] is not None:
                own.append(findings[idx])
        urls: list[str] = []
        for f in own:
            u = f.get("source_url") if isinstance(f, dict) else None
            if u and u not in urls:
                urls.append(u)
        out.append({"index": i, "heading": s.get("heading"), "goal": s.get("goal") or "", "key_points": s.get("key_points") or [], "findings": own, "source_urls": urls})
    empty = [s["heading"] for s in out if not s["findings"]]
    if empty:
        ctx.log(f"sections without findings: {', '.join(str(e) for e in empty)}")
    return {"sections": out, "sections_without_findings": empty, "_stats": {"in": len(findings), "out": len(out)}}
