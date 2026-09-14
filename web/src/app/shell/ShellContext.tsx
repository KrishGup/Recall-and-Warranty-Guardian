// Shared shell state: theme/direction, layout mode, the summary and decisions the shell keeps fresh over SSE,
// the toast, the item-detail split panel and the info panel. Pages read it with useShell().
import { createContext, useContext } from 'react'
import type { Decisions, Summary } from '../../api/types'
import type { Dir } from '../../theme/prefs'
import type { Theme } from '../../theme/tokens'

export type PageId = 'home' | 'decisions' | 'inventory' | 'activity' | 'settings' | 'flow'

export interface Shell {
  page: PageId
  theme: Theme
  dark: boolean
  dir: Dir
  rtl: boolean
  narrow: boolean
  toggleScheme: () => void
  toggleDir: () => void
  summary: Summary | null
  summaryError: string | null
  refreshSummary: () => void
  decisions: Decisions | null
  decisionsError: string | null
  refreshDecisions: () => void
  /** Bumps when Guardian data changed (SSE or a local mutation); pages refetch on it. */
  dataVersion: number
  /** Call after a mutation the SSE stream won't itself report (e.g. deleting an item from the split panel) to make every page relying on dataVersion refetch immediately. */
  bumpData: () => void
  /** Bumps on gren engine events; the Agent flow page refetches the run on it. */
  runVersion: number
  toast: (message: string) => void
  selectedItemId: string | null
  openItem: (id: string) => void
  closeItem: () => void
  helpOpen: boolean
  toggleHelp: () => void
  address: string
  copyAddress: () => void
  runSweep: () => void
}

export const ShellContext = createContext<Shell | null>(null)

export function useShell(): Shell {
  const s = useContext(ShellContext)
  if (!s) throw new Error('useShell must be used inside AppShell')
  return s
}
