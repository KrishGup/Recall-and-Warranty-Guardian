// Dashboard routes inside the shell. "/flow/trace" is matched before this by App.tsx and renders the trace view.
import { Navigate, Route, Routes } from 'react-router-dom'
import { Activity } from './pages/Activity'
import { Decisions } from './pages/Decisions'
import { Flow } from './pages/Flow'
import { Home } from './pages/Home'
import { Inventory } from './pages/Inventory'
import { Settings } from './pages/Settings'
import { AppShell } from './shell/AppShell'

export function AppShellRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/decisions" element={<Decisions />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/flow" element={<Flow />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
