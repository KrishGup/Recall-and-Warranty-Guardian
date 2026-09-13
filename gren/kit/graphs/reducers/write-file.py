# Side-effect reducer: write text (or JSON) to a file. Deterministic file name per run.
# args: { dir: "out", name: "report", ext: "md", field?: "markdown" }   input: { markdown | text | content | ... }
import json
import os
import re
import time


def reduce(input, args, ctx):
    d = os.path.abspath(str(args.get("dir", "out")))
    ext = str(args.get("ext", "md"))
    field = str(args["field"]) if args.get("field") else None
    raw = input.get(field) if field else (input.get("markdown") if input.get("markdown") is not None else input.get("text") if input.get("text") is not None else input.get("content") if input.get("content") is not None else input)
    body = raw if isinstance(raw, str) else json.dumps(raw, indent=2, ensure_ascii=False, default=str)
    base = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(args.get("name", "report")))[:60]
    stamp = re.sub(r"[^a-zA-Z0-9_-]+", "_", ctx.run_id)[-28:]
    file = os.path.join(d, f"{base}-{stamp}.{ext}")
    os.makedirs(d, exist_ok=True)
    with open(file, "w", encoding="utf-8") as f:
        f.write(body)
    ctx.log(f"wrote {file} ({len(body)} chars)")
    return {"written": True, "file": file.replace("\\", "/"), "bytes": len(body.encode("utf-8")), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
