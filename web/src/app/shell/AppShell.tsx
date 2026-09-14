// The dashboard shell: top bar with the animated logo, resizable side nav, breadcrumb, flashbar, page outlet,
// item-detail split panel, info panel, mobile tab bar and toast. Keeps the summary and pending decisions fresh
// over the /api/events SSE stream and hands everything to pages through ShellContext.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Api, useEventSource } from '../../api/client'
import type { Decision, Decisions, GuardianEvent, Summary } from '../../api/types'
import { readBool, readNumber, useNarrow, usePrefs, writeNumber } from '../../theme/prefs'
import { AGENT_STATUS, BREAKPOINT_NARROW } from '../../theme/tokens'
import { Logo } from '../../ui/Logo'
import { clamp, errMsg } from '../format'
import { InfoPanel } from './InfoPanel'
import { ShellContext, type PageId, type Shell } from './ShellContext'
import { SplitPanel } from './SplitPanel'
import { useResize } from './useResize'
import '../app.css'

const MOCK = import.meta.env.VITE_MOCK === '1'
const NAV_KEY = 'guardian.navW'
export const NOTIFY_KEY = 'guardian.notify'

interface NavDef {
  id: PageId
  path: string
  label: string
  icon: string // border-radius of the outlined tab-bar glyph
}
const HOUSEHOLD: NavDef[] = [
  { id: 'home', path: '/', label: 'Home', icon: '50%' },
  { id: 'decisions', path: '/decisions', label: 'Decisions', icon: '6px' },
  { id: 'inventory', path: '/inventory', label: 'Inventory', icon: '4px' },
  { id: 'activity', path: '/activity', label: 'Activity', icon: '50% 50% 4px 4px' },
  { id: 'settings', path: '/settings', label: 'Settings', icon: '12px' },
]
const TECHNICAL: NavDef[] = [{ id: 'flow', path: '/flow', label: 'Agent flow', icon: '4px' }]
const TITLES: Record<PageId, string> = { home: 'Home', decisions: 'Decisions', inventory: 'Inventory', activity: 'Activity', settings: 'Settings', flow: 'Agent flow' }
const PAGE_IDS: PageId[] = ['decisions', 'inventory', 'activity', 'settings', 'flow']

function pageOf(pathname: string): PageId {
  const seg = pathname.split('/')[1] || ''
  return PAGE_IDS.find(p => p === seg) ?? 'home'
}

/** Flashbar sentence from the first pending critical decision: item, retailer and purchase date come from its facts. */
function flashText(d: Decision): string {
  const purchased = d.facts.find(f => f.label === 'Purchased')?.value ?? ''
  const [date, retailer] = purchased.split(/,\s*/)
  const name = d.item_name || d.title
  const bought = date ? `, bought${retailer ? ` at ${retailer}` : ''} on ${date}` : ''
  return `${name}${bought}. Remedy is drafted; one decision is needed.`
}

