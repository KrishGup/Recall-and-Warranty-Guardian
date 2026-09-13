# Handoff: Guardian Dashboard (Recall & Warranty Guardian)

## Overview
Web dashboard for the Recall & Warranty Guardian agent (see `BUILD_PLAN.md`, section 12). Purpose: prove the agent worked while nobody watched, and make the rare decision effortless. Six views: Home, Decisions, Inventory, Activity, Settings, and a technical Agent flow view. Plus a resizable contextual Info panel and a resizable item-detail split panel.

## About the Design Files
The `.dc.html` files in this bundle are **design references built in HTML**. They are prototypes showing intended look and behavior, not production code. Recreate them in the target codebase (the plan calls for Vite + React, Cognito Hosted UI, CloudFront) using its patterns. If you adopt a component library, the design mimics **Cloudscape Design System** conventions (app layout with top nav / side nav / help panel / split panel, containers with headers, flashbar, key-value pairs, status indicators, pill buttons). Cloudscape's `AppLayout`, `SideNavigation`, `TopNavigation`, `Container`, `Header`, `Flashbar`, `KeyValuePairs`, `StatusIndicator`, `SplitPanel`, `HelpPanel`, `Table`, `Tiles`, `Toggle` map 1:1 onto what is drawn here; theme its tokens to the palette below.

Open `Guardian Dashboard v2.dc.html` in a browser to explore. `Guardian Dashboard.dc.html` is the earlier v1 (kept for reference). `Guardian Logos.dc.html` shows the five logo explorations; **option 1d ("Night watch") is the chosen mark**.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, states, and copy are final. Data values are illustrative seed data.

## Foundations (non-negotiable)
- **Accessibility**: landmarks (`header`, `nav`, `main`, `aside`), skip link, `aria-current` on nav, `aria-pressed` on toggles, `aria-expanded` on disclosures, `role="progressbar"` with values on warranty bars, `role="separator"` with `aria-valuenow` on resize handles (keyboard-resizable with arrow keys), `role="alert"` on the flashbar, `role="status" aria-live="polite"` on toasts, 44 px minimum targets on primary actions, visible 2 px focus rings (`#2274A5`, amber `#FCBA04` on the dark top bar), status conveyed by dot **and** text, all text ≥ 4.5:1, `prefers-reduced-motion` disables transitions/animations.
- **Responsive**: breakpoint 860 px. Above: side nav (resizable 200–400 px, default 248) + content + optional Info panel (resizable 240–560, default 320); item detail is a bottom split panel (resizable 160 px to 50 % viewport, default 300). Below: side nav hidden, 5-item bottom tab bar (60 px), Info panel and item detail become full-width sheets, table rows become stacked cards with inline labels, scheme/direction toggles move into Settings.
- **Bidirectional**: root `dir` toggles ltr/rtl. All spacing uses logical properties (`padding-inline`, `inset-inline-start`, `border-inline-start`, `margin-inline-end`, `text-align:start`). Chevrons/arrows flip in RTL. Email, phone, and code blocks are forced `dir="ltr"`.

## Hard Rules: Fonts and Colors (do not deviate)

These are fixed brand constraints, not suggestions. Do not substitute, add, or "improve" any of them.

**Fonts — exactly three, no others (no Inter, Roboto, Arial, system-ui fallbacks as primary):**
1. `Roboto Slab` — every heading, page title, container header, number, timestamp, date, badge count, and the wordmark. Weights 400, 500, 600, 700 only.
2. `Lora` — every body/paragraph/description/table-cell run of text. Weights 400, 500, 600 + italic 400.
3. `Habibi` — every UI label: nav items, tab labels, buttons, chips, pills, badges, eyebrows, breadcrumbs, form labels, status text. Weight 400 only.
- Load from Google Fonts. Fallback stack: `Georgia, serif` for Roboto Slab/Lora; `serif` for Habibi.
- Only exception: `ui-monospace, monospace` for the forwarding address, code, and structured-output blocks.

