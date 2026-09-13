"""JSON-schema validation of everything that crosses an edge, plus JSON schema -> Pydantic model for Strands
structured output (Strands turns the Pydantic model into a tool spec the model must call)."""
from __future__ import annotations

import copy
import hashlib
import json
import re
from typing import Any, Literal

import jsonschema
from pydantic import BaseModel, ConfigDict, Field, create_model

_validators: dict[str, jsonschema.protocols.Validator] = {}
_models: dict[str, type[BaseModel]] = {}


def _key(schema: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(schema, sort_keys=True, default=str).encode()).hexdigest()


def validate_against(schema: dict[str, Any] | None, value: Any) -> tuple[bool, list[str]]:
    if not schema:
        return True, []
    key = _key(schema)
    v = _validators.get(key)
    if v is None:
        try:
            cls = jsonschema.validators.validator_for(schema)
            cls.check_schema(schema)
            v = cls(schema)
        except jsonschema.SchemaError as e:
            return False, [f"invalid JSON schema: {e.message}"]
        _validators[key] = v
    errors = []
    for err in sorted(v.iter_errors(value), key=lambda e: list(e.path)):
        path = "/".join(str(p) for p in err.path) or "<root>"
        errors.append(f"{path} {err.message}")
    return (not errors), errors[:20]


def apply_defaults(schema: dict[str, Any] | None, value: Any) -> Any:
    """Fill in `default` values declared in an object schema (top-level and nested objects)."""
    if not schema:
        return value
    t = schema.get("type")
    t = t[0] if isinstance(t, list) else t
    if value is None and "default" in schema:
        return copy.deepcopy(schema["default"])
    if t == "object" and isinstance(schema.get("properties"), dict):
        src = value if isinstance(value, dict) else {}
        out = dict(src)
        for k, sub in schema["properties"].items():
            v = apply_defaults(sub, src.get(k))
            if v is not None:
                out[k] = v
        return out
    if t == "array" and isinstance(value, list) and isinstance(schema.get("items"), dict):
        return [apply_defaults(schema["items"], x) for x in value]
    return value


def _py_name(name: str) -> str:
    n = re.sub(r"[^0-9a-zA-Z_]", "_", name)
    if not n or n[0].isdigit():
        n = f"f_{n}"
    return n


def _field_type(schema: dict[str, Any], name: str) -> Any:
    t = schema.get("type")
    t = t[0] if isinstance(t, list) else t
    if "enum" in schema and schema["enum"]:
        return Literal[tuple(schema["enum"])]  # type: ignore[valid-type]
    if t == "object":
        return json_schema_to_model(schema, name=_py_name(name).title() or "Obj")
    if t == "array":
        items = schema.get("items") if isinstance(schema.get("items"), dict) else {"type": "string"}
        return list[_field_type(items, f"{name}_item")]  # type: ignore[misc]
    if t == "integer":
        return int
    if t == "number":
        return float
    if t == "boolean":
        return bool
    if t == "null":
        return None
    if t == "string":
        return str
    return Any


def json_schema_to_model(schema: dict[str, Any], name: str = "Output") -> type[BaseModel]:
    """Build a Pydantic model that mirrors an object JSON schema (the subset gren specs use)."""
    key = f"{name}:{_key(schema)}"
    cached = _models.get(key)
    if cached is not None:
        return cached
    props: dict[str, Any] = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    fields: dict[str, Any] = {}
    for prop, sub in props.items():
        py = _py_name(prop)
        typ = _field_type(sub, f"{name}_{prop}")
        kwargs: dict[str, Any] = {"alias": prop} if py != prop else {}
        if sub.get("description"):
            kwargs["description"] = sub["description"]
        for js, pd in (("minimum", "ge"), ("maximum", "le"), ("minLength", "min_length"), ("maxLength", "max_length"), ("minItems", "min_length"), ("maxItems", "max_length")):
            if js in sub:
                kwargs[pd] = sub[js]
        if prop in required:
            fields[py] = (typ, Field(**kwargs))
        else:
            fields[py] = (typ | None, Field(default=None, **kwargs))  # type: ignore[operator]
    extra = "forbid" if schema.get("additionalProperties") is False else "allow"
    model = create_model(_py_name(name), __config__=ConfigDict(extra=extra, populate_by_name=True), **fields)  # type: ignore[call-overload]
    model.__gren_schema__ = schema  # the original JSON schema: providers send this, not pydantic's $ref form
    _models[key] = model
    return model


def schema_of(model: type[BaseModel]) -> dict[str, Any]:
    """The JSON schema a provider should send: the gren spec's own schema when the model was built from one,
    otherwise pydantic's schema with $refs inlined."""
    s = getattr(model, "__gren_schema__", None)
    if isinstance(s, dict):
        return s
    return inline_refs(model.model_json_schema(by_alias=True))


def inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    defs = schema.get("$defs") or schema.get("definitions") or {}

    def walk(v: Any) -> Any:
        if isinstance(v, dict):
            if "$ref" in v and isinstance(v["$ref"], str):
                name = v["$ref"].rsplit("/", 1)[-1]
                target = defs.get(name)
                if target is not None:
                    return walk({**target, **{k: x for k, x in v.items() if k != "$ref"}})
            return {k: walk(x) for k, x in v.items() if k not in ("$defs", "definitions")}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(schema)


def model_to_plain(value: Any) -> Any:
    """Pydantic model (possibly nested) -> plain JSON-compatible data using the schema's own field names."""
    if isinstance(value, BaseModel):
        return value.model_dump(by_alias=True, mode="json")
    if isinstance(value, list):
        return [model_to_plain(x) for x in value]
    if isinstance(value, dict):
        return {k: model_to_plain(v) for k, v in value.items()}
    return value
