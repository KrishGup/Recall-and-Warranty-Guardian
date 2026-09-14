import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Dev proxy: the Guardian API (FastAPI, port 8787) serves /api/* and mounts the gren run
// dashboard API under /gren/api/*. `npm run dev` therefore expects `guardian serve` to be running.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new build waits until the user taps Reload (src/app/pwa/UpdatePrompt.tsx), so an open
      // SSE stream or a half-answered decision is never torn down under them.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Recall and Warranty Guardian',
        short_name: 'Guardian',
        description: 'A background agent that watches recalls and warranty windows for your household and only interrupts for real decisions.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        lang: 'en',
        theme_color: '#000F08',
        background_color: '#F7F4F3',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Decisions', url: '/decisions', description: 'Answer what is waiting for you' },
          { name: 'Inventory', url: '/inventory', description: 'What Guardian watches' },
          { name: 'Agent flow', url: '/flow', description: 'Every run of the nightly sweep' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        // Never answer these navigations from the shell cache: the API and the gren mount are not the SPA, and a
        // `?token=` visit must reach the server so it can set the auth cookie.
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/gren(\/|$)/, /[?&]token=/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/gren': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
})
