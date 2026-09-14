# Handoff: Guardian Dashboard (Recall and Warranty Guardian)

## Overview

This is the web dashboard for the Recall and Warranty Guardian agent (see `BUILD_PLAN.md`, section 12). Its purpose is to show that the agent worked while nobody watched, and to make the rare decision easy. It has six views: Home, Decisions, Inventory, Activity, Settings, and a technical Agent flow view. It also has a resizable contextual Info panel and a resizable item-detail split panel.

## About the design files

The `.dc.html` files in this bundle are **design references built in HTML**. They are prototypes. They show the intended look and behavior. They are not production code. Recreate them in the target codebase (the plan calls for Vite and React, Cognito Hosted UI, CloudFront) with its patterns. If you use a component library, note that the design follows the conventions of the **Cloudscape Design System**:

- An app layout with a top nav, a side nav, a help panel, and a split panel.
- Containers with headers, a flashbar, key-value pairs, status indicators, and pill buttons.

These Cloudscape components map one to one onto what is drawn here: `AppLayout`, `SideNavigation`, `TopNavigation`, `Container`, `Header`, `Flashbar`, `KeyValuePairs`, `StatusIndicator`, `SplitPanel`, `HelpPanel`, `Table`, `Tiles`, and `Toggle`. Theme its tokens to the palette below.

Open `Guardian Dashboard v2.dc.html` in a browser to explore the design. `Guardian Dashboard.dc.html` is the earlier v1, kept for reference. `Guardian Logos.dc.html` shows the five logo explorations. **Option 1d ("Night watch") is the chosen mark.**

## Fidelity

**High fidelity.** The colors, the type, the spacing, the radii, the states, and the copy are final. The data values are illustrative seed data.

## Foundations (not negotiable)

- **Accessibility.** Use landmarks (`header`, `nav`, `main`, `aside`) and a skip link. Use `aria-current` on the nav, `aria-pressed` on toggles, and `aria-expanded` on disclosures. Use `role="progressbar"` with values on the warranty bars. Use `role="separator"` with `aria-valuenow` on the resize handles, and make them resizable with the arrow keys. Use `role="alert"` on the flashbar and `role="status" aria-live="polite"` on the toasts. Primary actions have a minimum target of 44 px. Focus rings are visible and 2 px (`#2274A5`, amber `#FCBA04` on the dark top bar). A status always has a dot **and** text. All text has a contrast of 4.5:1 or more. `prefers-reduced-motion` turns off the transitions and the animations.
- **Responsive.** The breakpoint is 860 px. Above it: a side nav (resizable 200 to 400 px, default 248) plus the content plus an optional Info panel (resizable 240 to 560, default 320). The item detail is a bottom split panel (resizable from 160 px to 50 percent of the viewport, default 300). Below it:
  - The side nav is hidden. A 5-item bottom tab bar (60 px) appears.
  - The Info panel and the item detail become full-width sheets.
  - The table rows become stacked cards with inline labels.
  - The scheme and direction toggles move into Settings.
- **Bidirectional.** The root `dir` toggles ltr and rtl. All spacing uses logical properties (`padding-inline`, `inset-inline-start`, `border-inline-start`, `margin-inline-end`, `text-align:start`). Chevrons and arrows flip in RTL. Email, phone, and code blocks are always `dir="ltr"`.

## Hard rules: fonts and colors (do not deviate)

These are fixed brand constraints, not suggestions. Do not substitute, add, or "improve" any of them.

**Fonts: exactly three, and no others (no Inter, Roboto, Arial, or system-ui fallbacks as the primary font):**

1. `Roboto Slab`: each heading, page title, container header, number, timestamp, date, badge count, and the wordmark. Weights 400, 500, 600, 700 only.
2. `Lora`: each body, paragraph, description, and table-cell run of text. Weights 400, 500, 600, plus italic 400.
3. `Habibi`: each UI label: nav items, tab labels, buttons, chips, pills, badges, eyebrows, breadcrumbs, form labels, status text. Weight 400 only.

- Load the fonts from Google Fonts. The fallback stack is `Georgia, serif` for Roboto Slab and Lora, and `serif` for Habibi.
- The only exception is `ui-monospace, monospace` for the forwarding address, code, and structured-output blocks.

**Colors: the five brand hex values are the only source of color:**

