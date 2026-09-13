# Node answers: turn the household's gate approval into the list of approved decisions the remedy agent works on.
# The approval comment carries per-decision answers as JSON: {"answers": [{"index": 0, "decision_id": "...", "choice": "request_remedy"}]}.
# An approval without a parseable comment (CLI `gren approve`, --auto-approve) approves every decision in the plan.
import json

from guardian.models import now_iso

APPROVE = {"request_remedy", "report_problem"}


def reduce(input, args, ctx):
    gate = input.get("decision") or {}
    plan = input.get("plan") or {}
    decisions = plan.get("decisions") or []
    answers = []
    try:
        parsed = json.loads(gate.get("comment") or "")
        answers = list(parsed.get("answers") or []) if isinstance(parsed, dict) else []
    except (ValueError, TypeError):
        answers = []
    by_index = {int(a.get("index", -1)): a for a in answers if isinstance(a, dict)}
    approved, rejected = [], []
    for i, d in enumerate(decisions):
        a = by_index.get(i)
        choice = str(a.get("choice")) if a else ("request_remedy" if gate.get("decision") == "approved" else "not_mine")
        rec = {**d, "index": i, "decision_id": (a or {}).get("decision_id"), "choice": choice, "answered_by": (a or {}).get("by") or gate.get("by") or "household"}
        (approved if choice in APPROVE else rejected).append(rec)
    ctx.log(f"{len(approved)} approved, {len(rejected)} declined (gate {gate.get('decision')} by {gate.get('by')})")
    return {"approved": approved, "approved_count": len(approved), "rejected": rejected, "rejected_count": len(rejected), "by": gate.get("by"), "at": now_iso(), "_stats": {"in": len(decisions), "out": len(approved)}}
