// Cross-app notification: POST a JSON payload to a webhook (Slack incoming webhook, Discord, Zapier/Make, Teams...).
// A side effect - always behind a gate. Without a URL it records a dry-run payload instead of sending.
// input: { url?, text, payload? }  args: { format: "slack" | "discord" | "json" }
export default async function postWebhook(input, args, ctx) {
  const url = input.url ? String(input.url) : "";
  const text = String(input.text ?? "");
  const format = String(args.format ?? "slack");
  const body = format === "discord" ? { content: text.slice(0, 1900) } : format === "slack" ? { text } : { text, ...(input.payload ?? {}) };
  if (!url) {
    ctx.log("post-webhook: no url provided - recording a dry run");
    return { sent: false, dry_run: true, format, body, at: new Date().toISOString() };
  }
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const responseText = (await res.text()).slice(0, 500);
  ctx.log(`post-webhook: ${res.status} ${res.statusText}`);
  if (!res.ok) throw new Error(`webhook responded ${res.status}: ${responseText}`);
  return { sent: true, dry_run: false, format, status: res.status, response: responseText, at: new Date().toISOString() };
}