- `#000F08` ink, top nav background
- `#960200` critical
- `#2274A5` primary action, links, focus, selection
- `#F7F4F3` page background (light), text on dark
- `#FCBA04` accent, quiet status

- Each other value in this document (surfaces, borders, tints, the dark theme, the green and amber status colors, `#4A5551` secondary text) is a derivative of these five. They are listed below. Use those exact hex values. Do not add new hues, gradients, or the default blue, red, or green of a component library.
- Primary buttons are always `#2274A5` (light) or `#6FB3E3` (dark). Critical buttons are always `#960200` with white text in both themes. Links are always the primary color.
- A status is never shown by color only. Pair each colored dot with text.
- The contrast floor is 4.5:1 for all text. Do not use alpha-faded text for "muted" copy. Use `#4A5551` (light) or `#B9C3BD` (dark).

## Design tokens

### Palette (given)

- `#000F08` ink, top nav background
- `#960200` critical (buttons, flashbar, badges)
- `#2274A5` primary action, links, selection, focus ring
- `#F7F4F3` page background (light), text on dark
- `#FCBA04` accent: agent-quiet status, top-bar focus ring, wireframe tag

### Derived (light theme)

- surface `#FFFFFF`
- secondary text `#4A5551`
- border `#DDD7D4`
- tint (selected, zebra, KV background) `#EFEBE9`
- critical tint `#F8E6E4`
- ok green `#2E7D4F`
- warning amber for a warranty at 70 to 89 percent `#B8860B`

### Derived (dark theme)

- bg `#0A130E`
- surface `#131F18`
- ink `#F7F4F3`
- secondary `#B9C3BD`
- border `#2C3B33`
- tint `#1C2A22`
- primary `#6FB3E3` (primary button text `#000F08`)
- critical text `#E4746A` (critical buttons keep the `#960200` background and white text)
- critical tint `#3A1512`
- ok `#5DBB86`

### Agent status colors (logo dot, header dot)

idle or quiet `#FCBA04` · pending decision `#E0463A` · working `#3FBF7F` (pulses)

### Typography (Google Fonts)

- **Roboto Slab** 600 and 700:
  - Page titles: clamp 24 to 30 px.
  - Container headers: 18 px. Card titles: 22 px.
  - The hero number: clamp(56 px, 9 vw, 88 px) at weight 700.
  - Stat numbers: 28 px at 600. Timestamps and dates: 13 px at 400. The wordmark: 17 px at 600.
- **Lora** 400 and 500, italic: body 15 px with line height 1.5, descriptions, table cells.
- **Habibi** 400, for all UI labels:
  - Nav items: 15 px. Buttons: 13 to 15 px.
  - Eyebrows: 12 to 13 px uppercase, with letter spacing 0.06 to 0.08 em.
  - Badges: 11 to 12 px uppercase. Breadcrumbs: 13 px. The tab bar: 11 px.
- Monospace (`ui-monospace`) for the forwarding address and the structured output.

### Spacing and shape

The base is 4 and 8 px. Container padding is 20 to 24 px (the hero uses clamp 20 to 32). The content page padding is `16px clamp(12px,3vw,40px) 40px`. Grid gaps are 16 px (12 px inside the stat grid). The radius is 16 px for containers and 12 px for inner cards. Inputs use 8 px, pill buttons 20 to 22 px, and badges 10 to 12 px. Borders are 1 px (containers) and 2 px (buttons, inputs). The split panel shadow is `0 -8px 24px rgba(0,15,8,.12)`. The toast shadow is `0 8px 24px rgba(0,15,8,.25)`.

### Motion

Buttons, links, rows, and separators: `background-color, border-color, color, filter, box-shadow .15s ease`. The disclosure chevron: `transform .12s`. The logo cover: `transform .8s cubic-bezier(.2,.8,.2,1)`. The working pulse: `@keyframes gPulse 0%/100% scale(1) opacity 1; 50% scale(1.35) opacity .7`, 1.1 s, infinite.

## Global shell

**Top bar.** 52 px, `#000F08`, text `#F7F4F3`. Left: the animated logo (28 px) plus the "Guardian" wordmark. The logo is a link to Home. It also starts a demo sweep. A small status label follows it (desktop only): "Quiet", "Needs you", or "Sweeping now…". Right: a status dot plus "Last sweep 03:04 today" (desktop), the pill buttons "Dark/Light" and "RTL/LTR" (desktop), and "ⓘ Info" (always; the pressed state background is `rgba(252,186,4,.25)`). Pill buttons are 36 px tall with a 1 px `rgba(247,244,243,.35)` border. On hover, the background is `rgba(247,244,243,.12)`.