**Colors — the five brand hexes are the only source of color:**
- `#000F08` ink, top nav background
- `#960200` critical
- `#2274A5` primary action / links / focus / selection
- `#F7F4F3` page background (light), text on dark
- `#FCBA04` accent / quiet status
- Every other value in this document (surfaces, borders, tints, dark theme, green/amber status, `#4A5551` secondary text) is a derivative of these five and is listed explicitly below. Use those exact hexes; do not introduce new hues, gradients, or a component library's default blue/red/green.
- Primary buttons are always `#2274A5` (light) / `#6FB3E3` (dark). Critical buttons are always `#960200` with white text in both themes. Links are always the primary color.
- Status is never color-only: pair every colored dot with text.
- Contrast floor 4.5:1 for all text; do not use alpha-faded text for "muted" copy — use `#4A5551` (light) / `#B9C3BD` (dark).

## Design Tokens

### Palette (provided)
- `#000F08` ink / top nav background
- `#960200` critical (buttons, flashbar, badges)
- `#2274A5` primary action, links, selection, focus ring
- `#F7F4F3` page background (light), text on dark
- `#FCBA04` accent: agent-quiet status, top-bar focus ring, wireframe tag

### Derived (light theme)
surface `#FFFFFF` · secondary text `#4A5551` · border `#DDD7D4` · tint (selected/zebra/KV background) `#EFEBE9` · critical tint `#F8E6E4` · ok green `#2E7D4F` · warning amber for warranty 70–89 % `#B8860B`

### Derived (dark theme)
bg `#0A130E` · surface `#131F18` · ink `#F7F4F3` · secondary `#B9C3BD` · border `#2C3B33` · tint `#1C2A22` · primary `#6FB3E3` (primary button text `#000F08`) · critical text `#E4746A` (critical buttons stay `#960200` bg / white text) · critical tint `#3A1512` · ok `#5DBB86`

### Agent status colors (logo dot, header dot)
idle/quiet `#FCBA04` · pending decision `#E0463A` · working `#3FBF7F` (pulses)

### Typography (Google Fonts)
- **Roboto Slab** 600/700: page titles (clamp 24–30 px), container headers 18 px, card titles 22 px, hero number clamp(56 px, 9 vw, 88 px) weight 700, stat numbers 28 px 600, timestamps/dates 13 px 400, wordmark 17 px 600.
- **Lora** 400/500, italic: body 15 px / 1.5, descriptions, table cells.
- **Habibi** 400: all UI labels: nav items 15 px, buttons 13–15 px, eyebrows 12–13 px uppercase letter-spacing 0.06–0.08 em, badges 11–12 px uppercase, breadcrumbs 13 px, tab bar 11 px.
- Monospace (`ui-monospace`) for the forwarding address and structured output.

### Spacing & shape
Base 4/8 px. Container padding 20–24 px (hero clamp 20–32). Content page padding `16px clamp(12px,3vw,40px) 40px`. Grid gaps 16 px (12 px inside stat grid). Containers radius 16 px, inner cards 12 px, inputs 8 px, pill buttons 20–22 px, badges 10–12 px. Borders 1 px (containers) / 2 px (buttons, inputs). Split panel shadow `0 -8px 24px rgba(0,15,8,.12)`; toast `0 8px 24px rgba(0,15,8,.25)`.

### Motion
Buttons/links/rows/separators: `background-color, border-color, color, filter, box-shadow .15s ease`. Disclosure chevron `transform .12s`. Logo cover `transform .8s cubic-bezier(.2,.8,.2,1)`. Working pulse: `@keyframes gPulse 0%/100% scale(1) opacity 1; 50% scale(1.35) opacity .7` 1.1 s infinite.

## Global Shell

