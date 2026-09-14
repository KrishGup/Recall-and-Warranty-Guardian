# Showcase video script

This is a read-aloud script for a full feature tour of Guardian. It is longer
and less clipped than `docs/DEMO_SCRIPT.md`, which is the tight 4:44 cut with
exact timecodes tied to one recorded video. Use this script for a walkthrough
video, a live-narrated screen recording, or a talk. It has no fixed timecodes,
because you record it fresh; each block lists a target duration instead.

One person can read the whole script. Two people can split it: **Presenter**
carries the product story and the live dashboard; **Engineer** carries the
architecture and the AWS detail. Where a block has one speaker, either person
can read it in the solo version.

Pace target: 140 words a minute, the same pace `docs/DEMO_SCRIPT.md` uses.
Read `docs/SHOWCASE_PREP.md` before you record: it lists what to seed,
what to open, and what to check first.

Total run time at this pace, all scenes included: about 13 to 15 minutes.
Scenes marked **(cuttable)** come out cleanly for a shorter version; cut them
in whole blocks, not mid-scene.

---

## Scene 1 — Open (0:30)

**On screen:** Title card, "Recall and Warranty Guardian."

**Presenter:** This is Guardian. It is a background agent for a household. It
watches the government recall feeds every night, checks them against what
the household owns, and speaks up only when a decision is necessary. Its
best output is silence.

**Presenter:** In the next few minutes, we show the whole loop: a receipt
comes in, a recall matches it while nobody is watching, the household
answers one question, and the remedy goes out. Then we open the graph
underneath and show how it runs on Strands Agents.

---

## Scene 2 — The problem (1:00)

**On screen:** Slide or plain background; no live UI yet.

**Presenter:** Recalls exist because products hurt people. The remedies are
almost always free: a refund, a repair kit, a replacement part. Most go
unclaimed. The notice goes to everyone and it is matched to nobody. CPSC
alone published 594 recalls in one 400-day window. The receipt that proves
you own the recalled product sits in an email nobody opens again.

**Presenter:** Food-safety advisories are worse, because many never become a
recall at all. Class-action settlements mail a postcard with a deadline and
a claim form; the money is legally yours and it stays unclaimed because the
form takes twenty minutes to fill in. Warranties expire the same way: nobody
remembers the term, and nobody can find the receipt.

**Presenter:** Guardian is built for the person who already carries this
load without a tool: a parent of a young child, a car owner, anyone with
appliances. Not another app to check. One message, with one decision, only
when it matters.

---

## Scene 3 — The loop, in words (0:45)

**On screen:** Slide: Capture, Watch, Decide, Act.

**Presenter:** Four steps. Capture: forward a receipt, or add a car by VIN,
and Guardian extracts the brand, model, UPC, purchase date, retailer, and
warranty term. Watch: every night, a graph pulls CPSC, NHTSA, and openFDA,
and matches them against the inventory, mostly in plain code. Decide: a
triage agent picks what deserves an interruption tonight, and a verifier
checks its plan before anyone is bothered. Act: after one approval, Guardian
writes the remedy request, sends it with the receipt attached, and follows
up until it is resolved.

**Presenter:** Now let us watch it happen on the live dashboard.

---

## Scene 4 — Home page (0:45)

**On screen:** Live: the Home page.

**Presenter:** This is Home. The headline number is the quiet score: days
since Guardian last needed the household for anything. Today it reads
[N] — [say what it means: either "zero, because something just matched" or
"n days, because nothing has needed us"].

**Presenter:** Below it: items watched, sweeps run, recalls screened in the
last 30 days, and decisions pending. Each tile is a shortcut to the page
behind the number. On the right, warranties ending soon, each with a bar
that shows how much of the term is left. On the left, last night's sweep,
one line for each thing that happened, quiet nights included.

---

## Scene 5 — Inventory and intake (1:15)

**On screen:** Live: the Inventory page; open one item; then "Add item."