**Logo (option 1d, animated).** A 28 px circle with a `#F7F4F3` background. Inside: a `#000F08` disc, a 9 px status dot in the center with a 2 px `#000F08` ring, and a `#F7F4F3` cover disc (transform-origin 100% 50%). Closed: `translateX(30%)`, which reads as a crescent. Open: `translateX(58%) rotate(28deg)`, like a manhole lid swung aside, which shows the dot. It opens 400 ms after the load. It stays open when the status is not idle. The dot color follows the agent status. It pulses when the agent works.

**Side nav** (desktop). Surface background, a right border, 14 px 12 px padding. Group labels "HOUSEHOLD" and "TECHNICAL" (Habibi 12 px uppercase, secondary). Items have a minimum height of 42 px, a radius of 8, and a 3 px inline-start bar (primary when current). The current item has primary text and a tint background. Hover shows the tint. Decisions shows a red count badge (22 px, Roboto Slab 12). Footer: "Forward receipts to" plus a monospace address button (it copies the address to the clipboard and shows a toast). The resize handle is a 12 px strip on the inline-end edge, `col-resize`, tint on hover, plus or minus 24 px with the keyboard.

**Bottom tab bar** (mobile). 60 px plus the safe area. 5 tabs (Home, Decisions, Inventory, Activity, Settings). A 3 px top bar on the current tab. A simple outlined glyph (a 22 px shape with a distinct radius for each tab) with a filled dot when current. Labels in Habibi 11 px. A red count badge on Decisions.

**Breadcrumb.** "Guardian / {Page}", Habibi 13 px.

**Flashbar.** Shown on each page except Decisions while a critical decision is pending. `#960200` background, white text, radius 12, and a "!" ring icon of 22 px. The lead is bold Roboto Slab: "Critical recall matches an item you own." A sentence follows it. A white pill button "Review decision" (text `#960200`) ends the bar.

**Info panel** (`aside`, right or inline-end). A header with a page-specific title plus × (40 px, round). A body with a 14 px paragraph plus 2 or 3 tinted key-value cards (Habibi 13 label, 13 px secondary value). The content for each page is in the `helpMap` of the prototype. The resize handle is a 14 px strip on the inline-start edge with a 4 by 40 grip. Mobile: a fixed full-screen sheet.

**Split panel: item detail** (at the bottom of the content column). A 22 px grab bar (56 by 5 grip), resizable with `row-resize`. A header with the item name (Roboto Slab 18), "brand · model · category" (13 px secondary), and a × button. A body with 3 auto-fit columns (minimum 240): Receipt (a 4:3 striped placeholder labeled "receipt thumbnail · {retailer}", and the buttons "Open original email" and "Add label photo"), Warranty (label, percent elapsed, an 8 px bar, a note, a KV list Purchased, Retailer, Paid, and the outline button "Something's wrong with it"), and Recall checks (a status dot plus text, the rationale, and "Checked against {sources} in {n} nightly sweeps since intake."). It opens from any item name. It closes on × or when the user goes to a page other than Home or Inventory. Mobile: a fixed bottom sheet of 60 vh with a radius of 16 at the top.

**Toast.** Fixed at the bottom center (20 px; 76 px on mobile, above the tabs). Ink background, text in the background color, Habibi 14, pill shape, 3 s.

## Screens

### Home

Title "One thing needs you" (pending) or "All quiet". Subtitle "A critical recall matched an item you own. Everything else ran on its own." (pending) or "What the agent did while you were away." (quiet). Actions on the right: the outline button "Copy forwarding address" and the primary button "Add item".

1. **Quiet score hero** container, 2 auto-fit columns (minimum 300, gap clamp 20 to 40).
   - Left: the eyebrow "QUIET SCORE". The number (0 if pending, else 42) plus "days since Guardian last needed you" (18 px secondary, maximum 220 px). The italic line "The agent's best output is silence."
   - Right: 2 by 2 stat tiles (buttons, minimum height 104, radius 12, primary border on hover). Each tile links to a page: Items watched 312 to Inventory; Sweeps run 187 to Activity; Recalls screened, 30 days 214 to Activity; Decisions pending {n} to Decisions (critical tint background when more than 0).
