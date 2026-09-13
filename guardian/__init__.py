"""Recall & Warranty Guardian."""
from __future__ import annotations

import os

__version__ = "0.1.0"


def load_env_file(path: str | None = None) -> list[str]:
    """Load KEY=VALUE lines from a .env file into os.environ. Variables already set win. The file is looked for at,
    in order: an explicit `path`, GUARDIAN_ENV_FILE (set it to an empty string to disable loading), ./.env, and the
    repository root's .env. Returns the names that were loaded."""
    if path is not None:
        candidates = [path]
    elif "GUARDIAN_ENV_FILE" in os.environ:
        candidates = [os.environ["GUARDIAN_ENV_FILE"]]
    else:
        candidates = [os.path.join(os.getcwd(), ".env"), os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")]
    loaded: list[str] = []
    for p in candidates:
        if not p or not os.path.isfile(p):
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                if s.startswith("export "):
                    s = s[7:]
                k, v = s.split("=", 1)
                k, v = k.strip(), v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                if k and k not in os.environ:
                    os.environ[k] = v
                    loaded.append(k)
        break
    return loaded


load_env_file()
