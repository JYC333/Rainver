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
