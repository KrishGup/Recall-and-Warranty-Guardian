// In-browser mock of the Guardian API for `VITE_MOCK=1 npm run dev`: the prototype's seed household (six items,
// the Graco critical decision, three nights of activity, ending-soon warranties, preferences) and a small fake
// gren run, so every page and flow renders with no Python backend.
import { installApi, type ApiShape } from '../api/client'
import type {
  ActivityNight, ActivityRow, AnswerResult, Category, Decision, DecisionChoice, GrenAnalysis, GrenMetrics, GrenNodeKind, GrenNodeRecord,
  GrenNodeStatus, GrenRun, GrenRunStatus, GrenRunSummary, GrenSpecNode, IntakeResult, Item, ItemDetail, ItemsPage, ItemsQuery, MatchCandidate,
  NewItem, Preferences, RecallSummary, Severity, Summary,
} from '../api/types'

const ADDRESS = 'receipts@guardian.house'
const RUN_ID = 'nightly-sweep-20260913-030004-mock'
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()
const todayIso = () => new Date().toISOString().slice(0, 10)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
function at(hhmm: string, dayOffset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  const [h, m] = hhmm.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
function plusDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ---------------------------------------------------------------------------------------------------------------
// items

interface Seed {
  id: string
  name: string
  brand: string
  model: string | null
  upc?: string | null
  category: Category
  date: string
  price: number | null
  retailer: string
  term: number | null
  ends: string | null
  source: Item['warranty']['source']
  pct: number | null
  wlabel: string
  wnote: string
  state: Item['recall']['state']
  label: string
  rationale: string
  sources: string[]
  sweeps: number
  vehicle?: Item['vehicle']
}

function mkItem(p: Seed): Item {
  return {
    id: p.id, name: p.name, brand: p.brand, model_number: p.model, upc: p.upc ?? null, serial: null, category: p.category, purchase_date: p.date, price: p.price,
    currency: 'USD', retailer: p.retailer, receipt_ref: null,
    warranty: { term_months: p.term, ends_on: p.ends, source: p.source, extended: false, elapsed_pct: p.pct, label: p.wlabel, note: p.wnote },
    vehicle: p.vehicle ?? null, status: 'watched',
    recall: { state: p.state, label: p.label, rationale: p.rationale, sources: p.sources, sweeps: p.sweeps },
    created_at: at('11:40', -30),
    photo_url: null, gmail_message_id: null,
  }
}

const ITEMS: Item[] = [
  mkItem({ id: 'itm_graco', name: 'Modes Nest stroller', brand: 'Graco', model: '2137765', upc: '047406171224', category: 'Juvenile', date: '2024-03-14', price: 379.99, retailer: 'Target', term: 12, ends: '2025-03-14', source: 'receipt', pct: 78, wlabel: '12 mo · ends 2025-03', wnote: 'Term read from receipt. Manufacturer registration URL stored.', state: 'critical_match', label: 'Critical match', rationale: 'UPC on receipt equals a UPC in CPSC recall 25-000. Purchase date inside sold window. Marked certain at stage 1.', sources: ['CPSC'], sweeps: 187 }),
  mkItem({ id: 'itm_subaru', name: 'Outback 2019', brand: 'Subaru', model: null, category: 'Vehicle', date: '2021-06-02', price: 27400, retailer: 'Carmax', term: 60, ends: '2024-06-02', source: 'manufacturer', pct: 100, wlabel: 'Powertrain 60 mo · ended', wnote: 'Factory term expired 2024-06. No extended plan found.', state: 'clear', label: 'Clear · 3 campaigns checked', rationale: 'Three NHTSA campaigns exist for this make and model; none cover model year 2019.', sources: ['NHTSA'], sweeps: 187, vehicle: { vin: '4S4BSANC2K3372741', year: 2019, make: 'Subaru', model: 'Outback' } }),
  mkItem({ id: 'itm_frigidaire', name: '50-pint dehumidifier', brand: 'Frigidaire', model: 'FFAD5033W1', category: 'Appliance', date: '2023-07-21', price: 249, retailer: 'Home Depot', term: 12, ends: '2026-07-21', source: 'category_default', pct: 62, wlabel: '12 mo · estimate', wnote: 'Category default: receipt had no warranty line. Shown as an estimate.', state: 'adjudicated_no', label: 'Adjudicated no', rationale: 'Lexical candidate for a Frigidaire recall. Label photo showed date code 2023-W29, outside the recalled range. Matcher verdict: no, confidence 0.93.', sources: ['CPSC'], sweeps: 140 }),
  mkItem({ id: 'itm_vitamix', name: 'Ascent A2500 blender', brand: 'Vitamix', model: 'A2500', category: 'Kitchen', date: '2016-10-01', price: 449.95, retailer: 'Williams Sonoma', term: 120, ends: '2026-10-01', source: 'receipt', pct: 96, wlabel: '120 mo · ends 2026-10-01', wnote: 'Ends in 18 days and exceeds your $200 threshold. Guardian will ask once whether anything is wrong.', state: 'clear', label: 'Clear', rationale: 'No candidates in 187 sweeps.', sources: ['CPSC'], sweeps: 187 }),
  mkItem({ id: 'itm_babyletto', name: 'Convertible crib', brand: 'Babyletto', model: 'M4901', category: 'Juvenile', date: '2024-01-09', price: 399, retailer: 'Target', term: 12, ends: '2027-01-09', source: 'receipt', pct: 40, wlabel: '12 mo · receipt', wnote: 'Term read from receipt.', state: 'clear', label: 'Clear', rationale: 'Two lexical candidates over time, both dropped by the date-window filter before any LLM call.', sources: ['CPSC'], sweeps: 187 }),
  mkItem({ id: 'itm_similac', name: 'Infant formula, 6 × 12.4 oz', brand: 'Similac', model: 'Lot 37-Q', category: 'Food', date: '2026-08-30', price: 189.99, retailer: 'Costco', term: null, ends: null, source: 'none', pct: null, wlabel: 'n/a', wnote: 'Consumables have no warranty; watched for FDA enforcement by lot code.', state: 'clear', label: 'Clear', rationale: 'Lot code compared against FDA food enforcement reports weekly.', sources: ['openFDA'], sweeps: 14 }),
]

const GRACO_RECALL: RecallSummary = {
  recall_id: 'cpsc#25-000', source: 'cpsc', title: 'Graco Recalls Modes Nest Strollers Due to Fingertip Amputation and Laceration Hazards', published_at: at('09:00', -1),
  url: 'https://www.cpsc.gov/Recalls', hazard_text: 'The stroller hinge can pinch or amputate a fingertip.', remedy_text: 'Contact Graco for a free repair kit.', severity: 'critical',
  contact: { phone: '800-345-4109', email: null, url: 'https://www.gracobaby.com/recall' }, sold_window: { from: '2023-09', to: '2025-02' }, retailers: ['Target', 'Amazon'],
}

const GRACO_MATCH: MatchCandidate = {
  id: 'mc_graco', item_id: 'itm_graco', recall_id: 'cpsc#25-000', stage: 1, key: 'upc', score: 100, verdict: 'certain', confidence: null,
  rationale: "UPC 047406171224 on your receipt equals a UPC listed in the recall's product table. Purchase date falls inside the sold window.", missing_info: [],
  state: 'surfaced', recall: GRACO_RECALL, created_at: at('03:02'), run_id: RUN_ID,
}

// ---------------------------------------------------------------------------------------------------------------
// decisions

const GRACO_DECISION: Decision = {
  id: 'dec_graco', kind: 'recall_remedy', severity: 'critical', state: 'pending', created_at: at('03:04'), expires_at: new Date(Date.now() + 71 * 3600e3).toISOString(),
  run_id: RUN_ID, gate: 'household_decision', item_id: 'itm_graco', item_name: 'Graco Modes Nest stroller', badge: 'Critical hazard',
  meta: 'CPSC recall 25‑000 · surfaced 03:04 today · expires in 71 h', title: 'Graco Modes Nest stroller — hinge can pinch or amputate a fingertip',
  summary: 'Remedy: free repair kit from the manufacturer. Guardian has drafted the request and attached your Target receipt.',
  message: 'The Graco stroller you bought at Target on 2024-03-14 has a critical recall (fingertip amputation). Reply 1 to request the free repair kit, 2 if you no longer own it, 3 if it is not yours.',
  recall: GRACO_RECALL,
  match: { stage: 1, key: 'upc', confidence_label: 'Certain (stage 1, exact key)', rationale: "UPC 047406171224 on your receipt equals a UPC listed in the recall's product table. Purchase date falls inside the sold window. No LLM adjudication was needed; the matcher marked it certain deterministically." },
  facts: [
    { label: 'Purchased', value: '2024‑03‑14, Target' },
    { label: 'Model', value: '2137765 · UPC match' },
    { label: 'Match confidence', value: 'Certain (stage 1, exact key)' },
    { label: 'Sold window', value: '2023‑09 to 2025‑02' },
  ],
  options: [
    { key: 'request_remedy', label: 'Request free repair kit', style: 'critical' },
    { key: 'no_longer_own', label: 'No longer own it', style: 'outline' },
    { key: 'not_mine', label: 'Not mine', style: 'outline' },
    { key: 'snooze', label: 'Ask me tomorrow', style: 'text' },
  ],
  answer: null, outcome: null, past_label: null,
}

function pastDecision(p: { id: string; item_id: string; item_name: string; title: string; kind: Decision['kind']; severity: Severity; choice: DecisionChoice; past_label: string; state: Decision['state']; days: number; summary: string }): Decision {
  const when = at('09:12', -p.days)
  return {
    id: p.id, kind: p.kind, severity: p.severity, state: p.state, created_at: when, expires_at: null, run_id: null, gate: null, item_id: p.item_id, item_name: p.item_name,
    badge: p.severity === 'critical' ? 'Critical hazard' : p.kind === 'warranty_checkin' ? 'Warranty window' : 'Standard hazard', meta: `surfaced ${shortDate(when)}`, title: p.title,
    summary: p.summary, message: p.summary, recall: null, match: null, facts: [], options: [], answer: { choice: p.choice, by: 'household', at: when }, outcome: null, past_label: p.past_label,
  }
}

const PAST: Decision[] = [
  pastDecision({ id: 'dec_frig', item_id: 'itm_frigidaire', item_name: 'Frigidaire dehumidifier', title: 'Frigidaire dehumidifier — label photo requested', kind: 'recall_remedy', severity: 'standard', choice: 'not_mine', past_label: 'Closed · not affected', state: 'answered', days: 42, summary: 'You sent the photo; matcher returned no (date code outside range).' }),
  pastDecision({ id: 'dec_subaru', item_id: 'itm_subaru', item_name: 'Subaru Outback', title: 'Subaru Outback — NHTSA campaign 24V‑311', kind: 'recall_remedy', severity: 'standard', choice: 'request_remedy', past_label: 'Remedy done', state: 'answered', days: 117, summary: 'Standard hazard, auto‑requested per your preference. Dealer appointment confirmed.' }),
  pastDecision({ id: 'dec_vitamix', item_id: 'itm_vitamix', item_name: 'Vitamix A2500', title: 'Vitamix A2500 — warranty check‑in', kind: 'warranty_checkin', severity: 'standard', choice: 'fine', past_label: 'Checked in · fine', state: 'answered', days: 365, summary: 'You replied "it\'s fine." No claim drafted.' }),
]

// ---------------------------------------------------------------------------------------------------------------
// preferences, activity

const PREFS: Preferences = { budget: 'weekly', value_threshold: 200, quiet_categories: ['Kitchen', 'Tools'], phone: '+1 (415) 555‑0134', forwarding_address: ADDRESS, sensitivities: { infant: true, pregnancy: false, elderly: false, allergens: [] } }

function row(time: string, source: string, text: string, result: string | null, tone: ActivityRow['tone'], dayOffset = 0): ActivityRow {
  return { time, source, text, result, tone, at: at(time, dayOffset) }
}

const state = {
  items: clone(ITEMS),
  decisions: [clone(GRACO_DECISION), ...clone(PAST)],
  prefs: clone(PREFS),
  working: false,
  sweepsRun: 187,
  extraRows: [] as ActivityRow[],
  answeredNow: false,
}

const pendingList = () => state.decisions.filter(d => d.state === 'pending')

function tonightRows(): ActivityRow[] {
  const pending = pendingList().length > 0
  return [
    row('03:02', 'CPSC', 'Pulled 4 new CPSC recalls', pending ? '1 candidate · certain' : '0 candidates', pending ? 'critical' : 'ok'),
    row('03:02', 'NHTSA', 'Checked 2019 Subaru Outback against NHTSA', '0 campaigns', 'ok'),
    row('03:03', 'FDA', 'Pulled 61 FDA enforcement reports', '1 candidate · adjudicated no (different lot range)', 'muted'),
    row('03:04', 'Triage', pending ? 'Drafted remedy request, sent SMS, paused for decision' : 'Sweep complete', pending ? 'Waiting on you' : 'Nothing to report', pending ? 'critical' : 'ok'),
    ...state.extraRows,
  ]
}

function nights(): ActivityNight[] {
  const pending = pendingList().length > 0
  const label = (off: number) => shortDate(at('12:00', off))
  const list: ActivityNight[] = [
    { date: todayIso(), label: `Tonight · ${label(0)}`, summary: pending ? '1 decision pending' : 'Quiet', tone: pending ? 'critical' : 'ok', run_id: RUN_ID, rows: [...tonightRows()].reverse() },
    { date: plusDays(-1), label: label(-1), summary: 'Quiet', tone: 'ok', run_id: 'nightly-sweep-mock-2', rows: [row('11:40', 'Intake', 'Receipt from Target parsed: Babyletto crib sheet set, $34, warranty n/a', null, 'ok', -1), row('03:01', 'NHTSA', '0 new campaigns for 1 vehicle', null, 'ok', -1), row('03:01', 'CPSC', 'Pulled 2 new recalls', '0 candidates', 'ok', -1)] },
    { date: plusDays(-2), label: label(-2), summary: 'Quiet', tone: 'ok', run_id: 'nightly-sweep-mock-3', rows: [row('03:02', 'Warranty', 'Vitamix A2500 ends within 30 days and exceeds $200', 'question queued within budget', 'muted', -2), row('03:01', 'CPSC', 'Pulled 5 new recalls', '2 lexical candidates, both dropped by date window', 'ok', -2)] },
  ]
  return list
}

function summary(): Summary {
  const pending = pendingList()
  const status: Summary['agent_status'] = state.working ? 'working' : pending.length ? 'pending' : 'idle'
  return {
    household: { id: 'hh_demo', name: 'The demo household' },
    agent_status: status,
    agent_label: { working: 'Sweeping now…', pending: 'Needs you', idle: 'Quiet' }[status],
    sweep_label: state.working ? 'Sweep running' : 'Last sweep 03:04 today',
    last_sweep: { run_id: RUN_ID, at: at('03:00'), status: state.working ? 'running' : pending.length ? 'paused' : 'completed' },
    quiet_days: pending.length || state.answeredNow ? 0 : 42,
    items_watched: state.items.filter(i => i.status === 'watched').length,
    sweeps_run: state.sweepsRun,
    recalls_screened_30d: 214,
    decisions_pending: pending.length,
    forwarding_address: ADDRESS,
    recent_activity: tonightRows(),
    ending_soon: [
      { item_id: 'itm_vitamix', name: 'Vitamix Ascent A2500', ends_on: plusDays(18), days_left: 18, pct: 96, note: 'Guardian will ask "anything wrong with it?" on Sep 17.' },
      { item_id: 'itm_frigidaire', name: 'Frigidaire dehumidifier', ends_on: plusDays(34), days_left: 34, pct: 62, note: 'Term from category default; receipt had no warranty line.' },
      { item_id: 'itm_babyletto', name: 'Babyletto crib', ends_on: plusDays(55), days_left: 55, pct: 40, note: '12‑month term read from receipt.' },
    ],
    provider: { bridge: 'mock', live: false, label: 'mock provider (no tokens)' },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// items API

function matchesQuery(it: Item, q: ItemsQuery): boolean {
  const needle = (q.q ?? '').trim().toLowerCase()
  if (needle && ![it.name, it.brand, it.model_number ?? '', it.retailer ?? '', it.category].join(' ').toLowerCase().includes(needle)) return false
  if (q.category && it.category !== q.category) return false
  const today = todayIso()
  const ends = it.warranty.ends_on
  switch (q.warranty) {
    case 'active':
      if (!ends || ends < today) return false
      break
    case 'ending':
      if (!ends || ends < today || ends > plusDays(60)) return false
      break
    case 'expired':
      if (!ends || ends >= today) return false
      break
    case 'none':
      if (it.warranty.elapsed_pct != null) return false
      break
    default:
      break
  }
  const groups: Record<string, string[]> = { clear: ['clear', 'unchecked'], match: ['critical_match', 'standard_match', 'candidate'], adjudicated_no: ['adjudicated_no'], resolved: ['resolved'] }
  if (q.recall && !(groups[q.recall] ?? []).includes(it.recall.state)) return false
  return true
}

const ORDER: Record<string, number> = { critical_match: 0, standard_match: 1, candidate: 2, resolved: 3, adjudicated_no: 4, clear: 5, unchecked: 6 }

function itemsPage(q: ItemsQuery = {}): ItemsPage {
  const rows = state.items.filter(it => matchesQuery(it, q)).sort((a, b) => (ORDER[a.recall.state] ?? 9) - (ORDER[b.recall.state] ?? 9) || a.purchase_date.localeCompare(b.purchase_date))
  const page = Math.max(1, q.page ?? 1)
  const size = Math.max(1, q.page_size ?? 25)
  return { items: clone(rows.slice((page - 1) * size, page * size)), total: rows.length, page, page_size: size }
}

function guessCategory(text: string): Category {
  const t = text.toLowerCase()
  if (/stroller|crib|car seat|infant|baby/.test(t)) return 'Juvenile'
  if (/blender|mixer|toaster|kettle|pan|knife|air fryer/.test(t)) return 'Kitchen'
  if (/dehumidifier|washer|dryer|fridge|refrigerator|dishwasher|vacuum/.test(t)) return 'Appliance'
  if (/vin|sedan|suv|truck|outback|civic|camry/.test(t)) return 'Vehicle'
  if (/drill|saw|sander|wrench/.test(t)) return 'Tools'
  if (/formula|food|snack|juice|cereal/.test(t)) return 'Food'
  if (/tv|laptop|phone|speaker|headphone|roku|charger/.test(t)) return 'Electronics'
  if (/toy|lego|plush|doll/.test(t)) return 'Toys'
  if (/lamp|fan|sofa|chair|shelf|rug/.test(t)) return 'Home'
  return 'Other'
}

function createItem(body: NewItem, source: string): Item {
  const months = body.warranty_months ?? (body.category === 'Food' ? null : 12)
  const ends = months ? plusDays(0) : null
  let endsOn: string | null = null
  if (months) {
    const d = new Date(`${body.purchase_date}T12:00:00`)
    d.setMonth(d.getMonth() + months)
    endsOn = d.toISOString().slice(0, 10)
  }
  const elapsed = months && endsOn ? Math.max(0, Math.min(100, Math.round(((Date.now() - new Date(`${body.purchase_date}T12:00:00`).getTime()) / (new Date(`${endsOn}T12:00:00`).getTime() - new Date(`${body.purchase_date}T12:00:00`).getTime())) * 100))) : null
  const id = `itm_${Date.now().toString(36)}`
  const it: Item = {
    id, name: body.name, brand: body.brand || (body.name.split(/\s+/)[0] ?? ''), model_number: body.model_number ?? null, upc: body.upc ?? null, serial: body.serial ?? null, category: body.category,
    purchase_date: body.purchase_date, price: body.price ?? null, currency: 'USD', retailer: body.retailer ?? null, receipt_ref: null,
    warranty: { term_months: months, ends_on: endsOn ?? ends, source: body.warranty_months ? 'receipt' : months ? 'category_default' : 'none', extended: false, elapsed_pct: elapsed, label: months ? `${months} mo · ${endsOn && endsOn < todayIso() ? 'ended' : `ends ${endsOn?.slice(0, 7)}`}${body.warranty_months ? '' : ' · estimate'}` : 'n/a', note: body.warranty_months ? 'Term read from receipt.' : months ? 'Category default: receipt had no warranty line. Shown as an estimate.' : 'No warranty term on file.' },
    vehicle: body.vin ? { vin: body.vin, year: 0, make: body.brand, model: body.name } : null, status: 'watched',
    recall: { state: 'unchecked', label: 'Not yet swept', rationale: 'This item has not been through a nightly sweep yet.', sources: body.category === 'Vehicle' ? ['NHTSA'] : body.category === 'Food' ? ['openFDA'] : ['CPSC'], sweeps: 0 },
    created_at: nowIso(),
    photo_url: null, gmail_message_id: null,
  }
  state.items.unshift(it)
  const hhmm = new Date().toTimeString().slice(0, 5)
  state.extraRows.push(row(hhmm, 'Intake', `Added ${it.brand} ${it.name}`.trim(), `warranty ${it.warranty.label} · source ${source}`, 'ok'))
  return clone(it)
}

// ---------------------------------------------------------------------------------------------------------------
// answers

function outcomeFor(d: Decision, choice: DecisionChoice): NonNullable<Decision['outcome']> {
  const tomorrow = shortDate(at('08:00', 1))
  if (choice === 'request_remedy' || choice === 'report_problem') {
    return {
      title: 'Remedy requested', subtitle: 'Guardian takes it from here. You will only hear back if Graco goes quiet.',
      steps: [
        { text: 'You approved: request free repair kit', when: 'Just now', done: true },
        { text: 'Remedy request emailed to Graco with receipt attached', when: 'Just now · via SES', done: true },
        { text: 'Follow‑up check scheduled', when: `${shortDate(at('09:00', 14))} · 10 business days`, done: false },
        { text: 'Guardian nudges once if Graco is silent', when: 'Only if needed', done: false },
      ],
    }
  }
  if (choice === 'snooze') {
    return { title: 'Snoozed until tomorrow', subtitle: 'Logged. Nothing else to do.', steps: [{ text: 'You answered: ask me tomorrow', when: 'Just now', done: true }, { text: 'Guardian will resurface this at 08:00 tomorrow', when: tomorrow, done: false }] }
  }
  const what = { no_longer_own: 'no longer own it', not_mine: 'not mine', fine: "it's fine", done: 'done', review_and_attest: 'review and attest', skip_claim: 'skip this settlement' }[choice] ?? choice
  return { title: d.kind === 'recall_remedy' ? 'Match closed' : 'Noted', subtitle: 'Logged. Nothing else to do.', steps: [{ text: `You answered: ${what}`, when: 'Just now', done: true }, { text: d.kind === 'recall_remedy' ? 'Match closed and logged; item status updated' : 'No claim drafted', when: 'Just now', done: true }] }
}

function answer(id: string, choice: DecisionChoice): AnswerResult {
  const d = state.decisions.find(x => x.id === id)
  if (!d) throw new Error(`decision ${id} not found`)
  if (d.state !== 'pending') return { ok: true, decision: clone(d), run_id: d.run_id }
  if (!d.options.some(o => o.key === choice)) throw new Error(`choice must be one of ${d.options.map(o => o.key).join(', ')}`)
  d.answer = { choice, by: 'dashboard', at: nowIso() }
  d.state = choice === 'snooze' ? 'snoozed' : 'answered'
  d.outcome = outcomeFor(d, choice)
  d.past_label = { request_remedy: 'Remedy requested', no_longer_own: 'Closed · no longer owned', not_mine: 'Closed · not mine', snooze: 'Snoozed', fine: 'Checked in · fine', report_problem: 'Claim drafted', done: 'Done', review_and_attest: 'Claim drafted', skip_claim: 'Closed · skipped' }[choice]
  d.meta = d.meta.replace(/ · expires in .*$/, '')
  state.answeredNow = true
  const it = state.items.find(x => x.id === d.item_id)
  if (it) {
    if (choice === 'request_remedy') it.recall = { ...it.recall, state: 'resolved', label: 'Resolved', rationale: 'Remedy requested for CPSC recall 25‑000. Follow‑up scheduled.' }
    else if (choice === 'no_longer_own' || choice === 'not_mine') it.recall = { ...it.recall, state: 'clear', label: 'Clear', rationale: `Match closed: household answered "${choice === 'not_mine' ? 'not mine' : 'no longer own it'}".` }
    if (choice === 'no_longer_own') it.status = 'disposed'
  }
  const hhmm = new Date().toTimeString().slice(0, 5)
  state.extraRows.push(row(hhmm, 'Household', choice === 'request_remedy' ? `Approved 'Request free repair kit' for ${d.item_name}` : choice === 'snooze' ? `Snoozed: ${d.item_name}` : `Answered '${choice.replace(/_/g, ' ')}' for ${d.item_name}`, choice === 'request_remedy' ? 'remedy request emailed via SES' : choice === 'snooze' ? 'resurfaces tomorrow 08:00' : 'match closed', choice === 'snooze' ? 'muted' : 'ok'))
  return { ok: true, decision: clone(d), run_id: d.run_id }
}

// ---------------------------------------------------------------------------------------------------------------
// gren run (the prototype's six nodes)

function grenRun(): GrenRun {
  const pending = pendingList().length > 0
  const status: GrenRunStatus = state.working ? 'running' : pending ? 'paused' : 'completed'
  const t0 = at('03:00')
  const spec: GrenSpecNode[] = [
    { id: 'feeds_refresh', kind: 'code', description: 'Deterministic. Pulls new records by date window, normalizes them into RecallRecord rows, snapshots raw JSON to S3.' },
    { id: 'candidate_gen', kind: 'code', description: 'Exact keys, then brand + token_set_ratio ≥ 80, then the sold‑window filter. Only survivors reach a model.' },
    { id: 'matcher', kind: 'agent', model: 'opus', description: 'Adjudicates only the ambiguous pair (FDA lot range). The stroller was already certain and skipped the model.' },
    { id: 'triage', kind: 'agent', model: 'opus', description: 'Reads preferences from Memory, classifies severity (critical: amputation), checks the notification budget, drafts the SMS, and raises the guardian-decision interrupt.' },
    { id: 'household_decision', kind: 'gate', description: 'The graph is paused across Runtime invocations. State lives in the AgentCore Memory session; the decision row holds enough to rebuild the plan if a session is lost.' },
    { id: 'remedy', kind: 'agent', model: 'opus', side_effect: true, requires_gate: 'household_decision', description: 'Runs only after a recorded approval (hook‑level interrupt guards the node). Sends the request, attaches the receipt, schedules the 10‑day follow‑up, logs the action.' },
  ]
  const rec = (id: string, kind: GrenNodeKind, st: GrenNodeStatus, duration_ms: number | null, cost_usd: number, tokens: number, output: unknown): GrenNodeRecord => ({
    id, kind, status: st, attempts: [], cost_usd, usage: tokens ? { inputTokens: Math.round(tokens * 0.7), outputTokens: tokens - Math.round(tokens * 0.7), totalTokens: tokens } : {}, agent_calls: tokens ? 1 : 0, retries: 0, repairs: 0,
    started_at: st === 'pending' ? null : t0, ended_at: st === 'completed' ? t0 : null, duration_ms, error: null, skip_reason: null, output, outputs: null, items: null, verify: null, gate: null, route: null, route_reason: null, artifact: null, side_effect_done: null, repair: null,
  })
  const gateStatus: GrenNodeStatus = pending ? 'waiting_approval' : 'completed'
  const nodes: Record<string, GrenNodeRecord> = {
    feeds_refresh: rec('feeds_refresh', 'code', 'completed', 4100, 0, 0, { cpsc: 4, nhtsa: 0, fda: 61, upserted: 65 }),
    candidate_gen: rec('candidate_gen', 'code', 'completed', 300, 0, 0, { certain: 1, candidates: 1, unlikely: 3 }),
    matcher: rec('matcher', 'agent', 'completed', 6800, 0.041, 2140, { is_match: 'no', confidence: 0.93, rationale: 'Lot 37-Q outside recalled range 12-A..21-F', missing_info: [] }),
    triage: rec('triage', 'agent', 'completed', 2900, 0.027, 1380, { channel: 'sms_now', severity: 'critical', message: 'The Graco stroller you bought at Target…', options: ['request_remedy', 'no_longer_own', 'details'] }),
    household_decision: { ...rec('household_decision', 'gate', gateStatus, pending ? null : 27660000, 0, 0, pending ? null : { interruptResponse: { response: { choice: 'request_remedy' } } }), gate: pending ? { requested_at: at('03:04') } : { requested_at: at('03:04'), decision: 'approved', by: 'household', at: nowIso() } },
    remedy: rec('remedy', 'agent', pending ? 'pending' : 'completed', pending ? null : 5200, pending ? 0 : 0.018, pending ? 0 : 960, pending ? null : { type: 'email_sent', to: 'recalls@gracobaby.com', attachments: ['receipt-2024-03-14.pdf'], next_check_at: plusDays(14) }),
  }
  const ids = spec.map(n => n.id)
  const analysis: GrenAnalysis = {
    name: 'nightly-sweep',
    nodes: Object.fromEntries(ids.map((id, i) => [id, { id, kind: spec[i].kind, model: spec[i].model ?? null, deps: i ? [ids[i - 1]] : [], dependents: i < ids.length - 1 ? [ids[i + 1]] : [], level: i, est_ms: 3000, est_cost_usd: 0.02, fan_out: false, on_critical_path: true }])),
    edges: ids.slice(1).map((id, i) => ({ from: ids[i], to: id, kind: id === 'remedy' ? 'gate' : 'data', data: [] })),
    order: ids, levels: ids.map(id => [id]), critical_path: { nodes: ids, est_ms: 18000 }, sum_of_work_ms: 18000, parallel_speedup: 1, max_width: 1, est_cost_usd: { min: 0.05, max: 0.12 }, frozen: [], findings: [], checklist: [], ok: true,
  }
  const cost = Object.values(nodes).reduce((s, n) => s + n.cost_usd, 0)
  const wall = Object.values(nodes).reduce((s, n) => s + (n.duration_ms ?? 0), 0)
  const metrics: GrenMetrics = {
    run_id: RUN_ID, graph: 'nightly-sweep', status, wall_ms: wall, human_wait_ms: pending ? 0 : 27660000, active_ms: wall, nested_runs: 0, cost_usd: cost, agent_calls: pending ? 2 : 3,
    tokens: { input: 3500, output: 980, cache_read: 0 }, critical_path: { nodes: ids, ms: wall }, sum_of_node_ms: wall, parallel_speedup: 1, width: { peak: 1, budget: null, agent_seconds: 15 },
    node_failure_rate: 0, retry_rate: 0, verifier: { candidates: 0, killed: 0, kill_rate: 0, per_verifier: [] }, fan_out: { workers: 0, failed_workers: 0, unique_per_worker: null },
    compression: { records_in: 0, records_out: 0, ratio: 1, per_reducer: [] }, human: { gates: 1, approved: pending ? 0 : 1, rejected: 0, auto: 0, manual_tasks: 0, orchestrator_tasks: 0, cost_unknown_calls: 0, intervention_rate: 1 },
    cost_by_model: { opus: cost }, nodes: ids.map(id => ({ id, kind: nodes[id].kind, status: nodes[id].status, duration_ms: nodes[id].duration_ms ?? 0, cost_usd: nodes[id].cost_usd, attempts: nodes[id].agent_calls, failed_attempts: 0, retries: 0, repairs: 0, on_critical_path: true })), hints: [],
  }
  return {
    run: {
      id: RUN_ID, graph: 'nightly-sweep', spec_file: 'graphs/nightly-sweep.yaml', spec: { name: 'nightly-sweep', version: 1, description: 'Nightly recall and warranty sweep.', nodes: spec }, input: { household: 'hh_demo' },
      status, created_at: t0, updated_at: nowIso(), started_at: t0, ended_at: status === 'completed' ? nowIso() : null, bridge: 'mock', budget: {}, frozen: [],
      totals: { cost_usd: cost, usage: { inputTokens: 3500, outputTokens: 980, totalTokens: 4480 }, agent_calls: 3, retries: 0, wall_ms: wall },
      approvals: pending ? {} : { household_decision: { gate: 'household_decision', decision: 'approved', by: 'household', at: nowIso() } }, decisions: [], parent: null, labels: null, output: null, error: null, warnings: null,
    },
    nodes, analysis, metrics, tasks: [], spec_yaml: 'name: nightly-sweep\nnodes:\n  - id: feeds_refresh\n    kind: code\n  - id: candidate_gen\n    kind: code\n  - id: matcher\n    kind: agent\n    model: opus\n  - id: triage\n    kind: agent\n    model: opus\n  - id: household_decision\n    kind: gate\n  - id: remedy\n    kind: agent\n    model: opus\n    requires_gate: household_decision\n', in_process: state.working, events_count: 0,
  }
}

function runSummary(): GrenRunSummary {
  const r = grenRun()
  const vals = Object.values(r.nodes)
  return { id: r.run.id, graph: r.run.graph, status: r.run.status, created_at: r.run.created_at, updated_at: r.run.updated_at, cost_usd: r.run.totals.cost_usd, bridge: 'mock', parent: null, nodes: { total: vals.length, completed: vals.filter(n => n.status === 'completed').length, failed: 0, skipped: 0, waiting: vals.filter(n => n.status === 'waiting_approval').length }, in_process: state.working }
}

// ---------------------------------------------------------------------------------------------------------------

const impl: ApiShape = {
  summary: async () => {
    await delay(120)
    return summary()
  },
  items: async (q = {}) => {
    await delay(150)
    return itemsPage(q)
  },
  item: async id => {
    await delay(160)
    const it = state.items.find(x => x.id === id)
    if (!it) throw new Error(`item ${id} not found`)
    const detail: ItemDetail = {
      ...clone(it),
      matches: id === 'itm_graco' ? [clone(GRACO_MATCH)] : [],
      activity: [...tonightRows()].filter(r => r.text.toLowerCase().includes(it.brand.toLowerCase())),
      receipt_text: id === 'itm_graco' ? 'Target order confirmation\nOrder #102-4471990-0 · placed March 14, 2024\nGraco Modes Nest Stroller, Sullivan · Item 2137765 · UPC 047406171224\nQty 1 · $379.99\nManufacturer warranty: 12 months (see gracobaby.com/register)' : null,
      notes: null,
    }
    return detail
  },
  createItem: async body => {
    await delay(300)
    return createItem(body, 'manual')
  },
  importItems: async items => {
    await delay(300)
    const created = items.map(b => createItem(b, 'csv'))
    return { created: created.length, items: created }
  },
  removeItem: async id => {
    await delay(250)
    state.items = state.items.filter(x => x.id !== id)
    return { ok: true, item_id: id }
  },
  uploadPhoto: async (itemId, file) => {
    await delay(400)
    const it = state.items.find(x => x.id === itemId)
    if (!it) throw new Error(`item ${itemId} not found`)
    it.photo_url = URL.createObjectURL(file)
    return clone(it)
  },
  removePhoto: async itemId => {
    await delay(200)
    const it = state.items.find(x => x.id === itemId)
    if (!it) throw new Error(`item ${itemId} not found`)
    it.photo_url = null
    return clone(it)
  },
  intake: async text => {
    await delay(1800)
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return { run_id: null, item: null, fields_confident: 0, fields_total: 6, cost_usd: 0, duration_ms: 1800, error: 'No text to read.' }
    const retailer = text.match(/\b(Target|Amazon|Costco|Walmart|Home Depot|Best Buy|Williams Sonoma|IKEA|Lowe's)\b/i)?.[1] ?? null
    const price = text.match(/\$\s?(\d{1,5}(?:\.\d{2})?)/)
    const nameLine = lines.find(l => !/order|thank|receipt|total|qty|subtotal|\$|@/i.test(l) && l.length > 4) ?? lines[0]
    const item = createItem({ name: nameLine.slice(0, 80), brand: nameLine.split(/\s+/)[0], category: guessCategory(text), purchase_date: todayIso(), price: price ? Number(price[1]) : null, retailer, warranty_months: /warranty/i.test(text) ? 12 : null }, 'intake')
    const result: IntakeResult = { run_id: 'intake-mock', item, fields_confident: 4, fields_total: 6, cost_usd: 0.012, duration_ms: 1800, error: null }
    return result
  },
  reportProblem: async (itemId, text) => {
    await delay(300)
    const it = state.items.find(x => x.id === itemId)
    if (!it) throw new Error(`item ${itemId} not found`)
    const hhmm = new Date().toTimeString().slice(0, 5)
    state.extraRows.push(row(hhmm, 'Warranty', `Problem reported for ${it.brand} ${it.name}: ${text.slice(0, 140)}`, `coverage ${it.warranty.label}`, 'warn'))
    return { ok: true, decision: null, message: 'Tell Guardian what happened; it drafts the claim and asks once before sending.' }
  },
  decisions: async () => {
    await delay(120)
    return { pending: clone(pendingList()), past: clone(state.decisions.filter(d => d.state !== 'pending')) }
  },
  answer: async (id, choice) => {
    await delay(400)
    return answer(id, choice)
  },
  activity: async () => {
    await delay(150)
    return { nights: nights() }
  },
  preferences: async () => {
    await delay(100)
    return clone(state.prefs)
  },
  savePreferences: async p => {
    await delay(250)
    state.prefs = clone(p)
    return clone(state.prefs)
  },
  sweep: async () => {
    if (state.working) throw new Error('a sweep is already running')
    state.working = true
    window.setTimeout(() => {
      state.working = false
      state.sweepsRun += 1
      const hhmm = new Date().toTimeString().slice(0, 5)
      state.extraRows.push(row(hhmm, 'CPSC', 'Pulled 0 new CPSC recalls', '0 candidates', 'ok'), row(hhmm, 'Guardian', 'Sweep complete', 'Nothing new', 'ok'))
    }, 4500)
    return { run_id: RUN_ID }
  },
  gmail: {
    status: async () => {
      await delay(120)
      return { configured: false, connected: false, email: null, last_sync: null }
    },
    connect: async () => ({ url: '#' }),
    sync: async () => ({ checked: 0, added: 0 }),
    disconnect: async () => ({ ok: true }),
  },
  gren: {
    runs: async () => [runSummary()],
    run: async id => {
      await delay(150)
      if (id !== RUN_ID) throw new Error(`run ${id} not found`)
      return grenRun()
    },
    events: async () => [],
    artifact: async () => null,
    approve: async () => ({ ok: true }),
    fork: async () => ({ run_id: RUN_ID }),
    resume: async () => ({ run_id: RUN_ID }),
    cancel: async () => ({ ok: true }),
    graphs: async () => [],
    graph: async () => {
      throw new Error('no graph blueprints in mock mode')
    },
    start: async () => ({ run_id: RUN_ID }),
  },
}

export function install() {
  installApi(impl)
}
