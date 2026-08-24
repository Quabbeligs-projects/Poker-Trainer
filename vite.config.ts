import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * GitHub Pages serves a project site from `/<repo>/`, so assets and the service
 * worker scope must be prefixed. Overridable with VITE_BASE for a custom domain
 * (where it would be `/`).
 */
const base = process.env.VITE_BASE ?? '/Poker-Trainer/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Poker Equity Trainer',
        short_name: 'Equity',
        description: 'Offline Texas Hold\'em equity, pot odds and action trainer.',
        theme_color: '#0F1A18',
        background_color: '#0F1A18',
        display: 'standalone',
        orientation: 'portrait',
        scope: base,
        start_url: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache every build asset so the app runs with no network at all
        // after a single load. The engine data files are small and must be
        // present offline, so they are precached rather than fetched lazily.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,json}'],
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
