"""The ported example reducers (graphs/reducers/*.py) - deterministic plumbing must stay deterministic."""
import os

from gren.reducers.builtin import ReducerCtx, load_reducer_module

RED = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "graphs", "reducers")
CTX = ReducerCtx("run-1", "n", lambda m: None)


def _r(name: str):
    return load_reducer_module(os.path.join(RED, f"{name}.py"))


def test_citation_check_canonicalises_urls():
    ok = _r("citation-check")({"item": {"heading": "Findings", "body": "x" * 100, "citations": ["https://arxiv.org/pdf/2401.12345v2"]}, "allowed": ["http://www.arxiv.org/abs/2401.12345/"]}, {}, CTX)
    assert ok["verdict"] == "pass"
    bad = _r("citation-check")({"item": {"heading": "Findings", "body": "x" * 100, "citations": ["https://example.org/other"]}, "allowed": ["https://example.org/a"]}, {}, CTX)
    assert bad["verdict"] == "kill" and bad["confidence"] == 1
    meta = _r("citation-check")({"item": {"heading": "Limits of this evidence", "body": "y" * 100, "citations": []}, "allowed": []}, {}, CTX)
    assert meta["verdict"] == "pass"


def test_prioritize_and_markdown_table():
    p = _r("prioritize")({"items": [{"severity": "minor", "category": "docs", "title": "a"}, {"severity": "blocker", "category": "security", "title": "b"}, {"severity": "major", "category": "tests", "title": "c"}]}, {"k": 2}, CTX)
    assert [i["title"] for i in p["items"]] == ["b", "c"] and p["dropped"] == 1 and p["by_severity"]["blocker"] == 1
    t = _r("markdown-table")({"items": [{"a": 1, "b": "x|y"}, {"a": 2, "b": None}]}, {}, CTX)
    assert t["rows"] == 2 and "x\\|y" in t["markdown"] and t["markdown"].startswith("| a | b |")


def test_policy_check_and_triage_result():
    pc = _r("policy-check")({"reply": {"text": "We guarantee a refund", "refund_usd": 80}, "tier": "free", "label": "billing", "policies": {"tier_limits": {"free": 25}, "forbidden_phrases": ["guarantee"]}}, {}, CTX)
    assert not pc["ok"] and len(pc["violations"]) == 3 and pc["needs_human"]
    tr = _r("triage-result")({"ticket": {"id": "t1", "customer": "c", "tier": "free"}, "label": {"label": "billing", "confidence": 0.9}, "route": "auto", "reply_survivors": [], "reply_killed": [{"reasons": ["too vague"]}], "policy": pc}, {}, CTX)
    assert tr["needs_human"] and any("verifier" in r for r in tr["reasons"]) and tr["ticket_id"] == "t1"


def test_write_file_and_assemble(tmp_path):
    a = _r("assemble-report")({"title": "T", "summary": "S", "sections": [{"heading": "H", "body": "B", "citations": ["https://x.org/1"]}], "sources": [{"url": "https://x.org/1", "title": "one"}], "caveats": ["c"]}, {}, CTX)
    assert a["citations_used"] == 1 and a["citations_unknown"] == [] and "## Sources" in a["markdown"]
    w = _r("write-file")({"markdown": a["markdown"]}, {"dir": str(tmp_path), "name": "rep"}, CTX)
    assert w["written"] and os.path.exists(w["file"]) and w["bytes"] > 10


def test_inventory_and_run_command():
    inv = _r("inventory")({"repo_path": os.path.dirname(RED), "include": ["reducers"]}, {"exts": [".py"]}, CTX)
    assert inv["file_count"] >= 15 and inv["modules"][0]["module"] == "reducers"
    rc = _r("run-command")({"command": "python", "args": ["-c", "print('hello')"]}, {"timeout_ms": 30000}, CTX)
    assert rc["passed"] and "hello" in rc["stdout_tail"]
