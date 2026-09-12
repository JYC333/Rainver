import { resolve } from 'node:path'
import type { PreRenderedChunk } from 'rollup'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Browser code calls same-origin /api/v1/*; in dev the Vite proxy forwards
// those requests to the server service inside the compose network. API_URL is
// only a local-shell override; compose does not inject a backend URL.
const apiProxyTarget = process.env.API_URL || 'http://server:8010'
const projectRoot = process.cwd()
const repoRoot = resolve(projectRoot, '../..')

const graphWebglPackages = [
  '/node_modules/@antv/g-webgl/',
  '/node_modules/@antv/g-plugin-device-renderer/',
  '/node_modules/@antv/g-device-api/',
  '/node_modules/@antv/g-shader-components/',
] as const

function chunkFileName(chunk: PreRenderedChunk): string {
  const moduleIds = chunk.moduleIds.map(id => id.replaceAll('\\', '/'))
  if (moduleIds.some(id => graphWebglPackages.some(packagePath => id.includes(packagePath)))) {
    return 'assets/graph-webgl-[hash].js'
  }
  if (moduleIds.some(id => (
    id.includes('/node_modules/@antv/')
    || id.includes('/src/components/graph/')
  ))) {
    return 'assets/graph-engine-[hash].js'
  }
  return 'assets/[name]-[hash].js'
}

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Stable prefixes let Workbox keep the optional graph engine out of
        // the application shell without changing Rollup's natural ownership
        // of shared dependencies.
        chunkFileNames: chunkFileName,
      },
    },
  },
  resolve: {
    alias: [
      // The shadcn CLI writes `@/…` imports into the components it copies, so
      // the alias exists for those. Everything hand-written here stays on
      // relative paths.
      { find: /^@\//, replacement: `${resolve(projectRoot, 'src')}/` },
      { find: /^react$/, replacement: resolve(projectRoot, 'node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(projectRoot, 'node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(projectRoot, 'node_modules/react/jsx-dev-runtime.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Rainver',
        short_name: 'Rainver',
        description: 'Agent-first memory system',
        theme_color: '#0f1117',
        background_color: '#0f1117',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // A full-page navigation to /api/... (the Google sign-in start and
        // callback are top-level redirects, not fetches) must reach the
        // server. Without this the SPA navigation fallback serves the cached
        // index.html for it, the app loads at that URL, sees a 401 from /me,
        // and bounces to /login without ever leaving the browser.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html}'],
        globIgnores: [
          '**/GraphView-*.js',
          '**/graph-engine-*.js',
          '**/graph-webgl-*.js',
        ],
        runtimeCaching: [
          // POST/PATCH/DELETE mutations must never be served from cache.
          // Some operations (quota PTY refresh, workspace console runs) take
          // 20-30 s; the timeout below would cause a null response and a
          // TypeError in the client — so use NetworkOnly for all writes.
          {
            urlPattern: ({ request }) => request.method !== 'GET',
            handler: 'NetworkOnly',
          },
          // Authenticated GET bodies must never land in Cache Storage: the
          // cache key is not per-user, and a later visitor (or an offline
          // reopen after logout) would otherwise read the previous session.
          {
            urlPattern: /^.*\/api\/v1\/.*/i,
            handler: 'NetworkOnly',
            options: { cacheName: 'api-cache' },
          },
          // Graph rendering is optional and large. Cache its chunks after the
          // first online visit instead of adding them to every PWA install.
          {
            urlPattern: /\/assets\/(?:GraphView|graph-engine|graph-webgl)-[^/]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'graph-runtime-v1',
              expiration: {
                maxEntries: 12,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,  // bind 0.0.0.0 so Docker port mapping works
    fs: {
      // Official plugin frontend sources live at repo-root/plugins/official/*.
      allow: [repoRoot],
    },
    proxy: {
      // `xfwd` appends the address this proxy saw to X-Forwarded-For. The
      // server trusts this container as its one proxy hop
      // (SERVER_TRUSTED_PROXY_HOST), so without it the client's own header
      // would reach the server as the client address.
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      // The trusted-host daemon uses the internal WebSocket endpoint directly
      // from the host machine during dev. Keep it on the same public dev
      // origin as the REST registration flow, and explicitly enable WS
      // upgrade forwarding.
      //
      // This one path, not all of `/internal`: production nginx forwards
      // `/api/` and this endpoint and nothing else, and a dev proxy that
      // forwarded the whole prefix meant a path only reachable in dev looked
      // like it worked everywhere. The Run tool surface moved under `/api/v1`
      // for exactly that reason.
      '/internal/hosts/ws': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
    },
    watch: {
      // polling needed in WSL2/Docker — inotify events don't propagate reliably
      usePolling: process.env.CHOKIDAR_USEPOLLING === 'true',
      interval: 300,
    },
  },
})
