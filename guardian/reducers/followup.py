# Node followup (side effect, gated): send each drafted remedy request, record the action on the decision, close the
# match, and schedule the 10-business-day follow-up. Executed at most once per run; never re-run on resume.
from datetime import date, timedelta

from guardian.models import Activity, now_iso
from guardian.notify import Notifier
from guardian.store import Store


def business_days_from(start: date, n: int) -> date:
    d = start
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def reduce(input, args, ctx):
    store = Store.default()
    notifier = Notifier(store)
    answers = input.get("answers") or {}
    approved_list = [a for a in (answers.get("approved") or []) if isinstance(a, dict)]
    approved = {str(a.get("decision_id")): a for a in approved_list if a.get("decision_id")}
    by_item = {str(a.get("item_id")): a for a in approved_list if a.get("item_id")}
    # `actions` are the remedy node's per-item records ({index, status, output}); index i drafted approved_list[i].
    # The index is the reliable link; the ids the model echoes back are the fallback.
    actions = []
    for rec in input.get("actions") or []:
        if not isinstance(rec, dict) or rec.get("status") != "completed" or not isinstance(rec.get("output"), dict):
            continue
        out = dict(rec["output"])
        i = rec.get("index")
        if isinstance(i, int) and 0 <= i < len(approved_list):
            ans = approved_list[i]
            if ans.get("decision_id") and store.decision(str(ans["decision_id"])) is not None:
                out["decision_id"] = str(ans["decision_id"])
            if ans.get("item_id") and store.item(str(ans["item_id"])) is not None:
                out["item_id"] = str(ans["item_id"])
        actions.append(out)
    sent, emails = 0, []
    today = date.today()
    for a in actions:
        dec_id = str(a.get("decision_id") or "")
        decision = store.decision(dec_id)
        if decision is None and a.get("item_id") in by_item and by_item[str(a.get("item_id"))].get("decision_id"):
            # the drafting agent did not echo the decision id; recover it from the approved answer for the same item
            dec_id = str(by_item[str(a.get("item_id"))]["decision_id"])
            decision = store.decision(dec_id)
        item = store.item(str(a.get("item_id") or "")) if a.get("item_id") else None
        item_name = f"{item.brand} {item.name}".strip() if item else str(a.get("item_id"))
        next_check = business_days_from(today, int(a.get("next_check_days") or 10))
        delivery = notifier.email(to=a.get("to"), subject=str(a.get("subject") or ""), body=str(a.get("body") or ""), attachments=list(a.get("attachments") or []), ref={"decision_id": dec_id, "run_id": ctx.run_id, "type": a.get("type")})
        sent += 1
        emails.append({"decision_id": dec_id, "to": a.get("to"), "subject": a.get("subject"), "delivery": delivery, "next_check_at": next_check.isoformat()})
        if decision is not None:
            decision.action = {**a, "delivery": delivery, "next_check_at": next_check.isoformat(), "sent_at": now_iso()}
            choice = (approved.get(dec_id) or {}).get("choice") or (decision.answer or {}).get("choice") or "request_remedy"
            decision.outcome = {
                "title": "Remedy requested" if decision.kind == "recall_remedy" else "Claim sent",
                "subtitle": "Guardian takes it from here. You will only hear back if the manufacturer goes quiet.",
                "steps": [
                    {"text": f"You approved: {decision.remedy_label.lower() or choice.replace('_', ' ')}", "when": "Just now", "done": True},
                    {"text": f"{'Remedy request' if decision.kind == 'recall_remedy' else 'Claim'} emailed to {a.get('to') or 'the recall contact'}" + (" with receipt attached" if a.get("attachments") else ""), "when": f"Just now · {delivery.get('note') or 'via SES'}", "done": True},
                    {"text": "Follow-up check scheduled", "when": f"{next_check.isoformat()} · {a.get('next_check_days') or 10} business days", "done": False},
                    {"text": "Guardian nudges once if they stay silent", "when": "Only if needed", "done": False},
                ],
            }
            decision.state = "answered"
            store.upsert_decision(decision)
            if decision.match_id:
                m = store.match(decision.match_id)
                if m is not None:
                    m.state = "closed"
                    store.upsert_match(m)
        store.log(Activity(source="Remedy", text=f"{'Remedy request' if a.get('type') != 'email_warranty_claim' else 'Warranty claim'} for {item_name} emailed to {a.get('to') or 'the recall contact'}" + (" with receipt attached" if a.get("attachments") else ""),
                           result=delivery.get("note") or "sent", tone="ok", run_id=ctx.run_id, item_id=item.id if item else None, decision_id=dec_id or None))
        store.log(Activity(source="Remedy", text=f"Follow-up check scheduled for {item_name}", result=f"{next_check.isoformat()} · nudges once if silent", tone="muted", run_id=ctx.run_id, item_id=item.id if item else None, decision_id=dec_id or None))
    ctx.log(f"{sent} request(s) sent")
    return {"sent": sent, "emails": emails, "next_check_at": emails[0]["next_check_at"] if emails else None, "_stats": {"in": len(actions), "out": sent}}