2. Two auto-fit containers (minimum 300): **Last night's sweep** (a header plus the "All activity" link; rows with a time in 13 px Roboto Slab, 44 px wide, the text, and a status dot plus the result line) and **Warranties ending soon** (a header plus the "Inventory" link; rows with an item name button that opens the detail, "ends {date}", a 6 px bar colored by the elapsed percent, and a note).

### Decisions

Title "Decisions (n pending)". Subtitle "The same cards your phone points to. One tap, then the agent finishes the job." Below: a flex-wrap row. The pending card is `flex 1 1 560px`. Past decisions is `flex 1 1 320px`.

- **Pending decision card.** A 6 px top border in `#960200`. The badge "! CRITICAL HAZARD". The meta line "CPSC recall 25‑000 · surfaced 03:04 today · expires in 71 h". The title "Graco Modes Nest stroller — hinge can pinch or amputate a fingertip". The remedy sentence. A tinted KV strip (Purchased, Model, Match confidence, Sold window). The disclosure "▸ Why Guardian thinks this is yours" (it shows a tinted rationale with a 3 px primary inline-start border) and the link button "Open item and receipt" (it opens the split panel). The action row has a top border. It holds the critical primary button "Request free repair kit" (flex 1 1 200). Next to it: the outline buttons "No longer own it" and "Not mine", and the text button "Ask me tomorrow". All are 44 px tall.
- **After an answer.** A green-topped container "Remedy requested", "Snoozed until tomorrow", or "Match closed". It has a vertical step timeline (14 px dots, a 2 px connector; completed is ok green, future is the border color) and the link "See it in the activity log". A toast confirms.
- **Empty state** (the quiet scenario). A dashed container, a green ✓ disc of 56 px, "Nothing needs you", "The last sweep found nothing that applies to your household. The next one runs at 03:00."
- **Past decisions** list. Rows with a radius of 12 (dot, title, detail, outcome in color, date). Primary border on hover.

### Inventory

Title "Inventory (312)", a subtitle, and the primary button "Add item" (toast). Container: a toolbar (a search input of 40 px, 2 px border, radius 8; the filter pill toggles Category, Warranty status, and Recall status; pressed is the primary fill). A table header row (tint background, Habibi 12 uppercase) with the columns `2fr 1fr 1fr 1.4fr 1.2fr`: Item, Category, Purchased, Warranty, Recall status. Rows have 12 px 16 px padding, a 3 px inline-start selection bar, tint on hover, and a click opens the detail. The item cell is a 40 px striped thumbnail plus the name (link button) plus "brand · model". The warranty cell is a label plus a 6 px bar (maximum 220). The bar is ok below 70 percent, amber at 70 to 89 percent, and critical at 90 percent or more. The status cell is a dot plus text (Critical match, Clear, Adjudicated no, Resolved). Footer "1–6 of 312" plus 40 px previous and next buttons. Mobile: a single column, the header hidden, each cell with an 11 px uppercase label in front.

### Activity

Title, subtitle "Every sweep is logged, including the ones that found nothing.", and the link "How last night ran →" (to Agent flow). An auto-fit grid (minimum 380) of containers, one for each night: a header (date, summary dot plus text) and rows `52px 1fr`: time, a source badge (an outlined pill, uppercase 11 px: CPSC, NHTSA, FDA, Triage, Intake, Warranty), text.

### Agent flow (Technical): the summary page in the dashboard

It has the primary button "Open full trace view →" that links to `Guardian Agent Flow.dc.html` (below). Title, subtitle "Tonight's run as the Strands graph saw it. Deterministic code in grey, agents in blue, the human in amber.", and the amber tag "WIREFRAME · BUILT IN PHASE 7". A container with a horizontally scrolling node row: 196 px node buttons (a kind badge Code, Agent, or Human with tint, primary, or amber fills, the name in Roboto Slab 15, meta, a status dot plus text) joined by 36 px connectors with arrowheads (they flip in RTL). Nodes: Feeds refresh, Candidate generation, matcher, triage (interrupted while pending), Household, remedy. A selection of a node fills the **detail container**: a description, the KV Duration, Tokens, and Cost, and a "STRUCTURED OUTPUT" `pre` block (ltr). A second dashed container "What this view will show" (5 bullets: a live Observability trace, structured output for each node with the interrupt wait, memory reads and writes, token and cost totals, replay).

