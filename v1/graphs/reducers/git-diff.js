// Deterministic diff of a worktree against its base commit (uncommitted + committed changes). Read-only.
// input: { worktree, base_commit }  args: { max_chars: 60000 }
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function gitDiff(input, args) {
  const cwd = path.resolve(String(input.worktree));
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const base = String(input.base_commit ?? "HEAD");
  git("add", "-A", "--intent-to-add");
  const diff = git("diff", base);
  const stat = git("diff", "--stat", base).trim();
  const max = Number(args.max_chars ?? 60000);
  const files = stat.split("\n").filter((l) => l.includes("|")).map((l) => l.split("|")[0].trim());
  return { base_commit: base, stat, files, diff: diff.length > max ? `${diff.slice(0, max)}\n… (truncated ${diff.length - max} chars)` : diff, changed: files.length > 0, _stats: { in: files.length, out: files.length } };
}
