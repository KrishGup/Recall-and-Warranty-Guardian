// "Add item" dialog: paste a receipt (POST /api/intake, an LLM extraction that can take 10–40 s) or enter the
// item manually (POST /api/items). Modal with Escape to close, focus moved in on open and restored on close.
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Api, fmt } from '../../api/client'
import { CATEGORIES, type Category, type IntakeResult, type Item, type NewItem } from '../../api/types'
import { Working } from '../../ui/primitives'
import { errMsg } from '../format'
import { useShell } from '../shell/ShellContext'

export function AddItemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (item: Item) => void }) {
  const { toast, openItem } = useShell()
  const [tab, setTab] = useState<'paste' | 'manual'>('paste')
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  const firstRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    firstRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])
  return (
    <div
      className="g-overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="add-h" className="g-dialog">
        <div className="g-dialog__head">
          <h2 id="add-h" className="g-h2">
            Add item
          </h2>
          <button type="button" className="g-btn g-btn--icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="g-dialog__body">
          <div role="tablist" aria-label="How to add the item" className="g-tabs-row">
            <button ref={firstRef} type="button" role="tab" id="tab-paste" aria-selected={tab === 'paste'} aria-controls="panel-paste" className="g-tab" onClick={() => setTab('paste')}>
              Paste a receipt
            </button>
            <button type="button" role="tab" id="tab-manual" aria-selected={tab === 'manual'} aria-controls="panel-manual" className="g-tab" onClick={() => setTab('manual')}>
              Enter manually
            </button>
          </div>
          {tab === 'paste' ? (
            <div role="tabpanel" id="panel-paste" aria-labelledby="tab-paste">
              <PasteTab onCreated={onCreated} onClose={onClose} onOpen={openItem} toast={toast} />
            </div>
          ) : (
            <div role="tabpanel" id="panel-manual" aria-labelledby="tab-manual">
              <ManualTab onCreated={onCreated} onClose={onClose} toast={toast} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PasteTab({ onCreated, onClose, onOpen, toast }: { onCreated: (item: Item) => void; onClose: () => void; onOpen: (id: string) => void; toast: (m: string) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IntakeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = text.trim().length >= 8
  async function run(e: FormEvent) {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await Api.intake(text, 'paste')
      setResult(r)
      if (r.item) {
        toast(`Added ${r.item.name}.`)
        onCreated(r.item)
      } else {
        setError(r.error || 'Guardian could not read an item from that text.')
      }
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const item = result?.item ?? null
  return (
    <form onSubmit={run}>
      <label className="g-field">
        <span>Receipt or order confirmation</span>
        <textarea className="g-textarea" dir="ltr" value={text} onChange={e => setText(e.target.value)} placeholder="Paste the email text here. Guardian reads the item, brand, model, price, retailer and the warranty line." disabled={busy} />
      </label>
      <p className="g-help-text" style={{ margin: '6px 0 0' }}>
        Card numbers are stripped before anything is stored.
      </p>
      {busy && (
        <div style={{ marginTop: 12 }}>
          <Working>Guardian is reading the receipt with the model. This usually takes 10–40 seconds.</Working>
        </div>
      )}
      {error && (
        <p className="g-error" role="alert" style={{ margin: '12px 0 0' }}>
          {error}
        </p>
      )}
      {item && result && (
        <div className="g-result">
          <div className="g-eyebrow" style={{ marginBottom: 4 }}>
            Added to inventory
          </div>
          <div style={{ fontWeight: 500 }}>{item.name}</div>
          <div className="g-small g-muted">{[item.brand, item.model_number, item.category].filter(Boolean).join(' · ')}</div>
          <dl className="g-kv" style={{ marginTop: 10 }}>
            <dt>Purchased</dt>
            <dd className="g-num">
              {item.purchase_date}
              {item.retailer ? `, ${item.retailer}` : ''}
            </dd>
            <dt>Warranty</dt>
            <dd>{item.warranty.label}</dd>
            <dt>Extraction</dt>
            <dd>
              {result.fields_confident}/{result.fields_total} fields confident · {fmt.usd(result.cost_usd)} · {fmt.ms(result.duration_ms)}
            </dd>
          </dl>
          {result.error && (
            <p className="g-error" style={{ margin: '10px 0 0' }}>
              {result.error}
            </p>
          )}
        </div>
      )}
      <div className="g-dialog__foot">
        {item ? (
          <>
            <button type="button" className="g-btn g-btn--lg" onClick={onClose}>
              Done
            </button>
            <button
              type="button"
              className="g-btn g-btn--primary g-btn--lg"
              onClick={() => {
                onOpen(item.id)
                onClose()
              }}
            >
              Open item
            </button>
          </>
        ) : (
          <>
            <button type="button" className="g-btn g-btn--lg" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="g-btn g-btn--primary g-btn--lg" disabled={busy || !ready}>
              {busy ? 'Reading…' : 'Read receipt'}
            </button>
          </>
        )}
      </div>
    </form>
  )
}

type Field = 'name' | 'brand' | 'model_number' | 'upc' | 'serial' | 'category' | 'purchase_date' | 'price' | 'retailer' | 'warranty_months' | 'vin'

function ManualTab({ onCreated, onClose, toast }: { onCreated: (item: Item) => void; onClose: () => void; toast: (m: string) => void }) {
  const [f, setF] = useState<Record<Field, string>>({ name: '', brand: '', model_number: '', upc: '', serial: '', category: 'Other', purchase_date: new Date().toISOString().slice(0, 10), price: '', retailer: '', warranty_months: '', vin: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const up = (k: Field) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF(s => ({ ...s, [k]: e.target.value }))
  const opt = (v: string) => (v.trim() ? v.trim() : null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!f.name.trim() || !f.purchase_date) {
      setError('Name and purchase date are required.')
      return
    }
    const category = (CATEGORIES as string[]).includes(f.category) ? (f.category as Category) : 'Other'
    const body: NewItem = {
      name: f.name.trim(),
      brand: f.brand.trim(),
      model_number: opt(f.model_number),
      upc: opt(f.upc),
      serial: opt(f.serial),
      category,
      purchase_date: f.purchase_date,
      price: f.price === '' ? null : Number(f.price),
      retailer: opt(f.retailer),
      warranty_months: f.warranty_months === '' ? null : Number(f.warranty_months),
      vin: opt(f.vin)?.toUpperCase() ?? null,
    }
    setBusy(true)
    setError(null)
    try {
      const item = await Api.createItem(body)
      toast(`Added ${item.name}.`)
      onCreated(item)
      onClose()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="g-form" aria-busy={busy}>
      <label className="g-field g-field--full">
        <span>Item name *</span>
        <input className="g-input" value={f.name} onChange={up('name')} required placeholder="e.g. Modes Nest stroller" />
      </label>
      <label className="g-field">
        <span>Brand</span>
        <input className="g-input" value={f.brand} onChange={up('brand')} placeholder="e.g. Graco" />
      </label>
      <label className="g-field">
        <span>Model number</span>
        <input className="g-input g-mono" dir="ltr" value={f.model_number} onChange={up('model_number')} />
      </label>
      <label className="g-field">
        <span>Category</span>
        <select className="g-input g-select" value={f.category} onChange={up('category')}>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="g-field">
        <span>Purchase date *</span>
        <input type="date" className="g-input g-num" dir="ltr" value={f.purchase_date} onChange={up('purchase_date')} required />
      </label>
      <label className="g-field">
        <span>Price (USD)</span>
        <input type="number" min={0} step="0.01" className="g-input g-num" dir="ltr" value={f.price} onChange={up('price')} />
      </label>
      <label className="g-field">
        <span>Retailer</span>
        <input className="g-input" value={f.retailer} onChange={up('retailer')} placeholder="e.g. Target" />
      </label>
      <label className="g-field">
        <span>Warranty (months)</span>
        <input type="number" min={0} step={1} className="g-input g-num" dir="ltr" value={f.warranty_months} onChange={up('warranty_months')} placeholder="blank = category default" />
      </label>
      <label className="g-field">
        <span>UPC</span>
        <input className="g-input g-mono" dir="ltr" inputMode="numeric" value={f.upc} onChange={up('upc')} />
      </label>
      <label className="g-field">
        <span>Serial</span>
        <input className="g-input g-mono" dir="ltr" value={f.serial} onChange={up('serial')} />
      </label>
      <label className="g-field">
        <span>VIN (vehicles)</span>
        <input className="g-input g-mono" dir="ltr" maxLength={17} value={f.vin} onChange={up('vin')} placeholder="17 characters" />
      </label>
      {error && (
        <p className="g-error g-field--full" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <div className="g-dialog__foot g-field--full">
        <button type="button" className="g-btn g-btn--lg" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="g-btn g-btn--primary g-btn--lg" disabled={busy}>
          {busy ? 'Adding…' : 'Add item'}
        </button>
      </div>
    </form>
  )
}
