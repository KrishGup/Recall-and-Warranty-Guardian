# Create an isolated git worktree + branch for a run (local, reversible - not a gated side effect).
# input: { repo_path, branch? }  args: { dir: ".worktrees", base?: "HEAD", prefix: "gren/", link?: [".venv"] }
#
# WARNING (Windows): the worktree gets a JUNCTION to the main checkout's dependency folders (.venv, node_modules)
# so tests can run there. `git worktree remove --force` follows junctions and deletes the real folder. Remove
# worktrees with ./git-worktree-remove.py (or `rmdir <worktree>\.venv` first). A marker file documents this.
import os
import re
import subprocess


def _git(repo: str, *a: str) -> str:
    return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout.strip()


def _link_dir(target: str, link: str) -> None:
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", link, target], capture_output=True, check=True)
    else:
        os.symlink(target, link, target_is_directory=True)


def reduce(input, args, ctx):
    repo = os.path.abspath(str(input.get("repo_path") or "."))
    root = _git(repo, "rev-parse", "--show-toplevel")
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", ctx.run_id)[-32:]
    branch = str(input.get("branch") or f"{args.get('prefix', 'gren/')}{slug}")
    d = os.path.abspath(os.path.join(root, str(args.get("dir", ".worktrees")), slug))
    base = str(args.get("base", "HEAD"))
    if os.path.exists(d):
        ctx.log(f"worktree already exists at {d}")
        return {"worktree": d.replace("\\", "/"), "branch": branch, "base_commit": _git(repo, "rev-parse", base), "reused": True}
    os.makedirs(os.path.dirname(d), exist_ok=True)
    if _git(repo, "branch", "--list", branch):
        _git(repo, "worktree", "add", d, branch)
    else:
        _git(repo, "worktree", "add", "-b", branch, d, base)
    base_commit = _git(repo, "rev-parse", base)
    links = [str(x) for x in args.get("link")] if isinstance(args.get("link"), list) else [".venv", "node_modules"]
    linked: list[str] = []
    for rel in links:
        target, link = os.path.join(root, rel), os.path.join(d, rel)
        if os.path.exists(target) and not os.path.exists(link):
            try:
                _link_dir(target, link)
                linked.append(rel)
            except Exception as e:  # noqa: BLE001
                ctx.log(f"could not link {rel}: {e}")
    # The marker lives NEXT TO the worktree (never inside it) so it can never show up in the change's diff.
    if linked:
        with open(f"{d}.GREN-README.txt", "w", encoding="utf-8") as f:
            f.write(f"Worktree {os.path.basename(d)} was created by gren run {ctx.run_id}.\nLinked from the main checkout (junction/symlink, NOT a copy): {', '.join(linked)}\n"
                    f'Do NOT run "git worktree remove --force" on it on Windows - it follows the junction and deletes the real folder.\n'
                    f'Remove with: graphs/reducers/git-worktree-remove.py, or "rmdir <worktree>\\{linked[0]}" first, then git worktree remove.\n')
    ctx.log(f"worktree {d} on branch {branch} from {base_commit[:8]}{' (linked ' + ', '.join(linked) + ')' if linked else ''}")
    return {"worktree": d.replace("\\", "/"), "branch": branch, "base_commit": base_commit, "reused": False, "linked": linked}
