# Handoff: Guardian — hackathon demo deck (13 slides, ≤ 5 min)

## Overview
Pitch + demo deck for **Guardian (Recall & Warranty Guardian)**, submitted to the Agents for Humans hackathon (AWS, Strands Agents SDK, Everyday Agents track). The deck must be turned into a demo video of at most 5 minutes that (1) demonstrates the working project, (2) states the problem, (3) states who it's for, (4) states why it matters. The speaker notes carry a voice-over script already timed to 5:00.

Repo: https://github.com/KrishGup/Recall-and-Warranty-Guardian

## About the design files
`Guardian Demo Deck.dc.html` is a **design reference built in HTML**: it shows the intended look, copy, order and timing. It is not production code. The job is to **recreate this deck in the team's deliverable format** (Keynote / PowerPoint / Google Slides / a recorded screen capture of the HTML) and produce the 5-minute video. Opening the HTML directly in a browser (with `deck-stage.js`, `support.js` and `assets/` alongside) gives a full-screen presenter with arrow-key navigation, a thumbnail rail and print-to-PDF, so the HTML can also be recorded as-is.

## Fidelity
**High-fidelity.** Colors, type, spacing and copy are final. Recreate 1:1; only the two `Not yet built` caveats and the sweep numbers (see "Open items") may change before recording.

## Canvas, grid and shared tokens
- Slide size **1920 × 1080**. Two backgrounds only: ink `#000F08` (pitch + technical) and paper `#F7F4F3` (the five demo slides).
- Standard padding `96px top · 110px sides · 90px bottom` (demo slides: `80px` sides). Title→body gap `44px`, list-item gap `24px`.
- Type: **Roboto Slab** 700 for titles and big numbers, **Lora** 400/italic for body, **Habibi** (uppercase, `letter-spacing .08em`) for eyebrows and labels, `ui-monospace` for URLs and identifiers. Google Fonts: `Roboto+Slab:wght@400;500;600;700`, `Lora:ital,wght@0,400;0,500;0,600;1,400`, `Habibi`.
- Scale: title 64px (demo slides 54px; problem slide 80px; cover 128px) · subtitle 40 · body 30 · small/eyebrow 26 · footnote 24 · big numbers 104 (line-height 1).
- Ink-slide palette: text `#F7F4F3`, muted text `#B9C3BD`, rule `#2C3B33`, card `#131F18`, eyebrow/amber `#FCBA04`, agent blue `#6FB3E3`, verifier green `#5DBB86`, repair red `#E4746A`, connector `#4A5551`.
- Paper-slide palette: text `#000F08`, muted `#4A5551`, rule `#DDD7D4`, step number blue `#2274A5`.
- Screenshot frame (paper slides): `border 1px #DDD7D4`, `radius 12px`, `shadow 0 8px 24px rgba(0,15,8,.12)`; phone: `border 1px #2C3B33`, `radius 28px`, `height 820px`.
- Logo (cover + closing): "Night watch" mark — a paper `#F7F4F3` circle with an ink `#000F08` disc, an amber dot `#FCBA04` (23px on the 72px mark, 31px on the 96px mark) ringed with ink (`box-shadow 0 0 0 5–6px #000F08`), and a paper crescent (`translateX(58%) rotate(28deg)`) swung aside. Wordmark "Guardian" Roboto Slab 600, 44px / 56px. Source of the mark: `web/src/ui/Logo.tsx`.

## Slides
Speaker notes (the voice-over script) are the `data-speaker-notes` attributes; timings in brackets are cumulative.

1. **Title** (ink, 0:00–0:15). Logo row top-left. Centered block: H1 "Recall & Warranty Guardian" 128px/1.02 · subtitle 40px "A background agent that watches government recall feeds for the things your household actually owns." · italic 34px muted "The agent's best output is silence." Footer above a `#2C3B33` rule, two stacked lines: amber Habibi eyebrow "Agents for Humans · Everyday Agents · Strands Agents SDK", then the repo URL in monospace muted.
2. **The problem** (ink, 0:15–0:50). Eyebrow "The problem" · H2 80px "Recalls are broadcast to everyone and matched by no one" · 34px muted paragraph (copy in file). Bottom, above a rule, 3 equal columns of 104px numbers with 28px muted captions: **594** CPSC recalls in one 400-day window · **1,200** openFDA enforcement reports · **3** NHTSA campaigns on a single 2019 Subaru Outback.
3. **Who it's for** (ink, 0:50–1:10). 2-column grid `1fr auto`, gap 80, vertically centered. Left: eyebrow "Who it's for", H2 64px "The household's default administrator", 3 bullets (14px amber squares, 36px Lora): Parents of young children · Car owners · Anyone with appliances; 30px muted line "Not another app to keep open. One SMS with one decision, and only when something you own is actually affected." Right: `assets/screens/decisions-mobile-dark.png` at 820px tall.
4. **What Guardian does** (paper, 1:10–1:35). Eyebrow + H2 "Capture, watch, decide, act". Four equal columns, each with a 2px ink top rule: step number (Roboto Slab 600 28px `#2274A5`), H3 40px, Habibi 24px label, 28px body. Labels/body copy verbatim in the file (Capture / Watch / Decide / Act). Grid is vertically centered in the remaining space.
5–9. **Demo 1/5 … 5/5** (paper). 2-column grid `520px 1fr`, gap 60, top-aligned, 80px side padding. Left column: eyebrow "Demo · n / 5", H2 54px, then three 28px paragraphs each with a `#DDD7D4` top rule and 20px padding. Right: full-width screenshot in the frame style above.
   - 5 (1:35–2:05) "The inventory, built from forwarded receipts" — `inventory.png`
   - 6 (2:05–2:30) "The morning after a sweep" — `home.png`
   - 7 (2:30–3:00) "One decision, one tap" — `decisions.png`
   - 8 (3:00–3:30) "The run, paused on the human gate" — `trace-tasks-gate.png`
   - 9 (3:30–3:50) "Every sweep is logged" — `activity.png`
