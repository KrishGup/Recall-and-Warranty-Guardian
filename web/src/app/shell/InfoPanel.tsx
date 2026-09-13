// Contextual help (Cloudscape "help panel"): page-specific copy from helpMap, resizable 240–560 on desktop
// (handle on the inline-start edge, keyboard ± 24 px), a full-screen sheet on mobile.
import { useCallback, useState } from 'react'
import { readNumber, writeNumber } from '../../theme/prefs'
import { clamp } from '../format'
import { helpMap } from './helpMap'
import { useShell, type PageId } from './ShellContext'
import { useResize } from './useResize'

const KEY = 'guardian.helpW'

export function InfoPanel({ page, onClose }: { page: PageId; onClose: () => void }) {
  const { narrow, rtl } = useShell()
  const [w, setW] = useState(() => clamp(readNumber(KEY, 320), 240, 560))
  const set = useCallback((v: number) => {
    setW(v)
    writeNumber(KEY, v)
  }, [])
  const resize = useResize({ value: w, min: 240, max: 560, set, axis: 'x', sign: rtl ? 1 : -1, growKey: rtl ? 'ArrowRight' : 'ArrowLeft', shrinkKey: rtl ? 'ArrowLeft' : 'ArrowRight' })
  const help = helpMap[page]
  return (
    <aside aria-label="Info" className="g-help" style={narrow ? undefined : { width: w }}>
      <div role="separator" aria-label="Resize info panel" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={560} aria-valuenow={w} tabIndex={0} className="g-sep g-help__sep" {...resize}>
        <span aria-hidden="true" className="g-sep__grip" />
      </div>
      <div className="g-help__inner">
        <div className="g-help__head">
          <h2 className="g-help__title">{help.title}</h2>
          <button type="button" className="g-btn g-btn--icon" onClick={onClose} aria-label="Close info panel">
            ×
          </button>
        </div>
        <div className="g-help__body">
          <p style={{ margin: 0 }}>{help.body}</p>
          {help.points.map(p => (
            <div key={p.k} className="g-help__pt">
              <div className="g-help__k">{p.k}</div>
              <div className="g-help__v">{p.v}</div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
