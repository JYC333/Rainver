import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { BUILD_INPUTS_FILE, collectBuildInputs } from './buildInputs.ts'
import { bundledPluginAliases } from './bundledPluginDeps.ts'

// Browser code calls same-origin /api/v1/*; in dev the Vite proxy forwards
// those requests to the server service inside the compose network. API_URL is
// only a local-shell override; compose does not inject a backend URL.
const apiProxyTarget = process.env.API_URL || 'http://server:8010'
const appBuild = { id: `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 6)}`, builtAt: new Date().toISOString() }
const projectRoot = process.cwd()
const repoRoot = resolve(projectRoot, '../..')

function pwaPlugins(): PluginOption[] {
  const shellFiles = new Set(['index.html'])
  return [
    {
      name: 'rainver-pwa-shell',
      apply: 'build',
      generateBundle: { order: 'post', handler(_options, bundle) {
        const entry = Object.values(bundle).find(file => file.type === 'chunk' && file.isEntry && file.name === 'app')
        if (!entry) this.error('The PWA main entry is missing from the build output')

        const pending = [entry.fileName]
        for (const name of pending) {
          if (shellFiles.has(name)) continue
          const chunk = bundle[name]
          if (chunk?.type !== 'chunk') continue
          shellFiles.add(name)
          // Rollup's static imports and Vite's generated CSS/assets reach the
          // browser at boot. Dynamic imports wait for their feature to open.
          pending.push(...chunk.imports)
          for (const asset of chunk.viteMetadata?.importedCss ?? []) shellFiles.add(asset)
          for (const asset of chunk.viteMetadata?.importedAssets ?? []) {
            // Other Inter subsets are selected by CSS unicode-range as needed.
            // The offline shell can fall back to system fonts for those glyphs.
            if (/^assets\/inter-(?!latin-wght-normal-).*\.woff2$/.test(asset)) continue
            shellFiles.add(asset)
          }
        }
      } },
    },
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['theme.js', 'icons/*.png', 'icons/*.svg'],
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
        // A waiting worker must leave the current tab's drafts and recordings
        // intact. Settings explicitly asks it to activate before reloading.
        // A full-page navigation to /api/... (the Google sign-in start and
        // callback are top-level redirects, not fetches) must reach the
        // server. Do not fall through to the SPA fallback. It serves the cached
        // index.html for it, the app loads at that URL, sees a 401 from /me,
        // and bounces to /login without ever leaving the browser.
        navigateFallbackDenylist: [/^\/api\//, /^\/version\.json$/, /^\/viewport-test(?:\/|$)/],
        globPatterns: ['index.html', 'assets/**/*'],
        manifestTransforms: [(entries) => {
          const manifest = entries.filter(entry => shellFiles.has(entry.url))
          const included = new Set(manifest.map(entry => entry.url))
          const missing = [...shellFiles].filter(file => !included.has(file))
          if (missing.length) throw new Error(`Missing PWA shell assets: ${missing.join(', ')}`)
          return { manifest, warnings: [] }
        }],
        runtimeCaching: [
          { urlPattern: /\/version\.json(?:\?|$)/, handler: 'NetworkOnly' },
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
          // Cache immutable Vite assets on first use, including lazy feature
          // JavaScript, CSS and fonts. Only same-origin hashed files qualify.
          {
            urlPattern: ({ sameOrigin, url }) => sameOrigin && !url.search
              && /^\/assets\/[^/]+-[\w-]{8}\.(?:js|css|woff2?)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'hashed-static-v1',
              cacheableResponse: { statuses: [200] },
              expiration: {
                maxEntries: 120,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
    }),
  ]
}

export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      input: { app: resolve(projectRoot, 'index.html'), viewportTest: resolve(projectRoot, 'viewport-test/index.html') },
    },
  },
  resolve: {
    alias: [
      ...(mode === 'plugin-acceptance' ? [{
        find: /^\.\/acceptanceCatalog$/,
        replacement: resolve(projectRoot, 'src/__tests__/pluginAcceptanceCatalog.fixture.ts'),
      }] : []),
      // The shadcn CLI writes `@/…` imports into the components it copies.
      // Those imports resolve through this alias. Everything hand-written here stays on
      // relative paths.
      { find: /^@\//, replacement: `${resolve(projectRoot, 'src')}/` },
      ...bundledPluginAliases(projectRoot),
      { find: /^react$/, replacement: resolve(projectRoot, 'node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(projectRoot, 'node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(projectRoot, 'node_modules/react/jsx-dev-runtime.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  plugins: [
    {
      name: 'rainver-plugin-fixture-boundary',
      apply: 'build',
      moduleParsed(info) {
        if (mode !== 'plugin-acceptance' && /\/(?:server\/test|src\/__tests__)\//.test(info.id.replaceAll('\\', '/'))) {
          this.error('Normal web builds must not parse test fixture modules');
        }
      },
      generateBundle() {
        const fixtures = [...this.getModuleIds()].filter(id => /plugin(?:AcceptanceCatalog|OperationViews)\.fixture|server\/test\/fixtures\/pluginOperation\/manifest/.test(id));
        console.info(`Plugin fixture build boundary (${mode}): ${fixtures.length} modules`);
      },
    },
    {
      name: 'rainver-build-version',
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(appBuild) }) },
      // The build identity lives only in the uncached HTML and version.json
      // (appVersion.ts reads these tags). Inlined into JavaScript, it changed
      // one chunk on every build and, through import names, renamed most
      // hashed assets even when no source had changed.
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { name: 'rainver-build-id', content: appBuild.id }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'rainver-build-at', content: appBuild.builtAt }, injectTo: 'head' },
      ],
      configureServer(server) {
        server.middlewares.use('/version.json', (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(appBuild))
        })
      },
    },
    {
      // Lets a server browser case refuse a dist that no longer matches the
      // checkout (server/test/support/webDist.ts); see buildInputs.ts.
      name: 'rainver-build-inputs',
      apply: 'build',
      generateBundle: { order: 'post', handler(_options, bundle) {
        const inputs = collectBuildInputs(repoRoot, projectRoot, this.getModuleIds())
        const source = JSON.stringify(inputs)
        const inputsHash = createHash('sha256').update(source).digest('hex')
        for (const [name, html] of Object.entries(bundle)) {
          if (name.endsWith('.html') && html.type === 'asset' && typeof html.source === 'string') {
            if (name === 'viewport-test/index.html') {
              html.source = html.source.replace(/<link\b[^>]*rel="manifest"[^>]*>/g, '')
                .replace('</head>', '<link rel="manifest" href="/viewport-test/manifest.webmanifest" /></head>')
            }
            html.source = html.source.replace('</head>', `<meta name="rainver-build-inputs" content="${inputsHash}" /></head>`)
          }
        }
        const version = bundle['version.json']
        if (version?.type === 'asset') version.source = JSON.stringify({ ...appBuild, inputsHash })
        this.emitFile({ type: 'asset', fileName: BUILD_INPUTS_FILE, source })
      } },
    },
    react(),
    tailwindcss(),
    ...pwaPlugins(),
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
      // This one path, not all of `/internal`. Production nginx forwards
      // `/api/` and this endpoint and nothing else. Do not forward the whole
      // prefix. A path only reachable in dev would look like it works
      // everywhere. The Run tool surface is under `/api/v1`.
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
}))
