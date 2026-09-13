"""Load a graph spec from YAML/JSON, validate it, resolve subgraph files, make module paths absolute."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from .schema import GraphSpec


class SpecError(Exception):
    def __init__(self, message: str, issues: list[str] | None = None):
        super().__init__(message)
        self.message = message
        self.issues = issues or []


@dataclass
class LoadedGraph:
    spec: GraphSpec
    file: str
    dir: str


def validate_spec_object(raw: Any, file: str = "<inline>") -> GraphSpec:
    try:
        return GraphSpec.model_validate(raw)
    except ValidationError as e:
        issues = []
        for err in e.errors():
            loc = ".".join(str(p) for p in err.get("loc", ())) or "<root>"
            issues.append(f"{loc}: {err.get('msg')}")
        raise SpecError(f"{file}: invalid graph spec ({len(issues)} issue{'s' if len(issues) != 1 else ''})", issues) from None


def parse_spec_text(text: str, file: str = "<inline>") -> GraphSpec:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise SpecError(f"{file}: could not parse YAML/JSON: {e}") from None
    return validate_spec_object(raw, file)


def _resolve_nested(spec: GraphSpec, base_dir: str, seen: set[str]) -> None:
    for node in spec.nodes:
        kind = node.kind
        if kind == "subgraph":
            if isinstance(node.graph, str):
                sub = load_graph(os.path.join(base_dir, node.graph), set(seen))
                node.graph = sub.spec
            else:
                _resolve_nested(node.graph, base_dir, seen)
        elif kind == "loop":
            _resolve_nested(node.body, base_dir, seen)
        if kind in ("code", "verify") and getattr(node, "module", None) and not os.path.isabs(node.module):
            node.module = os.path.abspath(os.path.join(base_dir, node.module))


def load_graph(file: str, seen: set[str] | None = None) -> LoadedGraph:
    seen = seen if seen is not None else set()
    abs_path = os.path.abspath(file)
    if abs_path in seen:
        raise SpecError(f"subgraph cycle: {abs_path} includes itself")
    seen.add(abs_path)
    if not os.path.exists(abs_path):
        raise SpecError(f"spec file not found: {abs_path}")
    text = Path(abs_path).read_text(encoding="utf8")
    spec = parse_spec_text(text, abs_path)
    base_dir = os.path.dirname(abs_path)
    _resolve_nested(spec, base_dir, seen)
    return LoadedGraph(spec=spec, file=abs_path, dir=base_dir)


def load_graph_from_object(raw: Any, base_dir: str | None = None) -> LoadedGraph:
    spec = validate_spec_object(raw)
    base_dir = base_dir or os.getcwd()
    _resolve_nested(spec, base_dir, set())
    return LoadedGraph(spec=spec, file="<inline>", dir=base_dir)