**Implementation note (2026-09-13).** The built Agent flow tab embeds the full trace view of the next section inside the dashboard shell, in place of this summary page. `docs/AGENT_FLOW.md` describes the result.

### Agent flow: the full trace view (`Guardian Agent Flow.dc.html`)

This is a rebuild of the gren runs dashboard (`gren/v1/src/ui/index.html` in the repository of the team; REST and SSE from `src/server`) in the shell, the palette, and the fonts of Guardian. Replace the Inter and system font stack of gren, its blue `#2563eb`, its purple `#7c3aed`, and its green, amber, and red with the tokens here. Purple (route) is replaced with ink `#000F08`.

**Layout.** The Guardian top bar (the logo links back to the dashboard, "/ Agent flow", the amber TECHNICAL tag, a pulsing green "Trace stream connected", the Dark and RTL pills, the primary button "Run sweep now"). Below it: three columns.

- **Runs sidebar** (resizable 220 to 420, default 280; hidden on mobile and replaced by a `<select>` run picker). A row is a status dot plus the graph name (Roboto Slab 14 at 600) plus a "live" pill, the monospace run id, and Habibi meta (the status in color, done of total nodes, cost). The selected row has a tint background plus a 3 px primary inline-start bar.
- **Canvas** (a dot grid `radial-gradient(line 1px)` at 20 px). An SVG with pan (drag), wheel zoom (0.2 to 3 times), node drag, and keyboard-focusable nodes (Enter selects). The toolbar at the top start: a pill group Fit, +, −, the toggle "Critical path" (pressed is the primary fill), and "Auto-layout". The run strip at the top end: status, cost, wall clock, and the amber button "1 gate waiting". The legend at the bottom start (hidden when the canvas is less than 300 px tall or less than 760 px wide). An edge tooltip on hover shows `from → to · kind` and the `$nodes.*` data list.
- **Node card.** 216 by 88, radius 12, surface fill, a 1.2 px border (2 px plus primary dashed plus the `gDash` animation when running; 2 px amber when waiting; 2 px critical when failed; 2.5 px primary when selected; 3 3 dashed at 60 percent opacity when skipped; critical-path nodes get a primary border). A 5 px kind stripe on the inline-start edge: Code `#4A5551`, Agent `#2274A5`, Verify `#2E7D4F`, Gate or human `#FCBA04`. A status dot of r5 at (20,20): completed is ok, running and waiting pulse. Texts:
  - The id in Roboto Slab 13.5 at 600.
  - The kind label in Habibi 10.5 uppercase in the kind color (end-aligned).
  - The sub line in Habibi 11 secondary (model · map · tools · side-effect).
  - The badge in monospace 11 (items, kill rate, attempts, "awaiting approval").
  - Duration · cost in Roboto Slab 11 at the bottom end.
  Nodes that are not related dim to 30 percent when one node is selected.
- **Edges.** A cubic bezier from the mid-right of a card to the mid-left of the next (handles of plus or minus 44 px). Repair edges arc over the top. Colors:
  - Data: `faint`, 1.6 px. It becomes ok green after the source completed and the target started.
  - Gate: amber `#D9A004`, dashed 7 4.
  - Repair: `#960200`, dashed 4 3.
  - Route: ink, solid.
  - Critical path: primary, 2.6 px. Highlighted: primary, 2.8 px. Unrelated: 18 percent opacity.
  Arrowheads come through `<marker>` in the matching colors.
- **Drawer** (at the bottom of the canvas column). A 14 px grab bar, resizable from 120 px to 45 percent of the column, default min(260, 32 percent). It starts collapsed to the 52 px tab strip when the column is less than 600 px tall. A ▾ and ▴ toggle. Tabs (Habibi 13, a 2 px primary underline when active):
  - Events: a monospace grid `72 170 150 1fr`. The type is colored by class: kill, reject, and failed are critical; finished, completed, and approved are ok; waiting, paused, and repair are amber.
  - Metrics: auto-fill 170 px cards (wall clock, parallel speedup, cost, peak width, node failure rate, verifier kill rate, human, tokens). Then a table for each node: Node, Kind, Status, Duration, Tokens, Cost. The rows are clickable.
  - Decisions: cards with a 3 px ink inline-start border (node, kind · time, a sentence, a state snapshot `pre`).
  - Tasks: an amber-bordered gate card with the green pill "Approve (as dashboard)" and the critical outline "Reject". An approval marks the gate completed, runs `remedy` and `followup`, appends events, and updates the metrics and the output.
  - Spec: a YAML `pre`. Output: a JSON `pre`.
  An amber count badge shows on Tasks while a gate waits.
