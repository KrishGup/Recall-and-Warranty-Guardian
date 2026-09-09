// Open a GitHub pull request from a worktree branch with the gh CLI (a side effect - gate it).
// If the repository has no remote (or gh is missing) it records a dry run with the exact command instead.
// input: { worktree, branch, title, body, base?: "main", draft?: true }
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function ghPr(input, args, ctx) {
  const cwd = path.resolve(String(input.worktree));
  const run = (cmd, a) => execFileSync(cmd, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }).trim();
  const branch = String(input.branch);
  const base = String(input.base ?? args.base ?? "main");
  const title = String(input.title ?? "gren: automated change");
  const body = String(input.body ?? "");
  const draft = input.draft !== false;
  const argv = ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", branch, ...(draft ? ["--draft"] : [])];
  let remote = "";
  try { remote = run("git", ["remote", "get-url", "origin"]); } catch { remote = ""; }
  let ghOk = true;
  try { run("gh", ["--version"]); } catch { ghOk = false; }
  if (!remote || !ghOk || args.dry_run === true) {
    ctx.log(`gh-pr: dry run (${!remote ? "no origin remote" : !ghOk ? "gh not installed" : "dry_run"})`);
    return { created: false, dry_run: true, reason: !remote ? "no origin remote" : !ghOk ? "gh not installed" : "dry_run", command: `gh ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`, branch, base, title };
  }
  run("git", ["push", "-u", "origin", branch]);
  const url = run("gh", argv);
  ctx.log(`gh-pr: ${url}`);
  return { created: true, dry_run: false, url, branch, base, title };
}
