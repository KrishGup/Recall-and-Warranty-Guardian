"""The JSON schemas in the graph YAML and the pydantic models must describe the same shapes, and both graphs must pass
gren's static analysis (dependency test, frozen constraints)."""
import os

import yaml
from gren.spec.analyze import analyze
from gren.spec.load import load_graph
from jsonschema import validate

from guardian.models import ActionReport, CoverageAssessment, MatchVerdict, SurfaceDecision, SurfacePlan
from guardian.service import GRAPHS_DIR


def _nodes(name: str) -> dict:
    with open(os.path.join(GRAPHS_DIR, name), encoding="utf-8") as f:
        return {n["id"]: n for n in yaml.safe_load(f)["nodes"]}


def test_sweep_schemas_match_models():
    n = _nodes("nightly-sweep.yaml")
    validate(MatchVerdict(match_id="a~b", is_match="unsure", confidence=0.4, rationale="one fact would settle it: the model number", missing_info=["model number"]).model_dump(), n["matcher"]["output_schema"])
    plan = SurfacePlan(channel="sms_now", severity="critical", decisions=[SurfaceDecision(kind="recall_remedy", match_id="a~b", item_id="a", recall_id="b", severity="critical", headline="h", message="m", remedy_label="Request refund")], digest_count=0, rationale="r")
    validate(plan.model_dump(), n["triage"]["output_schema"])
    validate(ActionReport(decision_id="d", item_id="a", recall_id="b", type="email_remedy_request", to="x@y.z", subject="s", body="b" * 90).model_dump(), n["remedy"]["output_schema"])
    validate(CoverageAssessment(item_id="a", covered=True, ask=True, question="q", ask_on="2026-09-17", reason="r").model_dump(), n["warranty"]["output_schema"])


def test_graphs_pass_static_analysis():
    for name in ("nightly-sweep.yaml", "intake.yaml"):
        a = analyze(load_graph(os.path.join(GRAPHS_DIR, name)).spec)
        errors = [f for f in a.findings if f.level == "error"]
        assert a.ok and not errors, [f"{f.code}: {f.message}" for f in errors]
    a = analyze(load_graph(os.path.join(GRAPHS_DIR, "nightly-sweep.yaml")).spec)
    edges = {(e["from"], e["to"]) for e in [x.to_dict() for x in a.edges]}
    assert ("severity_check", "household_decision") in edges and ("household_decision", "answers") in edges and ("answers", "remedy") in edges
    assert "verifier_can_kill" in a.frozen and "gate_before_side_effect" in a.frozen
