// Item detail split panel (bottom of the content column): receipt, warranty and recall checks for one item,
// from GET /api/items/{id}. Resizable 160 px – 50 % of the viewport on desktop, a 60 vh sheet on mobile.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Api } from '../../api/client'
import type { ItemDetail, MatchCandidate } from '../../api/types'
import { readNumber, writeNumber } from '../../theme/prefs'
import { warrantyColor } from '../../theme/tokens'
import { Bar, ErrorNote, Skeleton, Status } from '../../ui/primitives'
import { clamp, errMsg, money, plural, recallVar } from '../format'
import { useShell } from './ShellContext'
import { useAsync } from './useAsync'
import { useResize } from './useResize'

const KEY = 'guardian.splitH'

export function SplitPanel({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { theme, toast, narrow, dataVersion, bumpData } = useShell()
  const max = Math.max(160, Math.round((typeof window !== 'undefined' ? window.innerHeight : 900) * 0.5))
  const [h, setH] = useState(() => clamp(readNumber(KEY, 300), 160, max))
  const set = useCallback((v: number) => {
    setH(v)
    writeNumber(KEY, v)
  }, [])
  const resize = useResize({ value: h, min: 160, max, set, axis: 'y', sign: -1, growKey: 'ArrowUp', shrinkKey: 'ArrowDown' })
  const detail = useAsync(() => Api.item(itemId), [itemId, dataVersion])
  const item = detail.data

  const sub = item ? [item.brand, item.model_number ?? (item.vehicle ? `VIN …${item.vehicle.vin.slice(-4)}` : null), item.category].filter(Boolean).join(' · ') : ''

  async function remove() {
    if (!item) return
    try {
      await Api.removeItem(item.id)
      toast(`Removed ${item.name} from inventory.`)
      onClose()
      bumpData()
    } catch (err) {
      toast(`Could not remove the item: ${errMsg(err)}`)
    }
  }

  return (
    <section aria-label="Item detail" className="g-split" style={narrow ? undefined : { height: h }} aria-busy={detail.loading}>
      <div role="separator" aria-label="Resize item detail panel" aria-orientation="horizontal" aria-valuemin={160} aria-valuemax={max} aria-valuenow={h} tabIndex={0} className="g-sep g-split__sep" {...resize}>
        <span aria-hidden="true" className="g-sep__grip" />
      </div>
      <div className="g-split__head">
        <div style={{ minWidth: 0 }}>
          <h2 className="g-split__title">{item ? item.name : detail.error ? 'Item detail' : <Skeleton w={220} h={18} />}</h2>
          <div className="g-small g-muted">{item ? sub : detail.error ? '' : <Skeleton w={160} h={12} />}</div>
        </div>
        <button type="button" className="g-btn g-btn--icon" onClick={onClose} aria-label="Close item detail">
          ×
        </button>
      </div>
      <div className="g-split__body">
        {detail.error && !item && <ErrorNote message={detail.error} onRetry={detail.reload} style={{ gridColumn: '1 / -1' }} />}
        {!item && !detail.error && <SplitSkeleton />}
        {item && (
          <>
            <ReceiptColumn item={item} onToast={toast} onReload={detail.reload} />
            <WarrantyColumn item={item} color={warrantyColor(theme, item.warranty.elapsed_pct ?? 0)} onToast={toast} onRemove={remove} />
            <RecallColumn item={item} />
          </>
        )}
      </div>
    </section>
  )
}

function SplitSkeleton() {
  return (
    <>
      {[0, 1, 2].map(i => (
        <div key={i} aria-hidden="true">
          <Skeleton w={80} h={12} style={{ marginBottom: 10 }} />
          <Skeleton h={i === 0 ? 120 : 14} style={{ marginBottom: 8 }} />
          <Skeleton w="70%" h={14} />
        </div>
      ))}
    </>
  )
}

function ReceiptColumn({ item, onToast, onReload }: { item: ItemDetail; onToast: (m: string) => void; onReload: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)

  async function pickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      await Api.uploadPhoto(item.id, file)
      onToast('Label photo added.')
      onReload()
    } catch (err) {
      onToast(`Could not add the photo: ${errMsg(err)}`)
    } finally {
      setUploading(false)
    }
  }
  async function removePhoto() {
    setUploading(true)
    try {
      await Api.removePhoto(item.id)
      onToast('Photo removed.')
      onReload()
    } catch (err) {
      onToast(`Could not remove the photo: ${errMsg(err)}`)
    } finally {
      setUploading(false)
    }
  }
  function openOriginalEmail() {
    if (item.gmail_message_id) {
      window.open(`https://mail.google.com/mail/u/0/#all/${item.gmail_message_id}`, '_blank', 'noopener,noreferrer')
      return
    }
    if (item.receipt_text) {
      setEmailOpen(true)
      return
    }
    onToast('No original email was captured for this item (it was entered manually).')
  }

  return (
    <div>
      <div className="g-eyebrow" style={{ marginBottom: 8 }}>
        Receipt
      </div>
      {item.photo_url ? (
        <img src={item.photo_url} alt={`Label or receipt photo for ${item.name}`} className="g-receipt g-receipt--photo" />
      ) : (
        <div className="g-receipt" aria-label="No label photo on file">
          receipt thumbnail · {item.retailer ?? 'unknown retailer'}
        </div>
      )}
      {item.receipt_text && (
        <pre className="g-receipt-text" dir="ltr" aria-label="Receipt text">
          {item.receipt_text}
        </pre>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="g-btn g-btn--sm" onClick={openOriginalEmail}>
          Open original email
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} aria-hidden="true" tabIndex={-1} />
        <button type="button" className="g-btn g-btn--sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Working…' : item.photo_url ? 'Replace label photo' : 'Add label photo'}
        </button>
        {item.photo_url && (
          <button type="button" className="g-btn g-btn--sm g-btn--text" onClick={removePhoto} disabled={uploading}>
            Remove photo
          </button>
        )}
      </div>
      {emailOpen && <EmailModal item={item} onClose={() => setEmailOpen(false)} onToast={onToast} />}
    </div>
  )
}

