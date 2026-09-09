// Create an isolated git worktree + branch for a run (local, reversible - not a gated side effect).
// input: { repo_path, branch? }  args: { dir: ".worktrees", base?: "HEAD", prefix: "gren/", link?: ["node_modules"] }
//
// WARNING (Windows): the worktree gets a JUNCTION to the main checkout's node_modules so tests can run there.
// `git worktree remove --force` follows junctions and deletes the real node_modules. Remove worktrees with
// ./git-worktree-remove.js (or `rmdir <worktree>\node_modules` first). A marker file documents this in the worktree.
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
  // Share heavy, untracked dependency folders with the main checkout so tests/builds run in the worktree.
  const links = Array.isArray(args.link) ? args.link.map(String) : ["node_modules"];
  const linked = [];
  for (const rel of links) {
    const target = path.join(root, rel);
    const link = path.join(dir, rel);
    if (fs.existsSync(target) && !fs.existsSync(link)) {
      try {
        fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
        linked.push(rel);
      } catch (e) {
        ctx.log(`could not link ${rel}: ${e.message}`);
      }
    }
  }
  if (linked.length) fs.writeFileSync(path.join(dir, "GREN-WORKTREE-README.txt"), `This worktree was created by gren run ${ctx.runId}.\nLinked from the main checkout (junction/symlink, NOT a copy): ${linked.join(", ")}\nDo NOT run "git worktree remove --force" here on Windows - it follows the junction and deletes the real folder.\nRemove with: node graphs/reducers/git-worktree-remove.js, or "rmdir <this dir>\\${linked[0]}" first, then git worktree remove.\n`, "utf8");
  ctx.log(`worktree ${dir} on branch ${branch} from ${baseCommit.slice(0, 8)}${linked.length ? ` (linked ${linked.join(", ")})` : ""}`);
  return { worktree: dir.replace(/\\/g, "/"), branch, base_commit: baseCommit, reused: false, linked };
}
