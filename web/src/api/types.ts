// Guardian API contract. The Python side (guardian/api) is the source of truth; keep these in sync.
// Dates are ISO strings (YYYY-MM-DD for dates, full ISO 8601 UTC for timestamps).

export type Severity = 'critical' | 'standard'
export type AgentStatus = 'idle' | 'pending' | 'working'
export type Category = 'Juvenile' | 'Kitchen' | 'Appliance' | 'Vehicle' | 'Tools' | 'Food' | 'Electronics' | 'Toys' | 'Home' | 'Other'
export const CATEGORIES: Category[] = ['Juvenile', 'Kitchen', 'Appliance', 'Vehicle', 'Tools', 'Food', 'Electronics', 'Toys', 'Home', 'Other']

export interface Warranty {
  term_months: number | null
  ends_on: string | null
  source: 'receipt' | 'category_default' | 'manufacturer' | 'none'
  extended: boolean
  elapsed_pct: number | null // 0..100, null when there is no warranty
  label: string // e.g. "12 mo · ends 2025-03", "Powertrain 60 mo · ended", "12 mo · estimate", "n/a"
  note: string // one sentence, e.g. "Term read from receipt."
}

export interface Vehicle {
  vin: string
  year: number
  make: string
  model: string
}

export type RecallState = 'unchecked' | 'clear' | 'candidate' | 'critical_match' | 'standard_match' | 'adjudicated_no' | 'resolved'

export interface RecallStatus {
  state: RecallState
  label: string // e.g. "Critical match", "Clear", "Clear · 3 campaigns checked", "Adjudicated no", "Resolved"
  rationale: string
  sources: string[] // e.g. ["CPSC"], ["NHTSA"], ["openFDA"]
  sweeps: number // nightly sweeps this item has been through
}

export interface Item {
  id: string
  name: string
  brand: string
  model_number: string | null
  upc: string | null
  serial: string | null
  category: Category
  purchase_date: string
  price: number | null
  currency: string
  retailer: string | null
  receipt_ref: string | null // evidence locker key or null
  warranty: Warranty
  vehicle: Vehicle | null
  status: 'watched' | 'resolved' | 'disposed'
  recall: RecallStatus
  created_at: string
  photo_url: string | null // GET this URL for the label/receipt photo, when present
  gmail_message_id: string | null // set when the item came from a synced Gmail message
}

export interface RecallSummary {
  recall_id: string // "cpsc#26530" | "nhtsa#19V493000" | "fda_food#F-1234-2026"
  source: 'cpsc' | 'nhtsa' | 'fda_food' | 'fda_drug' | 'fda_device'
  title: string
  published_at: string
  url: string | null
  hazard_text: string
  remedy_text: string
  severity: Severity
  contact: { phone: string | null; email: string | null; url: string | null }
  sold_window: { from: string | null; to: string | null } | null
  retailers: string[]
}

export interface MatchCandidate {
  id: string
  item_id: string
  recall_id: string
  stage: 1 | 2 | 3 | 4 // 1 exact key, 2 lexical, 3 date window, 4 LLM adjudication
  key: string // "upc" | "vin" | "model" | "lexical:84" | ...
  score: number // 0..100
  verdict: 'certain' | 'yes' | 'no' | 'unsure' | 'dropped' | 'pending'
  confidence: number | null // 0..1 for LLM verdicts
  rationale: string
  missing_info: string[]
  state: 'open' | 'surfaced' | 'closed'
  recall: RecallSummary
  created_at: string
  run_id: string | null
}

export interface ItemDetail extends Item {
  matches: MatchCandidate[]
  activity: ActivityRow[]
  receipt_text?: string | null // raw forwarded/pasted receipt text when the item came from intake
  notes?: string | null
}

export interface ItemsQuery {
  q?: string
  category?: Category | ''
  warranty?: '' | 'active' | 'ending' | 'expired' | 'none'
  recall?: '' | 'clear' | 'match' | 'adjudicated_no' | 'resolved'
  page?: number
  page_size?: number
}
export interface ItemsPage {
  items: Item[]
  total: number
  page: number
  page_size: number
}