**Presenter:** This is the inventory: twelve items, seeded from real
receipts and one VIN. Open an item and you see what Guardian kept: the
receipt image, the extracted brand and model, the warranty window as a bar,
and the recall checks run against it so far.

**Presenter:** Getting an item in takes one habit: forward the receipt.
Guardian's intake graph redacts the card numbers before anything else
happens, then extracts the product record and saves it. The forwarding
address is right here, one click to copy. [If demonstrating: Click "Add
item," paste an order confirmation, and narrate the extracted fields as
they appear.]

**Presenter (cuttable):** A car works the same way, by VIN instead of a
receipt. NHTSA's vPIC service decodes the year, make, and model, and from
then on Guardian checks that VIN against NHTSA's own recall campaigns every
night.

---

## Scene 6 — Running the sweep, live on the graph (2:30)

**On screen:** Live: the Agent flow tab. Click "Run sweep now." Let the
graph fill in node by node.

**Engineer:** This is the Agent flow tab: gren's trace workbench, embedded
in the shell, showing the nightly sweep as it runs, streamed live over
server-sent events. Grey nodes are plain code. Blue nodes are agents. Green
is the verifier. Amber is the human gate.

**Engineer:** Watch the order. Feeds refresh first: CPSC, NHTSA, and
openFDA, pulled and normalized in code. Candidate generation runs entirely
in code too: exact key matches on UPC and vehicle campaign, then a lexical
similarity pass, then a sold-window filter. Only the pairs that are still
ambiguous after all of that reach a model — the matcher agent — for a
judgment call.

**Engineer:** Triage takes the certain matches and the model's verdicts and
decides what is worth an interruption tonight, against the household's own
notification budget. A verifier checks that plan against a keyword pass of
its own; if they disagree, it can send triage back once for a repair round
before anything reaches the household.

**On screen:** The run pauses at the household gate. Amber banner. Switch
to the drawer's Timeline tab.

**Engineer:** And here the run stops. This is a Strands interrupt, not a
crash and not a timeout: the checkpoint is written to disk, and nothing
downstream — no notification sent twice, no remedy filed — can run until a
human answers. The Timeline tab shows the human wait as its own bar,
separate from the machine time on either side of it. The gate can hold a
run like this for up to 72 hours.

---

## Scene 7 — Inside the drawer (1:15) **(cuttable)**

**On screen:** Live: click through the drawer tabs — Overview, Events,
Metrics, Tasks, Spec, Output. Optionally open the Inspector on one node.

**Engineer:** The rest of the drawer is worth a look if you are evaluating
the graph itself, not just the outcome. Overview carries a plain narrative
of what Guardian is and what this run did. Events is the full, filterable
log of everything the graph did. Metrics has the token spend and the
latency for each agent call — this run cost about [$0.41] and ran in about
[235] seconds against live feeds. Tasks is where the gate approval itself
lives, and it is answerable from here too, not only from Decisions. Spec
shows the graph's own YAML. Output is the final structured result.

**Engineer:** The inspector opens on any node for its fan-out detail — the
matcher and remedy nodes run as a map over every candidate pair or every
approved decision, one execution per item — and a run can be forked from
any point in its history, which is how we can replay a past sweep with a
different answer without re-running the whole night. Blueprints, in the
sidebar, list the graphs that have not run yet, each with a one-click "Run
this graph."

---

## Scene 8 — The decision (0:45)

**On screen:** Live: the Decisions page. The pending card. Expand "Why
Guardian thinks this is yours." Tap the remedy button.

**Presenter:** This is the other side of the same gate — the card the
household's phone would point to. The badge says how severe it is, the
summary says what happened, and "Why Guardian thinks this is yours" opens
the model's own rationale for the match, not a black box.

**Presenter:** One tap: request the refund. That answer goes back to the
exact same graph run, waiting at the gate.

---

## Scene 9 — After the approval (1:00)

**On screen:** Live: back to Agent flow. The run resumes and completes.
Then Decisions shows the outcome steps. Then Activity.

