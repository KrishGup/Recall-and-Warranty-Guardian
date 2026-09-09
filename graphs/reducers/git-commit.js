// Commit all changes inside a worktree (a side effect: gate it). Returns the diff stat and commit hash.
// input: { worktree, message, author? }
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function gitCommit(input, args, ctx) {
  const cwd = path.resolve(String(input.worktree));
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const status = git("status", "--porcelain");
  if (!status) return { committed: false, reason: "no changes in worktree", commit: null, stat: "" };
  git("add", "-A");
  const message = String(input.message ?? args.message ?? "gren: automated change");
  const trailer = `\n\nCo-Authored-By: ${String(input.author ?? args.author ?? "gren <noreply@example.com>")}`;
  git("-c", "user.name=gren", "-c", "user.email=gren@localhost", "commit", "-q", "-m", message + trailer);
  const commit = git("rev-parse", "HEAD");
  const stat = git("show", "--stat", "--oneline", "HEAD");
  ctx.log(`committed ${commit.slice(0, 8)} in ${cwd}`);
  return { committed: true, commit, branch: git("rev-parse", "--abbrev-ref", "HEAD"), stat, files_changed: status.split("\n").length };
}
