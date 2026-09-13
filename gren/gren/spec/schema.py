"""The graph spec: nodes, edges (derived from data references), gates, budgets, frozen constraints.

Design rules encoded here (from the two Graph Engineering essays):
  - An edge is a DATA contract, not an arrow. Edges are derived from `$nodes.<id>...` references.
  - Every node has one job, explicit input, structured output, and an explicit failure policy.
  - Human approval is an edge type (`gate` nodes + `requires_gate`), not a prompt instruction.
  - Every cycle (loop / repair) has a hard stop and a budget.
  - Some rules are frozen: they are validated by the engine, not suggested to the model.

The spec format is unchanged from gren 1 so graphs, the skill and the dashboard carry over.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

Effort = Literal["low", "medium", "high", "xhigh", "max"]

FROZEN_CONSTRAINTS: dict[str, str] = {
    "gate_before_side_effect": "Every node with side_effect:true must declare requires_gate pointing at a gate node. Publishing is unreachable without approval.",
    "spend_cap": "budget.max_cost_usd must be set; the engine hard-stops the run when it is exceeded.",
    "no_unbounded_loops": "Every loop and repair cycle must have a hard stop (max_rounds) - enforced structurally.",
    "structured_outputs_only": "Every agent/verify node must declare output_schema; free text never crosses an edge.",
    "no_status_only_edges": "`after:` ordering-only edges are forbidden - every edge must carry data.",
    "verifier_can_kill": "Every verify node's verdict must be consumed downstream (survivors/killed) or drive a repair; a verifier nobody listens to is decoration.",
    "width_budget": "budget.max_width must be set; fan-out is capped by it.",
    "no_side_effect_retry_without_idempotency": "side_effect nodes are executed at most once per run (idempotency key = run+node), never re-run on resume.",
}
DEFAULT_FROZEN = [
    "gate_before_side_effect",
    "spend_cap",
    "no_unbounded_loops",
    "structured_outputs_only",
    "no_side_effect_retry_without_idempotency",
]

VERIFY_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "kill"]},
        "reasons": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["verdict", "reasons", "confidence"],
    "additionalProperties": False,
}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Fallback(_Strict):
    model: str | None = None
    bridge: str | None = None


class FailurePolicy(_Strict):
    retries: int | None = Field(default=None, ge=0, le=10)
    backoff_ms: int | None = Field(default=None, ge=0)
    timeout_ms: int | None = Field(default=None, ge=1000)
    fallback: Fallback | None = None
    on_failure: Literal["block", "continue"] | None = None
    quorum: float | None = Field(default=None, ge=0, le=1)
    repair_attempts: int | None = Field(default=None, ge=0, le=5)


class EffectiveFailure(BaseModel):
    retries: int = 1
    backoff_ms: int = 1500
    timeout_ms: int = 300_000
    on_failure: Literal["block", "continue"] = "block"
    quorum: float = 1.0
    repair_attempts: int = 1
    fallback: Fallback | None = None


class Budget(_Strict):
    max_cost_usd: float | None = Field(default=None, gt=0)
    max_wall_ms: int | None = Field(default=None, gt=0)
    max_width: int | None = Field(default=None, gt=0)
    max_agent_calls: int | None = Field(default=None, gt=0)
    max_tokens: int | None = Field(default=None, gt=0)


class After(_Strict):
    node: str
    reason: str = Field(min_length=3)


class Repair(_Strict):
    node: str
    max_rounds: int = Field(ge=1, le=10)


class Route(_Strict):
    when: Any
    route: str
    reason: str | None = None


class OnReject(_Strict):
    route: str | None = None
    fail_run: bool | None = None


class LoopUntil(_Strict):
    max_rounds: int = Field(ge=1, le=100)
    no_new_for_rounds: int | None = Field(default=None, ge=1)
    max_cost_usd: float | None = Field(default=None, gt=0)
    max_wall_ms: int | None = Field(default=None, gt=0)
    converged: Any = None


class NodeBase(_Strict):
    id: str = Field(pattern=r"^[a-zA-Z_][a-zA-Z0-9_\-]*$")
    description: str | None = None
    input: dict[str, Any] | None = None
    when: Any = None
    after: list[After] | None = None
    optional: list[str] | None = None
    failure: FailurePolicy | None = None
    requires_gate: str | list[str] | None = None
    side_effect: bool = False
    map: str | None = None
    max_width: int | None = Field(default=None, gt=0)
    tags: list[str] | None = None
    est_ms: int | None = Field(default=None, gt=0)


class AgentNode(NodeBase):
    kind: Literal["agent"]
    model: str | None = None
    bridge: str | None = Field(default=None, description="model provider: bedrock | anthropic | claude-code | inbox | mock")
    effort: Effort | None = None
    system: str | None = None
    prompt: str = Field(min_length=1)
    output_schema: dict[str, Any]
    tools: list[str] | None = None
    max_turns: int | None = Field(default=None, gt=0)
    max_output_tokens: int | None = Field(default=None, gt=0)
    cwd: str | None = None
    max_cost_usd: float | None = Field(default=None, gt=0)


class CodeNode(NodeBase):
    kind: Literal["code"]
    fn: str | None = None
    module: str | None = None
    args: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None


class VerifyNode(NodeBase):
    kind: Literal["verify"]
    target: str
    mode: Literal["agent", "code"] | None = None
    model: str | None = None
    bridge: str | None = None
    effort: Effort | None = None
    system: str | None = None
    prompt: str | None = None
    tools: list[str] | None = None
    max_turns: int | None = Field(default=None, gt=0)
    cwd: str | None = None
    max_cost_usd: float | None = Field(default=None, gt=0)
    fn: str | None = None
    module: str | None = None
    args: dict[str, Any] | None = None
    kill_threshold: float | None = Field(default=None, ge=0, le=1)
    min_survivors: int | None = Field(default=None, ge=0)
    repair: Repair | None = None


class GateNode(NodeBase):
    kind: Literal["gate"]
    title: str
    prompt: str | None = None
    approve_effect: str | None = None
    reject_effect: str | None = None
    show: Any = None
    timeout_ms: int | None = Field(default=None, gt=0)
    on_timeout: Literal["reject", "wait"] | None = None
    on_reject: OnReject | None = None
    auto_approve_when: Any = None


class RouterNode(NodeBase):
    kind: Literal["router"]
    routes: list[Route] = Field(min_length=1)
    default: str


class LoopNode(NodeBase):
    kind: Literal["loop"]
    body: "GraphSpec"
    until: LoopUntil
    collect: str
    seen_key: str | None = None
    on_nonconvergence: Literal["accept", "fail"] | None = None


class SubgraphNode(NodeBase):
    kind: Literal["subgraph"]
    graph: Union[str, "GraphSpec"]


NodeSpec = Annotated[
    Union[AgentNode, CodeNode, VerifyNode, GateNode, RouterNode, LoopNode, SubgraphNode],
    Field(discriminator="kind"),
]


class Defaults(_Strict):
    bridge: str | None = None
    model: str | None = None
    effort: Effort | None = None
    failure: FailurePolicy | None = None


class GraphSpec(_Strict):
    name: str = Field(min_length=1)
    version: int | str | None = None
    description: str | None = None
    goal: str | None = None
    input_schema: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None
    budget: Budget | None = None
    frozen: list[str] | None = None
    defaults: Defaults | None = None
    nodes: list[NodeSpec] = Field(min_length=1)

    @field_validator("frozen")
    @classmethod
    def _known_frozen(cls, v: list[str] | None) -> list[str] | None:
        if v:
            unknown = [x for x in v if x not in FROZEN_CONSTRAINTS]
            if unknown:
                raise ValueError(f"unknown frozen constraint(s): {', '.join(unknown)}")
        return v

    def node(self, node_id: str) -> NodeSpec | None:
        for n in self.nodes:
            if n.id == node_id:
                return n
        return None


LoopNode.model_rebuild()
SubgraphNode.model_rebuild()
GraphSpec.model_rebuild()


def effective_failure(spec: GraphSpec, node: NodeBase) -> EffectiveFailure:
    merged: dict[str, Any] = {}
    if spec.defaults and spec.defaults.failure:
        merged.update(spec.defaults.failure.model_dump(exclude_none=True))
    if node.failure:
        merged.update(node.failure.model_dump(exclude_none=True))
    return EffectiveFailure(**merged)


def effective_frozen(spec: GraphSpec) -> list[str]:
    out: list[str] = list(DEFAULT_FROZEN)
    for f in spec.frozen or []:
        if f not in out:
            out.append(f)
    return out


def gates_of(node: NodeBase) -> list[str]:
    if not node.requires_gate:
        return []
    return list(node.requires_gate) if isinstance(node.requires_gate, list) else [node.requires_gate]
