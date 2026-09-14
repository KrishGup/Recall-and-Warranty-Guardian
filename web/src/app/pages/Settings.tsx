// Settings: the household preferences Guardian keeps in memory (GET/PUT /api/preferences) plus appearance.
import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Api } from '../../api/client'
import type { Preferences } from '../../api/types'
import { NOTIFY_KEY } from '../shell/AppShell'
import { readBool, writeBool } from '../../theme/prefs'
import { ErrorNote, Skeleton } from '../../ui/primitives'
import { errMsg } from '../format'
import { useShell } from '../shell/ShellContext'
import { useAsync } from '../shell/useAsync'

const GMAIL_FILTER = 'from:(amazon.com OR shopify OR target.com OR walmart.com OR bestbuy.com OR instacart.com OR homedepot.com OR costco.com) OR subject:(receipt OR "order confirmation" OR "your order")'

const BUDGETS: { key: Preferences['budget']; label: string; desc: string }[] = [
  { key: 'critical_only', label: 'Critical only', desc: 'Never interrupt for standard hazards or warranty windows.' },
  { key: 'weekly', label: 'Once a week', desc: 'Default. One unsolicited message per week at most.' },
  { key: 'daily', label: 'Daily digest', desc: 'A short email every morning after the sweep.' },
]
const QUIET = ['Juvenile', 'Kitchen', 'Appliance', 'Vehicle', 'Tools', 'Food', 'Electronics', 'Toys', 'Home']

