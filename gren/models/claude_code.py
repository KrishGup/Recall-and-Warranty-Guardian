"""Claude Code provider: each call is one headless Claude Code session (`claude -p`) on the Claude Code login.

Structured output uses `--json-schema`; the session's own tools (WebSearch, Read, Bash, ...) are enabled per node via
`tools`; `--max-turns` and `--max-budget-usd` bound the session. Cost comes from the CLI's own `total_cost_usd`.
The parent session's CLAUDECODE*/CLAUDE_CODE_* variables are stripped so a nested session is allowed.
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import shutil
import time
from typing import Any

from ._base import OneShotModel

_STRIP_PREFIXES = ("CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_PID")


def find_claude_binary(explicit: str | None = None) -> str | None:
    for cand in (explicit, os.environ.get("GREN_CLAUDE_PATH"), shutil.which("claude"), shutil.which("claude.exe")):
        if cand and os.path.exists(cand):
            return cand
    appdata = os.environ.get("APPDATA")
    if appdata:
        found = sorted(glob.glob(os.path.join(appdata, "Claude", "claude-code", "*", "claude.exe")))
        if found:
            return found[-1]
    local = os.path.expanduser("~/.local/bin/claude")
    return local if os.path.exists(local) else None


class ClaudeCodeModel(OneShotModel):
    def __init__(self, model_id: str = "claude-sonnet-5", effort: str | None = None, binary: str | None = None, tools: list[str] | None = None,
                 max_turns: int | None = None, max_budget_usd: float | None = None, cwd: str | None = None, timeout_s: float = 900, **_: Any):
        super().__init__(model_id, effort=effort, tools=tools or [], max_turns=max_turns, max_budget_usd=max_budget_usd, cwd=cwd, timeout_s=timeout_s)
        self.binary = find_claude_binary(binary)

    async def complete(self, prompt: str, system_prompt: str | None, output_schema: dict[str, Any] | None) -> dict[str, Any]:
        if not self.binary:
            raise RuntimeError("claude binary not found (install Claude Code or set GREN_CLAUDE_PATH)")
        c = self.config
        tools: list[str] = c.get("tools") or []
        max_turns = c.get("max_turns") or (60 if tools else 4)
        args = [self.binary, "-p", "--output-format", "json", "--model", c["model_id"], "--max-turns", str(max_turns),
                "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
                "--permission-mode", "dontAsk"]
        if c.get("effort"):
            args += ["--effort", str(c["effort"])]
        if tools:
            args += ["--tools", ",".join(tools), "--allowedTools", ",".join(tools)]
        else:
            args += ["--tools", ""]
        if c.get("max_budget_usd"):
            args += ["--max-budget-usd", f"{float(c['max_budget_usd']):.2f}"]
        if system_prompt:
            args += ["--system-prompt", system_prompt]
        if output_schema is not None:
            args += ["--json-schema", json.dumps(output_schema)]
        env = {k: v for k, v in os.environ.items() if not any(k.startswith(p) for p in _STRIP_PREFIXES)}
        t0 = time.time()
        proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=c.get("cwd") or None, env=env)
        try:
            out, err = await asyncio.wait_for(proc.communicate(prompt.encode("utf8")), timeout=float(c.get("timeout_s") or 900))
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"claude-code timed out after {c.get('timeout_s')}s") from None
        latency = int((time.time() - t0) * 1000)
        text = out.decode("utf8", "replace").strip()
        try:
            data = json.loads(text[text.index("{"):]) if "{" in text else {}
        except json.JSONDecodeError:
            data = {}
        if not data:
            raise RuntimeError(f"claude-code produced no JSON result (exit {proc.returncode}): {(err.decode('utf8', 'replace') or text)[:400]}")
        if data.get("is_error") or data.get("subtype") not in (None, "success"):
            raise RuntimeError(f"claude-code {data.get('subtype') or 'error'}: {str(data.get('result'))[:500]}")
        usage = data.get("usage") or {}
        return {
            "text": data.get("result") or "",
            "json": data.get("structured_output") if output_schema is not None else None,
            "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                      "cacheReadInputTokens": usage.get("cache_read_input_tokens", 0), "cacheWriteInputTokens": usage.get("cache_creation_input_tokens", 0)},
            "cost_usd": data.get("total_cost_usd"),
            "session_id": data.get("session_id"),
            "latency_ms": latency,
        }
