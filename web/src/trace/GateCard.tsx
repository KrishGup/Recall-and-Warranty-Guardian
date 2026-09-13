// The waiting-gate card, shared by the Tasks tab (full card) and the inspector (compact box).
// Gate approval rule: Guardian's household gate is answered through Guardian decision rows so the
// dashboard and the SMS flow stay consistent; other gates are answered directly in gren.
import { fmt } from '../api/client'
import type { Decision, GrenNodeRecord, GrenSpecNode } from '../api/types'

export interface GateInfo {
  gateId: string
  rec: GrenNodeRecord | undefined
  spec: GrenSpecNode | null
  /** Guardian decisions pending for this run (household gate only). */
  pending: Decision[]
  household: boolean
  busy: boolean
  onDecide: (gateId: string, approve: boolean) => void
}

export function waitingFor(rec: GrenNodeRecord | undefined, now: number): string {
  const since = rec?.gate?.requested_at ?? rec?.started_at
  if (!since) return '—'
  const t = Date.parse(since)
  return Number.isNaN(t) ? '—' : fmt.ms(Math.max(0, now - t))
}

export function GateCard({ gate, now, variant }: { gate: GateInfo; now: number; variant: 'task' | 'box' }) {
  const { gateId, rec, spec, pending, household, busy, onDecide } = gate
  const wait = waitingFor(rec, now)
  const n = pending.length
  if (variant === 'box') {
    return (
      <div className="tr-gate tr-gate--box">
        <div className="tr-gate-title">{household ? 'Waiting on the household' : 'Waiting on approval'}</div>
        <p>
          Paused {wait}.{' '}
          {household
            ? n
              ? `${n} decision${n === 1 ? '' : 's'} pending by SMS reply, signed link or dashboard. `
              : 'No Guardian decision row is pending for this run, so answering here goes straight to the gate. '
            : ''}
          Nothing downstream runs until an approval record exists.
        </p>
        <div className="tr-actions">
          <button type="button" className="tr-btn tr-btn--ok tr-btn--sm" disabled={busy} onClick={() => onDecide(gateId, true)}>
            Approve
          </button>
          <button type="button" className="tr-btn tr-btn--critical tr-btn--sm" disabled={busy} onClick={() => onDecide(gateId, false)}>
            Reject
          </button>
        </div>
      </div>
    )
  }
  const title = spec?.title ?? pending[0]?.title ?? `Approve ${gateId}?`
  const prompt = spec?.prompt ?? 'The graph is paused on this gate until an approval record exists.'
  return (
    <div className="tr-gate">
      <div className="tr-eyebrow">
        Gate · {gateId} · waiting {wait}
      </div>
      <div className="tr-gate-title">{title}</div>
      <p>{prompt}</p>
      {household &&
        pending.map(d => (
          <div key={d.id} className="tr-gate-dec">
            <div className="tr-eyebrow">
              {d.badge} · {d.meta}
            </div>
            <b>{d.title}</b>
            <q dir="auto">{d.message}</q>
          </div>
        ))}
      {household && n > 0 && (
        <p>
          The same decision{n === 1 ? '' : 's'} the household sees by SMS. Answering here writes the Guardian decision row, which resumes the graph into{' '}
          <code dir="ltr">answers</code>.
        </p>
      )}
      {household && n === 0 && <p>No Guardian decision row is pending for this run yet; approving here answers the gate directly in gren.</p>}
      {(spec?.approve_effect || spec?.reject_effect) && (
        <div className="tr-gate-effects">
          {spec?.approve_effect && <span>Approve → {spec.approve_effect}</span>}
          {spec?.reject_effect && <span>Reject → {spec.reject_effect}</span>}
        </div>
      )}
      <div className="tr-actions">
        <button type="button" className="tr-btn tr-btn--ok" disabled={busy} onClick={() => onDecide(gateId, true)}>
          {busy ? 'Answering…' : 'Approve (as dashboard)'}
        </button>
        <button type="button" className="tr-btn tr-btn--critical" disabled={busy} onClick={() => onDecide(gateId, false)}>
          Reject
        </button>
      </div>
    </div>
  )
}
