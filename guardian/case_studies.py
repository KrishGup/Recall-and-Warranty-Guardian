"""Real-life example fixtures for `guardian seed`: a critical children's-product recall (button-cell battery
ingestion) and a class-action settlement (the DDR4 memory-kit example narrated in BUILD_PLAN.md), seeded straight
into the store so the Decisions tab has something to test against without waiting on, or paying for, a live sweep.

Ids and numbers are clearly demo data (`cpsc#DEMO-...`), not real CPSC recall or docket numbers. Two more items are
seeded with purchase dates picked relative to today so at least two warranties land inside the 60-day "ending soon"
window Home and Inventory show, regardless of when this is run."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from .models import Decision, MatchCandidate, RecallContact, RecallProduct, RecallRecord
from .service import DECISION_TTL_H, RECALL_OPTIONS, SETTLEMENT_OPTIONS, Guardian


def seed_case_studies(g: Guardian) -> dict[str, int]:
    today = date.today()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=DECISION_TTL_H)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # ---- case study 1: a children's toy recalled for a swallowable button-cell battery (critical) ----
    toy_purchase = (today - timedelta(days=40)).isoformat()
    toy = g.add_item(
        {
            "id": "itm_glowbuddy_toy",
            "name": "GlowBuddy plush nightlight toy",
            "brand": "Cuddle Bright",
            "model_number": "CB-2201",
            "category": "Toys",
            "purchase_date": toy_purchase,
            "price": 24.99,
            "retailer": "Target",
            "receipt_text": f"Target.com order confirmation\nOrder #TGT-88213340\nCuddle Bright GlowBuddy Plush Nightlight Toy, Model CB-2201\nQty 1  $24.99\nOrdered {toy_purchase}",
            "notes": "Case study: children's product recall for a swallowed button-cell battery.",
        },
        source="seed",
    )
    recall = RecallRecord(
        recall_id="cpsc#DEMO-26-901",
        source="cpsc",
        native_id="DEMO-26-901",
        title="Cuddle Bright Recalls GlowBuddy Plush Nightlight Toys Due to Ingestion and Choking Hazards (case study, not a real CPSC recall)",
        published_at=(today - timedelta(days=5)).isoformat(),
        url="https://www.cpsc.gov/Recalls",
        products=[RecallProduct(name="GlowBuddy plush nightlight toy", brand="Cuddle Bright", model_numbers=["CB-2201"], sold_from="2025-11", sold_to="2026-08", retailers=["Target", "Amazon"])],
        hazard_text="The toy's button-cell battery compartment can open, releasing a small battery that a young child can dislodge and swallow, posing an ingestion hazard and risk of serious internal chemical burns or death.",
        remedy_text="Stop use immediately and contact Cuddle Bright for a free repair kit that permanently secures the battery compartment, or for a full refund.",
        severity="critical",
        severity_reasons=["ingestion", "death"],
        contact=RecallContact(phone="800-555-0142", email="recalls@cuddlebright-demo.example", url="https://cuddlebright-demo.example/recall"),
        description="Case study fixture seeded by `guardian seed`; not a real CPSC recall number.",
    )
    g.store.upsert_recalls([recall])
    match = MatchCandidate(
        id=f"{toy['id']}~{recall.recall_id}",
        item_id=toy["id"],
        recall_id=recall.recall_id,
        stage=1,
        key="model",
        score=100.0,
        verdict="certain",
        rationale="Model number CB-2201 on the order confirmation matches the recalled model exactly; purchase date falls inside the sold window. Marked certain at stage 1.",
        state="surfaced",
        severity="critical",
    )
    g.store.upsert_match(match)
    toy_options = [o.model_copy() for o in RECALL_OPTIONS]
    toy_options[0].label = "Request repair kit or refund"
    g.store.upsert_decision(
        Decision(
            id="dec_demo_glowbuddy",
            kind="recall_remedy",
            severity="critical",
            state="pending",
            expires_at=expires_at,
            item_id=toy["id"],
            item_name=f"{toy['brand']} {toy['name']}",
            match_id=match.id,
            recall_id=recall.recall_id,
            headline="Cuddle Bright GlowBuddy plush nightlight — button battery can be swallowed",
            summary="Remedy: free repair kit or full refund from Cuddle Bright. Guardian has drafted the request and attached your Target receipt.",
            message=(
                f"Guardian: The Cuddle Bright GlowBuddy toy you bought at Target on {toy_purchase} matches CPSC recall DEMO-26-901 "
                "(battery can be swallowed, risking death). Remedy: free repair kit or refund. Reply 1 to request it, 2 if you no longer own it, 3 for details."
            ),
            remedy_label="Request repair kit or refund",
            options=toy_options,
        )
    )

    # ---- case study 2: a class-action settlement over an advertised memory-kit speed rating (standard) ----
    kit = g.add_item(
        {
            "id": "itm_gskill_ddr4",
            "name": "Trident Z 32 GB (2x16 GB) DDR4-3200 desktop memory kit",
            "brand": "G.Skill",
            "model_number": "F4-3200C16D-32GTZ",
            "category": "Electronics",
            "purchase_date": "2022-05-08",
            "price": 134.99,
            "retailer": "Micro Center",
            "receipt_text": "MICRO CENTER #14  TUSTIN CA\nG.SKILL TRIDENT Z 32GB (2X16GB) DDR4-3200  F4-3200C16D-32GTZ  134.99\n05/08/22 14:07",
            "notes": "Case study: class-action settlement over advertised vs. actual rated memory speed.",
        },
        source="seed",
    )
    g.store.upsert_decision(
        Decision(
            id="dec_demo_ddr4_settlement",
            kind="settlement_claim",
            severity="standard",
            state="pending",
            expires_at=expires_at,
            item_id=kit["id"],
            item_name=f"{kit['brand']} {kit['name']}",
            headline="DDR4 memory-kit speed-rating settlement — your Micro Center purchase qualifies",
            summary="Estimated payment $20 to $60 to your PayPal email. Guardian found your 2022-05-08 Micro Center receipt as proof of purchase.",
            message=(
                "Guardian: Your G.Skill DDR4 kit from Micro Center (2022-05-08) falls in the class period for the memory-kit "
                "speed-rating settlement. Estimated payment $20-$60. Claim deadline 2026-11-02. Reply 1 to review and attest, 2 to skip."
            ),
            remedy_label="Review and attest",
            options=[o.model_copy() for o in SETTLEMENT_OPTIONS],
            extra_facts=[
                {"label": "Case", "value": "In re Memory Kit Marketing and Sales Practices Litigation (case study, not a real docket)"},
                {"label": "Administrator", "value": "Angeion Group (demo)"},
                {"label": "Claim deadline", "value": "2026-11-02"},
                {"label": "Estimated payment", "value": "$20 - $60 to PayPal"},
            ],
        )
    )

    # ---- two items whose warranty lands inside the 60-day "ending soon" window, whenever this seed runs ----
    g.add_item(
        {"id": "itm_demo_brewer", "name": "K-Elite single-serve coffee maker", "brand": "Keurig", "model_number": "K-Elite", "category": "Kitchen",
         "purchase_date": (today - timedelta(days=350)).isoformat(), "price": 189.99, "retailer": "Target", "warranty_months": 12,
         "notes": "Case study: warranty ending soon, one of two seeded to exercise the Home page widget."},
        source="seed",
    )
    g.add_item(
        {"id": "itm_demo_headphones", "name": "WH-1000XM5 noise-canceling headphones", "brand": "Sony", "model_number": "WH-1000XM5", "category": "Electronics",
         "purchase_date": (today - timedelta(days=320)).isoformat(), "price": 399.99, "retailer": "Best Buy", "warranty_months": 12,
         "notes": "Case study: warranty ending soon, one of two seeded to exercise the Home page widget."},
        source="seed",
    )

    return {"items": 4, "decisions": 2}
