// Decisions: the pending cards (same ones the phone points to), the outcome timeline after answering, the quiet
// empty state, and the past-decisions list. Data from GET /api/decisions; answers go to POST /api/decisions/{id}/answer.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Api, fmt } from '../../api/client'
import type { AnswerResult, Decision, DecisionChoice, DecisionOption } from '../../api/types'
import { Dot, ErrorNote, Skeleton } from '../../ui/primitives'
import { errMsg, pastVar } from '../format'
import { useShell } from '../shell/ShellContext'

function toastFor(choice: DecisionChoice): string {
  switch (choice) {
    case 'request_remedy':
      return 'Remedy requested. Guardian takes it from here and follows up in 10 business days.'
    case 'report_problem':
      return 'Claim drafting started. Guardian asks once before anything is sent.'
    case 'review_and_attest':
      return 'Claim drafting started. Guardian prefills the form; you review and attest before anything is submitted.'
    case 'skip_claim':
      return "Noted. Settlement skipped; you won't be asked about it again."
    case 'snooze':
      return 'Guardian will ask again tomorrow at 08:00.'
    case 'fine':
      return "Noted. It's fine; no claim drafted."
    default:
      return 'Noted. Match dismissed and logged.'
  }
}

function btnClass(o: DecisionOption): string {
  const base = 'g-btn g-btn--lg'
  switch (o.style) {
    case 'critical':
      return `${base} g-btn--critical g-btn--grow`
    case 'primary':
      return `${base} g-btn--primary g-btn--grow`
    case 'text':
      return `${base} g-btn--text`
    default:
      return base
  }
}

