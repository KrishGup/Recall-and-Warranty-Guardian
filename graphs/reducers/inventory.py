# Deterministic repository inventory: source files grouped into modules (top-level dirs), sizes, languages.
# input: { repo_path, include? }   args: { include?: ["gren","graphs"], max_files?: 400, exts?: [".py"], module_depth?: 2 }
import os

IGNORE = {"node_modules", "dist", ".git", "runs", "out", ".claude", "coverage", "build", "target", "__pycache__", ".venv", "venv", ".worktrees", ".pytest_cache", "v1"}
DEFAULT_EXTS = [".py", ".ts", ".tsx", ".js", ".mjs", ".go", ".rs", ".java", ".yaml", ".yml", ".json", ".md", ".html", ".toml"]


def reduce(input, args, ctx):
    root = os.path.abspath(str(input.get("repo_path") or args.get("root") or "."))
    inc = input.get("include") if isinstance(input.get("include"), list) else args.get("include")
    include = [str(p) for p in inc] if isinstance(inc, list) and inc else None
    exts = {str(e) for e in (args.get("exts") if isinstance(args.get("exts"), list) else DEFAULT_EXTS)}
    max_files = int(args.get("max_files", 400))
    depth = int(args.get("module_depth", 2))
    files: list[dict] = []

    def walk(d: str, rel: str) -> None:
        if len(files) >= max_files:
            return
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if entry.name in IGNORE or entry.name.startswith("."):
                continue
            r = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir(follow_symlinks=False):
                walk(entry.path, r)
            elif os.path.splitext(entry.name)[1] in exts:
                if include and not any(r == p or r.startswith(f"{p}/") for p in include):
                    continue
                try:
                    with open(entry.path, encoding="utf-8", errors="replace") as f:
                        text = f.read()
                except OSError:
                    continue
                files.append({"path": r, "bytes": len(text.encode("utf-8")), "lines": text.count("\n") + 1, "ext": os.path.splitext(entry.name)[1]})
                if len(files) >= max_files:
                    return

    walk(root, "")
    modules: dict[str, dict] = {}
    for f in files:
        parts = f["path"].split("/")
        key = "/".join(parts[:depth]) if len(parts) > depth else "/".join(parts[:-1]) if len(parts) > 1 else "(root)"
        m = modules.setdefault(key, {"module": key, "files": [], "lines": 0, "bytes": 0})
        m["files"].append(f["path"])
        m["lines"] += f["lines"]
        m["bytes"] += f["bytes"]
    listed = sorted(modules.values(), key=lambda m: -m["lines"])
    ctx.log(f"inventory: {len(files)} files in {len(listed)} modules under {root}")
    return {
        "root": root.replace("\\", "/"), "file_count": len(files), "total_lines": sum(f["lines"] for f in files), "modules": listed,
        "largest_files": sorted(files, key=lambda f: -f["lines"])[:10], "_stats": {"in": len(files), "out": len(listed)},
    }
