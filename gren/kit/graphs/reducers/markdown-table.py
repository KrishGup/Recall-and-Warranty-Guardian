# Deterministic comparison matrix: rows = records, columns = fields. input: { items: [...], fields?: [...] } args: { fields?: [...] }
import json
import re


def _cell(v) -> str:
    if v is None:
        s = ""
    elif isinstance(v, (dict, list)):
        s = json.dumps(v, ensure_ascii=False, default=str)
    else:
        s = str(v)
    return re.sub(r"\r?\n", " ", s.replace("|", "\\|"))


def reduce(input, args, ctx):
    items = input.get("items") if isinstance(input.get("items"), list) else []
    fields = input.get("fields") if isinstance(input.get("fields"), list) else args.get("fields") if isinstance(args.get("fields"), list) else list((items[0] if items and isinstance(items[0], dict) else {}).keys())
    lines = ["| " + " | ".join(str(f) for f in fields) + " |", "| " + " | ".join("---" for _ in fields) + " |"]
    for it in items:
        lines.append("| " + " | ".join(_cell(it.get(f) if isinstance(it, dict) else None) for f in fields) + " |")
    return {"markdown": "\n".join(lines), "rows": len(items), "columns": len(fields), "_stats": {"in": len(items), "out": len(items)}}
