# Cross-app notification: POST a JSON payload to a webhook (Slack incoming webhook, Discord, Zapier/Make, Teams...).
# A side effect - always behind a gate. Without a URL it records a dry-run payload instead of sending.
# input: { url?, text, payload? }  args: { format: "slack" | "discord" | "json" }
import json
import time
import urllib.error
import urllib.request


def reduce(input, args, ctx):
    url = str(input.get("url") or "")
    text = str(input.get("text") or "")
    fmt = str(args.get("format", "slack"))
    body = {"content": text[:1900]} if fmt == "discord" else {"text": text} if fmt == "slack" else {"text": text, **(input.get("payload") or {})}
    at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if not url:
        ctx.log("post-webhook: no url provided - recording a dry run")
        return {"sent": False, "dry_run": True, "format": fmt, "body": body, "at": at}
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            status, response = res.status, res.read(500).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"webhook responded {e.code}: {e.read(500).decode('utf-8', 'replace')}") from e
    ctx.log(f"post-webhook: {status}")
    return {"sent": True, "dry_run": False, "format": fmt, "status": status, "response": response, "at": at}