export interface NewItem {
  name: string
  brand: string
  model_number?: string | null
  upc?: string | null
  serial?: string | null
  category: Category
  purchase_date: string
  price?: number | null
  retailer?: string | null
  warranty_months?: number | null
  vin?: string | null
}

export interface IntakeResult {
  run_id: string | null
  item: Item | null
  fields_confident: number
  fields_total: number
  cost_usd: number
  duration_ms: number
  error: string | null
}

export type DecisionChoice = 'request_remedy' | 'no_longer_own' | 'not_mine' | 'snooze' | 'fine' | 'report_problem' | 'done' | 'review_and_attest' | 'skip_claim'

export interface DecisionOption {
  key: DecisionChoice
  label: string // "Request free repair kit", "No longer own it", "Not mine", "Ask me tomorrow"
  style: 'critical' | 'primary' | 'outline' | 'text'
}

export interface Decision {
  id: string
  kind: 'recall_remedy' | 'warranty_checkin' | 'advisory' | 'settlement_claim'
  severity: Severity
  state: 'pending' | 'answered' | 'expired' | 'snoozed'
  created_at: string
  expires_at: string | null
  run_id: string | null // gren run that is paused on this decision
  gate: string | null // gren gate node id, e.g. "household_decision"
  item_id: string | null
  item_name: string
  badge: string // "Critical hazard" | "Standard hazard" | "Warranty window"
  meta: string // "CPSC recall 26530 · surfaced 03:04 today · expires in 71 h"
  title: string // "Boon NURSH baby bottles — outer shell can peel and pose a choking hazard"
  summary: string // "Remedy: full refund from TOMY. Guardian has drafted the request and attached your Walmart receipt."
  message: string // the exact SMS text
  recall: RecallSummary | null
  match: { stage: number; key: string; confidence_label: string; rationale: string } | null
  facts: { label: string; value: string }[] // Purchased / Model / Match confidence / Sold window
  options: DecisionOption[]
  answer: { choice: DecisionChoice; by: string; at: string } | null
  outcome: { title: string; subtitle: string; steps: { text: string; when: string; done: boolean }[] } | null
  past_label: string | null // for the "Past decisions" list: "Closed · not affected", "Remedy done", "Snoozed"
}

export interface Decisions {
  pending: Decision[]
  past: Decision[]
}
export interface AnswerResult {
  ok: boolean
  decision: Decision
  run_id: string | null
}

export type Tone = 'ok' | 'critical' | 'muted' | 'warn'
export interface ActivityRow {
  time: string // "03:02"
  source: string // "CPSC" | "NHTSA" | "FDA" | "Triage" | "Intake" | "Warranty" | "Remedy" | "Household" | "Guardian"
  text: string
  result: string | null // "1 candidate · certain"
  tone: Tone
  at: string // full ISO timestamp
}
export interface ActivityNight {
  date: string // YYYY-MM-DD
  label: string // "Tonight · Sep 13" | "Sep 12"
  summary: string // "1 decision pending" | "Quiet"
  tone: Tone
  run_id: string | null
  rows: ActivityRow[]
}

export interface EndingSoon {
  item_id: string
  name: string
  ends_on: string
  days_left: number
  pct: number
  note: string
}

export interface Summary {
  household: { id: string; name: string }
  agent_status: AgentStatus
  agent_label: string // "Quiet" | "Needs you" | "Sweeping now…"
  sweep_label: string // "Last sweep 03:04 today" | "Sweep running"
  last_sweep: { run_id: string | null; at: string | null; status: string | null }
  quiet_days: number
  items_watched: number
  sweeps_run: number
  recalls_screened_30d: number
  decisions_pending: number
  forwarding_address: string
  recent_activity: ActivityRow[]
  ending_soon: EndingSoon[]
  provider: { bridge: string; live: boolean; label: string } // which LLM provider the next sweep uses
}

