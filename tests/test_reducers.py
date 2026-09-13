"""Reducer contracts that the graph tests do not reach directly."""
from types import SimpleNamespace

from guardian.models import Decision, DecisionOption
from guardian.reducers import answers as answers_mod
from guardian.reducers import followup as followup_mod
from guardian.reducers import redact as redact_mod
from tests.conftest import seed_store


def _ctx():
    return SimpleNamespace(run_id="run-test", node_id="followup", log=lambda m: None)


def _decision(store, item_id: str, headline: str) -> Decision:
    d = Decision(kind="recall_remedy", severity="critical", state="answered", run_id="run-test", gate="household_decision", item_id=item_id, item_name=headline, headline=headline,
                 remedy_label="Request full refund", options=[DecisionOption(key="request_remedy", label="Request full refund", style="critical")], answer={"choice": "request_remedy", "by": "test", "at": "2026-09-13T00:00:00Z"})
    store.upsert_decision(d)
    return d


ACTION = {"decision_id": "not-a-real-id", "item_id": "wrong-item", "recall_id": "cpsc#26761", "type": "email_remedy_request", "to": "recall@example.test", "subject": "Refund request", "body": "b" * 100, "attachments": ["receipt-2026-06-02.pdf"], "next_check_days": 10}


def test_followup_accepts_per_item_records_and_links_by_index(store, demo):
    seed_store(store, demo, only={"itm_finger_lights"})
    d = _decision(store, "itm_finger_lights", "finger lights")
    answers = {"approved": [{"index": 0, "decision_id": d.id, "item_id": "itm_finger_lights", "choice": "request_remedy"}]}
    out = followup_mod.reduce({"actions": [{"index": 0, "status": "completed", "output": ACTION}], "answers": answers}, {}, _ctx())
    assert out["sent"] == 1 and out["emails"][0]["decision_id"] == d.id
    assert store.decision(d.id).action["to"] == "recall@example.test" and store.decision(d.id).outcome["title"] == "Remedy requested"


def test_followup_accepts_plain_outputs_from_older_spec_snapshots(store, demo):
    seed_store(store, demo, only={"itm_finger_lights"})
    d = _decision(store, "itm_finger_lights", "finger lights")
    answers = {"approved": [{"index": 0, "decision_id": d.id, "item_id": "itm_finger_lights", "choice": "request_remedy"}]}
    out = followup_mod.reduce({"actions": [ACTION], "answers": answers}, {}, _ctx())
    assert out["sent"] == 1 and store.decision(d.id).action is not None
    failed = followup_mod.reduce({"actions": [{"index": 0, "status": "failed", "error": "timeout"}], "answers": answers}, {}, _ctx())
    assert failed["sent"] == 0


def test_answers_skips_indexes_absent_from_an_explicit_approval():
    plan = {"decisions": [{"item_id": "a"}, {"item_id": "b"}, {"item_id": "c"}]}
    gate = {"decision": "approved", "by": "dashboard", "comment": '{"answers": [{"index": 0, "decision_id": "d0", "choice": "request_remedy"}, {"index": 2, "decision_id": "d2", "choice": "not_mine"}]}'}
    out = answers_mod.reduce({"decision": gate, "plan": plan}, {}, _ctx())
    assert [a["item_id"] for a in out["approved"]] == ["a"] and [a["item_id"] for a in out["rejected"]] == ["c"]
    everything = answers_mod.reduce({"decision": {"decision": "approved", "by": "cli", "comment": None}, "plan": plan}, {}, _ctx())
    assert everything["approved_count"] == 3


def test_redact_strips_only_luhn_valid_card_numbers():
    text, n = redact_mod.redact("Paid with Visa 4111 1111 1111 1111 on order 1234567890123 ref 4111-1111-1111-1111")
    assert n == 2 and "4111" not in text and "1234567890123" in text and text.count("[card removed]") == 2
