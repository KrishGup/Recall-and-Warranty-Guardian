// Safely remove a gren worktree. IMPORTANT on Windows: the worktree contains a junction to the main checkout's
// node_modules; `git worktree remove --force` follows it and deletes the REAL node_modules. Always unlink first.
// input: { worktree, branch?, delete_branch?: false }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default async function gitWorktreeRemove(input, args, ctx) {
  const dir = path.resolve(String(input.worktree));
  if (!fs.existsSync(dir)) return { removed: false, reason: "worktree directory does not exist" };
  const unlinked = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || (process.platform === "win32" && entry.isDirectory() && isJunction(p))) {
      fs.rmdirSync(p); // removes the link/junction only, never its target
      unlinked.push(entry.name);
    }
  }
  const repoRoot = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim().replace(/[\\/]\.git$/, "");
  execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", repoRoot, "worktree", "prune"], { stdio: "ignore" });
  let branchDeleted = false;
  if (input.delete_branch && input.branch) {
    try {
      execFileSync("git", ["-C", repoRoot, "branch", "-D", String(input.branch)], { stdio: "ignore" });
      branchDeleted = true;
    } catch {
      /* keep the branch */
    }
  }
  ctx.log(`removed worktree ${dir} (unlinked ${unlinked.join(", ") || "nothing"})`);
  return { removed: true, unlinked, branch_deleted: branchDeleted };
}

function isJunction(p) {
  try {
    fs.readlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
