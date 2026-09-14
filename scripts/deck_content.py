"""The demo deck, as data: one dict per slide with the copy, the speaker notes (the voice-over script) and the
seconds each slide holds in the assembled video. `build_deck.py` renders the .pptx and `record_demo.py slides`
renders the same slides to 1920x1080 PNGs for the video, so the two never drift.

Timings sum to the video: slides hold for `seconds`; demo title cards are short because the live clips carry the
demonstration. The numbers on the problem and sweep slides come from the real first sweep of 2026-09-13; re-run
`guardian sweep` and update them if they change."""
from __future__ import annotations

REPO = "github.com/KrishGup/Recall-and-Warranty-Guardian"
LIVE = "guardian.44-214-230-44.sslip.io"

INK = "#000F08"
PAPER = "#F7F4F3"
MUTED_DARK = "#B9C3BD"  # muted text on ink
MUTED_LIGHT = "#4A5551"  # muted text on paper
RULE_DARK = "#2C3B33"
RULE_LIGHT = "#DDD7D4"
CARD_DARK = "#131F18"
AMBER = "#FCBA04"
BLUE = "#6FB3E3"
GREEN = "#5DBB86"
RED = "#E4746A"
CONNECTOR = "#4A5551"
STEP_BLUE = "#2274A5"

