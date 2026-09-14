import { Route, Routes } from 'react-router-dom'
import { AppShellRoutes } from './app/routes'
import { PwaStatus } from './app/pwa/PwaStatus'
import { TraceView } from './trace/TraceView'

/** Two surfaces: the dashboard shell (side nav, pages, panels) and the full-screen Agent flow trace view. */
export function App() {
  return (
    <>
      <PwaStatus />
      <Routes>
        <Route path="/flow/trace" element={<TraceView />} />
        <Route path="/*" element={<AppShellRoutes />} />
      </Routes>
    </>
  )
}
