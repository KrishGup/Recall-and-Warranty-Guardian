// Settings: the household preferences Guardian keeps in memory (GET/PUT /api/preferences) plus appearance.
import { useEffect, useState, type FormEvent } from 'react'
import { Api } from '../../api/client'
import type { Preferences } from '../../api/types'
import { ErrorNote, Skeleton } from '../../ui/primitives'
import { errMsg } from '../format'
import { useShell } from '../shell/ShellContext'
import { useAsync } from '../shell/useAsync'

const BUDGETS: { key: Preferences['budget']; label: string; desc: string }[] = [
  { key: 'critical_only', label: 'Critical only', desc: 'Never interrupt for standard hazards or warranty windows.' },
  { key: 'weekly', label: 'Once a week', desc: 'Default. One unsolicited message per week at most.' },
  { key: 'daily', label: 'Daily digest', desc: 'A short email every morning after the sweep.' },
]
const QUIET = ['Juvenile', 'Kitchen', 'Appliance', 'Vehicle', 'Tools', 'Food', 'Electronics', 'Toys', 'Home']

export function Settings() {
  const { toast, dark, rtl, toggleScheme, toggleDir, copyAddress, refreshSummary } = useShell()
  const prefs = useAsync(() => Api.preferences(), [])
  const [base, setBase] = useState<Preferences | null>(null)
  const [form, setForm] = useState<Preferences | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (prefs.data) {
      setBase(prefs.data)
      setForm(prefs.data)
    }
  }, [prefs.data])
  const dirty = form !== null && base !== null && JSON.stringify(form) !== JSON.stringify(base)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form || saving) return
    setSaving(true)
    try {
      const saved = await Api.savePreferences(form)
      setBase(saved)
      setForm(saved)
      toast('Preferences saved to Guardian memory.')
      refreshSummary()
    } catch (err) {
      toast(`Could not save: ${errMsg(err)}`)
    } finally {
      setSaving(false)
    }
  }
  function cancel() {
    if (base) setForm(base)
    toast('Changes discarded.')
  }
  const toggleCat = (c: string) =>
    setForm(f => f && { ...f, quiet_categories: f.quiet_categories.includes(c) ? f.quiet_categories.filter(x => x !== c) : [...f.quiet_categories, c] })

  return (
    <>
      <h1 className="g-h1" style={{ marginBottom: 4 }}>
        Settings
      </h1>
      <p className="g-sub" style={{ margin: '0 0 20px' }}>
        Also changeable by replying in plain language, like "only bother me about the kids' stuff."
      </p>
      {prefs.error && !form && <ErrorNote message={prefs.error} onRetry={prefs.reload} />}
      {!form && !prefs.error && (
        <div className="g-settings" aria-busy="true">
          {[0, 1].map(i => (
            <div key={i} className="g-card g-card--pad" aria-hidden="true">
              <Skeleton w={140} h={20} style={{ marginBottom: 12 }} />
              <Skeleton h={44} style={{ marginBottom: 8 }} />
              <Skeleton h={44} />
            </div>
          ))}
        </div>
      )}
      {form && (
        <form onSubmit={save} className="g-settings" aria-busy={saving}>
          <section aria-labelledby="s1" className="g-card" style={{ padding: '20px 24px' }}>
            <h2 id="s1" className="g-h2" style={{ marginBottom: 4 }}>
              Interruptions
            </h2>
            <p className="g-muted" style={{ margin: '0 0 16px', fontSize: 14 }}>
              Critical hazards always come through. This governs everything else.
            </p>
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 18px' }}>
              <legend className="g-label" style={{ marginBottom: 8 }}>
                Notification budget
              </legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {BUDGETS.map(b => (
                  <label key={b.key} className={`g-radio${form.budget === b.key ? ' is-on' : ''}`}>
                    <input type="radio" name="budget" checked={form.budget === b.key} onChange={() => setForm({ ...form, budget: b.key })} />
                    <span>
                      <span style={{ fontWeight: 500 }}>{b.label}</span>
                      <span className="g-small g-muted" style={{ display: 'block' }}>
                        {b.desc}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="g-field" style={{ maxWidth: 320 }}>
              <span>Value threshold for warranty check‑ins</span>
              <span className="g-prefix">
                <span aria-hidden="true">$</span>
                <input
                  type="number"
                  min={0}
                  step={10}
                  dir="ltr"
                  value={form.value_threshold}
                  onChange={e => {
                    const v = Number(e.target.value)
                    setForm({ ...form, value_threshold: Number.isFinite(v) ? v : 0 })
                  }}
                  aria-describedby="thr-help"
                />
              </span>
              <span id="thr-help" className="g-help-text">
                Items below this expire quietly.
              </span>
            </label>
          </section>

          <section aria-labelledby="s2" className="g-card" style={{ padding: '20px 24px' }}>
            <h2 id="s2" className="g-h2" style={{ marginBottom: 4 }}>
              Quiet categories
            </h2>
            <p className="g-muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
              Standard‑hazard recalls in these categories go to the digest only.
            </p>
            <div role="group" aria-label="Quiet categories" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {QUIET.map(c => {
                const on = form.quiet_categories.includes(c)
                return (
                  <button key={c} type="button" aria-pressed={on} className={`g-chip${on ? ' is-on' : ''}`} onClick={() => toggleCat(c)}>
                    <span aria-hidden="true">{on ? '✓' : '+'}</span>
                    {c}
                  </button>
                )
              })}
            </div>
          </section>

          <section aria-labelledby="s3" className="g-card" style={{ padding: '20px 24px' }}>
            <h2 id="s3" className="g-h2" style={{ marginBottom: 12 }}>
              Channels
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 16 }}>
              <div className="g-field">
                <span>Forwarding address</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <code aria-label="Forwarding address" dir="ltr" className="g-code">
                    {form.forwarding_address}
                  </code>
                  <button type="button" className="g-btn g-btn--outline" style={{ paddingInline: 14, fontSize: 13 }} onClick={copyAddress}>
                    Copy
                  </button>
                </div>
              </div>
              <label className="g-field">
                <span>Phone for critical alerts</span>
                <input type="tel" dir="ltr" className="g-input g-num" style={{ textAlign: 'start' }} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
              </label>
            </div>
          </section>

          <section aria-labelledby="s4" className="g-card" style={{ padding: '20px 24px' }}>
            <h2 id="s4" className="g-h2" style={{ marginBottom: 12 }}>
              Appearance
            </h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="g-chip" onClick={toggleScheme} aria-pressed={dark}>
                Switch to {dark ? 'Light' : 'Dark'} mode
              </button>
              <button type="button" className="g-chip" onClick={toggleDir}>
                Text direction: {rtl ? 'LTR' : 'RTL'}
              </button>
            </div>
          </section>

          <div className="g-settings__foot">
            <button type="button" className="g-btn g-btn--lg" onClick={cancel} disabled={!dirty || saving}>
              Cancel
            </button>
            <button type="submit" className="g-btn g-btn--primary g-btn--lg" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
