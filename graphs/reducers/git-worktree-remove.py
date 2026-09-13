# Safely remove a gren worktree. IMPORTANT on Windows: the worktree contains a junction to the main checkout's
# dependency folders; `git worktree remove --force` follows it and deletes the REAL folder. Always unlink first.
# input: { worktree, branch?, delete_branch?: false }
#
# Standalone use:  python graphs/reducers/git-worktree-remove.py <worktree dir>
import os
import re
import stat
import subprocess
import sys


def _is_link(p: str) -> bool:
    if os.path.islink(p):
        return True
    isj = getattr(os.path, "isjunction", None)
    if isj is not None:
        return bool(isj(p))
    try:
        return bool(os.lstat(p).st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return False


def reduce(input, args, ctx):
    d = os.path.abspath(str(input.get("worktree")))
    if not os.path.exists(d):
        return {"removed": False, "reason": "worktree directory does not exist"}
    unlinked: list[str] = []
    for name in os.listdir(d):
        p = os.path.join(d, name)
        if _is_link(p):
            os.rmdir(p) if os.path.isdir(p) else os.remove(p)  # removes the link/junction only, never its target
            unlinked.append(name)
    common = subprocess.run(["git", "-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, check=True).stdout.strip()
    repo_root = re.sub(r"[\\/]\.git$", "", common)
    subprocess.run(["git", "-C", repo_root, "worktree", "remove", "--force", d], capture_output=True, check=True)
    subprocess.run(["git", "-C", repo_root, "worktree", "prune"], capture_output=True)
    marker = f"{d}.GREN-README.txt"
    if os.path.exists(marker):
        os.remove(marker)
    branch_deleted = False
    if input.get("delete_branch") and input.get("branch"):
        r = subprocess.run(["git", "-C", repo_root, "branch", "-D", str(input["branch"])], capture_output=True)
        branch_deleted = r.returncode == 0
    ctx.log(f"removed worktree {d} (unlinked {', '.join(unlinked) or 'nothing'})")
    return {"removed": True, "unlinked": unlinked, "branch_deleted": branch_deleted}


if __name__ == "__main__":
    class _Ctx:
        run_id = "cli"

        @staticmethod
        def log(m: str) -> None:
            print(m)

    print(reduce({"worktree": sys.argv[1]}, {}, _Ctx()))