SLIDES: list[dict] = [
    {
        "id": "title",
        "kind": "title",
        "bg": "ink",
        "seconds": 10,
        "h1": "Recall & Warranty Guardian",
        "sub": "A background agent that watches government recall feeds for the things your household actually owns.",
        "tagline": "The agent's best output is silence.",
        "footer_eyebrow": "Agents for Humans · Everyday Agents · Strands Agents SDK",
        "footer_mono": f"{REPO}  ·  live: {LIVE}",
        "notes": "This is Guardian, a recall and warranty agent for the household, built on the Strands Agents SDK. Its best output is silence.",
    },
    {
        "id": "problem",
        "kind": "problem",
        "bg": "ink",
        "seconds": 24,
        "eyebrow": "The problem",
        "h2": "Recalls are broadcast to everyone and matched by no one",
        "body": "Recalls exist because products injure people. Remedies are free: refunds, repair kits, replacement parts. Most go unclaimed, because the notice reaches everyone and the receipt that proves you own the product sits in an email nobody opens again.",
        "stats": [
            ("594", "CPSC recalls published in one 400-day window"),
            ("1,200", "openFDA enforcement reports in the same window"),
            ("3", "NHTSA campaigns open against a single 2019 Subaru Outback"),
        ],
        "notes": "Recalls exist because products injure people. The remedies are free: refunds, repair kits, replacement parts. Most go unclaimed, because a recall is broadcast to everyone and matched to nobody. CPSC alone published 594 recalls in one 400-day window, and the receipt that proves you own the product sits in an email nobody opens again.",
    },
    {
        "id": "who",
        "kind": "who",
        "bg": "ink",
        "seconds": 15,
        "eyebrow": "Who it's for",
        "h2": "The household's default administrator",
        "bullets": ["Parents of young children", "Car owners", "Anyone with appliances"],
        "body": "Not another app to keep open. One SMS with one decision, and only when something you own is actually affected.",
        "image": "decisions-mobile-dark.png",
        "notes": "Guardian is for the household's default administrator: the parent of a young child, the car owner, anyone with appliances. Not another app to keep open. One text with one decision, only when something they own is affected.",
    },
    {
        "id": "what",
        "kind": "steps",
        "bg": "paper",
        "seconds": 24,
        "eyebrow": "What Guardian does",
        "h2": "Capture, watch, decide, act",
        "steps": [
            ("01", "Capture", "intake graph · code + agent", "Forward a receipt or paste an order confirmation. Card numbers are stripped; brand, model, UPC, purchase date, retailer and warranty term are filed. Cars are added by VIN."),
            ("02", "Watch", "nightly sweep · code first", "Every night a Strands graph pulls new recalls from CPSC, NHTSA and openFDA and matches them in code: exact keys, lexical similarity, sold window. Only ambiguous pairs reach a model."),
            ("03", "Decide", "agent · verifier · human gate", "A triage agent applies severity rules and the household's notification budget; an adversarial verifier can send it back once. Critical hazards become one SMS. The graph pauses on a human gate for up to 72 hours."),
            ("04", "Act", "agent · side effect, once", "When the household answers, the graph resumes: a remedy agent drafts the request from the recall's own remedy and contact, sends it exactly once with the receipt attached, and schedules a 10-business-day follow-up."),
        ],
        "notes": "Four steps. Capture a receipt, or a car by VIN. Watch: every night a Strands graph pulls CPSC, NHTSA and openFDA and matches them in code; only ambiguous pairs reach a model. Decide: a triage agent picks what deserves an interruption; a verifier checks it. Act: after one approval, Guardian sends the remedy request, receipt attached.",
    },
    {
        "id": "demo-inventory",
        "kind": "demo",
        "bg": "paper",
        "seconds": 5,
        "clip": "inventory",
        "eyebrow": "Demo · 1 / 5 · live site",
        "h2": "The inventory, built from forwarded receipts",
        "paras": [
            "12 items seeded from real receipts and one VIN. Intake redacts card numbers, then extracts brand, model, UPC, date, retailer and warranty term.",
            "UPC 669028116546 on the Walmart receipt equals the UPC in CPSC recall 26530; the purchase date sits inside the sold window.",
            "Every item shows its receipt, its warranty window and every recall check it has been through.",
        ],
        "image": "inventory.png",
        "notes": "Here it is on the live site. Twelve items, seeded from real receipts and a VIN. Intake redacts card numbers and extracts brand, model, UPC, purchase date, retailer and warranty term. Select an item: its receipt, its warranty window, and its recall checks. None yet: tonight's sweep has not run.",
    },
    {
        "id": "demo-sweep",
        "kind": "demo",
        "bg": "paper",
        "seconds": 5,
        "clip": "sweep",
        "eyebrow": "Demo · 2 / 5 · live site",
        "h2": "The sweep, live, and the run paused on the human gate",
        "paras": [
            "One click starts tonight's sweep. The graph lights up node by node as Strands runs it: feeds, candidates, matcher, triage, verifier.",
            "Deterministic code in grey, agents in blue, the verifier in green, the human gate in amber.",
            "The run pauses at household_decision. The checkpoint is on disk; nothing downstream runs without an approval record.",
        ],
        "image": "flow-paused.png",
        "notes": "One click starts the sweep, and this is the run as the Strands graph sees it, streamed live. Grey nodes are code, blue are agents, green is the verifier, amber is the human gate. Feeds refresh, candidates are generated in code, the matcher adjudicates only the ambiguous pairs, triage decides what deserves an interruption tonight, and the verifier checks the plan; it can send it back once. Two minutes in, the run pauses at the household gate. The checkpoint is on disk, the timeline shows the wait, and nothing downstream can run without an approval record.",
    },
    {
        "id": "demo-home",
        "kind": "demo",
        "bg": "paper",
        "seconds": 5,
        "clip": "home",
        "eyebrow": "Demo · 3 / 5 · live site",
        "h2": "The morning after a sweep",
        "paras": [
            "Quiet score: days since Guardian last needed you. Zero today, because one critical recall matched.",
            "Items watched, sweeps run, recalls screened, decisions pending. Everything else ran on its own.",
            "The sweep log: triage chose sms_now, and severity_check verified the plan against the keyword pass.",
        ],
        "image": "home.png",
        "notes": "The morning after. The quiet score is the headline metric: days since Guardian last needed you. Today it is zero, because a critical recall matched. Twelve items watched, nearly two thousand recalls screened, and the sweep log shows each step.",
    },
    {
        "id": "demo-decision",
        "kind": "demo",
        "bg": "paper",
        "seconds": 5,
        "clip": "decision",
        "eyebrow": "Demo · 4 / 5 · live site",
        "h2": "One decision, one tap",
        "paras": [
            "The same card the phone points to: a real CPSC recall, surfaced tonight, expiring in 72 hours.",
            "The rationale is one click away: which key matched, or how the model adjudicated the pair and at what confidence.",
            "Request the remedy · No longer own it · Not mine · Ask me tomorrow. One tap, then the agent finishes the job.",
        ],
        "image": "decisions.png",
        "notes": "One decision. This is the same card the phone points to. The recall is real, the remedy request is already drafted with the receipt attached, and the reasoning is one click away. One tap: request the refund. The graph resumes, the remedy agent writes the request from the recall's own contact, sends it once, and schedules the follow-up.",
    },
    {
        "id": "demo-activity",
        "kind": "demo",
        "bg": "paper",
        "seconds": 5,
        "clip": "after",
        "eyebrow": "Demo · 5 / 5 · live site",
        "h2": "Every sweep is logged",
        "paras": [
            "After the approval, the run completes: remedy drafted and sent, the follow-up scheduled. The timeline shows the human wait as its own bar.",
            "The activity log keeps every sweep, including the ones that found nothing. Three NHTSA campaigns went to the weekly digest with no interruption.",
            "This is the proof that the agent worked while nobody watched.",
        ],
        "image": "activity.png",
        "notes": "After the approval the run completes: the remedy is sent and the follow-up is scheduled. The timeline keeps the human wait as its own bar, apart from machine time. And every sweep is logged, including the ones that found nothing: three NHTSA campaigns on the household's Subaru went to the weekly digest with no interruption.",
    },
    {
        "id": "graph",
        "kind": "graph",
        "bg": "ink",
        "seconds": 24,
        "eyebrow": "How it works",
        "h2": "The nightly sweep: 13 nodes on Strands Agents",
        "row1": [
            [("feeds_refresh", "code", "code"), ("expiry_scan", "code", "code")],
            [("candidate_gen", "code · stages 1–3", "code"), ("warranty", "agent · map", "agent")],
            [("matcher", "agent · map", "agent")],
            [("verdicts", "code", "code")],
            [("triage", "agent", "agent")],
            [("severity_check", "verify · kill", "verify")],
        ],
        "row2": [
            [("household_decision", "gate · human", "gate"), ("digest", "code · weekly", "code")],
            [("answers", "code", "code")],
            [("remedy", "agent · map", "agent")],
            [("followup", "code · side effect", "code")],
        ],
        "explainer": "severity_check routes to household_decision when the plan's channel is sms_now, otherwise to digest. Deterministic pipes, judgment in agents; every agent output is a validated structured object. A quiet night skips every agent node: zero model calls, $0.",
        "legend": [("Code", MUTED_DARK), ("Agent", BLUE), ("Verify", GREEN), ("Gate · human", AMBER)],
        "notes": "The nightly sweep is thirteen nodes. Feed pagination, VIN decoding, UPC equality, sold-window arithmetic and the notification budget are code. Deciding whether a listing is the recalled product, or whether a plan is worth an interruption, is an agent, and every agent output is a validated structured object. A quiet night skips every agent node: zero model calls.",
    },
    {
        "id": "strands",
        "kind": "cards",
        "bg": "ink",
        "seconds": 20,
        "eyebrow": "On Strands Agents",
        "h2": "How the graph compiles onto Strands",
        "cards": [
            ("GraphBuilder", "Every node is a Strands MultiAgentBase executor. Edges are derived from data references such as $nodes.matcher.outputs, never declared by hand."),
            ("AND-joins", "Strands readiness is OR. gren adds an edge condition so a node runs only once all of its dependencies have completed."),
            ("Gates are interrupts", "A BeforeNodeCallEvent hook raises event.interrupt. The run pauses, the checkpoint sits on disk, the process may exit. Resume replays completed nodes without new model calls."),
            ("Verifier with kill authority", "severity_check returns {verdict, reasons, confidence}. A kill resets triage with the reasons as feedback through a conditional back-edge, at most one round."),
            ("Map fan-out", "matcher, warranty and remedy map over lists with structured_output_model. Retries, fallback model, timeouts and the spend cap are enforced by the engine."),
            ("Side effects, once", "followup declares side_effect and requires_gate. The frozen constraint gate_before_side_effect makes it unreachable without approval; it runs at most once per run."),
        ],
        "footnote": f"Runs on one EC2 instance with automatic HTTPS at {LIVE}; Provider: Claude on the Anthropic API; Amazon Bedrock pending account authorization. AgentCore Runtime built and tested locally. See ARCHITECTURE.md §5 and docs/PROBLEMS_EXPERIENCED.md.",
        "notes": "On Strands: every node is a MultiAgentBase executor in a GraphBuilder. Edges come from data references, with AND-join conditions. The gate is a Strands interrupt that survives a process exit. The verifier has kill authority with one bounded repair round, and side effects run once, behind the gate.",
    },
    {
        "id": "sweep",
        "kind": "numbers",
        "bg": "ink",
        "seconds": 16,
        "eyebrow": "A real first sweep · 13 Sep 2026 · live feeds",
        "h2": "One night on live feeds",
        "numbers": [
            ("594", "CPSC recalls pulled, plus 3 NHTSA campaigns"),
            ("1,200", "openFDA food enforcement reports pulled"),
            ("7,143", "item–recall pairs checked in code"),
            ("5 + 3", "exact matches, plus ambiguous pairs adjudicated by the model"),
            ("235 s", "from start to the human gate"),
            ("$0.41", "model spend for the night"),
        ],
        "footer": "Approving from the dashboard drafted the refund request to the recall's real contact address and scheduled the follow-up. 40 pytest tests run the graph end to end on the mock provider: pause at the gate, approve, decline, quiet night, verifier kill and repair, snoozes and late approvals.",
        "notes": "A real first sweep on live feeds: 594 CPSC recalls, 1,200 openFDA reports, 7,143 pairs checked in code, eight matches, paused at the gate after 235 seconds and 41 cents.",
    },
    {
        "id": "closing",
        "kind": "closing",
        "bg": "ink",
        "seconds": 12,
        "quote": "The agent's best output is silence. The product's headline metric is how rarely it has to talk to you.",
        "mono": f"{REPO}",
        "mono2": f"{LIVE}",
        "eyebrow": "Apache-2.0 · Strands Agents SDK · Everyday Agents track",
        "notes": "Guardian's headline metric is how rarely it has to talk to you. The code, the graph and the live site are in the repo. Thank you.",
    },
]

# Demo clips, in order, with the seconds each one is expected to hold on screen once recorded. `record_demo.py`
# measures the real clip lengths; these are the targets its pacing aims for.
CLIPS: dict[str, int] = {"inventory": 22, "sweep": 48, "home": 15, "decision": 22, "after": 22}


def logo_svg(size: int, dot: str = "#FCBA04", outline: bool = True) -> str:
    """The Night watch mark as inline SVG: the same 48-unit geometry as web/src/ui/Logo.tsx and design/avatars, open."""
    ring = f'<circle cx="24" cy="24" r="23.4" fill="none" stroke="{PAPER}" stroke-width="1.2"/>' if outline else ""
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" style="display:block;flex:0 0 auto">'
        f'<clipPath id="lc"><circle cx="24" cy="24" r="24"/></clipPath><g clip-path="url(#lc)"><circle cx="24" cy="24" r="24" fill="{INK}"/>'
        f'<circle cx="12" cy="34" r="4" fill="{dot}"/><circle cx="38" cy="16" r="24" fill="{PAPER}"/></g>{ring}</svg>'
    )


def total_seconds() -> int:
    return sum(s["seconds"] for s in SLIDES) + sum(CLIPS.values())
