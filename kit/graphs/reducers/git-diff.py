# Deterministic diff of a worktree against its base commit (uncommitted + committed changes). Read-only.
# input: { worktree, base_commit }  args: { max_chars: 60000 }
import os
import subprocess


def _git(cwd: str, *a: str) -> str:
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout


def reduce(input, args, ctx):
    cwd = os.path.abspath(str(input.get("worktree")))
    base = str(input.get("base_commit") or "HEAD")
    _git(cwd, "add", "-A", "--intent-to-add")
    diff = _git(cwd, "diff", base)
    stat = _git(cwd, "diff", "--stat", base).strip()
    mx = int(args.get("max_chars", 60000))
    files = [line.split("|")[0].strip() for line in stat.splitlines() if "|" in line]
    return {"base_commit": base, "stat": stat, "files": files, "diff": f"{diff[:mx]}\n… (truncated {len(diff) - mx} chars)" if len(diff) > mx else diff, "changed": bool(files), "_stats": {"in": len(files), "out": len(files)}}
