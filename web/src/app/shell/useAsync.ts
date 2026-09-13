// Fetch-as-state with stale-while-revalidate: the first load shows `loading`, later reloads keep the old data and
// set `refreshing`. Results that arrive out of order are dropped.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { errMsg } from '../format'

export interface Async<T> {
  data: T | null
  error: string | null
  loading: boolean
  refreshing: boolean
  reload: () => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const fnRef = useRef(fn)
  useLayoutEffect(() => {
    fnRef.current = fn
  })
  const [tick, setTick] = useState(0)
  const [st, setSt] = useState<{ data: T | null; error: string | null; loading: boolean; refreshing: boolean }>({ data: null, error: null, loading: true, refreshing: false })
  const seq = useRef(0)
  useEffect(() => {
    const my = ++seq.current
    setSt(s => (s.data === null ? { ...s, loading: true, error: null } : { ...s, refreshing: true }))
    fnRef.current().then(
      data => {
        if (my === seq.current) setSt({ data, error: null, loading: false, refreshing: false })
      },
      (e: unknown) => {
        if (my === seq.current) setSt(s => ({ data: s.data, error: errMsg(e), loading: false, refreshing: false }))
      },
    )
    // deps are provided by the caller; fn is read through a ref so it does not need to be stable
  }, [...deps, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setTick(t => t + 1), [])
  return { ...st, reload }
}