export interface Preferences {
  budget: 'critical_only' | 'weekly' | 'daily'
  value_threshold: number
  quiet_categories: string[]
  phone: string
  forwarding_address: string
  sensitivities: { infant: boolean; pregnancy: boolean; elderly: boolean; allergens: string[] }
}

export interface GmailStatus {
  configured: boolean // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET set on the server
  connected: boolean
  email: string | null
  last_sync: string | null
}

/** Server-sent events on /api/events. Guardian events carry `at`; gren engine events carry `seq` and `run_id`. */
export interface GuardianEvent {
  type: string
  at?: string
  data?: Record<string, unknown>
  seq?: number
  run_id?: string
  node?: string | null
  item?: number | null
  ts?: string
}

// ---------------------------------------------------------------------------------------------------------------
// gren (Graph Engineering Runtime) API, mounted at /gren/api/*. See gren/gren/server/app.py and design/sample-gren-run.json.

export type GrenRunStatus = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type GrenNodeKind = 'agent' | 'code' | 'verify' | 'gate' | 'router' | 'loop' | 'subgraph'
export type GrenNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval' | 'waiting_task'

export interface GrenRunSummary {
  id: string
  graph: string
  status: GrenRunStatus
  created_at: string
  updated_at: string
  cost_usd: number
  bridge: string
  parent: unknown
  nodes: { total: number; completed: number; failed: number; skipped: number; waiting: number }
  in_process?: boolean
}

export interface GrenAttempt {
  attempt: number
  item?: number | null
  started_at: string
  ended_at?: string
  model?: string
  bridge?: string
  status: string // ok | error | timeout | invalid_output
  error?: string
  usage?: Record<string, number>
  cost_usd?: number
  duration_ms?: number
  artifact?: string
  validation_errors?: string[]
}

export interface GrenFanoutItem {
  index: number
  status: string
  attempts?: number
  output?: unknown
  error?: string
  duration_ms?: number
}

export interface GrenNodeRecord {
  id: string
  kind: GrenNodeKind
  status: GrenNodeStatus
  attempts: GrenAttempt[]
  cost_usd: number
  usage: Record<string, number>
  agent_calls: number
  retries: number
  repairs: number
  started_at?: string | null
  ended_at?: string | null
  duration_ms?: number | null
  error?: string | null
  skip_reason?: string | null
  output?: unknown
  outputs?: unknown[] | null
  items?: GrenFanoutItem[] | null
  verify?: { total: number; survivors: unknown[]; killed: { index: number; item: unknown; reasons: string[]; confidence: number }[]; kill_rate: number; repair_round?: number } | null
  gate?: { requested_at?: string; decision?: string; by?: string; comment?: string | null; at?: string } | null
  route?: string | null
  route_reason?: string | null
  artifact?: string | null
  side_effect_done?: boolean | null
  repair?: { round: number; feedback: unknown } | null
}

export interface GrenEdge {
  from: string
  to: string
  kind: 'data' | 'gate' | 'order' | 'status' | string
  data: string[]
}

export interface GrenNodeAnalysis {
  id: string
  kind: GrenNodeKind
  model: string | null
  deps: string[]
  dependents: string[]
  level: number
  est_ms: number
  est_cost_usd: number
  fan_out: boolean
  on_critical_path: boolean
}

export interface GrenAnalysis {
  name: string
  nodes: Record<string, GrenNodeAnalysis>
  edges: GrenEdge[]
  order: string[]
  levels: string[][]
  critical_path: { nodes: string[]; est_ms: number }
  sum_of_work_ms: number
  parallel_speedup: number
  max_width: number
  est_cost_usd: { min: number; max: number }
  frozen: string[]
  findings: { level: 'error' | 'warning' | 'info'; code: string; node: string | null; message: string }[]
  checklist: { item: string; ok: boolean }[]
  ok: boolean
  repair_edges?: [string, string][]
}

export interface GrenNodeMetric {
  id: string
  kind: GrenNodeKind
  status: GrenNodeStatus
  duration_ms: number
  cost_usd: number
  attempts: number
  failed_attempts: number
  retries: number
  repairs: number
  on_critical_path: boolean
  items?: { total: number; completed: number }
  kill_rate?: number
  compression?: { in: number; out: number }
}

