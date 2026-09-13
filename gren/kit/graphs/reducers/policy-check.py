# Deterministic policy check for a drafted support reply: refund limits per tier, forbidden phrases, absolute promises.
# input: { reply: {text, refund_usd?, escalate?}, label, tier, policies: { refund_limit_usd, tier_limits: {tier: usd}, forbidden_phrases: [] } }
import re


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def reduce(input, args, ctx):
    p = input.get("policies") or {}
    reply = input.get("reply") or {}
    text = reply if isinstance(reply, str) else str(reply.get("text") or reply.get("reply") or "")
    refund = _num(reply.get("refund_usd") if isinstance(reply, dict) else None) or _num(input.get("refund_usd"))
    tier_limits = p.get("tier_limits") or {}
    tier_limit = _num(tier_limits.get(str(input.get("tier"))) if isinstance(tier_limits, dict) and input.get("tier") in tier_limits else p.get("refund_limit_usd"))
    violations: list[str] = []
    if refund > tier_limit:
        violations.append(f'refund ${refund:g} exceeds the ${tier_limit:g} limit for tier "{input.get("tier") or "default"}"')
    for phrase in p.get("forbidden_phrases") or []:
        if str(phrase).lower() in text.lower():
            violations.append(f'forbidden phrase: "{phrase}"')
    if re.search(r"\b(guarantee|100%|will never happen again|legally)\b", text, re.IGNORECASE):
        violations.append("reply makes an absolute or legal promise")
    needs_human = bool(violations) or input.get("label") == "legal" or (isinstance(reply, dict) and reply.get("escalate") is True)
    return {"ok": not violations, "violations": violations, "needs_human": needs_human, "refund_usd": refund, "tier_limit_usd": tier_limit, "label": input.get("label")}