export function Settings() {
  const { toast, dark, toggleScheme, copyAddress, refreshSummary, address } = useShell()
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

  // ---- desktop notifications: opt-in only, never auto-prompted ----
  const [notifyOn, setNotifyOn] = useState(() => readBool(NOTIFY_KEY, false))
  const notifySupported = typeof Notification !== 'undefined'
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission>(notifySupported ? Notification.permission : 'denied')
  async function toggleNotify() {
    if (!notifySupported) return
    if (!notifyOn) {
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
      setNotifyPermission(perm)
      if (perm !== 'granted') {
        toast(perm === 'denied' ? 'Notifications are blocked in the browser. Allow them for this site to turn this on.' : 'Notification permission was not granted.')
        return
      }
    }
    writeBool(NOTIFY_KEY, !notifyOn)
    setNotifyOn(!notifyOn)
    toast(!notifyOn ? 'Desktop notifications on for critical decisions.' : 'Desktop notifications off.')
  }

  // ---- gmail ----
  const [params, setParams] = useSearchParams()
  const gmail = useAsync(() => Api.gmail.status(), [])
  const [gmailBusy, setGmailBusy] = useState(false)
  useEffect(() => {
    const g = params.get('gmail')
    if (!g) return
    if (g === 'connected') toast('Gmail connected.')
    else if (g === 'error') toast(`Could not connect Gmail: ${params.get('reason') || 'unknown error'}`)
    const p = new URLSearchParams(params)
    p.delete('gmail')
    p.delete('reason')
    setParams(p, { replace: true })
    gmail.reload()
    // once, when the OAuth redirect lands
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps
  async function connectGmail() {
    setGmailBusy(true)
    try {
      const { url } = await Api.gmail.connect()
      window.location.href = url
    } catch (err) {
      toast(`Could not start Gmail connect: ${errMsg(err)}`)
      setGmailBusy(false)
    }
  }
  async function syncGmail() {
    setGmailBusy(true)
    try {
      const r = await Api.gmail.sync()
      toast(`Checked ${r.checked} message(s); added ${r.added} item(s).`)
      gmail.reload()
      refreshSummary()
    } catch (err) {
      toast(`Gmail sync failed: ${errMsg(err)}`)
    } finally {
      setGmailBusy(false)
    }
  }
  async function disconnectGmail() {
    setGmailBusy(true)
    try {
      await Api.gmail.disconnect()
      toast('Gmail disconnected.')
      gmail.reload()
    } catch (err) {
      toast(`Could not disconnect: ${errMsg(err)}`)
    } finally {
      setGmailBusy(false)
    }
  }
  function copyFilter() {
    const done = () => toast('Gmail filter copied.')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(GMAIL_FILTER).then(done, done)
    else done()
  }

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
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
              <label className={`g-radio${notifyOn ? ' is-on' : ''}`} style={{ maxWidth: 480 }}>
                <input type="checkbox" checked={notifyOn} onChange={toggleNotify} disabled={!notifySupported} />
                <span>
                  <span style={{ fontWeight: 500 }}>Desktop notifications for critical decisions</span>
                  <span className="g-small g-muted" style={{ display: 'block' }}>
                    {notifySupported
                      ? notifyPermission === 'denied' && !notifyOn
                        ? 'Blocked by the browser. Allow notifications for this site to turn this on.'
                        : "Guardian stays quiet in the tab; if it's not the one you're looking at, a critical match still gets a system notification."
                      : 'Not supported in this browser.'}
                  </span>
                </span>
              </label>
            </div>
          </section>

          <section aria-labelledby="s3g" className="g-card" style={{ padding: '20px 24px' }}>
            <h2 id="s3g" className="g-h2" style={{ marginBottom: 4 }}>
              Gmail
            </h2>
            <p className="g-muted" style={{ margin: '0 0 16px', fontSize: 14 }}>
              Link Gmail so Guardian reads receipts on its own, or skip the OAuth entirely with a filter that forwards them for you.
            </p>
            {gmail.error && !gmail.data && <ErrorNote message={gmail.error} onRetry={gmail.reload} />}
            {gmail.data && (
              <div style={{ marginBottom: 16 }}>
                {!gmail.data.configured && (
                  <p className="g-small g-muted" style={{ margin: '0 0 10px' }}>
                    Not configured on this server. Set <code className="g-code-inline">GOOGLE_CLIENT_ID</code> and <code className="g-code-inline">GOOGLE_CLIENT_SECRET</code> (see <code className="g-code-inline">.env.example</code>) to enable direct linking.
                  </p>
                )}
                {gmail.data.configured && !gmail.data.connected && (
                  <button type="button" className="g-btn g-btn--primary" onClick={connectGmail} disabled={gmailBusy}>
                    {gmailBusy ? 'Opening Google…' : 'Connect Gmail'}
                  </button>
                )}
                {gmail.data.connected && (
                  <div>
                    <p style={{ margin: '0 0 10px' }}>
                      Connected as <strong>{gmail.data.email}</strong>
                      <span className="g-small g-muted">{gmail.data.last_sync ? ` · last synced ${new Date(gmail.data.last_sync).toLocaleString()}` : ' · not yet synced'}</span>
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" className="g-btn g-btn--outline" onClick={syncGmail} disabled={gmailBusy}>
                        {gmailBusy ? 'Working…' : 'Sync now'}
                      </button>
                      <button type="button" className="g-btn" onClick={disconnectGmail} disabled={gmailBusy}>
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div style={{ paddingTop: gmail.data ? 16 : 0, borderTop: gmail.data ? '1px solid var(--line)' : 'none' }}>
              <p className="g-small g-muted" style={{ margin: '0 0 8px' }}>
                No Google account, or would rather not link one? Create a Gmail filter with this search and forward matches to{' '}
                <code className="g-code-inline" dir="ltr">
                  {address}
                </code>
                :
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                <code className="g-code" dir="ltr" style={{ overflowX: 'auto', whiteSpace: 'nowrap', flex: 1 }}>
                  {GMAIL_FILTER}
                </code>
                <button type="button" className="g-btn g-btn--outline" style={{ paddingInline: 14, fontSize: 13, flexShrink: 0 }} onClick={copyFilter}>
                  Copy
                </button>
              </div>
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
