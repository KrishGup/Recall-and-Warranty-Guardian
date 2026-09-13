// Info panel copy per page. Text is the prototype's helpMap (design/Guardian Dashboard v2.dc.html), verbatim.
import type { PageId } from './ShellContext'

export interface HelpContent {
  title: string
  body: string
  points: { k: string; v: string }[]
}

export const helpMap: Record<PageId, HelpContent> = {
  home: {
    title: 'About this page',
    body: 'Home proves the agent worked while nobody watched. The quiet score counts days since Guardian last needed a decision from you.',
    points: [
      { k: 'Quiet score', v: 'Resets to 0 when a decision is surfaced. Critical hazards reset it; digest items do not.' },
      { k: 'Sweeps', v: 'One per night at 03:00 local, plus a weekly openFDA full‑window refresh.' },
      { k: 'Forwarding', v: 'Forward any receipt or order confirmation to the address. Card numbers are stripped before anything is stored.' },
    ],
  },
  decisions: {
    title: 'Decisions',
    body: 'Each card is one confirmed match or warranty question that policy says is worth your time. Answering here or by SMS does the same thing.',
    points: [
      { k: 'Request remedy', v: 'Guardian sends the drafted request with your receipt and follows up in 10 business days.' },
      { k: 'No longer own it / Not mine', v: "Closes the match, updates the item, and trains the matcher's alias table for your household." },
      { k: 'Expiry', v: 'Links expire after 72 hours; the card stays here until you answer.' },
    ],
  },
  inventory: {
    title: 'Inventory',
    body: 'Every item Guardian watches, built from receipts, photos, and VINs. Select a name to open its detail panel.',
    points: [
      { k: 'Warranty bar', v: 'Elapsed share of the term. "Estimate" means the term came from a category default, not the receipt.' },
      { k: 'Recall status', v: 'Clear, adjudicated no (the model said no, with reasons), or a match state.' },
      { k: 'Add label photo', v: 'A photo of the model/date‑code label makes ambiguous candidates resolvable.' },
    ],
  },
  activity: {
    title: 'Activity',
    body: 'The full log, including nights that found nothing. This is the evidence behind the quiet score.',
    points: [
      { k: 'Sources', v: 'CPSC, NHTSA, and openFDA nightly; FSIS optional.' },
      { k: 'Adjudicated no', v: 'A candidate the model rejected. The rationale is kept so you can audit it.' },
    ],
  },
  settings: {
    title: 'Settings',
    body: "These mirror the preferences stored in Guardian's memory. Plain‑language replies by SMS update the same values.",
    points: [
      { k: 'Budget', v: 'Caps unsolicited interruptions. Critical hazards always bypass it.' },
      { k: 'Threshold', v: 'Warranty check‑ins only for items above this price.' },
    ],
  },
  flow: {
    title: 'Agent flow',
    body: 'A technical view of one nightly run. Grey nodes are deterministic code; blue nodes call a model; amber is the human interrupt.',
    points: [
      { k: 'Why it is cheap', v: 'Only ambiguous candidates reach a model. Most nights cost cents.' },
      { k: 'Interrupts', v: 'Tool‑level in triage and warranty; hook‑level guard on remedy so nothing sends without a recorded approval.' },
    ],
  },
}
