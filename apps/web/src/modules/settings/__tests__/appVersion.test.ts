import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLatestBuild, reloadLatestBuild } from '../appVersion'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('build verification', () => {
  it('reads a fresh manifest without HTTP cache', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'next', builtAt: 'today' }) })
    vi.stubGlobal('fetch', fetch)
    expect(await fetchLatestBuild()).toEqual({ id: 'next', builtAt: 'today' })
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/version.json\?check=/), expect.objectContaining({ cache: 'no-store' }))
  })
  it('rejects malformed manifests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 'x' }) }))
    await expect(fetchLatestBuild()).rejects.toThrow('Invalid build version')
  })
  it('waits for worker activation before reloading', async () => {
    const worker = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() })
    const update = vi.fn().mockResolvedValue(undefined)
    const reload = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update, installing: worker }) } })
    vi.stubGlobal('window', { location: { reload } })
    const pending = reloadLatestBuild()
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(reload).not.toHaveBeenCalled()
    worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'))
    await pending
    expect(reload).toHaveBeenCalledOnce()
  })
  it('does not reload after a failed worker check', async () => {
    const reload = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: async () => { throw new Error('offline') } }) } })
    vi.stubGlobal('window', { location: { reload } })
    await expect(reloadLatestBuild()).rejects.toThrow('offline')
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('content-free layout diagnostics', () => {
  it('reads actual DOM meta and removes all temporary probes', async () => {
    const { collectLayoutDiagnostics } = await import('../layoutDiagnostics')
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('CSS', { supports: () => true })
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes">'
    document.body.innerHTML = '<div id="root"><div class="app-safe-shell">private content</div></div>'
    const before = document.body.innerHTML
    const data = collectLayoutDiagnostics()
    expect(data.meta.viewport).toEqual(['width=device-width, viewport-fit=cover'])
    expect(data.meta.statusBarStyle).toEqual([])
    expect(data.meta.appleWebAppCapable).toEqual(['yes'])
    expect(data.viewportUnits).toHaveProperty('100svh')
    expect(document.body.innerHTML).toBe(before)
    expect(JSON.stringify(data)).not.toContain('private content')
    document.head.innerHTML = ''; document.body.innerHTML = ''
  })
  it('does not fetch a cross-origin manifest or retain manifest text', async () => {
    const { readManifestDisplay } = await import('../layoutDiagnostics')
    document.head.innerHTML = '<link rel="manifest" href="https://external.test/private.json">'
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(await readManifestDisplay()).toEqual({ status: 'cross-origin-skipped' })
    expect(fetch).not.toHaveBeenCalled()
    document.head.innerHTML = '<link rel="manifest" href="/manifest.webmanifest">'
    fetch.mockResolvedValue(new Response(JSON.stringify({ display: 'standalone', name: 'Private project', start_url: '/secret', display_override: ['browser', 'secret'] })))
    expect(await readManifestDisplay()).toEqual({ status: 'read', display: 'standalone', displayOverride: ['browser'] })
    document.head.innerHTML = ''
  })
})
