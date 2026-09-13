// Side-effect reducer: write text (or JSON) to a file. Deterministic file name per run.
// args: { dir: "out", name: "report", ext: "md", field?: "markdown" }   input: { markdown | text | content | ... }
import fs from "node:fs";
import path from "node:path";

export default async function writeFile(input, args, ctx) {
  const dir = path.resolve(String(args.dir ?? "out"));
  const ext = String(args.ext ?? "md");
  const field = args.field ? String(args.field) : undefined;
  const raw = field ? input[field] : (input.markdown ?? input.text ?? input.content ?? input);
  const body = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  const base = String(args.name ?? "report").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60);
  const stamp = ctx.runId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(-28);
  const file = path.join(dir, `${base}-${stamp}.${ext}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  ctx.log(`wrote ${file} (${body.length} chars)`);
  return { written: true, file: file.replace(/\\/g, "/"), bytes: Buffer.byteLength(body), at: new Date().toISOString() };
}
