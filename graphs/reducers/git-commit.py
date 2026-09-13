# Commit all changes inside a worktree (a side effect: gate it). Returns the diff stat and commit hash.
# input: { worktree, message, author? }
import os
import subprocess


def _git(cwd: str, *a: str) -> str:
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout.strip()


def reduce(input, args, ctx):
    cwd = os.path.abspath(str(input.get("worktree")))
    status = _git(cwd, "status", "--porcelain")
    if not status:
        return {"committed": False, "reason": "no changes in worktree", "commit": None, "stat": ""}
    _git(cwd, "add", "-A")
    message = str(input.get("message") or args.get("message") or "gren: automated change")
    trailer = f"\n\nCo-Authored-By: {input.get('author') or args.get('author') or 'gren <noreply@example.com>'}"
    _git(cwd, "-c", "user.name=gren", "-c", "user.email=gren@localhost", "commit", "-q", "-m", message + trailer)
    commit = _git(cwd, "rev-parse", "HEAD")
    ctx.log(f"committed {commit[:8]} in {cwd}")
    return {"committed": True, "commit": commit, "branch": _git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), "stat": _git(cwd, "show", "--stat", "--oneline", "HEAD"), "files_changed": len(status.splitlines())}
