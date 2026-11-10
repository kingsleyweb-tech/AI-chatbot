import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { apiDevPlugin } from './dev/api-plugin.js';
import { sitePrerender } from './dev/site-prerender.js';
import pkg from './package.json' with { type: 'json' };

export default defineConfig(({ mode }) => {
  // Expose server-only env vars (no VITE_ prefix) to the dev API handlers.
  const all = loadEnv(mode, process.cwd(), '');
  for (const [k, v] of Object.entries(all)) if (!(k in process.env)) process.env[k] = v;

  return {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [
      react(),
      tailwindcss(),
      apiDevPlugin(),
      sitePrerender(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'offline.html'],
        manifest: {
          name: 'Atlas AI',
          short_name: 'Atlas AI',
          description: 'Think further. Do more. Your intelligent assistant for thinking, creating and discovering.',
          theme_color: '#0f766e',
          background_color: '#f5f1e8',
          display: 'standalone',
          orientation: 'any',
          categories: ['productivity', 'utilities'],
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          globIgnores: ['**/pdf.worker*', '**/hl-*', '**/wasm-*'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/__\//],
          runtimeCaching: [
            {
              // Hashed, immutable build assets that were not precached (grammars, pdf worker).
              urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
              handler: 'CacheFirst',
              options: { cacheName: 'assets', expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 60 } },
            },
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
            {
              urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com' || url.origin === 'https://fonts.googleapis.com',
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'fonts', expiration: { maxEntries: 20 } },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./server/shared', import.meta.url)),
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            // Syntax grammars/themes load on demand and are runtime-cached, not precached.
            const grammar = /@shikijs[\\/](langs|themes)[\\/]dist[\\/]([\w.-]+)\.m?js/.exec(id);
            if (grammar) return `hl-${grammar[1]}-${grammar[2]}`;
            if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/[\\/](firebase|@firebase)[\\/]/.test(id)) return 'firebase';
            if (/[\\/](katex|rehype-katex|remark-math|micromark-extension-math)[\\/]/.test(id)) return 'math';
            return undefined;
          },
        },
      },
    },
    server: { port: 5173 },
  };
});
