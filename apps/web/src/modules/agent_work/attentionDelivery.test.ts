import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionDelivery } from './attentionDelivery'
const records: unknown[] = []
class Channel {
  static all = new Set<Channel>(); onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(public name: string) { Channel.all.add(this) }
  postMessage(data: unknown) { records.push(data); for (const other of Channel.all) if (other !== this && other.name === this.name) other.onmessage?.({ data }) }
  close() { Channel.all.delete(this) }
}
let queues: Map<string, Array<{ signal?: AbortSignal; callback: () => Promise<void>; resolve: () => void }>>
function installLocks() {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) => new Promise<void>(resolve => {
    const queue = queues.get(name) ?? []; queues.set(name, queue); queue.push({ signal: options.signal, callback, resolve })
    const run = () => { const next = queue[0]; if (!next) return; if (next.signal?.aborted) { queue.shift(); next.resolve(); run(); return }
      void next.callback().then(() => { queue.shift(); next.resolve(); run() }) }
    if (queue.length === 1) run()
  }) } })
}
const notice = { key: 'exact-revision', kind: 'finished' as const, work_key: 'opaque-work' }
beforeEach(() => { records.length = 0; queues = new Map(); installLocks(); vi.stubGlobal('BroadcastChannel', Channel) })
afterEach(() => { Channel.all.clear(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('per-user browser alert delivery', () => {
  it('elects one sender, shares delivered identities, and hands ownership to the queued tab on exit', async () => {
    const first = new AttentionDelivery('user', vi.fn()), second = new AttentionDelivery('user', vi.fn())
    expect(first.leader).toBe(true); expect(second.leader).toBe(false)
    expect(first.acceptExternal(notice)).toBe(true); expect(second.acceptExternal(notice)).toBe(false)
    first.close(); await Promise.resolve(); await Promise.resolve()
    expect(second.leader).toBe(true); expect(second.acceptExternal(notice)).toBe(false)
    expect(second.acceptExternal({ ...notice, key: 'new-revision' })).toBe(true)
    second.close()
    expect(records.some(record => JSON.stringify(record).includes('finished'))).toBe(false)
  })
  it('shares and keeps the alert choice per user, never as content', () => {
    localStorage.clear()
    const first = new AttentionDelivery('user', vi.fn()), changed = vi.fn(), second = new AttentionDelivery('user', changed)
    first.setPreferences({ sound: true, desktop: false })
    expect(second.preferences).toEqual({ sound: true, desktop: false }); expect(changed).toHaveBeenCalled()
    first.close(); second.close()
    expect(new AttentionDelivery('user', vi.fn()).preferences).toEqual({ sound: true, desktop: false })
    expect(new AttentionDelivery('other-user', vi.fn()).preferences).toEqual({ sound: false, desktop: false })
    expect(records).toEqual([{ type: 'preferences', sound: true, desktop: false }])
    localStorage.clear()
  })
  it('ignores legacy active-view hints and isolates different users', () => {
    const first = new AttentionDelivery('user', vi.fn()), viewer = new AttentionDelivery('user', vi.fn())
    for (const channel of Channel.all) channel.onmessage?.({ data: { type: 'active', tab: 'other-tab', keys: ['opaque-work'] } })
    expect(first.acceptExternal(notice)).toBe(true); expect(first.acceptToast(notice)).toBe(true)
    const other = new AttentionDelivery('other-user', vi.fn())
    expect(other.leader).toBe(true); expect(other.acceptExternal(notice)).toBe(true)
    first.close(); viewer.close(); other.close()
  })
  it('degrades without Web Locks or BroadcastChannel and never broadcasts content', () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const local = new AttentionDelivery('user', vi.fn())
    expect(local.supported).toBe(false); expect(local.acceptExternal(notice)).toBe(false); expect(local.acceptToast(notice)).toBe(true); local.close()
    installLocks(); vi.stubGlobal('BroadcastChannel', undefined)
    const missingChannel = new AttentionDelivery('user', vi.fn())
    expect(missingChannel.supported).toBe(false); missingChannel.close()
    expect(records).toEqual([])
  })
  it('degrades safely when the browser rejects channel creation', () => {
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('unavailable') } })
    const local = new AttentionDelivery('user', vi.fn())
    expect(local.supported).toBe(false); expect(local.acceptExternal(notice)).toBe(false); expect(local.acceptToast(notice)).toBe(true); local.close()
  })

  it('removes a hidden tab’s pending toast when a visible follower shows the revision', () => {
    const visibility = vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    const first = new AttentionDelivery('user',vi.fn()), follower = new AttentionDelivery('user',vi.fn())
    expect(first.leader).toBe(true); expect(follower.leader).toBe(false)
    expect(first.acceptToast(notice)).toBe(false); expect(first.seen.has(notice.key)).toBe(false)
    expect(records).toEqual([])
    visibility.mockReturnValue('visible')
    expect(follower.acceptToast(notice)).toBe(true); follower.toasted(notice.key)
    expect(follower.acceptToast(notice)).toBe(false)
    expect(first.flushToasts()).toEqual([])
    expect(records).toContainEqual({ type: 'toasted', key: notice.key })
    first.close(); follower.close()
  })
  it('does not let an external delivery identity consume a visible tab’s toast', () => {
    const first = new AttentionDelivery('user',vi.fn()), follower = new AttentionDelivery('user',vi.fn())
    expect(first.acceptExternal(notice)).toBe(true)
    expect(follower.acceptToast(notice)).toBe(true); expect(follower.acceptToast(notice)).toBe(false)
    expect(follower.acceptExternal(notice)).toBe(false)
    first.close(); follower.close()
  })

  it('suppresses a second visible tab after the first broadcasts its shown identity, isolating other accounts', () => {
    const first=new AttentionDelivery('user',vi.fn()), second=new AttentionDelivery('user',vi.fn())
    const other=new AttentionDelivery('other',vi.fn())
    expect(first.acceptToast(notice)).toBe(true); first.toasted(notice.key)
    expect(second.acceptToast(notice)).toBe(false); expect(other.acceptToast(notice)).toBe(true)
    const shown=records.filter(value=>(value as {type:string}).type==='toasted')
    expect(shown).toEqual([{type:'toasted',key:notice.key}])
    first.close(); second.close(); other.close()
  })
  it('keeps single-tab deduplication when BroadcastChannel is absent', () => {
    vi.stubGlobal('BroadcastChannel',undefined)
    const first=new AttentionDelivery('user',vi.fn()), second=new AttentionDelivery('user',vi.fn())
    expect(first.supported).toBe(false)
    expect(first.acceptToast(notice)).toBe(true); first.toasted(notice.key)
    expect(first.acceptToast(notice)).toBe(false)
    expect(second.acceptToast(notice)).toBe(true) // Explicit local-only degradation.
    expect(records).toEqual([]); first.close(); second.close()
  })

  it('keeps an enabled background desktop delivery separate from the pending foreground toast', () => {
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    const tab=new AttentionDelivery('user',vi.fn())
    expect(tab.acceptToast(notice)).toBe(false); expect(tab.acceptExternal(notice)).toBe(true)
    visibility.mockReturnValue('visible')
    expect(tab.flushToasts()).toEqual([notice]); tab.toasted(notice.key)
    expect(tab.flushToasts()).toEqual([]); expect(tab.acceptExternal(notice)).toBe(false)
    tab.close()
  })

})
