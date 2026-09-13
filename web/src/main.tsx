import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './theme/global.css'
import { App } from './App'

async function boot() {
  if (import.meta.env.VITE_MOCK === '1') {
    // Demo mode without the Python API: the in-browser mock serves the design's seed data.
    const m = await import('./app/mock')
    m.install()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}

void boot()