**Engineer:** The graph resumes from the checkpoint. The remedy agent
writes the request from the recall's own remedy text and contact address,
not a generic template. A side-effect node sends it exactly once, records
the action, and schedules a follow-up ten business days out — and that
node is built to run at most once per match, on purpose, so an approval can
never double-send.

**Presenter:** Decisions shows the same thing as a short outcome timeline:
requested, then the follow-up date. And every sweep is logged, including
the ones that found nothing — three NHTSA campaigns on the household's
Subaru went to the weekly digest with no interruption at all, and that is
in the Activity log too, not hidden because it was uneventful.

---

## Scene 10 — Settings (0:45) **(cuttable)**

**On screen:** Live: the Settings page.

**Presenter:** Settings is where the household tunes how loud Guardian is
allowed to be. Critical hazards always come through; this page governs
everything else: a notification budget from critical-only up to a daily
digest, a value threshold below which an expiring item is not worth a
check-in, and categories — juvenile, kitchen, vehicle, and more — that stay
in the digest even at standard severity. The same settings change by
replying in plain language, like "only bother me about the kids' stuff,"
without opening this page at all.

**Presenter:** Below that: the forwarding address again, a phone number for
critical alerts, and Gmail — either linked directly so Guardian reads
receipts on its own, or, with no OAuth at all, a filter that forwards
matching mail for you.

---

## Scene 11 — How the graph is built (1:15)

**On screen:** Slide or diagram: the 13-node nightly-sweep graph.

**Engineer:** The nightly sweep is thirteen nodes. Feed pagination, VIN
decoding, UPC equality, the sold-window arithmetic, and the notification
budget are all plain code — deterministic, tested, and free to run. An
agent only runs where a judgment call is genuinely needed: is this listing
the recalled product, and is this plan worth interrupting someone for
tonight. Every agent output is a validated, structured object, not free
text parsed after the fact. On a quiet night, with no ambiguous matches,
the graph can run end to end without a single model call.

**Engineer (cuttable):** On Strands, every node is a `MultiAgentBase`
executor built with a `GraphBuilder`. Edges come from data references
between nodes, with AND-join conditions where a node needs more than one
upstream input. The gate is a Strands interrupt that survives a process
exit — the household can answer hours later, after the server restarts, and
the run still resumes from exactly where it left off. The verifier has
kill authority over the triage plan, with one bounded repair round, and
every side effect runs behind the gate, never before it.

---

## Scene 12 — Real numbers (0:30) **(cuttable)**

**On screen:** Slide: the first live sweep.

**Presenter:** This is not a synthetic demo. The first sweep against live
feeds pulled 594 CPSC recalls, 1,200 openFDA reports, and 3 NHTSA
campaigns. The code compared 7,143 item-and-recall pairs on its own. Eight
matched. The run paused at the gate after 235 seconds and 41 cents.

---

## Scene 13 — Deployment (0:45) **(cuttable)**

**On screen:** Live or slide: the deployed URL, or the EC2 architecture.

**Engineer:** Guardian runs today on one EC2 instance behind Caddy, with
automatic HTTPS. The household store mirrors to S3, and a systemd timer
runs the nightly sweep on the instance so it works with the browser closed.
The provider is swappable: Bedrock, the Anthropic API, or a headless Claude
Code login all run the same graphs unchanged, which matters wherever one
provider is blocked or unavailable — the graph does not know or care which
one answered.

---

## Scene 14 — Close (0:30)

**On screen:** Title card, quiet score prominent.

**Presenter:** The agent's best output is silence. The metric that matters
most is how rarely Guardian has to talk to you, and the second is how much
it recovers when it does. The code, the graphs, and the live site are all
in the repository. Thank you.

---

## Alternate: short cut

For a five-minute cut, keep Scenes 1, 2 (trimmed to two sentences), 3, 4, 6,
8, 9, and 14, and drop every scene marked **(cuttable)**. This tracks the
same beats as `docs/DEMO_SCRIPT.md`, which is the reference for a tight
cut with exact timecodes already tied to a recording.
