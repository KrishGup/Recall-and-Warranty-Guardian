# Preparing to record the showcase video

This is the checklist for `docs/SHOWCASE_SCRIPT.md`. Read it before you
record. It covers what to seed, what provider to run, what to have open,
and what to rehearse. It does not cover the tight 4:44 cut; that video is
already recorded, and `docs/DEMO_SCRIPT.md` documents it as built.

## 1. Decide on a provider before you seed anything

The sweep scene (Scene 6) behaves differently by provider. Choose one and
say so in your prep notes, because it changes what you narrate:

| Provider | What you get | Use it when |
|---|---|---|
| `mock` (`GREN_ALLOW_MOCK=1`) | Instant, free, deterministic. No live feed calls, no model spend. | You want a reliable take with no wait and no cost, and you are comfortable saying the run is against recorded fixtures, not live feeds. |
| `claude-code`, `anthropic`, or `bedrock` against live feeds | Real CPSC, NHTSA, and openFDA data; a real spend and a real wait (about 2 to 4 minutes to the gate, per the numbers in Scene 12). | You want the real-numbers beat (Scene 12) to be true of the take you are recording, not a past run. |

Check `read_this_labubu.md` and `docs/AWS_SETUP.md` for the current state
of Bedrock authorization on the AWS account before you plan a live-feed
take against the deployed site; it has been blocked before. `ANTHROPIC_API_KEY`
in `.env` is the fallback that keeps the graphs unchanged.

If you are not sure, use `mock` for rehearsal takes and a live provider
only for the final recording.

## 2. Seed the household

```bash
guardian seed                 # with case-study fixtures: guaranteed matches for Scenes 6-9
guardian seed --no-case-studies   # the 12 real items only, no guaranteed match
```

Use the case-study seed if you need the sweep to reliably produce a
pending decision on camera. Use `--no-case-studies` only if you are
recording against live feeds and are willing to let the real feeds decide
whether anything matches that day — check that at least one match is
likely before you rely on it live.

Decide in advance whether Scene 4 (Home) should show a quiet score of zero
(a sweep already ran and something is pending) or a nonzero quiet score (no
sweep has run yet this session). The script has a bracketed line for
either case — fill it in before you read, not while recording.

## 3. Start the stack

```bash
guardian serve --port 8787       # API, gren API at /gren, and the built dashboard
cd web && npm run dev            # dashboard dev server on :5173, proxies to 8787
```

`.claude/launch.json` starts both. Confirm both are up and the dashboard
loads at `http://localhost:5173` before you open a recorder.

## 4. Open the screens you need, in order

Open these as separate browser tabs ahead of time so switching is a click,
not a navigation:

1. Home (`/`)
2. Inventory (`/inventory`), with one item already known so you are not
   searching for it live
3. Agent flow (`/flow`), or `/flow/trace` for the full-screen frame if you
   want the graph canvas at maximum size
4. Decisions (`/decisions`)
5. Activity (`/activity`)
6. Settings (`/settings`)

Run the browser at 1920x1080 or larger. The Agent flow canvas is sized for
a 1080p screen; a smaller window crops the graph or forces it to scroll
mid-scene.

## 5. Rehearse the live clicks, not just the lines

The script assumes these actions happen at specific points. Walk through
them once, dry, before recording:

- Scene 5: opening an inventory item, then "Add item" if you plan to show
  intake live rather than describe it.
- Scene 6: clicking "Run sweep now" and letting the graph run to the gate
  without narrating over the pause — let the amber banner land, then speak.
- Scene 7 (if kept): clicking through the drawer tabs in the order the
  script names them, and opening the inspector on one node.
- Scene 8: expanding "Why Guardian thinks this is yours" before tapping the
  remedy button, so the rationale is on screen when you mention it.
- Scene 9: returning to Agent flow to show the run complete, then Decisions
  for the outcome steps, then Activity for the logged history.

If two people are recording, agree on who clicks and who talks for each of
these five points before you start; do not improvise the hand-off live.

## 6. Fill in the bracketed numbers

Scene 4 and Scene 12 have bracketed placeholders (`[N]`, `[$0.41]`,
`[235]`). Replace them with the real values from the session you are about
to record, not the numbers from a past run — they are meant to match what
is on screen, and `docs/DEMO_SCRIPT.md` already documents the 2026-09-13
numbers for the tight cut, so reusing them here would contradict a fresh
take. If you are recording on `mock`, say so and use the mock run's own
numbers, or cut Scene 12 outright — it is marked cuttable for this reason.

## 7. One or two speakers

- **One person:** read every line; the Presenter and Engineer labels are
  a guide to tone, not a hard split. Slow down slightly in Engineer
  sections; they carry more technical density per sentence.
- **Two people:** Presenter drives the browser through Scenes 4, 5, 8, 9,
  10, and 14. Engineer drives Scenes 6, 7, 11, and 13, and should be at the
  keyboard for the Agent flow tab since most of their lines describe what
  is happening on it live. Agree on the hand-off wording at each scene
  boundary — a short "over to you" is enough; do not script it.

## 8. Pace and cuts

Read at about 140 words a minute, matched to `docs/DEMO_SCRIPT.md`. Do not
talk over a pause the UI itself creates (the gate landing, a page loading);
let it land, then speak. Cut on scene boundaries only — every scene in
`docs/SHOWCASE_SCRIPT.md` is written to stand alone, so a jump cut between
scenes never crosses a sentence.

## 9. Final check before you hit record

- [ ] Provider decided (Section 1) and `.env` set accordingly.
- [ ] Household seeded the way this take needs (Section 2).
- [ ] `guardian serve` and `npm run dev` both running, dashboard loads.
- [ ] All six tabs open, in order (Section 4).
- [ ] Browser window at 1080p or larger, dark or light mode chosen on
      purpose (Settings has the toggle — decide before recording, since
      switching mid-video is a visible seam).
- [ ] Dry run of the five live-click points (Section 5) completed once.
- [ ] Bracketed numbers in the script filled in or the scene cut
      (Section 6).
- [ ] Speaker split agreed, if two people are reading (Section 7).
