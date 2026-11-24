// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { UserConfig, UserConfigExport } from 'vite'
import type { VitePWAOptions } from 'vite-plugin-pwa'

// Record the options the real config hands the PWA plugin; the plugin itself
// still runs unchanged.
const pwa = vi.hoisted(() => ({ options: [] as Partial<VitePWAOptions>[] }))
vi.mock('vite-plugin-pwa', async importOriginal => {
  const actual = await importOriginal<typeof import('vite-plugin-pwa')>()
  return {
    ...actual,
    VitePWA: (options: Partial<VitePWAOptions>) => {
      pwa.options.push(options)
      return actual.VitePWA(options)
    },
  }
})

type RuntimeCaching = NonNullable<NonNullable<VitePWAOptions['workbox']>['runtimeCaching']>[number]

async function devConfig(): Promise<{ config: UserConfig; workbox: NonNullable<VitePWAOptions['workbox']> }> {
  pwa.options.length = 0
  // A non-literal specifier keeps the Node-side config out of the browser tsconfig program.
  const configPath: string = '../../vite.config.ts'
  const { default: configFn } = await import(/* @vite-ignore */ configPath) as { default: UserConfigExport }
  if (typeof configFn !== 'function') throw new Error('vite.config.ts must export a config function')
  const config = await configFn({ command: 'serve', mode: 'development' })
  expect(pwa.options).toHaveLength(1)
  const workbox = pwa.options[0]!.workbox
  if (!workbox) throw new Error('PWA config has no workbox options')
  return { config, workbox }
}

// Workbox route matching: a RegExp is tested against the full URL; a function
// receives the request context.
function routeMatches(entry: RuntimeCaching, href: string, method: string): boolean {
  const url = new URL(href)
  const pattern = entry.urlPattern
  if (pattern instanceof RegExp) return pattern.test(url.href)
  if (typeof pattern === 'string') return url.href === new URL(pattern, url).href
  return Boolean(pattern({
    url,
    request: new Request(url, { method }),
    sameOrigin: url.origin === origin,
    event: {} as never,
  }))
}

// Vite dev proxy matching: `^`-prefixed keys are regexes, others are prefixes.
function proxyKeysFor(proxy: Record<string, unknown>, path: string): string[] {
  return Object.keys(proxy).filter(key => key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key))
}

const origin = 'https://rainver.example'
const apiRequests: Array<[string, string]> = [
  ['GET', '/api/v1/me'],
  ['GET', '/api/v1/sources/gmail/messages/abc?format=full'],
  ['POST', '/api/v1/rooms/r1/messages'],
  ['DELETE', '/api/v1/memories/m1'],
]

describe('web API entrypoint', () => {
  it('proxies only the trusted-host WebSocket under /internal through the dev origin', async () => {
    // Production nginx forwards `/api/` and this one endpoint and nothing else,
    // so a Run tool surface under `/internal/runs/...` must not work in dev only.
    const { config } = await devConfig()
    const proxy = (config.server?.proxy ?? {}) as Record<string, { target?: unknown; ws?: boolean }>
    expect(proxyKeysFor(proxy, '/internal/hosts/ws')).toEqual(['/internal/hosts/ws'])
    expect(proxy['/internal/hosts/ws']).toMatchObject({ ws: true, target: proxy['/api']?.target })
    expect(proxyKeysFor(proxy, '/internal/runs/run-1/tools')).toEqual([])
    expect(proxyKeysFor(proxy, '/internal/hosts/register')).toEqual([])
  })

  it('serves every /api/v1/ request (Gmail mail included) NetworkOnly so no reply enters Cache Storage', async () => {
    const { workbox } = await devConfig()
    const routes = workbox.runtimeCaching ?? []
    for (const [method, path] of apiRequests) {
      const matching = routes.filter(entry => routeMatches(entry, origin + path, method))
      expect(matching.length, `${method} ${path} has a route`).toBeGreaterThan(0)
      // Workbox uses the first matching route; any later match must not cache either.
      expect(matching.map(entry => entry.handler), `${method} ${path}`).toEqual(matching.map(() => 'NetworkOnly'))
    }
  })

  it('lets full-page navigations to /api/ (the OAuth callback) reach the server', async () => {
    const { workbox } = await devConfig()
    const denylist = workbox.navigateFallbackDenylist ?? []
    expect(denylist.some(pattern => pattern.test('/api/v1/auth/google/callback'))).toBe(true)
    expect(denylist.some(pattern => pattern.test('/rooms/r1'))).toBe(false)
  })

  it('runtime-caches only same-origin immutable asset paths', async () => {
    const { workbox } = await devConfig()
    const assetRoute = workbox.runtimeCaching?.find(route => route.handler === 'CacheFirst')
    expect(assetRoute).toBeDefined()
    for (const path of ['/assets/editor-BY_abcDE.js', '/assets/editor-BY_abcDE.css', '/assets/inter-BY_abcDE.woff2']) {
      expect(routeMatches(assetRoute!, origin + path, 'GET')).toBe(true)
    }
    for (const href of [
      `${origin}/assets/editor.js`, `${origin}/assets/editor-BY_abcDE.js?preview=1`,
      `${origin}/api/v1/assets/editor-BY_abcDE.js`, 'https://peer.example/assets/editor-BY_abcDE.js',
    ]) {
      expect(routeMatches(assetRoute!, href, 'GET')).toBe(false)
    }
  })
})
