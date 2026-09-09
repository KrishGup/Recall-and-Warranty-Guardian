// Deterministic repository inventory: source files grouped into modules (top-level dirs), sizes, languages.
// input: { repo_path }   args: { include?: ["src","graphs"], max_files?: 400, exts?: [".ts",".js"], module_depth?: 2 }
import fs from "node:fs";
import path from "node:path";

const IGNORE = new Set(["node_modules", "dist", ".git", "runs", "out", ".claude", "coverage", "build", "target", "__pycache__"]);

export default async function inventory(input, args, ctx) {
  const root = path.resolve(String(input.repo_path ?? args.root ?? "."));
  const inc = Array.isArray(input.include) ? input.include : args.include;
  const include = Array.isArray(inc) && inc.length ? inc.map(String) : null;
  const exts = new Set((Array.isArray(args.exts) ? args.exts : [".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rs", ".java", ".yaml", ".yml", ".json", ".md", ".html"]).map(String));
  const maxFiles = Number(args.max_files ?? 400);
  const depth = Number(args.module_depth ?? 2);
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else if (exts.has(path.extname(entry.name))) {
        if (include && !include.some((p) => r === p || r.startsWith(`${p}/`))) continue;
        const text = fs.readFileSync(abs, "utf8");
        files.push({ path: r, bytes: Buffer.byteLength(text), lines: text.split("\n").length, ext: path.extname(entry.name) });
        if (files.length >= maxFiles) return;
      }
    }
  };
  walk(root, "");
  const modules = {};
  for (const f of files) {
    const parts = f.path.split("/");
    const key = parts.length > depth ? parts.slice(0, depth).join("/") : parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
    const m = (modules[key] ??= { module: key, files: [], lines: 0, bytes: 0 });
    m.files.push(f.path);
    m.lines += f.lines;
    m.bytes += f.bytes;
  }
  const list = Object.values(modules).sort((a, b) => b.lines - a.lines);
  ctx.log(`inventory: ${files.length} files in ${list.length} modules under ${root}`);
  return {
    root: root.replace(/\\/g, "/"),
    file_count: files.length,
    total_lines: files.reduce((s, f) => s + f.lines, 0),
    modules: list,
    largest_files: [...files].sort((a, b) => b.lines - a.lines).slice(0, 10),
    _stats: { in: files.length, out: list.length },
  };
}