export interface GrenMetrics {
  run_id: string
  graph: string
  status: string
  wall_ms: number
  human_wait_ms: number
  active_ms: number
  nested_runs: number
  cost_usd: number
  agent_calls: number
  tokens: { input: number; output: number; cache_read: number }
  critical_path: { nodes: string[]; ms: number }
  sum_of_node_ms: number
  parallel_speedup: number
  width: { peak: number; budget: number | null; agent_seconds: number }
  node_failure_rate: number
  retry_rate: number
  verifier: { candidates: number; killed: number; kill_rate: number; per_verifier: { id: string; candidates: number; killed: number; kill_rate: number; repair_rounds: number }[] }
  fan_out: { workers: number; failed_workers: number; unique_per_worker: number | null }
  compression: { records_in: number; records_out: number; ratio: number; per_reducer: { id: string; in: number; out: number }[] }
  human: { gates: number; approved: number; rejected: number; auto: number; manual_tasks: number; orchestrator_tasks: number; cost_unknown_calls: number; intervention_rate: number }
  cost_by_model: Record<string, number>
  nodes: GrenNodeMetric[]
  hints: string[]
}

export interface GrenSpecNode {
  id: string
  kind: GrenNodeKind
  description?: string
  model?: string
  effort?: string
  map?: string
  tools?: string[]
  side_effect?: boolean
  requires_gate?: string | string[]
  prompt?: string
  system?: string
  title?: string
  approve_effect?: string
  reject_effect?: string
  when?: unknown
  input?: Record<string, unknown>
  fn?: string
  module?: string
  target?: string
  repair?: { node: string; max_rounds: number }
  [key: string]: unknown
}

export interface GrenSpec {
  name: string
  version?: number | string
  description?: string
  goal?: string
  budget?: { max_cost_usd?: number; max_wall_ms?: number; max_width?: number }
  defaults?: Record<string, unknown>
  nodes: GrenSpecNode[]
}

export interface GrenDecision {
  at: string
  node: string
  kind: string // skip | route | gate | verify | repair | failure | budget | loop
  detail: string
  state?: unknown
}

export interface GrenRun {
  run: {
    id: string
    graph: string
    spec_file: string
    spec: GrenSpec
    input: unknown
    status: GrenRunStatus
    created_at: string
    updated_at: string
    started_at?: string | null
    ended_at?: string | null
    bridge: string
    budget: Record<string, number>
    frozen: string[]
    totals: { cost_usd: number; usage: Record<string, number>; agent_calls: number; retries: number; wall_ms: number }
    approvals: Record<string, { gate: string; decision: string; by: string; comment?: string | null; at: string }>
    decisions: GrenDecision[]
    parent?: unknown
    labels?: Record<string, string> | null
    output?: unknown
    error?: string | null
    warnings?: string[] | null
  }
  nodes: Record<string, GrenNodeRecord>
  analysis: GrenAnalysis
  metrics: GrenMetrics
  tasks: unknown[]
  spec_yaml: string
  in_process: boolean
  events_count: number
}

export interface GrenEvent {
  ts: string
  seq: number
  run_id: string
  type: string // run.started, node.started, call.started, call.finished, item.*, fanout.*, verify.kill, repair.scheduled, gate.waiting, gate.approved, gate.rejected, run.paused, run.resumed, run.completed, run.failed, ...
  node: string | null
  item: number | null
  data: Record<string, unknown>
}

export interface GrenArtifact {
  node?: string
  item?: number | null
  attempt?: number
  model?: string
  bridge?: string
  request?: { system?: string; prompt?: string; output_schema?: unknown; effort?: string | null; repair_rounds?: number }
  response?: { output?: unknown; raw?: unknown; usage?: Record<string, number>; cost_usd?: number | null; duration_ms?: number; source?: string; session_id?: string | null }
  input?: unknown
  output?: unknown
  title?: string
  prompt?: string | null
  show?: unknown
  approve_effect?: string | null
  reject_effect?: string | null
}
