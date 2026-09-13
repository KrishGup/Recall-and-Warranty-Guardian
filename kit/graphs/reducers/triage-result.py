# Deterministic per-ticket result: needs_human is computed by code from the route, the policy check and the verifier.
# input: { ticket, label, trail, route, reply_survivors, reply_killed, policy }


def reduce(input, args, ctx):
    survivors = input.get("reply_survivors") if isinstance(input.get("reply_survivors"), list) else []
    killed = input.get("reply_killed") if isinstance(input.get("reply_killed"), list) else []
    policy = input.get("policy") or {}
    label = input.get("label")
    label_value = label.get("label") if isinstance(label, dict) else label
    confidence = label.get("confidence") if isinstance(label, dict) else None
    escalated = input.get("route") == "escalate"
    reply = survivors[0] if survivors else None
    reasons: list[str] = []
    if escalated:
        reasons.append(f"routed to escalate (label {label_value or '?'})")
    if policy.get("needs_human"):
        reasons.extend(policy.get("violations") or ["policy check requires a human"])
    if not escalated and reply is None:
        reasons.append(f"reply rejected by verifier: {'; '.join((killed[0].get('reasons') or []) if isinstance(killed[0], dict) else [])}" if killed else "no reply drafted")
    ticket = input.get("ticket") or {}
    return {
        "ticket_id": ticket.get("id"), "customer": ticket.get("customer"), "tier": ticket.get("tier"), "label": label_value, "confidence": confidence,
        "route": input.get("route"), "reply": reply, "refund_usd": (reply.get("refund_usd") if isinstance(reply, dict) else None) or 0,
        "needs_human": bool(reasons), "reasons": reasons, "trail": input.get("trail") or {}, "policy": policy,
    }
