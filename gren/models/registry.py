"""Model providers ("bridges"). Every provider is a Strands `Model`, so the same Agent loop, structured
output, hooks and telemetry apply whichever way the tokens are paid for.

  bedrock      strands.models.bedrock.BedrockModel      AWS credentials (the AWS-native default)
  anthropic    strands.models.anthropic.AnthropicModel  ANTHROPIC_API_KEY
  claude-code  gren.models.claude_code.ClaudeCodeModel  headless Claude Code sessions on the Claude Code login
  inbox        gren.models.inbox.InboxModel             an external worker (a Claude Code session via MCP, a human)
  mock         gren.models.mock.MockModel               deterministic, schema-driven, no tokens
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Any

from strands.models import Model

from .pricing import BEDROCK_ALIASES, MODEL_ALIASES, resolve_model

BRIDGE_NAMES = ("bedrock", "anthropic", "claude-code", "inbox", "mock")


@dataclass
class BridgeChoice:
    name: str
    source: str
    warning: str | None = None


def default_bridge(explicit: str | None = None) -> BridgeChoice:
    """explicit > GREN_BRIDGE > ANTHROPIC_API_KEY -> anthropic > AWS credentials -> bedrock > claude-code."""
    if explicit:
        return BridgeChoice(explicit, "explicit")
    env = os.environ.get("GREN_BRIDGE")
    if env:
        if env == "mock" and os.environ.get("GREN_ALLOW_MOCK") != "1":
            return BridgeChoice(_auto(), "default", "GREN_BRIDGE=mock ignored (set GREN_ALLOW_MOCK=1 to allow the mock provider from the environment)")
        if env not in BRIDGE_NAMES:
            return BridgeChoice(_auto(), "default", f'GREN_BRIDGE="{env}" is not a known provider; using {_auto()}')
        return BridgeChoice(env, "env")
    return BridgeChoice(_auto(), "auto")


def _has_aws() -> bool:
    if os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE") or os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        return True
    home = os.path.expanduser("~")
    return any(os.path.exists(os.path.join(home, ".aws", f)) for f in ("credentials", "config"))


def _auto() -> str:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    if _has_aws():
        return "bedrock"
    return "claude-code"


class ModelRegistry:
    """Builds Strands Model instances per (provider, model alias, node options). Instances are cheap; one per call."""

    def __init__(self, mock_options: dict[str, Any] | None = None, claude_path: str | None = None, runs_root: str | None = None,
                 inbox_options: dict[str, Any] | None = None):
        self.mock_options = mock_options or {}
        self.inbox_options = inbox_options or {}
        self.claude_path = claude_path
        self.runs_root = runs_root

    def available(self, name: str) -> tuple[bool, str]:
        if name == "anthropic":
            return (bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")), "ANTHROPIC_API_KEY")
        if name == "bedrock":
            return (_has_aws(), "AWS credentials (env, profile or ~/.aws)")
        if name == "claude-code":
            from .claude_code import find_claude_binary

            b = find_claude_binary(self.claude_path)
            return (b is not None, f"binary: {b}" if b else "claude binary not found (install Claude Code / set GREN_CLAUDE_PATH)")
        if name in ("inbox", "mock"):
            return (True, "always")
        return (False, f"unknown provider {name}")

    def describe(self, name: str) -> str:
        return {
            "bedrock": "Amazon Bedrock via Strands BedrockModel (AWS credentials)",
            "anthropic": "Anthropic API via Strands AnthropicModel (ANTHROPIC_API_KEY)",
            "claude-code": "headless Claude Code sessions (Claude Code login, tools run inside Claude Code)",
            "inbox": "orchestrator inbox: an external worker executes the call (Claude Code via MCP, CLI, or a human)",
            "mock": "deterministic schema-driven mock (no tokens)",
        }.get(name, "?")

    def model_id_for(self, name: str, alias_or_id: str | None) -> str:
        key = (alias_or_id or "sonnet").strip()
        if name == "bedrock":
            if key in BEDROCK_ALIASES:
                return BEDROCK_ALIASES[key]
            first_party = MODEL_ALIASES.get(key, key)
            return first_party if "." in first_party else f"global.anthropic.{first_party}"
        return resolve_model(key)

    def create(self, name: str, model: str | None, *, effort: str | None = None, max_tokens: int | None = None, node_opts: dict[str, Any] | None = None) -> Model:
        node_opts = node_opts or {}
        model_id = self.model_id_for(name, model)
        if name == "anthropic":
            from strands.models.anthropic import AnthropicModel

            params: dict[str, Any] = {}
            if effort:
                params["output_config"] = {"effort": effort}
            return AnthropicModel(model_id=model_id, max_tokens=max_tokens or 8000, params=params or None)
        if name == "bedrock":
            from strands.models.bedrock import BedrockModel

            kwargs: dict[str, Any] = {"model_id": model_id, "max_tokens": max_tokens or 8000}
            region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
            if region:
                kwargs["region_name"] = region
            return BedrockModel(**kwargs)
        if name == "claude-code":
            from .claude_code import ClaudeCodeModel

            return ClaudeCodeModel(model_id=model_id, effort=effort, binary=self.claude_path, **node_opts)
        if name == "inbox":
            from .inbox import InboxModel

            return InboxModel(model_id=model_id, effort=effort, runs_root=self.runs_root, **{**node_opts, **self.inbox_options})
        if name == "mock":
            from .mock import MockModel

            return MockModel(model_id=model_id, **self.mock_options)
        raise ValueError(f"unknown model provider '{name}' (known: {', '.join(BRIDGE_NAMES)})")


def which_claude() -> str | None:
    return shutil.which("claude")
