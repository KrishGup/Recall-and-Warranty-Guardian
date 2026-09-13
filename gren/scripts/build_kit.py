"""Build the starter kit: a wheel plus the files a new project needs (skill, MCP config, graphs, notes).

Run from the repository root:  python scripts/build_kit.py
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(ROOT, "kit")
DATA = os.path.join(ROOT, "gren", "_data")


def copy_tree(src: str, dst: str) -> None:
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def main() -> None:
    os.makedirs(KIT, exist_ok=True)
    for old in glob.glob(os.path.join(KIT, "gren-*.whl")):
        os.remove(old)
    # package data for `gren init` when installed from the wheel
    copy_tree(os.path.join(ROOT, "skills"), os.path.join(DATA, "skills"))
    copy_tree(os.path.join(ROOT, "graphs"), os.path.join(DATA, "graphs"))
    try:
        subprocess.run([sys.executable, "-m", "pip", "wheel", ".", "--no-deps", "-w", KIT, "-q"], cwd=ROOT, check=True)
    finally:
        shutil.rmtree(DATA, ignore_errors=True)
    copy_tree(os.path.join(ROOT, "skills", "graph-engineering"), os.path.join(KIT, ".claude", "skills", "graph-engineering"))
    copy_tree(os.path.join(ROOT, "graphs"), os.path.join(KIT, "graphs"))
    with open(os.path.join(KIT, ".mcp.json"), "w", encoding="utf-8") as f:
        json.dump({"mcpServers": {"gren": {"command": ".venv/Scripts/python.exe", "args": ["-m", "gren", "mcp"], "env": {"GREN_RUNS": "runs"}}}}, f, indent=2)
        f.write("\n")
    with open(os.path.join(KIT, "CLAUDE.md"), "w", encoding="utf-8") as f:
        f.write(
            "# gren project notes\n\n"
            "- gren = Graph Engineering Runtime on Strands Agents. Design multi-agent workflows as graphs (graphs/*.yaml), run them, monitor them.\n"
            "- CLI: `gren <command>` inside the activated `.venv` (validate | analyze | run | resume | fork | status | metrics | approve | tasks | complete | ui | mcp). Without activation: `.venv/Scripts/python -m gren <command>`.\n"
            "- MCP: .mcp.json registers the `gren` server (tools gren_*). Skill: .claude/skills/graph-engineering - load it (/graph-engineering) before designing a graph.\n"
            "- Providers: bedrock (AWS credentials) | anthropic (ANTHROPIC_API_KEY) | claude-code (Claude Code login) | inbox (this session executes nodes with subagents) | mock (no tokens).\n"
            "- Runs are checkpointed under runs/ (gitignored). Dashboard: `gren ui` -> http://127.0.0.1:4545\n"
            "- Reference: gren_reference (MCP) or .claude/skills/graph-engineering/references/spec.md. Start from graphs/starter-fork-join.yaml.\n"
        )
    with open(os.path.join(KIT, ".gitignore"), "w", encoding="utf-8") as f:
        f.write(".venv/\nruns/\nout/\n.worktrees/\n__pycache__/\n*.log\n")
    with open(os.path.join(KIT, "requirements.txt"), "w", encoding="utf-8") as f:
        wheel = os.path.basename(glob.glob(os.path.join(KIT, "gren-*.whl"))[0])
        f.write(f"./{wheel}\n")
    print("kit built:", sorted(os.listdir(KIT)))


if __name__ == "__main__":
    main()