**Top bar** 52 px, `#000F08`, text `#F7F4F3`. Left: animated logo (28 px) + "Guardian" wordmark; the logo is a link to Home and also triggers a demo sweep. Small status label after it (desktop only): "Quiet" / "Needs you" / "Sweeping now…". Right: status dot + "Last sweep 03:04 today" (desktop), pill buttons "Dark/Light", "RTL/LTR" (desktop), "ⓘ Info" (always; pressed state background `rgba(252,186,4,.25)`). Pill buttons 36 px tall, 1 px `rgba(247,244,243,.35)` border, hover `rgba(247,244,243,.12)`.

**Logo (option 1d, animated)** — 28 px circle, background `#F7F4F3`, inside: a `#000F08` disc, a 9 px status dot centered with a 2 px `#000F08` ring, and a `#F7F4F3` cover disc (transform-origin 100% 50%). Closed: `translateX(30%)` (reads as a crescent). Open: `translateX(58%) rotate(28deg)`, like a manhole lid swung aside, revealing the dot. Opens 400 ms after load and stays open whenever status ≠ idle. Dot color per agent status; pulses when working.

**Side nav** (desktop) surface background, right border, 14 px 12 px padding. Group labels "HOUSEHOLD" / "TECHNICAL" (Habibi 12 px uppercase, secondary). Items 42 px min-height, radius 8, 3 px inline-start bar (primary when current), current: primary text + tint background; hover tint. Decisions shows a red count badge (22 px, Roboto Slab 12). Footer: "Forward receipts to" + monospace address button (copies to clipboard, toast). Resize handle: 12 px wide strip on the inline-end edge, `col-resize`, hover tint, keyboard ± 24 px.

**Bottom tab bar** (mobile) 60 px + safe area, 5 tabs (Home, Decisions, Inventory, Activity, Settings), 3 px top bar on current, simple outlined glyph (22 px shape with distinct radius per tab) with a filled dot when current, label Habibi 11 px, red count badge on Decisions.

**Breadcrumb** "Guardian / {Page}", Habibi 13 px.

**Flashbar** (shown on every page except Decisions while a critical decision is pending): `#960200` bg, white text, radius 12, "!" ring icon 22 px, bold Roboto Slab lead "Critical recall matches an item you own." + sentence, white pill button "Review decision" (text `#960200`).

**Info panel** (`aside`, right / inline-end): header with page-specific title + × (40 px round), body 14 px paragraph + 2–3 tinted key/value cards (Habibi 13 label, 13 px secondary value). Content per page in the prototype's `helpMap`. Resize handle 14 px strip on the inline-start edge with a 4×40 grip. Mobile: fixed full-screen sheet.

**Split panel — Item detail** (bottom of the content column): 22 px grab bar (56×5 grip) resizable `row-resize`, header (item name Roboto Slab 18, "brand · model · category" 13 px secondary, × button), body 3-column auto-fit (min 240): Receipt (4:3 striped placeholder labelled "receipt thumbnail · {retailer}", buttons "Open original email", "Add label photo"), Warranty (label, % elapsed, 8 px bar, note, KV list Purchased/Retailer/Paid, outline button "Something's wrong with it"), Recall checks (status dot+text, rationale, "Checked against {sources} in {n} nightly sweeps since intake."). Opens from any item name; closes on × or when navigating to a page other than Home/Inventory. Mobile: fixed bottom sheet 60 vh, radius 16 top.

**Toast** fixed bottom-center (20 px; 76 px on mobile above tabs), ink background, bg-colored text, Habibi 14, pill, 3 s.

## Screens

### Home
Title "One thing needs you" (pending) / "All quiet"; subtitle "A critical recall matched an item you own. Everything else ran on its own." / "What the agent did while you were away." Actions right: outline "Copy forwarding address", primary "Add item".
1. **Quiet score hero** container, 2-col auto-fit (min 300, gap clamp 20–40). Left: eyebrow "QUIET SCORE", number (0 if pending, else 42) + "days since Guardian last needed you" (18 px secondary, max 220 px), italic "The agent's best output is silence." Right: 2×2 stat tiles (buttons, min-height 104, radius 12, hover primary border) linking to pages: Items watched 312 → Inventory; Sweeps run 187 → Activity; Recalls screened, 30 days 214 → Activity; Decisions pending {n} → Decisions (critical tint bg when > 0).
2. Two containers auto-fit (min 300): **Last night's sweep** (header + "All activity" link; rows: time 13 px Roboto Slab 44 px wide, text, status dot+result line) and **Warranties ending soon** (header + "Inventory" link; rows: item name button (opens detail), "ends {date}", 6 px bar colored by elapsed %, note).

