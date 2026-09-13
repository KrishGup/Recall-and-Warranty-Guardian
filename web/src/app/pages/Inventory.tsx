// Inventory: server-side searched, filtered and paginated table of watched items (GET /api/items). Selecting a row
// opens the item-detail split panel; "Add item" opens the intake dialog. Rows stack into labelled cards on mobile.
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Api } from '../../api/client'
import { CATEGORIES, type Category, type Item, type ItemsQuery } from '../../api/types'
import { warrantyColor } from '../../theme/tokens'
import { Bar, ErrorNote, Skeleton, Status } from '../../ui/primitives'
import { recallVar } from '../format'
import { useShell } from '../shell/ShellContext'
import { useAsync } from '../shell/useAsync'
import { AddItemDialog } from './AddItemDialog'

const PAGE = 10
type WarrantyFilter = NonNullable<ItemsQuery['warranty']>
type RecallFilter = NonNullable<ItemsQuery['recall']>
interface Opt {
  value: string
  label: string
}
const CATEGORY_OPTS: Opt[] = CATEGORIES.map(c => ({ value: c, label: c }))
const WARRANTY_OPTS: Opt[] = [
  { value: 'active', label: 'Active' },
  { value: 'ending', label: 'Ending soon' },
  { value: 'expired', label: 'Expired' },
  { value: 'none', label: 'No warranty' },
]
const RECALL_OPTS: Opt[] = [
  { value: 'clear', label: 'Clear' },
  { value: 'match', label: 'Match' },
  { value: 'adjudicated_no', label: 'Adjudicated no' },
  { value: 'resolved', label: 'Resolved' },
]

export function Inventory() {
  const { summary, refreshSummary, theme, openItem, selectedItemId, dataVersion } = useShell()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [warranty, setWarranty] = useState<WarrantyFilter>('')
  const [recall, setRecall] = useState<RecallFilter>('')
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setDq(q.trim()), 300)
    return () => window.clearTimeout(t)
  }, [q])
  useEffect(() => {
    setPage(1)
  }, [dq, category, warranty, recall])
  // Home's "Add item" lands here with ?add=1.
  useEffect(() => {
    if (params.get('add') === '1') {
      setAdding(true)
      const p = new URLSearchParams(params)
      p.delete('add')
      setParams(p, { replace: true })
    }
  }, [params, setParams])

  const list = useAsync(() => Api.items({ q: dq, category, warranty, recall, page, page_size: PAGE }), [dq, category, warranty, recall, page, dataVersion])
  const data = list.data
  // ?open=first|<item id> opens the detail panel once the list is in (demo links, screenshot capture).
  useEffect(() => {
    const want = params.get('open')
    if (!want || !data) return
    const id = want === 'first' ? data.items[0]?.id : want
    if (id) openItem(id)
    const p = new URLSearchParams(params)
    p.delete('open')
    setParams(p, { replace: true })
  }, [params, setParams, data, openItem])
  const total = data?.total ?? summary?.items_watched ?? null
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  useEffect(() => {
    if (data && page > pages) setPage(pages)
  }, [data, page, pages])
  const start = data && data.total > 0 ? (page - 1) * PAGE + 1 : 0
  const end = data ? Math.min(page * PAGE, data.total) : 0
  const filtered = Boolean(dq || category || warranty || recall)
  const clear = () => {
    setQ('')
    setCategory('')
    setWarranty('')
    setRecall('')
  }
  const onCreated = (item: Item) => {
    list.reload()
    refreshSummary()
    openItem(item.id)
  }

  return (
    <>
      <div className="g-page__head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="g-h1">
            Inventory <span className="g-h1__count">({total == null ? '…' : total.toLocaleString()})</span>
          </h1>
          <p className="g-sub">Built from forwarded receipts, photos, and VINs. Select an item to see its receipt, warranty, and matches.</p>
        </div>
        <button type="button" className="g-btn g-btn--primary" onClick={() => setAdding(true)}>
          Add item
        </button>
      </div>

      <section aria-labelledby="inv-h" className="g-card" aria-busy={list.loading || list.refreshing}>
        <h2 id="inv-h" className="sr-only">
          Inventory table
        </h2>
        <div className="g-toolbar">
          <label className="g-search">
            <span className="sr-only">Find items</span>
            <input type="search" className="g-input" placeholder="Find items" value={q} onChange={e => setQ(e.target.value)} autoComplete="off" />
          </label>
          <div role="group" aria-label="Filters" className="g-filters">
            <FilterPill label="Category" value={category} options={CATEGORY_OPTS} onChange={v => setCategory(v as Category | '')} />
            <FilterPill label="Warranty status" value={warranty} options={WARRANTY_OPTS} onChange={v => setWarranty(v as WarrantyFilter)} />
            <FilterPill label="Recall status" value={recall} options={RECALL_OPTS} onChange={v => setRecall(v as RecallFilter)} />
          </div>
        </div>

        <div role="table" aria-label="Items">
          <div role="row" className="g-table__head">
            <span role="columnheader">Item</span>
            <span role="columnheader">Category</span>
            <span role="columnheader">Purchased</span>
            <span role="columnheader">Warranty</span>
            <span role="columnheader">Recall status</span>
          </div>
          {list.loading && !data && [0, 1, 2, 3, 4].map(i => <RowSkeleton key={i} />)}
          {list.error && !data && (
            <div style={{ padding: 16 }}>
              <ErrorNote message={list.error} onRetry={list.reload} />
            </div>
          )}
          {data && data.items.length === 0 && (
            <div className="g-empty">
              No items match{filtered ? ' these filters' : ''}.{' '}
              {filtered && (
                <button type="button" className="g-linkbtn g-ui" onClick={clear}>
                  Clear filters
                </button>
              )}
            </div>
          )}
          {data?.items.map(it => (
            <Row key={it.id} it={it} selected={selectedItemId === it.id} onOpen={() => openItem(it.id)} color={warrantyColor(theme, it.warranty.elapsed_pct ?? 0)} />
          ))}
        </div>

        <div className="g-table__foot">
          <span>
            {data ? `${start}–${end} of ${data.total.toLocaleString()}` : '…'}
            {list.refreshing ? ' · updating…' : ''}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="g-pager" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
              <span aria-hidden="true">‹</span>
            </button>
            <button type="button" className="g-pager" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))}>
              <span aria-hidden="true">›</span>
            </button>
          </div>
        </div>
      </section>

      {adding && <AddItemDialog onClose={() => setAdding(false)} onCreated={onCreated} />}
    </>
  )
}

