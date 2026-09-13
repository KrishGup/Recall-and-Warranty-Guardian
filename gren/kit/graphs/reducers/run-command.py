# Deterministic command runner (tests, builds, linters). Not a side effect: it only reads/executes and reports.
# input: { cwd?, command?, args? }  args: { command: "python", args: ["-m","pytest","-q"], timeout_ms: 600000, cwd?: ".", ok_pattern?: "regex" }
import os
import re
import shutil
import subprocess
import time


def _tail(s: str, n: int = 4000) -> str:
    return f"…{s[-n:]}" if len(s) > n else s


def reduce(input, args, ctx):
    command = str(input.get("command") or args.get("command") or "python")
    cmd_args = [str(a) for a in (input.get("args") if isinstance(input.get("args"), list) else args.get("args") if isinstance(args.get("args"), list) else [])]
    cwd = os.path.abspath(str(input.get("cwd") or args.get("cwd") or "."))
    timeout = float(args.get("timeout_ms", 600000)) / 1000
    started = time.time()
    ctx.log(f"run-command: {command} {' '.join(cmd_args)} (cwd {cwd})")
    exe = shutil.which(command) or command
    env = {**os.environ, "CI": "1", "FORCE_COLOR": "0", "PYTHONIOENCODING": "utf-8"}
    try:
        p = subprocess.run([exe, *cmd_args], cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        out, err, code, timed_out = p.stdout, p.stderr, p.returncode, False
    except subprocess.TimeoutExpired as e:
        out, err, code, timed_out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or ""), (e.stderr or b"").decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or ""), -1, True
    except OSError as e:
        out, err, code, timed_out = "", str(e), -1, False
    ok_pattern = args.get("ok_pattern")
    passed = code == 0 and (not ok_pattern or re.search(str(ok_pattern), out + err) is not None)
    return {
        "command": f"{command} {' '.join(cmd_args)}".strip(), "cwd": cwd.replace("\\", "/"), "exit_code": code, "passed": passed, "timed_out": timed_out,
        "duration_ms": int((time.time() - started) * 1000), "stdout_tail": _tail(out), "stderr_tail": _tail(err),
    }
