// PWA status: the "new version ready" prompt (the service worker registers with registerType 'prompt', so a new
// build waits for the user instead of reloading under an open SSE stream) and an offline notice. Rendered at the
// app root so it covers both the dashboard shell and the full-screen trace view; styles are .g-pwa* in global.css.
import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

export function PwaStatus() {
  const online = useOnline()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Look for a new build once an hour while the tab stays open; the nightly sweep runs unattended for days.
      if (reg) window.setInterval(() => void reg.update(), 60 * 60 * 1000)
    },
  })

  if (!online) {
    return (
      <div role="status" aria-live="polite" className="g-pwa g-pwa--offline">
        <span className="g-pwa__text">Offline. Guardian shows what it has; actions wait until you are back.</span>
      </div>
    )
  }
  if (needRefresh) {
    return (
      <div role="status" aria-live="polite" className="g-pwa">
        <span className="g-pwa__text">A new version of Guardian is ready.</span>
        <button type="button" className="g-pwa__btn g-pwa__btn--primary" onClick={() => void updateServiceWorker(true)}>
          Reload
        </button>
        <button type="button" className="g-pwa__btn" onClick={() => setNeedRefresh(false)}>
          Later
        </button>
      </div>
    )
  }
  return null
}
