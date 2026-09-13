from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx

UA = "Guardian/0.1 (+https://github.com/KrishGup/Recall-and-Warranty-Guardian) household recall watcher"
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixtures_mode() -> bool:
    return os.environ.get("GUARDIAN_FEEDS", "live").lower() == "fixtures"


def load_fixture(name: str) -> Any:
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return json.load(f)


def get_json(url: str, params: dict[str, Any] | None = None, timeout: float = 45.0, retries: int = 2) -> Any:
    """GET JSON with a browser-like User-Agent (FSIS and some agency hosts reject bare clients) and short retries."""
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with httpx.Client(timeout=timeout, headers={"User-Agent": UA, "Accept": "application/json"}, follow_redirects=True) as c:
                r = c.get(url, params=params)
                r.raise_for_status()
                return r.json()
        except (httpx.HTTPError, ValueError) as e:  # noqa: PERF203
            last = e
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"feed request failed: {url} ({last})")
