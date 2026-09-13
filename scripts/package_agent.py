"""Vendor the repository's Python packages into the AgentCore code location before packaging or deploying.

    python scripts/package_agent.py            # copies guardian/, gren/gren/ -> gren/, demo/ into deploy/agentcore/app/guardian/

CodeZip runtimes bundle the code location plus its declared third-party dependencies; local packages are not
resolvable from there, so the sources are copied (caches, tests and fixtures' zips excluded). Re-run after any change."""
from __future__ import annotations

import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "deploy", "agentcore", "app", "guardian")
EXCLUDE_DIRS = {"__pycache__", ".pytest_cache", "tests", "_data", ".venv", "node_modules"}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".log", ".zip")


def _copy_tree(src: str, dst: str) -> tuple[int, int]:
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    files, size = 0, 0
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        rel = os.path.relpath(dirpath, src)
        out = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(out, exist_ok=True)
        for fn in filenames:
            if fn.endswith(EXCLUDE_SUFFIX):
                continue
            shutil.copy2(os.path.join(dirpath, fn), os.path.join(out, fn))
            files += 1
            size += os.path.getsize(os.path.join(out, fn))
    return files, size


def main() -> int:
    if not os.path.isdir(DEST):
        print(f"missing {DEST}; run agentcore create first or check out deploy/agentcore", file=sys.stderr)
        return 1
    total_files, total_size = 0, 0
    for src, name in ((os.path.join(ROOT, "guardian"), "guardian"), (os.path.join(ROOT, "gren", "gren"), "gren"), (os.path.join(ROOT, "demo"), "demo")):
        files, size = _copy_tree(src, os.path.join(DEST, name))
        total_files += files
        total_size += size
        print(f"  {name:9s} {files:4d} files  {size / 1024:8.0f} KB")
    print(f"vendored {total_files} files ({total_size / 1024 / 1024:.1f} MB) into {os.path.relpath(DEST, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
