# Deterministic markdown assembly of a report from written sections, with a citation audit.
# input: { title, summary, sections: [{heading, body, citations[]}], sources: [{url|source|id, title?}], caveats[], meta{} }
import json


def _key(s):
    if isinstance(s, str):
        return s
    if isinstance(s, dict):
        return s.get("url") or s.get("source") or s.get("id") or json.dumps(s, sort_keys=True)
    return json.dumps(s, default=str)


def reduce(input, args, ctx):
    sections = input.get("sections") if isinstance(input.get("sections"), list) else []
    sources = input.get("sources") if isinstance(input.get("sources"), list) else []
    source_keys = {str(_key(s)).strip().lower() for s in sources}
    used: set[str] = set()
    lines = [f"# {input.get('title') or 'Report'}", ""]
    if input.get("summary"):
        lines += [str(input["summary"]), ""]
    meta = input.get("meta")
    if isinstance(meta, dict):
        lines += ["> " + " · ".join(f"{k}: {json.dumps(v) if isinstance(v, (dict, list)) else v}" for k, v in meta.items()), ""]
    for s in sections:
        lines += [f"## {s.get('heading')}", "", str(s.get("body") or "").strip(), ""]
        cites = s.get("citations") if isinstance(s.get("citations"), list) else []
        if cites:
            lines.append("Sources:")
            for c in cites:
                used.add(str(_key(c)).strip().lower())
                lines.append(f"- {_key(c)}")
            lines.append("")
    caveats = input.get("caveats") if isinstance(input.get("caveats"), list) else []
    if caveats:
        lines += ["## Caveats", ""] + [f"- {c}" for c in caveats] + [""]
    if sources:
        lines += ["## Sources", ""] + [f"{i + 1}. {_key(s)}{' — ' + str(s['title']) if isinstance(s, dict) and s.get('title') else ''}" for i, s in enumerate(sources)] + [""]
    unknown = [u for u in used if source_keys and u not in source_keys]
    ctx.log(f"assembled {len(sections)} sections, {len(used)} citations ({len(unknown)} unknown)")
    return {"markdown": "\n".join(lines), "sections": len(sections), "citations_used": len(used), "citations_unknown": unknown, "_stats": {"in": len(sections), "out": 1}}
