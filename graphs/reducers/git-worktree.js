// Create an isolated git worktree + branch for a run (local, reversible - not a gated side effect).
// input: { repo_path, branch? }  args: { dir: ".worktrees", base?: "HEAD", prefix: "gren/" }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default async function gitWorktree(input, args, ctx) {
  const repo = path.resolve(String(input.repo_path ?? "."));
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const slug = ctx.runId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(-32);
  const branch = String(input.branch ?? `${args.prefix ?? "gren/"}${slug}`);
  const dir = path.resolve(root, String(args.dir ?? ".worktrees"), slug);
  const base = String(args.base ?? "HEAD");
  if (fs.existsSync(dir)) {
    ctx.log(`worktree already exists at ${dir}`);
    return { worktree: dir.replace(/\\/g, "/"), branch, base_commit: git("rev-parse", base), reused: true };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = git("branch", "--list", branch);
  if (exists) git("worktree", "add", dir, branch);
  else git("worktree", "add", "-b", branch, dir, base);
  const baseCommit = git("rev-parse", base);
  ctx.log(`worktree ${dir} on branch ${branch} from ${baseCommit.slice(0, 8)}`);
  return { worktree: dir.replace(/\\/g, "/"), branch, base_commit: baseCommit, reused: false };
}
