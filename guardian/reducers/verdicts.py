# Node verdicts: persist the matcher's MatchVerdicts, join certain matches, and hand triage one compact list of
# confirmed matches with the item, the recall, the evidence and the contact. No tokens.
from guardian.models import MatchCandidate
from guardian.store import Store


def _payload(store: Store, m: MatchCandidate):
    it = store.item(m.item_id)
    r = store.recall(m.recall_id)
    if it is None or r is None:
        return None
    sold_from, sold_to = r.sold_window()
    return {
        "match_id": m.id, "stage": m.stage, "key": m.key, "verdict": m.verdict, "confidence": m.confidence, "rationale": m.rationale, "missing_info": m.missing_info,
        "item": {"id": it.id, "name": it.name, "brand": it.brand, "model_number": it.model_number, "upc": it.upc, "category": it.category, "purchase_date": it.purchase_date, "retailer": it.retailer, "price": it.price, "has_receipt": bool(it.receipt_text or it.receipt_ref)},
        "recall": {"recall_id": r.recall_id, "native_id": r.native_id, "source": r.source, "source_label": r.source_label, "title": r.title, "published_at": r.published_at, "url": r.url,
                   "hazard_text": r.hazard_text[:400], "remedy_text": r.remedy_text[:400], "severity": r.severity, "severity_reasons": r.severity_reasons,
                   "contact": r.contact.model_dump(), "sold_window": {"from": sold_from, "to": sold_to}, "flags": {k: v for k, v in r.flags.items() if k in ("parkIt", "parkOutSide", "classification")}},
    }


def reduce(input, args, ctx):
    store = Store.default()
    outs = input.get("verdicts") or []
    certain = input.get("certain") or []
    confirmed, rejected, unsure = [], 0, 0
    for v in outs:
        if not isinstance(v, dict) or not v.get("match_id"):
            continue
        m = store.match(str(v["match_id"]))
        if m is None:
            continue
        m.stage, m.verdict = 4, v.get("is_match") if v.get("is_match") in ("yes", "no", "unsure") else "unsure"
        m.confidence = float(v.get("confidence") or 0)
        m.rationale = str(v.get("rationale") or "")
        m.missing_info = [str(x) for x in v.get("missing_info") or []]
        m.run_id = ctx.run_id
        store.upsert_match(m)
        if m.verdict == "yes" or m.verdict == "unsure":
            p = _payload(store, m)
            if p:
                confirmed.append(p)
            if m.verdict == "unsure":
                unsure += 1
        else:
            rejected += 1
    for c in certain:
        m = store.match(str(c.get("match_id")))
        if m is not None:
            p = _payload(store, m)
            if p:
                confirmed.append(p)
    hazards = {p["recall"]["recall_id"]: {"severity_keyword_pass": p["recall"]["severity"], "reasons": p["recall"]["severity_reasons"], "hazard_text": p["recall"]["hazard_text"][:300]} for p in confirmed}
    questions = []
    for q in input.get("questions") or []:
        if isinstance(q, dict) and q.get("ask") and store.item(str(q.get("item_id") or "")) is not None:
            it = store.item(str(q["item_id"]))
            questions.append({**q, "item_name": f"{it.brand} {it.name}".strip(), "category": it.category, "price": it.price})
    ctx.log(f"{len(confirmed)} confirmed ({unsure} unsure), {rejected} rejected, {len(questions)} question(s)")
    return {"confirmed": confirmed, "confirmed_count": len(confirmed), "rejected": rejected, "unsure": unsure, "hazards": hazards, "questions": questions, "question_count": len(questions),
            "_stats": {"in": len(outs) + len(certain) + len(input.get("questions") or []), "out": len(confirmed) + len(questions)}}