### Decisions
Title "Decisions (n pending)", subtitle "The same cards your phone points to. One tap, then the agent finishes the job." Below: flex-wrap row; pending card `flex 1 1 560px`, Past decisions `flex 1 1 320px`.
- **Pending decision card**: 6 px top border `#960200`, badge "! CRITICAL HAZARD", meta "CPSC recall 25‑000 · surfaced 03:04 today · expires in 71 h", title "Graco Modes Nest stroller — hinge can pinch or amputate a fingertip", remedy sentence, tinted KV strip (Purchased / Model / Match confidence / Sold window), disclosure "▸ Why Guardian thinks this is yours" (reveals tinted rationale with 3 px primary inline-start border) and link-button "Open item and receipt" (opens split panel). Action row (top border): critical primary "Request free repair kit" (flex 1 1 200), outline "No longer own it", outline "Not mine", text "Ask me tomorrow". All 44 px tall.
- **After answering**: green-topped container "Remedy requested" / "Snoozed until tomorrow" / "Match closed" with a vertical step timeline (14 px dots, 2 px connector; completed = ok green, future = border color) and link "See it in the activity log". Toast confirms.
- **Empty state** (quiet scenario): dashed container, green ✓ disc 56 px, "Nothing needs you", "The last sweep found nothing that applies to your household. The next one runs at 03:00."
- **Past decisions** list: radius 12 rows (dot, title, detail, outcome colored, date), hover primary border.

### Inventory
Title "Inventory (312)", subtitle, primary "Add item" (toast). Container: toolbar (search input 40 px, 2 px border, radius 8; filter pill toggles Category / Warranty status / Recall status, pressed = primary fill). Table header row (tint bg, Habibi 12 uppercase) columns `2fr 1fr 1fr 1.4fr 1.2fr`: Item / Category / Purchased / Warranty / Recall status. Rows 12 px 16 px padding, 3 px inline-start selection bar, hover tint, click opens detail; item cell = 40 px striped thumbnail + name (link button) + "brand · model"; warranty cell = label + 6 px bar (max 220) colored ok < 70 %, amber 70–89 %, critical ≥ 90 %; status cell = dot + text (Critical match / Clear / Adjudicated no / Resolved). Footer "1–6 of 312" + 40 px prev/next. Mobile: single column, header hidden, each cell prefixed with an 11 px uppercase label.

### Activity
Title, subtitle "Every sweep is logged, including the ones that found nothing.", link "How last night ran →" (to Agent flow). Grid auto-fit (min 380) of per-night containers: header (date, summary dot+text), rows `52px 1fr`: time, source badge (outlined pill, uppercase 11 px: CPSC / NHTSA / FDA / Triage / Intake / Warranty), text.

### Agent flow (Technical) — summary page in the dashboard
Has a primary button "Open full trace view →" linking to `Guardian Agent Flow.dc.html` (below). Title, subtitle "Tonight's run as the Strands graph saw it. Deterministic code in grey, agents in blue, the human in amber.", amber tag "WIREFRAME · BUILT IN PHASE 7". Container with horizontally scrolling node row: 196 px node buttons (kind badge Code/Agent/Human with tint/primary/amber fills, name Roboto Slab 15, meta, status dot+text) joined by 36 px connectors with arrowheads (flip in RTL). Nodes: Feeds refresh → Candidate generation → matcher → triage (interrupted while pending) → Household → remedy. Selecting a node fills the **detail container**: description, KV Duration / Tokens / Cost, "STRUCTURED OUTPUT" `pre` block (ltr). Second dashed container "What this view will show" (5 bullets: live Observability trace, per-node structured output with interrupt wait, memory reads/writes, token/cost totals, replay).