- **Inspector** (right, resizable 280 to 600, default 380; hidden until a node is selected; on mobile a fixed bottom sheet of 70 vh with a radius of 16 at the top). From top to bottom:
  - A kind pill plus the status. The id (Roboto Slab 18). The sub line. The description.
  - A KV grid (Duration, Tokens, Cost, Attempts, On critical path).
  - An amber gate box with Approve and Reject, when waiting.
  - The list "Inputs crossing into this node" (from plus data code).
  - The structured output `pre` (maximum 260 px). The attempts list.
  - The footer buttons Copy last prompt, Copy node spec, and Fork run from here.
- fit(): scale = min(1.2, max(0.6, fit-to-bounds)). When clamped, center on the waiting or running node (else on `triage`). Re-fit after any panel resize, drawer toggle, inspector open or close, run change, or window resize.

**Graph (nightly-sweep).** The nodes run in this order:

1. feeds_refresh (code) and expiry_scan (code), in parallel.
2. candidate_gen (code) and warranty (agent, map), in parallel.
3. matcher (agent, map).
4. triage (agent).
5. severity_check (verify). It has a repair back-edge to triage, at most 1 round. It routes to household_decision when `plan.channel == sms_now`, else to digest.
6. household_decision (gate).
7. remedy (agent, side_effect, requires_gate).
8. followup (code).

The full YAML is in the `SPEC_YAML` of the file. Seeded runs: Sep 13 paused on the gate; Sep 10 to 12 quiet (skip cascade, $0); one intake run.

### Settings

Title, subtitle. The form is an auto-fit grid (minimum 340, gap 16). The sections are containers:

- **Interruptions.** Radio cards (44 px, 2 px border; selected is a primary border plus tint): "Critical only", "Once a week (default)", "Daily digest". "Value threshold for warranty check‑ins": a number input with a `$` prefix and the help text "Items below this expire quietly."
- **Quiet categories.** Toggle pills with a ✓ or + prefix (Juvenile, Kitchen, Appliance, Vehicle, Tools, Food).
- **Channels.** The forwarding address (monospace, read only, plus the outline button "Copy") and the phone for critical alerts (a tel input, ltr).
- **Appearance.** "Switch to Dark/Light mode", "Text direction: RTL/LTR".
- A full-width action row, right-aligned: the outline button "Cancel" and the primary button "Save changes" (toast "Preferences saved to Guardian memory.").

## State

The state has these fields:

- `page` (home, decisions, inventory, activity, settings, flow).
- `narrow` (matchMedia 860 or less), `dark`, `dir`.
- `pending` (derived: the scenario is critical and not resolved), `resolved` (null, approved, dismissed, snoozed), `rationaleOpen`.
- `selectedItemId` (it drives the split panel), `helpOpen`, `helpW`, `splitH`, `navW`, `flowSel`.
- `working` plus `coverOpen` (logo), the filters, categories, and budget, `toast`.

A navigation scrolls main to the top and moves the focus to `main` (no outline). Persist the theme, the direction, and the panel sizes for each user.

## Data (from BUILD_PLAN.md)

The dashboard reads the DynamoDB entities InventoryItem, MatchCandidate, Decision, Action, Activity, and Preferences. The decision actions call the decision API (`/d/<token>`, resume), which resumes the Strands graph. The Agent flow view reads the AgentCore Observability traces.

## Assets

There are no raster assets. The receipt thumbnails are striped placeholders. Replace them with S3 receipt images. The logo is pure CSS (see `Guardian Logos.dc.html` 1d and the `logo()` function in the v2 prototype). The fonts come from Google Fonts: Roboto Slab, Lora, Habibi.

## Files

- `Guardian Dashboard v2.dc.html`: the current design, all screens and behaviors
- `Guardian Agent Flow.dc.html`: the full trace view (the gren dashboard rebuilt in the Guardian style)
- `Guardian Dashboard.dc.html`: v1, reference only
- `Guardian Logos.dc.html`: the logo options 1a to 1e (1d chosen)
- `BUILD_PLAN.md`: the product and architecture plan that the design implements
- `support.js`: the runtime that opens the `.dc.html` prototypes locally (not for production)
