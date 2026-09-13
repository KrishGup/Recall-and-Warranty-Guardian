# Open a GitHub pull request from a worktree branch with the gh CLI (a side effect - gate it).
# If the repository has no remote (or gh is missing) it records a dry run with the exact command instead.
# input: { worktree, branch, title, body, base?: "main", draft?: true }
import json
import os
import re
import shutil
import subprocess


def _run(cwd: str, cmd: str, a: list[str]) -> str:
    exe = shutil.which(cmd) or cmd
    return subprocess.run([exe, *a], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout.strip()


def reduce(input, args, ctx):
    cwd = os.path.abspath(str(input.get("worktree")))
    branch = str(input.get("branch"))
    base = str(input.get("base") or args.get("base") or "main")
    title = str(input.get("title") or "gren: automated change")
    body = str(input.get("body") or "")
    draft = input.get("draft") is not False
    argv = ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", branch, *(["--draft"] if draft else [])]
    try:
        remote = _run(cwd, "git", ["remote", "get-url", "origin"])
    except subprocess.CalledProcessError:
        remote = ""
    gh_ok = shutil.which("gh") is not None
    if not remote or not gh_ok or args.get("dry_run") is True:
        reason = "no origin remote" if not remote else "gh not installed" if not gh_ok else "dry_run"
        ctx.log(f"gh-pr: dry run ({reason})")
        return {"created": False, "dry_run": True, "reason": reason, "command": "gh " + " ".join(json.dumps(a) if re.search(r"\s", a) else a for a in argv), "branch": branch, "base": base, "title": title}
    _run(cwd, "git", ["push", "-u", "origin", branch])
    url = _run(cwd, "gh", argv)
    ctx.log(f"gh-pr: {url}")
    return {"created": True, "dry_run": False, "url": url, "branch": branch, "base": base, "title": title}
