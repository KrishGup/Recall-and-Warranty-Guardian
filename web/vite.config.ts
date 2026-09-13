import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy: the Guardian API (FastAPI, port 8787) serves /api/* and mounts the gren run
// dashboard API under /gren/api/*. `npm run dev` therefore expects `guardian serve` to be running.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/gren': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
})
