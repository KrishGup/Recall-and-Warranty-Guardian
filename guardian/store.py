"""The household store: JSON files under GUARDIAN_DATA (default ./var/household).

Shaped like the DynamoDB single-table design in BUILD_PLAN.md section 11 (one entity type per file, ids as sort keys)
so the swap to DynamoDB is a driver change. Writes are atomic (write-then-rename) and guarded by a process lock;
readers always see a complete file."""
from __future__ import annotations

import json
import os
import random
import threading
from datetime import datetime, timezone
from typing import Any, Iterable

from .models import Activity, Decision, Household, InventoryItem, MatchCandidate, Preferences, RecallRecord, SweepRecord, now_iso

DEFAULT_ROOT = os.path.join("var", "household")


def _atomic_write(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{random.randbytes(2).hex()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False, default=str)
    for attempt in range(6):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            import time

            time.sleep(0.02 * (attempt + 1))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False, default=str)
    try:
        os.remove(tmp)
    except OSError:
        pass


def _read(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    for attempt in range(5):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            import time

            time.sleep(0.02 * (attempt + 1))
    return default


class Store:
    def __init__(self, root: str | None = None):
        self.root = os.path.abspath(root or os.environ.get("GUARDIAN_DATA") or DEFAULT_ROOT)
        os.makedirs(self.root, exist_ok=True)
        self.lock = threading.RLock()

    @classmethod
    def default(cls) -> "Store":
        return cls()

    def _p(self, name: str) -> str:
        return os.path.join(self.root, name)

    # ---- generic ----
    def _list(self, name: str) -> list[dict[str, Any]]:
        v = _read(self._p(name), [])
        return v if isinstance(v, list) else []

    def _save_list(self, name: str, rows: Iterable[dict[str, Any]]) -> None:
        _atomic_write(self._p(name), list(rows))

    def _upsert(self, name: str, row: dict[str, Any], key: str = "id") -> None:
        with self.lock:
            rows = self._list(name)
            for i, r in enumerate(rows):
                if r.get(key) == row.get(key):
                    rows[i] = row
                    break
            else:
                rows.append(row)
            self._save_list(name, rows)

    # ---- household / prefs ----
    def household(self) -> Household:
        return Household.model_validate(_read(self._p("household.json"), {}) or {})

    def save_household(self, hh: Household) -> None:
        _atomic_write(self._p("household.json"), hh.model_dump())

    def prefs(self) -> Preferences:
        return Preferences.model_validate(_read(self._p("prefs.json"), {}) or {})

    def save_prefs(self, p: Preferences) -> None:
        _atomic_write(self._p("prefs.json"), p.model_dump())

    # ---- items ----
    def items(self, include_disposed: bool = False) -> list[InventoryItem]:
        out = [InventoryItem.model_validate(r) for r in self._list("items.json")]
        return out if include_disposed else [i for i in out if i.status != "disposed"]

    def item(self, item_id: str) -> InventoryItem | None:
        for r in self._list("items.json"):
            if r.get("id") == item_id:
                return InventoryItem.model_validate(r)
        return None

    def upsert_item(self, item: InventoryItem) -> InventoryItem:
        self._upsert("items.json", item.model_dump())
        return item

    def delete_item(self, item_id: str) -> bool:
        with self.lock:
            rows = self._list("items.json")
            kept = [r for r in rows if r.get("id") != item_id]
            if len(kept) == len(rows):
                return False
            self._save_list("items.json", kept)
            self._save_list("matches.json", [m for m in self._list("matches.json") if m.get("item_id") != item_id])
        photo_dir = os.path.join(self.root, "photos", item_id)
        if os.path.isdir(photo_dir):
            for f in os.listdir(photo_dir):
                try:
                    os.remove(os.path.join(photo_dir, f))
                except OSError:
                    pass
            try:
                os.rmdir(photo_dir)
            except OSError:
                pass
        return True

    # ---- photos (label / receipt images) ----
    def save_photo(self, item_id: str, data: bytes, filename: str) -> str:
        d = os.path.join(self.root, "photos", item_id)
        os.makedirs(d, exist_ok=True)
        safe = "".join(c for c in filename if c.isalnum() or c in "._-") or "photo"
        name = f"{random.randbytes(4).hex()}-{safe}"
        with open(os.path.join(d, name), "wb") as f:
            f.write(data)
        return name

    def photo_path(self, item_id: str, filename: str) -> str:
        return os.path.join(self.root, "photos", item_id, filename)

    def delete_photo(self, item_id: str, filename: str) -> None:
        p = self.photo_path(item_id, filename)
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass

    def bump_sweeps(self, item_ids: Iterable[str]) -> None:
        ids = set(item_ids)
        with self.lock:
            rows = self._list("items.json")
            for r in rows:
                if r.get("id") in ids:
                    r["sweeps"] = int(r.get("sweeps") or 0) + 1
            self._save_list("items.json", rows)

    # ---- recalls ----
    def recalls(self) -> list[RecallRecord]:
        return [RecallRecord.model_validate(r) for r in self._list("recalls.json")]

    def recall(self, recall_id: str) -> RecallRecord | None:
        for r in self._list("recalls.json"):
            if r.get("recall_id") == recall_id:
                return RecallRecord.model_validate(r)
        return None

    def upsert_recalls(self, records: Iterable[RecallRecord]) -> list[str]:
        """Insert or replace; returns the ids that were new."""
        new: list[str] = []
        with self.lock:
            rows = self._list("recalls.json")
            by_id = {r["recall_id"]: i for i, r in enumerate(rows)}
            for rec in records:
                d = rec.model_dump()
                if rec.recall_id in by_id:
                    rows[by_id[rec.recall_id]] = d
                else:
                    by_id[rec.recall_id] = len(rows)
                    rows.append(d)
                    new.append(rec.recall_id)
            self._save_list("recalls.json", rows)
        return new

    def recalls_since(self, days: int) -> int:
        cutoff = (datetime.now(timezone.utc).timestamp()) - days * 86400
        n = 0
        for r in self._list("recalls.json"):
            try:
                if datetime.fromisoformat(str(r.get("fetched_at", "")).replace("Z", "+00:00")).timestamp() >= cutoff:
                    n += 1
            except ValueError:
                pass
        return n

    # ---- matches ----
    def matches(self) -> list[MatchCandidate]:
        return [MatchCandidate.model_validate(r) for r in self._list("matches.json")]

    def match(self, match_id: str) -> MatchCandidate | None:
        for r in self._list("matches.json"):
            if r.get("id") == match_id:
                return MatchCandidate.model_validate(r)
        return None

    def upsert_match(self, m: MatchCandidate) -> MatchCandidate:
        m.updated_at = now_iso()
        self._upsert("matches.json", m.model_dump())
        return m

    def matches_for_item(self, item_id: str) -> list[MatchCandidate]:
        return [m for m in self.matches() if m.item_id == item_id]

    # ---- decisions ----
    def decisions(self) -> list[Decision]:
        return [Decision.model_validate(r) for r in self._list("decisions.json")]

    def decision(self, decision_id: str) -> Decision | None:
        for r in self._list("decisions.json"):
            if r.get("id") == decision_id:
                return Decision.model_validate(r)
        return None

    def upsert_decision(self, d: Decision) -> Decision:
        self._upsert("decisions.json", d.model_dump())
        return d

    # ---- activity ----
    def log(self, a: Activity) -> Activity:
        with self.lock:
            with open(self._p("activity.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(a.model_dump(), ensure_ascii=False) + "\n")
        return a

    def activity(self, limit: int | None = None, since: str | None = None) -> list[Activity]:
        p = self._p("activity.jsonl")
        if not os.path.exists(p):
            return []
        out: list[Activity] = []
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    a = Activity.model_validate(json.loads(line))
                except Exception:  # noqa: BLE001
                    continue
                if since and a.at < since:
                    continue
                out.append(a)
        out.sort(key=lambda a: a.at)
        return out[-limit:] if limit else out

    # ---- sweeps ----
    def sweeps(self) -> list[SweepRecord]:
        return [SweepRecord.model_validate(r) for r in self._list("sweeps.json")]

    def upsert_sweep(self, s: SweepRecord) -> SweepRecord:
        self._upsert("sweeps.json", s.model_dump(), key="run_id")
        return s

    # ---- feed bookkeeping ----
    def feeds_state(self) -> dict[str, Any]:
        return _read(self._p("feeds.json"), {}) or {}

    def save_feeds_state(self, st: dict[str, Any]) -> None:
        _atomic_write(self._p("feeds.json"), st)

    # ---- gmail link (OAuth tokens; never a password) ----
    def gmail_state(self) -> dict[str, Any]:
        return _read(self._p("gmail.json"), {}) or {}

    def save_gmail_state(self, st: dict[str, Any]) -> None:
        _atomic_write(self._p("gmail.json"), st)

    # ---- background scheduler bookkeeping ----
    def scheduler_state(self) -> dict[str, Any]:
        return _read(self._p("scheduler.json"), {}) or {}

    def save_scheduler_state(self, st: dict[str, Any]) -> None:
        _atomic_write(self._p("scheduler.json"), st)

    # ---- outbox (what would have gone out over SNS / SES) ----
    def outbox_write(self, kind: str, payload: dict[str, Any]) -> str:
        d = os.path.join(self.root, "outbox")
        os.makedirs(d, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        path = os.path.join(d, f"{kind}-{stamp}-{random.randbytes(2).hex()}.json")
        _atomic_write(path, {"kind": kind, "at": now_iso(), **payload})
        return path.replace("\\", "/")

    def outbox(self) -> list[dict[str, Any]]:
        d = os.path.join(self.root, "outbox")
        if not os.path.isdir(d):
            return []
        out = []
        for f in sorted(os.listdir(d)):
            if f.endswith(".json"):
                v = _read(os.path.join(d, f), None)
                if isinstance(v, dict):
                    out.append({**v, "file": f})
        return out

    # ---- lifecycle ----
    def reset(self) -> None:
        with self.lock:
            for f in ("items.json", "recalls.json", "matches.json", "decisions.json", "activity.jsonl", "sweeps.json", "feeds.json", "prefs.json", "household.json", "scheduler.json", "gmail.json"):
                p = self._p(f)
                if os.path.exists(p):
                    os.remove(p)
            for sub in ("outbox", "photos"):
                d = os.path.join(self.root, sub)
                if os.path.isdir(d):
                    for root, _dirs, files in os.walk(d, topdown=False):
                        for f in files:
                            try:
                                os.remove(os.path.join(root, f))
                            except OSError:
                                pass
                        try:
                            os.rmdir(root)
                        except OSError:
                            pass