function EmailModal({ item, onClose, onToast }: { item: ItemDetail; onClose: () => void; onToast: (m: string) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  function copyText() {
    const text = item.receipt_text ?? ''
    const done = () => onToast('Copied.')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done)
    else done()
  }
  function download() {
    const subject = `${item.brand} ${item.name}`.trim()
    const eml = `From: ${item.retailer ?? 'unknown sender'}\r\nSubject: ${subject}\r\nDate: ${item.purchase_date}\r\n\r\n${item.receipt_text ?? ''}`
    const blob = new Blob([eml], { type: 'message/rfc822' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${item.id}.eml`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="g-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="email-h" className="g-dialog">
        <div className="g-dialog__head">
          <h2 id="email-h" className="g-h2">
            Original email
          </h2>
          <button type="button" className="g-btn g-btn--icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="g-dialog__body">
          <p className="g-small g-muted" style={{ margin: '0 0 10px' }}>
            The message Guardian ingested for {item.retailer ? `this ${item.retailer} purchase` : 'this item'}, captured as plain text.
          </p>
          <pre className="g-receipt-text" dir="ltr" style={{ maxHeight: '40vh' }}>
            {item.receipt_text}
          </pre>
          <div className="g-dialog__foot">
            <button type="button" className="g-btn" onClick={copyText}>
              Copy
            </button>
            <button type="button" className="g-btn g-btn--primary" onClick={download}>
              Download as .eml
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function WarrantyColumn({ item, color, onToast, onRemove }: { item: ItemDetail; color: string; onToast: (m: string) => void; onRemove: () => Promise<void> }) {
  const w = item.warranty
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  useEffect(() => {
    setOpen(false)
    setText('')
    setConfirmRemove(false)
  }, [item.id])
  const expired = w.ends_on != null && w.ends_on < new Date().toISOString().slice(0, 10)
  async function confirmedRemove() {
    setRemoving(true)
    try {
      await onRemove()
    } finally {
      setRemoving(false)
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const r = await Api.reportProblem(item.id, text.trim())
      onToast(r.message || 'Logged.')
      setOpen(false)
      setText('')
    } catch (err) {
      onToast(`Could not log the problem: ${errMsg(err)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="g-eyebrow" style={{ marginBottom: 8 }}>
        Warranty
      </div>
      <div className="g-between">
        <span className="g-bidi" style={{ fontWeight: 500 }}>
          {w.label}
        </span>
        <span className="g-num g-small g-muted g-bidi">{w.elapsed_pct == null ? 'no term' : `${Math.round(w.elapsed_pct)}% elapsed`}</span>
      </div>
      <Bar pct={w.elapsed_pct} color={color} height={8} style={{ marginTop: 8 }} />
      <p className="g-small g-muted" style={{ margin: '8px 0 12px' }}>
        {w.note}
      </p>
      <dl className="g-kv">
        <dt>Purchased</dt>
        <dd className="g-num">{item.purchase_date}</dd>
        <dt>Retailer</dt>
        <dd>{item.retailer ?? '—'}</dd>
        <dt>Paid</dt>
        <dd className="g-num">{money(item.price, item.currency)}</dd>
      </dl>
      {!open && (
        <button type="button" className="g-btn g-btn--outline" style={{ marginTop: 14 }} onClick={() => setOpen(true)} aria-expanded={open}>
          Something's wrong with it
        </button>
      )}
      {open && (
        <form className="g-problem" onSubmit={send}>
          <label className="g-field">
            <span>What happened? One sentence is enough.</span>
            <input className="g-input" value={text} onChange={e => setText(e.target.value)} placeholder="e.g. The motor stopped after two months." autoFocus />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" className="g-btn g-btn--primary" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Tell Guardian'}
            </button>
            <button type="button" className="g-btn" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        {!confirmRemove ? (
          <button type="button" className="g-btn g-btn--text" onClick={() => setConfirmRemove(true)}>
            Remove from inventory
          </button>
        ) : (
          <div className="g-problem">
            <p className="g-small" style={{ margin: 0 }}>
              {expired ? "This item's warranty has ended. Remove it from your inventory? Guardian will stop watching it." : 'Stop tracking this item? Guardian will no longer watch it for recalls or warranty windows.'}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="g-btn g-btn--critical" onClick={confirmedRemove} disabled={removing}>
                {removing ? 'Removing…' : 'Remove item'}
              </button>
              <button type="button" className="g-btn" onClick={() => setConfirmRemove(false)} disabled={removing}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function verdictColor(m: MatchCandidate): string {
  switch (m.verdict) {
    case 'certain':
    case 'yes':
      return m.recall?.severity === 'critical' ? 'var(--critical)' : 'var(--warn)'
    case 'unsure':
    case 'pending':
      return 'var(--warn)'
    default:
      return 'var(--ink2)'
  }
}

function RecallColumn({ item }: { item: ItemDetail }) {
  const r = item.recall
  const color = recallVar(r.state)
  return (
    <div>
      <div className="g-eyebrow" style={{ marginBottom: 8 }}>
        Recall checks
      </div>
      <Status color={color} size={10} style={{ fontSize: 14, marginBottom: 8 }}>
        {r.label}
      </Status>
      <p style={{ margin: '0 0 10px', fontSize: 14 }}>{r.rationale}</p>
      <p className="g-small g-muted" style={{ margin: 0 }}>
        Checked against {r.sources.length ? r.sources.join(', ') : 'the feeds'} in {plural(r.sweeps, 'nightly sweep')} since intake.
      </p>
      {item.matches.length > 0 && (
        <ul className="g-matches" aria-label="Match candidates">
          {item.matches.map(m => (
            <li key={m.id} className="g-match">
              <div style={{ fontWeight: 500 }}>
                {m.recall?.url ? (
                  <a href={m.recall.url} target="_blank" rel="noopener noreferrer">
                    {m.recall.title}
                  </a>
                ) : (
                  (m.recall?.title ?? m.recall_id)
                )}
              </div>
              <div className="g-ui g-muted" style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>
                  stage {m.stage} · {m.key}
                </span>
                <Status color={verdictColor(m)}>
                  {m.verdict}
                  {m.confidence != null ? ` · ${Math.round(m.confidence * 100)}%` : ''}
                </Status>
                <span>{m.state}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
