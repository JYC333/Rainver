import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissUpdateNotApplied, fetchLatestBuild, finishUpdateAfterReload, readCurrentBuild, readUpdateNotApplied, reloadLatestBuild, subscribeUpdateNotApplied } from '../appVersion'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
// A reload that the browser carries out: the page goes.
const leave = () => window.dispatchEvent(new Event('pagehide'))
// The page goes into the back/forward cache and later comes back.
const transition = (type: 'pagehide' | 'pageshow') => window.dispatchEvent(Object.assign(new Event(type), { persisted: true }))
function stubReload(onReload: () => void = () => {}) {
  const reload = vi.fn(onReload)
  vi.stubGlobal('location', { ...window.location, reload })
  return reload
}
describe('build verification', () => {
  it('reads the running build from its HTML, not from any JavaScript chunk', () => {
    const doc = new DOMParser().parseFromString(`<head><meta name="rainver-build-id" content="20261122T1-abc123"><meta name="rainver-build-at" content="2026-11-22T00:00:00.000Z"><meta name="rainver-build-inputs" content="${'b'.repeat(64)}"></head>`, 'text/html')
    expect(readCurrentBuild(doc)).toEqual({ id: '20261122T1-abc123', builtAt: '2026-11-22T00:00:00.000Z', inputsHash: 'b'.repeat(64) })
    expect(readCurrentBuild(new DOMParser().parseFromString('<head></head>', 'text/html'))).toEqual({ id: 'development', builtAt: '' })
  })
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
  it('waits for worker activation before reloading a page without unsaved input', async () => {
    const worker = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() })
    const update = vi.fn().mockResolvedValue(undefined)
    const reload = stubReload(leave)
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update, installing: worker }) } })
    void reloadLatestBuild()
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(reload).not.toHaveBeenCalled()
    worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'))
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })
  it('does not reload after a failed worker check', async () => {
    const reload = stubReload()
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: async () => { throw new Error('offline') } }) } })
    await expect(reloadLatestBuild()).rejects.toThrow('offline')
    expect(reload).not.toHaveBeenCalled()
  })

  describe('overlapping update requests', () => {
    afterEach(() => { sessionStorage.clear(); dismissUpdateNotApplied() })
    function activatingWorker(state = 'installing') {
      const worker = Object.assign(new EventTarget(), { state, postMessage: vi.fn() })
      const update = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update, installing: worker }) } })
      return { worker, update }
    }

    it('Settings, the error panel, the notice and the start-up continuation started together activate and reload once', async () => {
      const { worker, update } = activatingWorker()
      const reload = stubReload(leave)
      sessionStorage.setItem('rainver:update-after-reload', '1')
      const settled = vi.fn()
      for (const run of [reloadLatestBuild(), reloadLatestBuild(), reloadLatestBuild()]) void run.finally(settled)
      const continued = finishUpdateAfterReload()
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
      worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'))
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(update).toHaveBeenCalledOnce()
      expect(reload).toHaveBeenCalledOnce()
      expect(settled).not.toHaveBeenCalled()
      await expect(continued).resolves.toBe('reloaded')
    })

    it('a failure reaches every overlapping caller once and releases the action for a retry', async () => {
      const update = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update }) } })
      const reload = stubReload(leave)
      const outcomes = [reloadLatestBuild(), reloadLatestBuild()]
      for (const outcome of outcomes) await expect(outcome).rejects.toThrow('offline')
      expect(update).toHaveBeenCalledOnce()
      expect(reload).not.toHaveBeenCalled()
      void reloadLatestBuild()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      expect(update).toHaveBeenCalledTimes(2)
    })

    it('staying at the prompt resolves every overlapping caller and releases the action for a retry', async () => {
      vi.useFakeTimers()
      const guard = (event: Event) => event.preventDefault()
      window.addEventListener('beforeunload', guard)
      try {
        const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() })
        const update = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update, waiting: worker }) } })
        const reload = stubReload(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
        const outcomes = [reloadLatestBuild(), reloadLatestBuild()]
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
        await vi.advanceTimersByTimeAsync(2000)
        await expect(Promise.all(outcomes)).resolves.toEqual(['kept', 'kept'])
        expect(update).toHaveBeenCalledOnce()
        const again = reloadLatestBuild()
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
        await vi.advanceTimersByTimeAsync(2000)
        await expect(again).resolves.toBe('kept')
        expect(worker.postMessage).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener('beforeunload', guard)
        vi.useRealTimers()
      }
    })

    it('a request during a start-up activation that fails joins it, then a later request retries', async () => {
      vi.useFakeTimers()
      try {
        const { worker, update } = activatingWorker('installed')
        const reload = stubReload(leave)
        sessionStorage.setItem('rainver:update-after-reload', '1')
        const finished = finishUpdateAfterReload()
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
        const joined = reloadLatestBuild()
        worker.state = 'redundant'; worker.dispatchEvent(new Event('statechange'))
        await expect(finished).resolves.toBe('failed')
        await expect(joined).rejects.toThrow('Update failed')
        expect(readUpdateNotApplied()).toBe(true)
        expect(update).toHaveBeenCalledOnce()
        expect(reload).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(reload).not.toHaveBeenCalled()

        const retried = { worker: Object.assign(new EventTarget(), { state: 'activated', postMessage: vi.fn() }), update: vi.fn().mockResolvedValue(undefined) }
        vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: retried.update, waiting: retried.worker }) } })
        void reloadLatestBuild()
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
        expect(retried.update).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })
    it.each([
      ['no mark', false, async () => undefined],
      ['no registration', true, async () => undefined],
      ['no waiting worker', true, async () => ({ update: vi.fn() })],
    ])('a start-up continuation with %s does nothing, and requests that waited for it run one explicit update', async (_case, marked, startRegistration) => {
      if (marked) sessionStorage.setItem('rainver:update-after-reload', '1')
      const explicit = { update: vi.fn().mockResolvedValue(undefined) }
      let started = !marked
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => started ? Promise.resolve(explicit) : (started = true, startRegistration()) } })
      const reload = stubReload(leave)
      const finished = finishUpdateAfterReload()
      const settled = vi.fn()
      void reloadLatestBuild().finally(settled); void reloadLatestBuild().finally(settled)
      await expect(finished).resolves.toBe('nothing')
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(explicit.update).toHaveBeenCalledOnce()
      expect(reload).toHaveBeenCalledOnce()
      expect(settled).not.toHaveBeenCalled()
    })

    it('a start-up continuation reports a reload it started', async () => {
      const { worker } = activatingWorker('activated')
      const reload = stubReload(leave)
      sessionStorage.setItem('rainver:update-after-reload', '1')
      await expect(finishUpdateAfterReload()).resolves.toBe('reloaded')
      expect(reload).toHaveBeenCalledOnce()
      expect(worker.postMessage).not.toHaveBeenCalled()
    })

    it.each(['network check', 'activation'])('a page hidden into the back/forward cache during the %s keeps the run in flight', async phase => {
      let checked!: () => void
      const update = vi.fn(() => phase === 'network check' ? new Promise<void>(resolve => { checked = resolve }) : Promise.resolve())
      const worker = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() })
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update, installing: worker }) } })
      const reload = stubReload(leave)
      void reloadLatestBuild()
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
      transition('pagehide'); transition('pageshow')
      void reloadLatestBuild()
      await new Promise(resolve => setTimeout(resolve, 10))
      if (phase === 'network check') checked()
      worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'))
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(update).toHaveBeenCalledOnce()
      expect(reload).toHaveBeenCalledOnce()
    })

    it('a reload superseded by leaving into the back/forward cache is cancelled when the page comes back, and can be retried', async () => {
      const update = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update }) } })
      const reload = stubReload(() => transition('pagehide'))
      const outcomes = [reloadLatestBuild(), reloadLatestBuild()]
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      void reloadLatestBuild()
      transition('pageshow')
      await expect(Promise.all(outcomes)).resolves.toEqual(['kept', 'kept'])
      expect(update).toHaveBeenCalledOnce()
      void reloadLatestBuild()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
      transition('pageshow')
    })
  })

  describe('with unsaved input on the page', () => {
    const guard = (event: Event) => event.preventDefault()
    beforeEach(() => { sessionStorage.clear(); window.addEventListener('beforeunload', guard) })
    afterEach(() => { window.removeEventListener('beforeunload', guard); vi.useRealTimers() })
    function waitingWorker() {
      const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() })
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: async () => {}, waiting: worker }) } })
      return worker
    }

    it('reloads before activating; staying at the prompt activates nothing and can be retried', async () => {
      vi.useFakeTimers()
      const worker = waitingWorker()
      const reload = stubReload(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
      const outcome = reloadLatestBuild()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      expect(sessionStorage.getItem('rainver:update-after-reload')).toBe('1')
      await vi.advanceTimersByTimeAsync(2000)
      await expect(outcome).resolves.toBe('kept')
      expect(worker.postMessage).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('rainver:update-after-reload')).toBeNull()
      const again = reloadLatestBuild()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(2000)
      await expect(again).resolves.toBe('kept')
      expect(worker.postMessage).not.toHaveBeenCalled()
    })

    it('leaving the page lets the fresh document activate the update, then reload once', async () => {
      vi.useFakeTimers()
      const worker = waitingWorker()
      const reload = stubReload(() => {
        window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
        window.dispatchEvent(new Event('pagehide'))
      })
      let settled = false
      void reloadLatestBuild().finally(() => { settled = true })
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(15_000)
      expect(settled).toBe(false)
      expect(worker.postMessage).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('rainver:update-after-reload')).toBe('1')

      // The reloaded document starts without the guard.
      window.removeEventListener('beforeunload', guard)
      worker.postMessage.mockImplementation(() => { worker.state = 'activated'; worker.dispatchEvent(new Event('statechange')) })
      void finishUpdateAfterReload()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
      expect(sessionStorage.getItem('rainver:update-after-reload')).toBeNull()
      await finishUpdateAfterReload()
      expect(reload).toHaveBeenCalledTimes(2)
    })

    it('finishes the requested update offline from the worker that already installed', async () => {
      window.removeEventListener('beforeunload', guard)
      const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn(() => { worker.state = 'activated'; worker.dispatchEvent(new Event('statechange')) }) })
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: async () => { throw new TypeError('Failed to fetch') }, waiting: worker }) } })
      const reload = stubReload(leave)
      sessionStorage.setItem('rainver:update-after-reload', '1')
      void finishUpdateAfterReload()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    })

    it.each([
      ['times out', (worker: EventTarget & { state: string }) => { void worker }, 20_000],
      ['becomes redundant', (worker: EventTarget & { state: string }) => { worker.state = 'redundant'; worker.dispatchEvent(new Event('statechange')) }, 0],
    ])('when the requested activation %s, it stays on this build, says so and never reloads by itself', async (_case, settle, wait) => {
      vi.useFakeTimers()
      window.removeEventListener('beforeunload', guard)
      const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() })
      worker.postMessage.mockImplementation(() => settle(worker))
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ update: async () => {}, waiting: worker }) } })
      const reload = stubReload()
      const changed = vi.fn()
      const unsubscribe = subscribeUpdateNotApplied(changed)
      sessionStorage.setItem('rainver:update-after-reload', '1')
      const finished = finishUpdateAfterReload()
      await vi.advanceTimersByTimeAsync(wait)
      await finished
      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
      expect(readUpdateNotApplied()).toBe(true)
      expect(changed).toHaveBeenCalledOnce()
      expect(sessionStorage.getItem('rainver:update-after-reload')).toBeNull()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reload).not.toHaveBeenCalled()
      // A later start without the mark neither retries nor clears the notice.
      await finishUpdateAfterReload()
      expect(reload).not.toHaveBeenCalled()
      dismissUpdateNotApplied()
      expect(readUpdateNotApplied()).toBe(false)
      unsubscribe()
    })
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