export function AppShell({ children }: { children: ReactNode }) {
  const prefs = usePrefs()
  const narrow = useNarrow(BREAKPOINT_NARROW)
  const location = useLocation()
  const navigate = useNavigate()
  const page = pageOf(location.pathname)
  const rtl = prefs.rtl

  // ---- summary + decisions, refreshed on SSE events ----
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Decisions | null>(null)
  const [decisionsError, setDecisionsError] = useState<string | null>(null)
  const refreshSummary = useCallback(() => {
    Api.summary().then(
      s => {
        setSummary(s)
        setSummaryError(null)
      },
      (e: unknown) => setSummaryError(errMsg(e)),
    )
  }, [])
  const refreshDecisions = useCallback(() => {
    Api.decisions().then(
      d => {
        setDecisions(d)
        setDecisionsError(null)
      },
      (e: unknown) => setDecisionsError(errMsg(e)),
    )
  }, [])
  useEffect(() => {
    refreshSummary()
    refreshDecisions()
  }, [refreshSummary, refreshDecisions])

  const [dataVersion, setDataVersion] = useState(0)
  const [runVersion, setRunVersion] = useState(0)
  const pendingRef = useRef<{ data: boolean; run: boolean; timer: number | null }>({ data: false, run: false, timer: null })
  const schedule = useCallback(
    (kind: 'data' | 'run') => {
      const p = pendingRef.current
      p[kind] = true
      if (p.timer != null) return
      p.timer = window.setTimeout(() => {
        const { data, run } = p
        p.data = false
        p.run = false
        p.timer = null
        if (data) {
          setDataVersion(v => v + 1)
          refreshSummary()
          refreshDecisions()
        }
        if (run) setRunVersion(v => v + 1)
      }, 900)
    },
    [refreshSummary, refreshDecisions],
  )
  const bumpData = useCallback(() => {
    setDataVersion(v => v + 1)
    refreshSummary()
    refreshDecisions()
  }, [refreshSummary, refreshDecisions])
  // Silent unless something needs you: a critical decision fires a desktop notification only if the tab is not the
  // one being looked at and the household opted in (Settings > "Desktop notifications"); we never auto-prompt for
  // permission. Each decision id notifies at most once.
  const notifiedRef = useRef<Set<string>>(new Set())
  const maybeNotify = useCallback(
    (decisionId: string, body: string) => {
      if (!decisionId || notifiedRef.current.has(decisionId)) return
      notifiedRef.current.add(decisionId)
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !readBool(NOTIFY_KEY, false)) return
      if (document.visibilityState === 'visible') return
      const n = new Notification('Guardian needs you', { body, tag: 'guardian-critical' })
      n.onclick = () => {
        window.focus()
        navigate('/decisions')
        n.close()
      }
    },
    [navigate],
  )
  useEventSource(MOCK ? null : '/api/events', (e: GuardianEvent) => {
    if (!e || e.type === 'hello') return
    // Guardian events (sweep.*, decision.*, item.*) and engine events (run.*, node.*, gate.*) both change what the
    // pages show; refetch at most once per ~second instead of polling.
    schedule('run')
    schedule('data')
    if (e.type === 'decision.created' && e.data?.severity === 'critical') {
      maybeNotify(String(e.data.decision_id ?? ''), 'A critical recall matches an item you own. One decision is waiting.')
    }
  })
  // Safety net while a sweep runs (mock mode has no SSE; a dropped stream should not freeze the header).
  const working = summary?.agent_status === 'working'
  useEffect(() => {
    if (!working) return
    const t = window.setInterval(() => {
      refreshSummary()
      refreshDecisions()
      setRunVersion(v => v + 1)
      setDataVersion(v => v + 1)
    }, MOCK ? 1500 : 6000)
    return () => window.clearInterval(t)
  }, [working, refreshSummary, refreshDecisions])

  // ---- toast ----
  const [toastMsg, setToastMsg] = useState('')
  const toastTimer = useRef<number | null>(null)
  const toast = useCallback((m: string) => {
    setToastMsg(m)
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 3000)
  }, [])

  // ---- panels ----
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const openItem = useCallback((id: string) => setSelectedItemId(id), [])
  const closeItem = useCallback(() => setSelectedItemId(null), [])
  const [helpOpen, setHelpOpen] = useState(false)
  const toggleHelp = useCallback(() => setHelpOpen(o => !o), [])

  // ---- navigation side effects: title, scroll + focus main, close panels ----
  const firstNav = useRef(true)
  useEffect(() => {
    if (page !== 'home' && page !== 'inventory') setSelectedItemId(null)
    if (firstNav.current) {
      firstNav.current = false
      return
    }
    if (narrow) setHelpOpen(false)
    const m = document.getElementById('main')
    if (m) {
      m.scrollTop = 0
      m.focus({ preventScroll: true })
    }
    // runs on route change only
  }, [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  // Document title: a "(1)" prefix while a critical decision is pending and this tab is not the one being looked
  // at, cleared the moment it is focused again — a no-permission-required companion to the desktop notification.
  useEffect(() => {
    const hasCritical = decisions?.pending.some(d => d.severity === 'critical') ?? false
    const set = () => {
      document.title = `${hasCritical && document.visibilityState !== 'visible' ? '(1) ' : ''}Guardian · ${TITLES[page]}`
    }
    set()
    document.addEventListener('visibilitychange', set)
    return () => document.removeEventListener('visibilitychange', set)
  }, [page, decisions])

  // ?scheme=dark|light and ?dir=rtl|ltr preset the appearance (demo links, screenshot capture); persisted like the toggles.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const s = p.get('scheme')
    const d = p.get('dir')
    if (s === 'dark' || s === 'light') prefs.setScheme(s)
    if (d === 'rtl' || d === 'ltr') prefs.setDir(d)
    // once, on load
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- logo: cover opens 400 ms after load and whenever the agent is not idle ----
  const [coverOpen, setCoverOpen] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setCoverOpen(true), 400)
    return () => window.clearTimeout(t)
  }, [])
  const status = summary?.agent_status ?? 'idle'

  // ---- forwarding address + sweep ----
  const address = summary?.forwarding_address ?? 'receipts@guardian.house'
  const copyAddress = useCallback(() => {
    const done = () => toast('Forwarding address copied.')
    const fallback = () => toast(`Forwarding address: ${address}`)
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(address).then(done, fallback)
    else fallback()
  }, [address, toast])
  const sweeping = useRef(false)
  const runSweep = useCallback(() => {
    if (sweeping.current) return
    if (summary?.agent_status === 'working') {
      toast('A sweep is already running.')
      return
    }
    sweeping.current = true
    Api.sweep()
      .then(
        () => {
          toast(`Sweep started. Guardian is checking ${summary?.items_watched ?? 'your'} items against tonight's feeds.`)
          refreshSummary()
          setRunVersion(v => v + 1)
        },
        (e: unknown) => toast(`Could not start a sweep: ${errMsg(e)}`),
      )
      .finally(() => {
        sweeping.current = false
      })
  }, [summary, toast, refreshSummary])
  const onLogoClick = () => {
    if (page !== 'home') navigate('/')
    runSweep()
  }

  // ---- side nav width (200–400, default 248, persisted) ----
  const [navW, setNavW] = useState(() => clamp(readNumber(NAV_KEY, 248), 200, 400))
  const setNav = useCallback((v: number) => {
    setNavW(v)
    writeNumber(NAV_KEY, v)
  }, [])
  const navResize = useResize({ value: navW, min: 200, max: 400, set: setNav, axis: 'x', sign: rtl ? -1 : 1, growKey: rtl ? 'ArrowLeft' : 'ArrowRight', shrinkKey: rtl ? 'ArrowRight' : 'ArrowLeft' })

  const pendingCount = decisions?.pending.length ?? summary?.decisions_pending ?? 0
  const critical = decisions?.pending.find(d => d.severity === 'critical') ?? null
  const showFlash = critical !== null && page !== 'decisions'

  const shell: Shell = useMemo(
    () => ({
      page,
      theme: prefs.theme,
      dark: prefs.dark,
      dir: prefs.dir,
      rtl,
      narrow,
      toggleScheme: prefs.toggleScheme,
      toggleDir: prefs.toggleDir,
      summary,
      summaryError,
      refreshSummary,
      decisions,
      decisionsError,
      refreshDecisions,
      dataVersion,
      bumpData,
      runVersion,
      toast,
      selectedItemId,
      openItem,
      closeItem,
      helpOpen,
      toggleHelp,
      address,
      copyAddress,
      runSweep,
    }),
    [page, prefs.theme, prefs.dark, prefs.dir, prefs.toggleScheme, prefs.toggleDir, rtl, narrow, summary, summaryError, refreshSummary, decisions, decisionsError, refreshDecisions, dataVersion, bumpData, runVersion, toast, selectedItemId, openItem, closeItem, helpOpen, toggleHelp, address, copyAddress, runSweep],
  )

  return (
    <ShellContext.Provider value={shell}>
      <div className="g-root">
        <a href="#main" className="g-skip">
          Skip to content
        </a>

        <header role="banner" className="g-top">
          <button type="button" className="g-top__brand" onClick={onLogoClick} aria-label="Guardian home. Click to run a sweep now." title="Run a sweep now">
            <Logo status={status} open={coverOpen || status !== 'idle'} />
            <span className="g-top__word">Guardian</span>
          </button>
          <span className="g-top__agent g-desk">{summary?.agent_label ?? (summaryError ? 'Offline' : '…')}</span>
          <div className="g-top__spacer" />
          <span className="g-top__status g-desk">
            <span aria-hidden="true" className={`g-dot${status === 'working' ? ' g-dot--pulse' : ''}`} style={{ background: AGENT_STATUS[status] }} />
            {summary?.sweep_label ?? (summaryError ? 'API unreachable' : 'Connecting…')}
          </span>
          <button type="button" className="g-pill g-desk" onClick={prefs.toggleScheme} aria-pressed={prefs.dark}>
            {prefs.dark ? 'Light' : 'Dark'}
          </button>
          <button type="button" className={`g-pill${helpOpen ? ' g-pill--on' : ''}`} onClick={toggleHelp} aria-pressed={helpOpen} aria-label="Toggle info panel">
            <span aria-hidden="true" className="g-pill__i">
              i
            </span>
            Info
          </button>
        </header>

        <div className="g-body">
          <nav aria-label="Main" className="g-nav" style={{ width: navW }}>
            <div role="separator" aria-label="Resize navigation" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={400} aria-valuenow={navW} tabIndex={0} className="g-sep g-nav__sep" {...navResize}>
              <span aria-hidden="true" className="g-sep__grip" />
            </div>
            <div className="g-nav__group">Household</div>
            {HOUSEHOLD.map(n => (
              <NavItem key={n.id} def={n} count={n.id === 'decisions' ? pendingCount : 0} />
            ))}
            <div className="g-nav__group g-nav__group--tech">Technical</div>
            {TECHNICAL.map(n => (
              <NavItem key={n.id} def={n} count={0} />
            ))}
            <div className="g-nav__spacer" />
            <div className="g-nav__foot">
              Forward receipts to
              <br />
              <button type="button" className="g-nav__addr" onClick={copyAddress} title="Copy address" dir="ltr">
                {address}
              </button>
            </div>
          </nav>

          <div className="g-col">
            <main id="main" tabIndex={-1} className="g-main" style={narrow && selectedItemId ? { paddingBottom: '40vh' } : undefined}>
              <nav aria-label="Breadcrumb" className="g-crumb">
                <Link to="/">Guardian</Link>
                <span aria-hidden="true">/</span>
                <span aria-current="page">{TITLES[page]}</span>
              </nav>
              {showFlash && critical && (
                <div role="alert" className="g-flash">
                  <span aria-hidden="true" className="g-flash__i">
                    !
                  </span>
                  <div className="g-flash__text">
                    <strong>Critical recall matches an item you own.</strong> {flashText(critical)}
                  </div>
                  <button type="button" className="g-flash__btn" onClick={() => navigate('/decisions')}>
                    Review decision
                  </button>
                </div>
              )}
              {children}
            </main>
            {selectedItemId && <SplitPanel itemId={selectedItemId} onClose={closeItem} />}
          </div>

          {helpOpen && <InfoPanel page={page} onClose={toggleHelp} />}
        </div>

        <nav aria-label="Main" className="g-tabs">
          {HOUSEHOLD.map(n => (
            <TabItem key={n.id} def={n} count={n.id === 'decisions' ? pendingCount : 0} />
          ))}
        </nav>

        <div role="status" aria-live="polite" className={`g-toast${toastMsg ? ' is-on' : ''}`}>
          {toastMsg}
        </div>
      </div>
    </ShellContext.Provider>
  )
}

function NavItem({ def, count }: { def: NavDef; count: number }) {
  return (
    <NavLink to={def.path} end={def.path === '/'} className={({ isActive }) => `g-nav__item${isActive ? ' is-current' : ''}`}>
      <span>{def.label}</span>
      {count > 0 && (
        <span className="g-badge-count" aria-label={`${count} pending`}>
          {count}
        </span>
      )}
    </NavLink>
  )
}

function TabItem({ def, count }: { def: NavDef; count: number }) {
  return (
    <NavLink to={def.path} end={def.path === '/'} className={({ isActive }) => `g-tabs__item${isActive ? ' is-current' : ''}`}>
      <span aria-hidden="true" className="g-tabs__icon" style={{ borderRadius: def.icon }}>
        <span />
      </span>
      <span>{def.label}</span>
      {count > 0 && (
        <span className="g-tabs__badge" aria-label={`${count} pending`}>
          {count}
        </span>
      )}
    </NavLink>
  )
}
