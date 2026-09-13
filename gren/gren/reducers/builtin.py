"""Built-in deterministic reducers. "Use models for ambiguity. Use code for plumbing."

Each reducer is `(input: dict, args: dict, ctx) -> output` (sync or async). Reducers report `_stats: {in, out}`
so the compression metric is measured, not guessed. Custom reducers: a .py module exporting `reduce(input, args, ctx)`
(or `default`), referenced by `module:` relative to the spec file.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

from ..engine.expr import safe_match


@dataclass
class ReducerCtx:
    run_id: str
    node_id: str
    log: Callable[[str], None]


Reducer = Callable[[dict[str, Any], dict[str, Any], ReducerCtx], Any]


def get_path(obj: Any, path: str | None) -> Any:
    if not path:
        return obj
    cur = obj
    for seg in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(seg)
        elif isinstance(cur, list) and seg.isdigit():
            i = int(seg)
            cur = cur[i] if i < len(cur) else None
        else:
            cur = getattr(cur, seg, None)
    return cur


def as_list(v: Any) -> list[Any]:
    if isinstance(v, list):
        return v
    if v is None:
        return []
    return [v]


def _items(input_: dict[str, Any], args: dict[str, Any]) -> list[Any]:
    if isinstance(args.get("from"), str):
        return as_list(input_.get(args["from"]))
    if "items" in input_:
        return as_list(input_["items"])
    for v in input_.values():
        if isinstance(v, list):
            return v
    return []


def norm_key(v: Any) -> str:
    if isinstance(v, str):
        return re.sub(r"\s+", " ", v.strip().lower())
    return json.dumps(v, sort_keys=True, default=str)


def _stats(n_in: int, n_out: int) -> dict[str, Any]:
    return {"in": n_in, "out": n_out}


def flatten(input_, args, ctx):
    src = _items(input_, args)
    path = args.get("path")
    out: list[Any] = []
    for it in src:
        v = get_path(it, path) if path else it
        if isinstance(v, list):
            out.extend(v)
        elif v is not None:
            out.append(v)
    return {"items": out, "_stats": _stats(len(src), len(out))}


def filter_nulls(input_, args, ctx):
    src = _items(input_, args)
    req = args.get("require") or []
    out = [x for x in src if x is not None and not (req and (not isinstance(x, dict) or any(x.get(k) in (None, "") for k in req)))]
    return {"items": out, "dropped": len(src) - len(out), "_stats": _stats(len(src), len(out))}


def dedupe(input_, args, ctx):
    src = _items(input_, args)
    keys = None if args.get("key") is None else (args["key"] if isinstance(args["key"], list) else [str(args["key"])])
    keep_last = args.get("keep") == "last"
    seen: dict[str, Any] = {}
    for it in src:
        k = "|".join(norm_key(get_path(it, p)) for p in keys) if keys else norm_key(it)
        if not keep_last and k in seen:
            continue
        seen[k] = it
    out = list(seen.values())
    return {"items": out, "removed": len(src) - len(out), "_stats": {**_stats(len(src), len(out)), "compression": round(1 - len(out) / len(src), 3) if src else 0}}


def sort_(input_, args, ctx):
    src = list(_items(input_, args))
    by = str(args.get("by", ""))
    rev = args.get("order") != "asc"

    def keyf(x: Any) -> Any:
        v = get_path(x, by)
        return (0, float(v)) if isinstance(v, (int, float)) else (1, str(v or ""))

    src.sort(key=keyf, reverse=rev)
    return {"items": src, "_stats": _stats(len(src), len(src))}


def top_k(input_, args, ctx):
    src = list(_items(input_, args))
    k = int(input_.get("k") or args.get("k") or 10)
    if isinstance(args.get("by"), str):
        by = args["by"]
        src.sort(key=lambda x: float(get_path(x, by) or 0), reverse=True)
    out = src[:k]
    return {"items": out, "_stats": _stats(len(src), len(out))}


def group_by(input_, args, ctx):
    src = _items(input_, args)
    by = str(args.get("by", ""))
    groups: dict[str, list[Any]] = {}
    for it in src:
        groups.setdefault(str(get_path(it, by) or "unknown"), []).append(it)
    return {"groups": groups, "keys": list(groups), "_stats": _stats(len(src), len(groups))}


def count_votes(input_, args, ctx):
    src = _items(input_, args)
    by = str(args.get("by", ""))
    counts: dict[str, int] = {}
    for it in src:
        k = get_path(it, by)
        if k is None or k == "":
            continue
        counts[str(k)] = counts.get(str(k), 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    return {"counts": counts, "ranked": [{"key": k, "votes": v} for k, v in ranked], "winner": ranked[0][0] if ranked else None, "total": len(src), "_stats": _stats(len(src), len(ranked))}


def normalize_labels(input_, args, ctx):
    src = _items(input_, args)
    path = str(args.get("path", "label"))
    mapping = args.get("map") or {}
    lower = args.get("lower", True)
    out = []
    for it in src:
        if isinstance(it, dict):
            rec = dict(it)
            v = rec.get(path)
            if isinstance(v, str):
                key = v.strip().lower() if lower else v.strip()
                rec[path] = mapping.get(key, key)
            out.append(rec)
        else:
            out.append(it)
    return {"items": out, "_stats": _stats(len(src), len(out))}


def filter_(input_, args, ctx):
    src = _items(input_, args)
    path = str(args.get("path", ""))
    op = str(args.get("op", "=="))
    value = input_.get("value") if "value" in input_ and args.get("value") is None else args.get("value")

    def test(v: Any) -> bool:
        if op == "==":
            return v == value
        if op == "!=":
            return v != value
        if op in (">", ">=", "<", "<="):
            try:
                a, b = float(v), float(value)
            except (TypeError, ValueError):
                return False
            return {">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b}[op]
        if op == "in":
            return isinstance(value, list) and v in value
        if op == "not_in":
            return not (isinstance(value, list) and v in value)
        if op == "exists":
            return v not in (None, "")
        if op == "matches":
            return safe_match(str(value), str(v or ""))
        raise ValueError(f"filter: unknown op {op}")

    out = [it for it in src if test(get_path(it, path))]
    return {"items": out, "dropped": len(src) - len(out), "_stats": _stats(len(src), len(out))}


def pick(input_, args, ctx):
    src = _items(input_, args)
    fields = args.get("fields") or []
    out = [{f: it.get(f) for f in fields} if isinstance(it, dict) else it for it in src]
    return {"items": out, "_stats": _stats(len(src), len(out))}


def merge(input_, args, ctx):
    if args.get("mode") == "object":
        out: dict[str, Any] = {}
        for v in input_.values():
            if isinstance(v, dict):
                out.update(v)
        return out
    out_list: list[Any] = []
    for v in input_.values():
        out_list.extend(as_list(v))
    return {"items": out_list, "_stats": _stats(len(out_list), len(out_list))}


def identity(input_, args, ctx):
    return input_


def coverage(input_, args, ctx):
    records = _items(input_, args)
    key = args.get("key") if isinstance(args.get("key"), str) else None
    uniq = {norm_key(get_path(r, key)) if key else norm_key(r) for r in records}
    workers = int(input_.get("workers") or 0)
    return {"records": len(records), "unique": len(uniq), "workers": workers, "unique_per_worker": round(len(uniq) / workers, 2) if workers else None, "_stats": _stats(len(records), len(uniq))}


def template(input_, args, ctx):
    tpl = str(args.get("template", ""))

    def repl(m: re.Match[str]) -> str:
        v = get_path(input_, m.group(1))
        return v if isinstance(v, str) else json.dumps(v, indent=2, default=str)

    return {"text": re.sub(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}", repl, tpl)}


def check_fields(input_, args, ctx):
    item = input_.get("item", input_)
    reasons = [f'missing field "{k}"' for k in (args.get("require") or []) if get_path(item, k) in (None, "")]
    for k, n in (args.get("min_len") or {}).items():
        v = get_path(item, k)
        if isinstance(v, str) and len(v) < int(n):
            reasons.append(f'"{k}" shorter than {n} chars')
    return {"verdict": "kill" if reasons else "pass", "reasons": reasons, "confidence": 1 if reasons else 0}


def classify_regex(input_, args, ctx):
    text = str(get_path(input_, str(args.get("path", "text"))) or "")
    for r in args.get("rules") or []:
        if safe_match(str(r["match"]), text, re.IGNORECASE):
            return {"label": r["label"], "matched": r["match"], "confidence": 0.9}
    return {"label": str(args.get("default", "unknown")), "matched": None, "confidence": 0.3}


def record(input_, args, ctx):
    return {"recorded": True, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "payload": input_, "note": args.get("note")}


BUILTIN_REDUCERS: dict[str, Reducer] = {
    "flatten": flatten, "filter_nulls": filter_nulls, "dedupe": dedupe, "sort": sort_, "top_k": top_k, "group_by": group_by,
    "count_votes": count_votes, "normalize_labels": normalize_labels, "filter": filter_, "pick": pick, "merge": merge,
    "identity": identity, "coverage": coverage, "template": template, "check_fields": check_fields, "classify_regex": classify_regex, "record": record,
}


def get_reducer(name: str) -> Reducer:
    r = BUILTIN_REDUCERS.get(name)
    if r is None:
        raise ValueError(f'unknown built-in reducer "{name}". Available: {", ".join(BUILTIN_REDUCERS)}')
    return r


_module_cache: dict[str, Reducer] = {}


def load_reducer_module(path: str) -> Reducer:
    """Load `reduce` / `default` / `main` from a Python module file."""
    abs_path = os.path.abspath(path)
    if abs_path in _module_cache:
        return _module_cache[abs_path]
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"reducer module not found: {abs_path}")
    spec = importlib.util.spec_from_file_location(f"gren_reducer_{abs(hash(abs_path))}", abs_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load reducer module {abs_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, "reduce", None) or getattr(mod, "default", None) or getattr(mod, "main", None)
    if not callable(fn):
        raise ImportError(f"reducer module {abs_path} must define reduce(input, args, ctx)")
    _module_cache[abs_path] = fn
    return fn
