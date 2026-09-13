// Server-sent events with an honest connection state for the top-bar indicator.
// Same reconnect policy as api/client.ts useEventSource (exponential backoff to 15 s), plus `status`.
import { useEffect, useRef, useState } from 'react'
import type { GuardianEvent } from '../api/types'

export type StreamStatus = 'off' | 'connecting' | 'open' | 'reconnecting'

export function useTraceStream(url: string | null, onEvent: (e: GuardianEvent) => void): StreamStatus {
  const handler = useRef(onEvent)
  handler.current = onEvent
  const [status, setStatus] = useState<StreamStatus>(url ? 'connecting' : 'off')
  useEffect(() => {
    if (!url || typeof EventSource === 'undefined') {
      setStatus('off')
      return
    }
    let es: EventSource | null = null
    let closed = false
    let retry = 1000
    let timer: number | null = null
    setStatus('connecting')
    const open = () => {
      if (closed) return
      es = new EventSource(url)
      es.onopen = () => {
        retry = 1000
        setStatus('open')
      }
      es.onmessage = ev => {
        try {
          handler.current(JSON.parse(ev.data) as GuardianEvent)
        } catch {
          /* ignore malformed frames */
        }
      }
      es.onerror = () => {
        es?.close()
        es = null
        if (closed) return
        setStatus('reconnecting')
        timer = window.setTimeout(open, retry)
        retry = Math.min(retry * 2, 15000)
      }
    }
    open()
    return () => {
      closed = true
      es?.close()
      if (timer != null) clearTimeout(timer)
    }
  }, [url])
  return status
}
