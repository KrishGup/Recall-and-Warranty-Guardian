// "Run this graph" dialog (Kestra's execute-with-inputs): the nightly sweep takes its window and scan options and goes
// through Guardian's sweep endpoint (budget check, sweep record); intake takes the receipt text and goes through
// Guardian's intake; any other graph builds its form from the spec's input_schema and starts through gren directly.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Api } from '../api/client'
import type { GrenGraphInfo } from '../api/types'
import { errorMessage } from './model'

interface Props {
  graph: GrenGraphInfo
  onClose: () => void
  onStarted: (runId: string, note: string) => void
}

interface Field {
  name: string
  type: 'string' | 'number' | 'boolean' | 'json'
  required: boolean
  description?: string
  default?: unknown
}

function fieldsFromSchema(schema: unknown): Field[] {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {}
  const required = new Set(((schema as { required?: string[] }).required ?? []) as string[])
  return Object.entries(props).map(([name, p]) => {
    const t = p.type
    const type: Field['type'] = t === 'number' || t === 'integer' ? 'number' : t === 'boolean' ? 'boolean' : t === 'string' ? 'string' : 'json'
    return { name, type, required: required.has(name), description: typeof p.description === 'string' ? p.description : undefined, default: p.default }
  })
}

export function RunDialog({ graph, onClose, onStarted }: Props) {
  const kind = graph.path === 'nightly-sweep.yaml' ? 'sweep' : graph.path === 'intake.yaml' ? 'intake' : 'generic'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [window, setWindow] = useState(45)
  const [fullScan, setFullScan] = useState(false)
  const [autoApprove, setAutoApprove] = useState(false)
  const [text, setText] = useState('')
  const [source, setSource] = useState<'paste' | 'email'>('paste')
  const fields = kind === 'generic' ? fieldsFromSchema(graph.input_schema) : []
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(f => [f.name, f.default == null ? '' : typeof f.default === 'object' ? JSON.stringify(f.default) : String(f.default)])))
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  const firstRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
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

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (kind === 'sweep') {
        const r = await Api.sweep({ window_days: window, full_scan: fullScan, auto_approve: autoApprove })
        onStarted(r.run_id, `Sweep started with a ${window}-day window${fullScan ? ', full scan' : ''}${autoApprove ? ', gate auto-approved' : ''}.`)
      } else if (kind === 'intake') {
        if (text.trim().length < 8) throw new Error('paste at least a line of the receipt')
        const r = await Api.intake(text, source)
        if (r.error && !r.run_id) throw new Error(r.error)
        if (!r.run_id) throw new Error('intake did not record a run')
        onStarted(r.run_id, r.item ? `Intake finished: ${[r.item.brand, r.item.name].filter(Boolean).join(' ')} added.` : `Intake finished${r.error ? ` with an error: ${r.error}` : ''}.`)
      } else {
        const input: Record<string, unknown> = {}
        for (const f of fields) {
          const raw = values[f.name] ?? ''
          if (raw === '') {
            if (f.required) throw new Error(`${f.name} is required`)
            continue
          }
          if (f.type === 'number') {
            const n = Number(raw)
            if (Number.isNaN(n)) throw new Error(`${f.name} must be a number`)
            input[f.name] = n
          } else if (f.type === 'boolean') input[f.name] = raw === 'true'
          else if (f.type === 'json') {
            try {
              input[f.name] = JSON.parse(raw)
            } catch {
              input[f.name] = raw
            }
          } else input[f.name] = raw
        }
        const r = await Api.gren.start(graph.file ?? graph.path, input)
        onStarted(r.run_id, `${graph.name || graph.path} started.`)
      }
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="tr-modal"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form role="dialog" aria-modal="true" aria-labelledby="tr-run-h" className="tr-modal-card" onSubmit={e => void submit(e)}>
        <div className="tr-modal-head">
          <div>
            <div className="tr-eyebrow">Run a graph</div>
            <h2 id="tr-run-h">{graph.name || graph.path}</h2>
          </div>
          <button type="button" className="tr-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="tr-modal-body">
          {(graph.goal || graph.description) && <p className="tr-modal-desc">{graph.goal ?? graph.description}</p>}
          {kind === 'sweep' && (
            <>
              <label className="tr-field">
                <span>Recall history to pull (days)</span>
                <input ref={firstRef} type="number" min={1} max={400} className="tr-input" value={window} onChange={e => setWindow(Math.max(1, Math.min(400, Number(e.target.value) || 45)))} />
                <small>45 is the nightly default. The first sweep of a household looks back 400 days on its own.</small>
              </label>
              <label className="tr-check">
                <input type="checkbox" checked={fullScan} onChange={e => setFullScan(e.target.checked)} />
                <span>Full scan: re-check every item, not only the new recalls</span>
              </label>
              <label className="tr-check">
                <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} />
                <span>Demo mode: approve the household gate automatically (remedy emails go out without a person)</span>
              </label>
              <p className="tr-modal-note">Live feeds, real model calls: a sweep costs cents to a dollar and stops at the graph budget{graph.budget?.max_cost_usd != null ? ` ($${graph.budget.max_cost_usd.toFixed(2)})` : ''}.</p>
            </>
          )}
          {kind === 'intake' && (
            <>
              <label className="tr-field">
                <span>Receipt, order confirmation or product line</span>
                <textarea ref={firstRef} className="tr-textarea" value={text} onChange={e => setText(e.target.value)} placeholder="Paste the email or receipt text here" rows={8} dir="auto" />
              </label>
              <label className="tr-field">
                <span>Source</span>
                <select className="tr-input" value={source} onChange={e => setSource(e.target.value as 'paste' | 'email')}>
                  <option value="paste">Pasted text</option>
                  <option value="email">Forwarded email</option>
                </select>
              </label>
              <p className="tr-modal-note">Runs the intake graph (redact → extract → save) and adds the item to the inventory. Usually 10 to 40 seconds.</p>
            </>
          )}
          {kind === 'generic' &&
            (fields.length === 0 ? (
              <p className="tr-modal-note">This graph declares no inputs; it starts with an empty input.</p>
            ) : (
              fields.map((f, i) => (
                <label key={f.name} className={f.type === 'boolean' ? 'tr-check' : 'tr-field'}>
                  {f.type === 'boolean' ? (
                    <>
                      <input type="checkbox" checked={values[f.name] === 'true'} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.checked ? 'true' : 'false' }))} />
                      <span>
                        {f.name}
                        {f.description ? ` · ${f.description}` : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>
                        {f.name}
                        {f.required ? ' *' : ''}
                      </span>
                      {f.type === 'json' ? (
                        <textarea ref={i === 0 ? firstRef : undefined} className="tr-textarea" rows={4} value={values[f.name] ?? ''} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} placeholder={f.description ?? 'JSON'} dir="ltr" />
                      ) : (
                        <input ref={i === 0 ? firstRef : undefined} type={f.type === 'number' ? 'number' : 'text'} className="tr-input" value={values[f.name] ?? ''} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} placeholder={f.description ?? ''} />
                      )}
                      {f.description && <small>{f.description}</small>}
                    </>
                  )}
                </label>
              ))
            ))}
          {error && (
            <p role="alert" className="tr-modal-error">
              {error}
            </p>
          )}
        </div>
        <div className="tr-modal-foot">
          <button type="button" className="tr-btn tr-btn--outline" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="tr-btn tr-btn--ok" disabled={busy}>
            {busy ? (kind === 'intake' ? 'Reading the receipt…' : 'Starting…') : kind === 'sweep' ? 'Run the sweep' : kind === 'intake' ? 'Run intake' : 'Start run'}
          </button>
        </div>
      </form>
    </div>
  )
}
