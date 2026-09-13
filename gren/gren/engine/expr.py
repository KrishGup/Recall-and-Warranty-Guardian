"""Reference resolution, templating and the deterministic condition DSL.

References are the ONLY way data crosses an edge:
  $input.topic                 graph input
  $nodes.<id>.output.path      a node's structured output
  $nodes.<id>.outputs          successful item outputs of a map node (list)
  $nodes.<id>.items            per-item records {index,status,output,error}
  $nodes.<id>.count            {total, completed, failed} for a fan-out
  $nodes.<id>.status           completed | failed | skipped ...
  $nodes.<id>.survivors/.killed/.kill_rate   verify nodes
  $nodes.<id>.route            router nodes
  $item / $index               inside a map or verify fan-out
  $loop.round/.seen/.collected/.prev          inside a loop body (also on $input)
  $repair.round/.feedback      when a producer is re-run by a repair cycle
  $run.id / $graph.name / $env.GREN_*

Templates: "{{ $nodes.a.output.title }}" or "{{ nodes.a.output.title }}" - non-strings render as pretty JSON.
The model can be fuzzy inside the box; the interface around the box stays strict.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

REF_RE = re.compile(r"^\$(input|nodes|item|index|loop|repair|run|graph|env|output)(?=$|[.\[])")
TEMPLATE_RE = re.compile(r"\{\{\s*(json\s+)?([^{}]+?)\s*\}\}")
NODE_REF_RE = re.compile(r"\$nodes\.([a-zA-Z_][a-zA-Z0-9_\-]*)((?:\.[a-zA-Z0-9_\-]+|\[\d+\])*)")
TEMPLATE_NODE_REF_RE = re.compile(r"\{\{\s*(?:json\s+)?nodes\.([a-zA-Z_][a-zA-Z0-9_\-]*)((?:\.[a-zA-Z0-9_\-]+|\[\d+\])*)\s*\}\}")
PATH_RE = re.compile(r"([^.\[\]]+)|\[(\d+)\]")

MAX_REGEX_PATTERN = 512
MAX_REGEX_INPUT = 20_000
_regex_cache: dict[str, re.Pattern[str]] = {}


class RefError(Exception):
    pass


@dataclass
class Scope:
    input: Any = None
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    item: Any = None
    index: int | None = None
    loop: Any = None
    repair: Any = None
    run: dict[str, Any] | None = None
    graph: dict[str, Any] | None = None
    env: dict[str, str] | None = None
    output: Any = None


def is_ref(v: Any) -> bool:
    return isinstance(v, str) and bool(REF_RE.match(v.strip()))


def parse_path(ref: str) -> list[str]:
    s = ref.strip().lstrip("$")
    return [m.group(1) or m.group(2) for m in PATH_RE.finditer(s)]


def resolve_ref(ref: str, scope: Scope, strict: bool = False) -> Any:
    path = parse_path(ref)
    if not path:
        raise RefError(f"empty reference {ref!r}")
    root = path.pop(0)
    roots = {
        "input": scope.input,
        "nodes": scope.nodes,
        "item": scope.item,
        "index": scope.index,
        "loop": scope.loop,
        "repair": scope.repair,
        "run": scope.run,
        "graph": scope.graph,
        "env": scope.env or {},
        "output": scope.output,
    }
    if root not in roots:
        raise RefError(f"unknown reference root in {ref}")
    cur = roots[root]
    for seg in path:
        if cur is None:
            if strict:
                raise RefError(f"cannot resolve {ref}: hit None at {seg!r}")
            return None
        if isinstance(cur, list) and seg.isdigit():
            i = int(seg)
            cur = cur[i] if i < len(cur) else None
        elif isinstance(cur, dict):
            cur = cur.get(seg)
        elif hasattr(cur, seg):
            cur = getattr(cur, seg)
        else:
            if strict:
                raise RefError(f"cannot resolve {ref}: {seg!r} on {type(cur).__name__}")
            return None
    return cur


def _stringify(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return json.dumps(v, indent=2, ensure_ascii=False, default=str)


def render_template(tpl: str, scope: Scope) -> str:
    def repl(m: re.Match[str]) -> str:
        json_flag, expr = m.group(1), m.group(2).strip()
        ref = expr if expr.startswith("$") else f"${expr}"
        if not is_ref(ref):
            return m.group(0)
        v = resolve_ref(ref, scope)
        return json.dumps(v, indent=2, ensure_ascii=False, default=str) if json_flag else _stringify(v)

    return TEMPLATE_RE.sub(repl, tpl)


def resolve_value(v: Any, scope: Scope) -> Any:
    if isinstance(v, str):
        if is_ref(v):
            return resolve_ref(v, scope)
        if "{{" in v:
            return render_template(v, scope)
        return v
    if isinstance(v, list):
        return [resolve_value(x, scope) for x in v]
    if isinstance(v, dict):
        return {k: resolve_value(x, scope) for k, x in v.items()}
    return v


def _val(x: Any, scope: Scope) -> Any:
    return resolve_ref(x, scope) if is_ref(x) else x


def _truthy(v: Any) -> bool:
    if isinstance(v, (list, dict, str)):
        return len(v) > 0
    return bool(v)


def _loose_eq(a: Any, b: Any) -> bool:
    if a == b:
        return True
    if isinstance(a, (int, float)) or isinstance(b, (int, float)):
        try:
            return float(a) == float(b)
        except (TypeError, ValueError):
            return False
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def safe_match(pattern: str, text: str, flags: int = 0) -> bool:
    """Regex matching with ReDoS guards: length caps, nested quantifiers refused, compiled patterns cached."""
    if len(pattern) > MAX_REGEX_PATTERN:
        raise ValueError(f"regex pattern longer than {MAX_REGEX_PATTERN} chars")
    if re.search(r"(\([^)]*[+*][^)]*\)[+*{])|(\[[^\]]*\][+*]\)?[+*])", pattern):
        raise ValueError(f"regex pattern {pattern[:60]!r} has nested quantifiers (catastrophic backtracking risk)")
    key = f"{flags}/{pattern}"
    rx = _regex_cache.get(key)
    if rx is None:
        rx = re.compile(pattern, flags)
        if len(_regex_cache) > 500:
            _regex_cache.clear()
        _regex_cache[key] = rx
    return rx.search(text[:MAX_REGEX_INPUT]) is not None


def eval_cond(c: Any, scope: Scope) -> bool:
    if c is None:
        return True
    if isinstance(c, bool):
        return c
    if isinstance(c, str):
        return _truthy(_val(c, scope))
    if not isinstance(c, dict) or len(c) != 1:
        raise ValueError(f"unknown condition {c!r}")
    (op, arg), = c.items()
    if op in ("eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "matches"):
        a, b = arg
        av, bv = _val(a, scope), _val(b, scope)
        if op == "eq":
            return _loose_eq(av, bv)
        if op == "neq":
            return not _loose_eq(av, bv)
        if op == "in":
            return isinstance(bv, list) and any(_loose_eq(x, av) for x in bv)
        if op == "contains":
            if isinstance(av, list):
                return any(_loose_eq(x, bv) for x in av)
            if isinstance(av, str):
                return str(bv) in av
            return False
        if op == "matches":
            return safe_match(str(b), str(av if av is not None else ""))
        try:
            an, bn = float(av), float(bv)
        except (TypeError, ValueError):
            return False
        return {"gt": an > bn, "gte": an >= bn, "lt": an < bn, "lte": an <= bn}[op]
    if op == "exists":
        return _val(arg, scope) is not None
    if op == "empty":
        v = _val(arg, scope)
        return v is None or v == "" or (isinstance(v, (list, dict)) and len(v) == 0)
    if op == "truthy":
        return _truthy(_val(arg, scope))
    if op == "status":
        node_id, st = arg
        return (scope.nodes.get(node_id) or {}).get("status") == st
    if op == "and":
        return all(eval_cond(x, scope) for x in arg)
    if op == "or":
        return any(eval_cond(x, scope) for x in arg)
    if op == "not":
        return not eval_cond(arg, scope)
    raise ValueError(f"unknown condition operator {op!r}")


@dataclass
class FoundRef:
    node: str
    path: str
    field: str


def collect_node_refs(value: Any, field_name: str = "") -> list[FoundRef]:
    """Walk any value and collect every `$nodes.<id>...` (or `{{ nodes.<id>... }}`) reference with its field."""
    out: list[FoundRef] = []

    def walk(v: Any, f: str) -> None:
        if isinstance(v, str):
            for m in NODE_REF_RE.finditer(v):
                out.append(FoundRef(m.group(1), m.group(2) or "", f))
            for m in TEMPLATE_NODE_REF_RE.finditer(v):
                out.append(FoundRef(m.group(1), m.group(2) or "", f))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{f}[{i}]")
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{f}.{k}" if f else k)
        elif hasattr(v, "model_dump"):
            walk(v.model_dump(), f)

    walk(value, field_name)
    return out


def collect_status_conds(value: Any, field_name: str = "") -> list[FoundRef]:
    """`{status: [nodeId, status]}` conditions reference a node without a `$nodes.` string: count them as status edges."""
    out: list[FoundRef] = []

    def walk(v: Any, f: str) -> None:
        if isinstance(v, dict):
            if "status" in v and isinstance(v["status"], list) and len(v["status"]) == 2 and isinstance(v["status"][0], str):
                out.append(FoundRef(v["status"][0], ".status", f))
            for k, x in v.items():
                walk(x, f"{f}.{k}" if f else k)
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{f}[{i}]")
        elif hasattr(v, "model_dump"):
            walk(v.model_dump(), f)

    walk(value, field_name)
    return out


def uses_input(value: Any) -> bool:
    found = False

    def walk(v: Any) -> None:
        nonlocal found
        if found:
            return
        if isinstance(v, str):
            if re.search(r"\$(input|item|loop|repair)\b", v) or re.search(r"\{\{\s*(json\s+)?(input|item|loop|repair)\b", v):
                found = True
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif hasattr(v, "model_dump"):
            walk(v.model_dump())

    walk(value)
    return found