export function Decisions() {
  const { decisions, decisionsError, refreshDecisions, refreshSummary, toast, openItem } = useShell()
  const [answered, setAnswered] = useState<{ id: string; result: AnswerResult }[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  async function answer(d: Decision, choice: DecisionChoice) {
    if (busy) return
    setBusy(d.id)
    try {
      const r = await Api.answer(d.id, choice, 'dashboard')
      setAnswered(a => [...a.filter(x => x.id !== d.id), { id: d.id, result: r }])
      toast(toastFor(choice))
      refreshDecisions()
      refreshSummary()
    } catch (e) {
      toast(`Could not record the answer: ${errMsg(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const pending = decisions?.pending ?? []
  const answeredIds = new Set(answered.map(a => a.id))
  const live = pending.filter(d => !answeredIds.has(d.id))
  const past = decisions?.past ?? []
  const loading = !decisions && !decisionsError

  return (
    <>
      <h1 className="g-h1" style={{ marginBottom: 4 }}>
        Decisions <span className="g-h1__count">({decisions ? live.length : '…'} pending)</span>
      </h1>
      <p className="g-sub" style={{ margin: '0 0 20px' }}>
        The same cards your phone points to. One tap, then the agent finishes the job.
      </p>
      <div className="g-dec">
        <div className="g-dec__main">
          {loading && (
            <div className="g-card g-card--pad" aria-busy="true">
              <Skeleton w={120} h={22} style={{ marginBottom: 12 }} />
              <Skeleton h={26} style={{ marginBottom: 8 }} />
              <Skeleton w="80%" h={16} />
            </div>
          )}
          {decisionsError && !decisions && <ErrorNote message={decisionsError} onRetry={refreshDecisions} />}
          {answered.map(a => (
            <Outcome key={a.id} result={a.result} />
          ))}
          {live.map(d => (
            <DecisionCard key={d.id} d={d} busy={busy === d.id} onAnswer={answer} onOpenItem={openItem} />
          ))}
          {decisions && live.length === 0 && answered.length === 0 && (
            <div className="g-card g-card--dashed" style={{ padding: '40px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div aria-hidden="true" className="g-check">
                ✓
              </div>
              <h2 className="g-h2" style={{ fontSize: 22, marginBottom: 6 }}>
                Nothing needs you
              </h2>
              <p className="g-muted" style={{ margin: '0 auto', maxWidth: 420 }}>
                The last sweep found nothing that applies to your household. The next one runs at 03:00.
              </p>
            </div>
          )}
        </div>

        <section aria-labelledby="past-h" className="g-dec__past">
          <h2 id="past-h" className="g-h2" style={{ marginBottom: 10 }}>
            Past decisions
          </h2>
          {loading && <Skeleton h={60} />}
          {decisions && past.length === 0 && (
            <p className="g-muted g-small" style={{ margin: 0 }}>
              No past decisions yet.
            </p>
          )}
          <ul className="g-past">
            {past.map(pd => {
              const color = pastVar(pd)
              const when = pd.answer?.at ?? pd.created_at
              return (
                <li key={pd.id} className="g-past__row">
                  <Dot color={color} size={10} />
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 500 }}>{pd.title || pd.item_name}</div>
                    <div className="g-small g-muted">
                      {pd.item_name}
                      {pd.answer ? ` · answered by ${pd.answer.by}` : ''}
                    </div>
                  </div>
                  <span className="g-ui g-small" style={{ color }}>
                    {pd.past_label ?? pd.state}
                  </span>
                  <time className="g-num g-small g-muted" dateTime={when}>
                    {fmt.date(when)}
                  </time>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </>
  )
}

function DecisionCard({ d, busy, onAnswer, onOpenItem }: { d: Decision; busy: boolean; onAnswer: (d: Decision, choice: DecisionChoice) => void; onOpenItem: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const critical = d.severity === 'critical'
  const variant = critical ? '' : d.kind === 'warranty_checkin' ? ' g-deccard--warranty' : d.kind === 'settlement_claim' ? ' g-deccard--settlement' : ' g-deccard--standard'
  const itemId = d.item_id
  return (
    <article aria-labelledby={`dec-${d.id}`} className={`g-card g-deccard${variant}`} aria-busy={busy}>
      <div className="g-deccard__top">
        <div className="g-deccard__meta">
          <span className={`g-badge${critical ? ' g-badge--critical' : ''}`}>
            {critical && (
              <span aria-hidden="true" className="g-badge__i">
                !
              </span>
            )}
            {d.badge}
          </span>
          <span className="g-ui g-small g-muted g-bidi">{d.meta}</span>
        </div>
        <h2 id={`dec-${d.id}`} className="g-deccard__title">
          {d.title || d.item_name}
        </h2>
        <p className="g-deccard__sum">{d.summary || d.message}</p>
      </div>
      {d.facts.length > 0 && (
        <dl className="g-kvstrip">
          {d.facts.map(f => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="g-deccard__links">
        {d.match && (
          <button type="button" className="g-disclose" aria-expanded={open} aria-controls={`why-${d.id}`} onClick={() => setOpen(o => !o)}>
            <span aria-hidden="true" className={`g-chev${open ? ' is-open' : ''}`}>
              ▸
            </span>
            Why Guardian thinks this is yours
          </button>
        )}
        {itemId && (
          <button type="button" className="g-disclose" onClick={() => onOpenItem(itemId)}>
            Open item and receipt
          </button>
        )}
      </div>
      {open && d.match && (
        <p id={`why-${d.id}`} className="g-rationale">
          {d.match.rationale}
        </p>
      )}
      <div className="g-deccard__actions">
        {d.options.map(o => (
          <button key={o.key} type="button" disabled={busy} className={btnClass(o)} onClick={() => onAnswer(d, o.key)}>
            {busy && o.style !== 'text' && o.style !== 'outline' ? 'Working…' : o.label}
          </button>
        ))}
      </div>
    </article>
  )
}

function Outcome({ result }: { result: AnswerResult }) {
  const d = result.decision
  const o = d.outcome
  const steps = o?.steps ?? []
  return (
    <section aria-labelledby={`res-${d.id}`} className="g-card g-outcome">
      <h2 id={`res-${d.id}`} className="g-h2" style={{ fontSize: 20, marginBottom: 4 }}>
        {o?.title ?? 'Answered'}
      </h2>
      <p className="g-sub" style={{ margin: '0 0 16px' }}>
        {o?.subtitle ?? d.item_name}
      </p>
      {steps.length > 0 && (
        <ol className="g-steps">
          {steps.map((s, i) => {
            const color = s.done ? 'var(--ok)' : 'var(--line)'
            const line = i === steps.length - 1 ? 'transparent' : s.done ? 'var(--ok)' : 'var(--line)'
            return (
              <li key={`${i}-${s.text}`} className="g-step">
                <div className="g-step__rail">
                  <span aria-hidden="true" className="g-step__dot" style={{ background: color, border: `2px solid ${color}` }} />
                  <span aria-hidden="true" className="g-step__line" style={{ background: line }} />
                </div>
                <div className="g-step__body">
                  <div style={{ fontWeight: 500 }}>
                    {s.text}
                    <span className="sr-only">{s.done ? ' (done)' : ' (upcoming)'}</span>
                  </div>
                  <div className="g-num g-small g-muted">{s.when}</div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <Link to="/activity" className="g-link">
        See it in the activity log
      </Link>
    </section>
  )
}