### Agent Flow — full trace view (`Guardian Agent Flow.dc.html`)
A rebuild of the gren runs dashboard (`gren/v1/src/ui/index.html` in the team's repo; REST + SSE from `src/server`) in Guardian's shell, palette and fonts. Replace gren's Inter/system stack, blue `#2563eb`, purple `#7c3aed` and green/amber/red with the tokens here; purple (route) is dropped for ink `#000F08`.

**Layout**: Guardian top bar (logo links back to dashboard, "/ Agent flow", amber TECHNICAL tag, pulsing green "Trace stream connected", Dark/RTL pills, primary "Run sweep now"). Below: three columns.
- **Runs sidebar** (resizable 220–420, default 280; hidden on mobile → replaced by a `<select>` run picker). Row = status dot + graph name (Roboto Slab 14/600) + "live" pill, monospace run id, Habibi meta (status colored, done/total nodes, cost). Selected row: tint bg + 3 px primary inline-start bar.
- **Canvas** (dot grid `radial-gradient(line 1px)` 20 px): SVG with pan (drag), wheel zoom (0.2–3×), node drag, keyboard-focusable nodes (Enter selects). Toolbar top-start: pill group Fit / + / −, toggle "Critical path" (pressed = primary fill), "Auto-layout". Run strip top-end: status, cost, wall, amber "1 gate waiting" button. Legend bottom-start (hidden when canvas < 300 px tall or < 760 px wide). Edge tooltip on hover shows `from → to · kind` and the `$nodes.*` data list.
- **Node card** 216×88, radius 12, surface fill, 1.2 px border (2 px + primary dashed + `gDash` animation when running; 2 px amber when waiting; 2 px critical when failed; 2.5 px primary when selected; 3 3 dashed at 60 % opacity when skipped; critical-path nodes get a primary border). 5 px kind stripe on the inline-start edge: Code `#4A5551`, Agent `#2274A5`, Verify `#2E7D4F`, Gate/human `#FCBA04`. Status dot r5 at (20,20): completed ok, running/waiting pulse. Texts: id Roboto Slab 13.5/600; kind label Habibi 10.5 uppercase in kind color (end-aligned); sub Habibi 11 secondary (model · map · tools · side-effect); badge monospace 11 (items, kill rate, attempts, "awaiting approval"); duration · cost Roboto Slab 11 bottom-end. Non-related nodes dim to 30 % when one is selected.
- **Edges**: cubic bezier from card mid-right to mid-left (±44 px handles); repair edges arc over the top. Colors: data `faint` 1.6 px (ok green once the source completed and target started), gate amber `#D9A004` dashed 7 4, repair `#960200` dashed 4 3, route ink solid, critical path primary 2.6 px, highlighted primary 2.8 px, unrelated 18 % opacity. Arrowheads via `<marker>` in matching colors.
- **Drawer** (bottom of canvas column): 14 px grab bar, resizable 120 px–45 % of column, default min(260, 32 %); starts collapsed to the 52 px tab strip when the column is < 600 px tall; ▾/▴ toggle. Tabs (Habibi 13, 2 px primary underline when active): Events (monospace grid `72 170 150 1fr`, type colored by class: kill/reject/failed critical, finished/completed/approved ok, waiting/paused/repair amber), Metrics (auto-fill 170 px cards: wall clock, parallel speedup, cost, peak width, node failure rate, verifier kill rate, human, tokens; then a per-node table Node/Kind/Status/Duration/Tokens/Cost, rows clickable), Decisions (cards with 3 px ink inline-start border: node, kind · time, sentence, state snapshot `pre`), Tasks (amber-bordered gate card with "Approve (as dashboard)" green pill and "Reject" critical outline; approving marks the gate completed, runs `remedy` and `followup`, appends events, updates metrics/output), Spec (YAML `pre`), Output (JSON `pre`). Amber count badge on Tasks while a gate waits.
- **Inspector** (right, resizable 280–600, default 380; hidden until a node is selected; mobile = fixed bottom sheet 70 vh, radius 16 top): kind pill + status, id (Roboto Slab 18), sub, description, KV grid (Duration/Tokens/Cost/Attempts/On critical path), amber gate box with Approve/Reject when waiting, "Inputs crossing into this node" list (from + data code), structured output `pre` (max 260 px), attempts list, footer buttons Copy last prompt / Copy node spec / Fork run from here.
- fit(): scale = min(1.2, max(0.6, fit-to-bounds)); when clamped, center on the waiting/running node (else `triage`). Re-fit after any panel resize, drawer toggle, inspector open/close, run change, window resize.

**Graph (nightly-sweep)**: feeds_refresh (code) + expiry_scan (code) → candidate_gen (code) / warranty (agent, map) → matcher (agent, map) → triage (agent) → severity_check (verify, repair back-edge to triage max 1 round, routes to household_decision when `plan.channel == sms_now` else digest) → household_decision (gate) → remedy (agent, side_effect, requires_gate) → followup (code). Full YAML in the file's `SPEC_YAML`. Runs seeded: Sep 13 paused on the gate; Sep 10–12 quiet (skip cascade, $0); one intake run.

### Settings
Title, subtitle. Form as grid auto-fit (min 340, gap 16), sections as containers:
- **Interruptions**: radio cards (44 px, 2 px border, selected = primary border + tint) "Critical only" / "Once a week (default)" / "Daily digest"; "Value threshold for warranty check‑ins" `$` prefixed number input, help "Items below this expire quietly."
- **Quiet categories**: toggle pills with ✓/+ prefix (Juvenile, Kitchen, Appliance, Vehicle, Tools, Food).
- **Channels**: Forwarding address (monospace read-only + "Copy" outline button) and Phone for critical alerts (tel input, ltr).
- **Appearance**: "Switch to Dark/Light mode", "Text direction: RTL/LTR".
- Full-width action row right-aligned: outline "Cancel", primary "Save changes" (toast "Preferences saved to Guardian memory.").

## State
`page` (home|decisions|inventory|activity|settings|flow), `narrow` (matchMedia ≤ 860), `dark`, `dir`, `pending` (derived: scenario critical and not resolved), `resolved` (null|approved|dismissed|snoozed), `rationaleOpen`, `selectedItemId` (drives split panel), `helpOpen`, `helpW`, `splitH`, `navW`, `flowSel`, `working` + `coverOpen` (logo), filters/cats/budget, `toast`. Navigating scrolls main to top and moves focus to `main` (outline none). Persist theme/direction/panel sizes per user.

## Data (from BUILD_PLAN.md)
Dashboard reads DynamoDB entities: InventoryItem, MatchCandidate, Decision, Action, Activity, Preferences. Decision actions call the decision API (`/d/<token>` / resume) which resumes the Strands graph. Agent flow view will read AgentCore Observability traces.

## Assets
No raster assets. Receipt thumbnails are striped placeholders; replace with S3 receipt images. Logo is pure CSS (see `Guardian Logos.dc.html` 1d and the `logo()` function in the v2 prototype). Fonts from Google Fonts: Roboto Slab, Lora, Habibi.

## Files
- `Guardian Dashboard v2.dc.html` — current design, all screens and behaviors
- `Guardian Agent Flow.dc.html` — full trace view (gren dashboard rebuilt in Guardian style)
- `Guardian Dashboard.dc.html` — v1, reference only
- `Guardian Logos.dc.html` — logo options 1a–1e (1d chosen)
- `BUILD_PLAN.md` — product/architecture plan the design implements
- `support.js` — runtime needed to open the `.dc.html` prototypes locally (not for production)