10. **The nightly graph** (ink, 3:50–4:15). Eyebrow "How it works", H2 "The nightly sweep: 13 nodes on Strands Agents". Two rows of node cards (246px wide, `#131F18`, 1px `#2C3B33` border, 12px radius, 6px left color bar, name in Roboto Slab 600 26px, kind label in Habibi 24px), joined by 44px connector arrows (`#4A5551`). Row 1: [feeds_refresh, expiry_scan] → [candidate_gen, warranty] → matcher → verdicts → triage → severity_check, with a dashed red "repair ×1" back-arc over triage↔severity_check. Row 2: [household_decision, digest] → answers → remedy → followup, with a 26px muted explainer paragraph to the right. Legend bottom-left: Code grey `#B9C3BD` · Agent blue `#6FB3E3` · Verify green `#5DBB86` · Gate · human amber `#FCBA04`.
11. **On Strands Agents** (ink, 4:15–4:35). Eyebrow + H2 "How the graph compiles onto Strands". 3×2 grid of cards (`#131F18`, 16px radius, 28/32px padding, gap 24): GraphBuilder · AND-joins · Gates are interrupts · Verifier with kill authority · Map fan-out · Side effects, once — amber Habibi title, 27px body with inline monospace identifiers. Footnote 24px muted pinned to the bottom: "Not yet built: AgentCore Runtime deployment and SES/SNS delivery. The Bedrock provider and the AgentCore attachment points exist; see ARCHITECTURE.md §5."
12. **A real first sweep** (ink, 4:35–4:50). Eyebrow "A real first sweep · 13 Sep 2026 · live feeds", H2 "One night on live feeds". 3×2 grid of 104px numbers over 1px rules: 594 · 1,200 · 7,143 · 5 + 3 · 235 s · $0.41 with 28px captions. Bottom 26px muted paragraph about approval, follow-up and the 32 pytest tests.
13. **Why it matters** (ink, 4:50–5:00). Centered: logo + wordmark (96px / 56px), italic Lora 60px quote "The agent's best output is silence. The product's headline metric is how rarely it has to talk to you." (max-width 1440), repo URL monospace 32px `#6FB3E3`, amber eyebrow "Apache-2.0 · Strands Agents SDK · Everyday Agents track".

## Interactions & behavior
- Presenter: arrow keys / click advance; thumbnail rail; print-to-PDF (one page per slide) — all provided by `deck-stage.js`.
- Two tweakable props on the root component (Tweaks panel in the design tool; `data-props` in the file): `technicalSlides` (boolean, default true — hides slides 10–11 for a product-first cut) and `logoStatus` (`idle | pending | working` — logo dot amber / red `#E0463A` / green `#3FBF7F` with a 1.1s pulse `gPulse`). Neither needs to survive into the final video; pick a variant and bake it.
- No other animation. Cuts between slides are hard cuts; no transitions.

## Assets
`assets/screens/*.png` are real captures of the Guardian dashboard from the repo (`docs/screens/` and `var/screens/`, seeded with `demo/household.json`). Re-export from the running app if the UI has changed before recording. No stock imagery; the logo and node diagram are CSS.

## Open items before recording
- Numbers on slides 2 and 12 come from the README's 13 Sep 2026 live sweep (594 / 1,200 / 3 / 7,143 / 5 + 3 / 235 s / $0.41). Re-run `guardian sweep` and update if they change.
- Slide 11 footnote lists what is not yet built (AgentCore Runtime deploy, SES/SNS delivery). Delete or reword if that ships.
- Video: record the HTML deck full-screen at 1920×1080 with the speaker-note script as voice-over; total runtime 5:00. Slides 5–9 are the "working project" demonstration required by the brief; swap in a live screen recording of the same flows if one is available.

## Files
- `Guardian Demo Deck.dc.html` — the deck (markup, inline styles, speaker notes, props)
- `deck-stage.js` — presenter shell (scaling, nav, rail, print)
- `support.js` — runtime for the `.dc.html` format
- `assets/screens/` — the six screenshots used