function Row({ it, selected, onOpen, color }: { it: Item; selected: boolean; onOpen: () => void; color: string }) {
  const sub = [it.brand, it.model_number ?? (it.vehicle ? `VIN …${it.vehicle.vin.slice(-4)}` : null)].filter(Boolean).join(' · ')
  return (
    <div role="row" aria-selected={selected} className="g-table__row" onClick={onOpen}>
      <div role="cell" style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
        <span aria-hidden="true" className="g-thumb" />
        <div style={{ minWidth: 0 }}>
          <button
            type="button"
            className="g-linkbtn"
            style={{ minHeight: 24 }}
            onClick={e => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {it.name}
          </button>
          <div className="g-small g-muted">{sub}</div>
        </div>
      </div>
      <div role="cell">
        <span className="g-cell-label">Category</span>
        {it.category}
      </div>
      <div role="cell" className="g-num" style={{ fontSize: 14 }}>
        <span className="g-cell-label">Purchased</span>
        {it.purchase_date}
      </div>
      <div role="cell">
        <span className="g-cell-label">Warranty</span>
        <span className="g-small g-bidi">{it.warranty.label}</span>
        <Bar pct={it.warranty.elapsed_pct} color={color} maxWidth={220} style={{ marginTop: 6 }} />
      </div>
      <div role="cell">
        <span className="g-cell-label">Recall</span>
        <Status color={recallVar(it.recall.state)} size={10} style={{ fontSize: 14 }}>
          {it.recall.label}
        </Status>
      </div>
    </div>
  )
}

function RowSkeleton() {
  return (
    <div className="g-table__row" aria-hidden="true" style={{ cursor: 'default' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span className="g-thumb" />
        <Skeleton w={160} h={16} />
      </div>
      <Skeleton w={70} />
      <Skeleton w={90} />
      <Skeleton w={140} />
      <Skeleton w={90} />
    </div>
  )
}

/** Toggle-pill filter with a small listbox popover; the pill fills primary when a value is set. */
function FilterPill({ label, value, options, onChange }: { label: string; value: string; options: Opt[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btn.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const current = options.find(o => o.value === value)
  const on = value !== ''
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    btn.current?.focus()
  }
  return (
    <div className="g-filter" ref={ref}>
      <button ref={btn} type="button" className={`g-chip${on ? ' is-on' : ''}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {label}
        {current ? `: ${current.label}` : ''}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="listbox" aria-label={label} className="g-pop">
          <button type="button" role="option" aria-selected={!on} className="g-pop__opt" onClick={() => pick('')}>
            Any
          </button>
          {options.map(o => (
            <button key={o.value} type="button" role="option" aria-selected={value === o.value} className="g-pop__opt" onClick={() => pick(o.value)}>
              {o.label}
              {value === o.value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
