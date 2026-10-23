import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttentionStreamFrame } from '@rainver/protocol'
import { agentAttentionApi } from '../../api/client'
import { toast } from 'sonner'
import { AgentAttentionProvider, RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay, useAttentionState, useAttentionViewing } from './AgentAttentionProvider'
import { AttentionControls, AttentionBadge } from './AttentionIndicators'
import { useAgentWorkList } from './useAgentWorkList'
import { AttentionStore, FILTER_REFRESH_MS, PERSONAL_QUERY } from './attentionStore'
import { AttentionDelivery } from './attentionDelivery'
import { deferred, page, work } from './fixtures.test-support'
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('../../api/client', async original => ({ ...await original<typeof import('../../api/client')>(), agentAttentionApi: { stream: vi.fn(), snapshot: vi.fn(), list: vi.fn(), setReadState: vi.fn(), recordViews: vi.fn(async () => ({ read_count: 0, read_states: [] })) } }))
let sinks: Array<(frame: AgentAttentionStreamFrame) => void>
const frame = (seq = 1, type: AgentAttentionStreamFrame['type'] = 'attention.snapshot'): AgentAttentionStreamFrame => ({ seq, type, version: `v${seq}`, page: page(), unread_count: 103, notices: [] })
type Displayed = { ids: string[]; ready: boolean; bodies?: Record<string, string>; awaiting?: string[] }
function Probe({ filtered = false, viewing = false, displayed }: { filtered?: boolean; viewing?: boolean; displayed?: Displayed }) {
  useAttentionViewing('space-b', viewing ? 'session-b' : null, displayed && { ready: displayed.ready,
    messages: displayed.ids.map(id => ({ id, content: displayed.bodies?.[id] ?? `body of ${id}`, awaitingAnswer: displayed.awaiting?.includes(id) })) })
  const state = useAttentionState()
  const list = useAgentWorkList(filtered ? { project_id: 'project-b' } : {})
  return <><AttentionControls /><AttentionBadge /><p>{state.freshness}:{state.unread}:{state.needsYou}</p><p>{list.page?.items[0]?.title ?? list.error ?? 'pending'}</p><p data-testid="list-error">{list.error}</p></>
}
const show = (user = 'user', filtered = false) => <MemoryRouter><AgentAttentionProvider userId={user}><Probe filtered={filtered} /></AgentAttentionProvider></MemoryRouter>
const showViewing = () => <MemoryRouter><AgentAttentionProvider userId="user"><Probe viewing displayed={{ ids: ['m1'], ready: true }} /></AgentAttentionProvider></MemoryRouter>
function PaginatedProbe() {
  const list = useAgentWorkList({})
  return <>
    <ul>{list.page?.items.map(item => <li key={item.work_key}>{item.title}:{item.unread ? 'unread' : 'read'}</li>)}</ul>
    <button disabled={list.loading || !list.page?.next_cursor} onClick={() => void list.refresh(list.page!.next_cursor!)}>More works</button>
    <button disabled={list.loading} onClick={() => void list.refresh()}>Refresh works</button>
    <p>{list.loading ? 'Loading works' : 'Works ready'}</p>
  </>
}
const paginatedShow = (open = true) => <MemoryRouter><AgentAttentionProvider userId="user">{open && <PaginatedProbe />}</AgentAttentionProvider></MemoryRouter>
const readWork = () => work({ unread: false, read_states: work().read_states.map(state => ({ ...state, unread: false, state_version: 1, read_at: '2026-10-21T12:00:00Z' })) })
beforeEach(() => {
  vi.clearAllMocks(); sinks = []; localStorage.clear()
  vi.mocked(agentAttentionApi.stream).mockImplementation(async (sink, options) => { sinks.push(sink); await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true })) })
  vi.mocked(agentAttentionApi.list).mockResolvedValue(page([work({ title: 'Filtered work' })]))
  vi.mocked(agentAttentionApi.snapshot).mockResolvedValue(frame())
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(navigator,'locks',{configurable:true,value:undefined}) })
describe('Shell AgentAttentionProvider', () => {
  it.each([false, true])('records an already displayed conversation across provider initialization (StrictMode=%s)', async strict => {
    vi.useFakeTimers()
    const content = showViewing()
    const view = render(strict ? <StrictMode>{content}</StrictMode> : content)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledWith({ space_id: 'space-b', session_id: 'session-b', message_ids: ['m1'] }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    view.unmount()
  })
  it('reports the newest displayed messages beyond the request batch limit', async () => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 205 }, (_, i) => `m${i}`)
    const view = render(<MemoryRouter><AgentAttentionProvider userId="user"><Probe viewing displayed={{ ids, ready: true }} /></AgentAttentionProvider></MemoryRouter>)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(vi.mocked(agentAttentionApi.recordViews).mock.calls.flatMap(([body]) => body.message_ids)).toEqual(ids)
    expect(vi.mocked(agentAttentionApi.recordViews).mock.calls.every(([body]) => body.message_ids.length <= 200)).toBe(true)
    view.unmount()
  })
  it('reports the messages a visible conversation surface displayed, once per set and again when the tab returns', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const view = (displayed?: Displayed) => <MemoryRouter><AgentAttentionProvider userId="user"><Probe viewing displayed={displayed} /></AgentAttentionProvider></MemoryRouter>
    const { rerender, unmount } = render(view({ ids: ['m1', 'm2'], ready: false }))
    rerender(view({ ids: ['m1', 'm2'], ready: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(1)
    expect(agentAttentionApi.recordViews).toHaveBeenCalledWith({ space_id: 'space-b', session_id: 'session-b', message_ids: ['m1', 'm2'] }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    rerender(view({ ids: ['m1', 'm2'], ready: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(1)
    rerender(view({ ids: ['m1', 'm2', 'm3'], ready: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenLastCalledWith({ space_id: 'space-b', session_id: 'session-b', message_ids: ['m3'] }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(3)
    expect(agentAttentionApi.recordViews).toHaveBeenLastCalledWith({ space_id: 'space-b', session_id: 'session-b', message_ids: ['m1', 'm2', 'm3'] }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    unmount()
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(3)
  })
  it('reports a reply updated in place again, and never re-reports an unchanged body', async () => {
    vi.useFakeTimers()
    const view = (displayed: Displayed) => <MemoryRouter><AgentAttentionProvider userId="user"><Probe viewing displayed={displayed} /></AgentAttentionProvider></MemoryRouter>
    const viewed = (id: string) => [{ space_id: 'space-b', session_id: 'session-b', message_ids: [id] }, expect.objectContaining({ signal: expect.any(AbortSignal) })]
    // A Room waiting for approval shows a placeholder reply under the final reply's id.
    const { rerender, unmount } = render(view({ ids: ['m1', 'reply'], ready: true, bodies: { reply: 'Waiting for approval' }, awaiting: ['reply'] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(1)
    // Rerendering the same bodies is not a new view: a manual unread on them holds.
    rerender(view({ ids: ['m1', 'reply'], ready: true, bodies: { reply: 'Waiting for approval' }, awaiting: ['reply'] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(1)
    // The question is closed in place: the server's revision changed, so this is a new view.
    rerender(view({ ids: ['m1', 'reply'], ready: true, bodies: { reply: 'Waiting for approval' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(2)
    expect(agentAttentionApi.recordViews).toHaveBeenLastCalledWith(...viewed('reply'))
    // The resumed turn writes the final body in place under the same id.
    rerender(view({ ids: ['m1', 'reply'], ready: true, bodies: { reply: 'Final answer' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(3)
    expect(agentAttentionApi.recordViews).toHaveBeenLastCalledWith(...viewed('reply'))
    rerender(view({ ids: ['m1', 'reply'], ready: true, bodies: { reply: 'Final answer' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(3)
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    unmount()
  })
  it('shares the personal window and full badge counts without a second list reader', async () => {
    render(show())
    act(() => sinks[0]!(frame()))
    expect(await screen.findByText('Build the report')).toBeVisible()
    expect(screen.getByRole('status', { name: /103 unread/ })).toBeVisible()
    expect(agentAttentionApi.list).not.toHaveBeenCalled()
  })
  it('keeps filtered collection generations independent from the global personal alerts', async () => {
    render(show('user', true))
    expect(await screen.findByText('Filtered work')).toBeVisible()
    await act(async () => sinks[0]!(frame()))
    const next = { ...frame(2, 'attention.invalidation'), notices: [{ key: 'new-result', kind: 'finished' as const, work_key: 'another-project' }] }
    await act(async () => sinks[0]!(next))
    expect(toast).toHaveBeenCalledWith('An Agent turn finished', expect.any(Object))
    expect(screen.getByText('Filtered work')).toBeVisible()
    expect(agentAttentionApi.list).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'project-b' }), expect.any(Object))
  })
  it('silently baselines snapshots/resync and deduplicates new revision alerts', async () => {
    render(show())
    const notice = { key: 'result-revision', kind: 'failed' as const, work_key: 'other' }
    act(() => sinks[0]!({ ...frame(), notices: [notice] }))
    expect(toast).not.toHaveBeenCalled()
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), notices: [{ ...notice, key: 'viewed', work_key: 'opaque-b' }, notice] }))
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), notices: [notice] }))
    act(() => sinks[0]!({ ...frame(3, 'attention.invalidation'), notices: [notice] }))
    expect(toast).toHaveBeenCalledTimes(2)
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('alerts for a scoped conversation that is open outside the workbench', () => {
    render(<MemoryRouter><AgentAttentionProvider userId="user"><Probe viewing /></AgentAttentionProvider></MemoryRouter>)
    act(() => sinks[0]!(frame()))
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), notices: [{ key: 'visible-session', kind: 'answer', work_key: 'not-the-workbench-key' }] }))
    expect(toast).toHaveBeenCalledOnce()
  })
  it('clears content and counters after denied access', async () => {
    render(show()); act(() => sinks[0]!(frame()))
    act(() => sinks[0]!({ ...frame(2, 'attention.denied'), page: null, unread_count: 0 }))
    expect(screen.getByText('denied:0:0')).toBeVisible()
    expect(screen.queryByText('Build the report')).not.toBeInTheDocument()
  })
  it('ignores a prior account callback after logout or account replacement', async () => {
    const view = render(show()); const old = sinks[0]!
    act(() => old(frame()))
    view.rerender(show('other'))
    act(() => old({ ...frame(2), unread_count: 999 }))
    expect(screen.queryByText('Build the report')).not.toBeInTheDocument()
    act(() => sinks[1]!({ ...frame(), unread_count: 7 }))
    expect(screen.getByText('live:7:0')).toBeVisible()
  })
  it('falls back to a reauthorized silent snapshot after network failure and reports degraded freshness', async () => {
    vi.mocked(agentAttentionApi.stream).mockRejectedValueOnce(new TypeError('network'))
    const view = render(show())
    expect(await screen.findByText('snapshot:103:0')).toBeVisible()
    expect(screen.getByText('Build the report')).toBeVisible()
    expect(toast).not.toHaveBeenCalled()
    view.unmount()
  })
  it('rejects sequence gaps and ignores filtered late responses after account disposal', async () => {
    const store = new AttentionStore(); store.apply(frame())
    expect(store.apply(frame(3, 'attention.invalidation'))).toBe(false)
    expect(store.state.seq).toBe(1)
    const request = deferred<ReturnType<typeof page>>()
    vi.mocked(agentAttentionApi.list).mockReturnValue(request.promise)
    const entry = store.entry(JSON.stringify({ scope: 'all_visible' }))
    const read = store.refresh(entry); store.close(); request.resolve(page()); await read
    expect(entry.state.page).toBeNull()
  })
  it.each(['revision', 'attempt'] as const)('keeps a new source %s unread when an older read response arrives', change => {
    const store = new AttentionStore()
    const earlier = work().read_states[0]!
    const latest = { ...earlier, subject: { ...earlier.subject, ...(change === 'attempt' ? { attempt_id: 'attempt-next' } : { revision: 'rev-next' }) } }
    store.apply({ ...frame(), page: page([work({ read_states: [latest] })]) })
    store.update('opaque-b', { ...earlier, unread: false, state_version: 1 })
    const item = store.entry(PERSONAL_QUERY).state.page!.items[0]!
    expect(item.read_states).toEqual([latest])
    expect(item.unread).toBe(true)
    store.close()
  })
  it('keeps a newer manual-unread decision when an older response for the same revision arrives', () => {
    const store = new AttentionStore()
    const earlier = work().read_states[0]!
    const latest = { ...earlier, manual_unread: true, state_version: 2 }
    store.apply({ ...frame(), page: page([work({ read_states: [latest] })]) })
    store.update('opaque-b', { ...earlier, unread: false, state_version: 1 })
    const item = store.entry(PERSONAL_QUERY).state.page!.items[0]!
    expect(item.read_states).toEqual([latest])
    expect(item.unread).toBe(true)
    // A matching revision's newer decision still reconciles normally.
    store.update('opaque-b', { ...latest, unread: false, manual_unread: false, state_version: 3 })
    expect(store.entry(PERSONAL_QUERY).state.page!.items[0]!.unread).toBe(false)
    store.close()
  })
  it('keeps a stream-projected read cursor over a delayed manual unread at the same stored version', () => {
    const store = new AttentionStore()
    const latest = { ...work().read_states[0]!, unread: false, manual_unread: false, state_version: 2 }
    store.apply({ ...frame(), page: page([work({ read_states: [latest], unread: false })]) })
    store.update('opaque-b', { ...latest, unread: true, manual_unread: true })
    expect(store.entry(PERSONAL_QUERY).state.page!.items[0]).toMatchObject({ read_states: [latest], unread: false })
    store.close()
  })
  it('requires explicit gestures for sound and desktop delivery, and denial leaves the list usable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback()) } })
    class Channel { postMessage() {} close() {} onmessage = null }
    vi.stubGlobal('BroadcastChannel', Channel)
    const requested = vi.fn().mockResolvedValueOnce('denied').mockResolvedValueOnce('granted')
    const delivered = vi.fn()
    class DesktopNotification { static permission = 'granted'; static requestPermission = requested; constructor(title: string) { delivered(title) }; close() {} }
    const sounded = vi.fn(), resumed = vi.fn().mockResolvedValue(undefined)
    class Audio { state = 'running'; currentTime = 0; destination = {}; resume = resumed; close = vi.fn().mockResolvedValue(undefined)
      createOscillator = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: sounded, stop: vi.fn(), onended: null }); createGain = () => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }) }
    vi.stubGlobal('Notification', DesktopNotification); vi.stubGlobal('AudioContext', Audio)
    const view = render(show())
    await waitFor(() => expect(screen.getByLabelText('Enable sound')).toBeEnabled())
    expect(resumed).not.toHaveBeenCalled(); expect(requested).not.toHaveBeenCalled()
    act(() => sinks[0]!(frame()))
    fireEvent.click(screen.getByLabelText('Enable desktop alerts'))
    await waitFor(() => expect(requested).toHaveBeenCalledOnce())
    expect(screen.getByText('Build the report')).toBeVisible(); expect(screen.getByLabelText('Enable desktop alerts')).not.toBeChecked()
    expect(await screen.findByText('Alert delivery unavailable or permission refused')).toBeVisible()
    fireEvent.click(screen.getByLabelText('Enable desktop alerts')); fireEvent.click(screen.getByLabelText('Enable sound'))
    await waitFor(() => expect(screen.getByLabelText('Enable desktop alerts')).toBeChecked())
    expect(screen.queryByText('Alert delivery unavailable or permission refused')).not.toBeInTheDocument()
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), notices: [{ key: 'enabled', work_key: 'another-work', kind: 'finished' }] }))
    expect(delivered).toHaveBeenCalledOnce(); expect(sounded).toHaveBeenCalledOnce()
    view.unmount(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  })
  it('hands the enabled sound and desktop choice to the next delivery tab', async () => {
    const queue: Array<{ signal?: AbortSignal; callback: () => Promise<void>; resolve: () => void }> = []
    const next = () => { const head = queue[0]; if (!head) return; if (head.signal?.aborted) { queue.shift(); head.resolve(); next(); return }
      void head.callback().then(() => { queue.shift(); head.resolve(); next() }) }
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) =>
      new Promise<void>(resolve => { queue.push({ signal: options.signal, callback, resolve }); if (queue.length === 1) next() }) } })
    class Channel {
      static all = new Set<Channel>(); onmessage: ((event: { data: unknown }) => void) | null = null
      constructor(public name: string) { Channel.all.add(this) }
      postMessage(data: unknown) { for (const peer of Channel.all) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data }) }
      close() { Channel.all.delete(this) }
    }
    vi.stubGlobal('BroadcastChannel', Channel)
    const delivered = vi.fn(), sounded = vi.fn()
    class DesktopNotification { static permission = 'granted'; static requestPermission = vi.fn().mockResolvedValue('granted'); constructor(title: string) { delivered(title) }; close() {} }
    class Audio { state = 'suspended'; currentTime = 0; destination = {}; resume = vi.fn(async () => { this.state = 'running' }); close = vi.fn().mockResolvedValue(undefined)
      createOscillator = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: sounded, stop: vi.fn(), onended: null }); createGain = () => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }) }
    vi.stubGlobal('Notification', DesktopNotification); vi.stubGlobal('AudioContext', Audio)
    const first = render(show()); const second = render(show())
    const sender = within(first.container), heir = within(second.container)
    await waitFor(() => expect(sender.getByLabelText('Enable sound')).toBeEnabled())
    expect(heir.getByLabelText('Enable sound')).toBeDisabled()
    fireEvent.click(sender.getByLabelText('Enable desktop alerts')); fireEvent.click(sender.getByLabelText('Enable sound'))
    // The choice is shared live with the other tab, which only displays it.
    await waitFor(() => expect(heir.getByLabelText('Enable sound')).toBeChecked())
    expect(heir.getByLabelText('Enable desktop alerts')).toBeChecked()
    first.unmount()
    await waitFor(() => expect(heir.getByLabelText('Enable sound')).toBeEnabled())
    expect(heir.getByLabelText('Enable desktop alerts')).toBeChecked()
    expect(heir.getByText('Sound resumes after your next click or key press in this tab.')).toBeVisible()
    act(() => sinks[1]!(frame()))
    act(() => sinks[1]!({ ...frame(2, 'attention.invalidation'), notices: [{ key: 'after-handoff', work_key: 'another-work', kind: 'finished' }] }))
    expect(delivered).toHaveBeenCalledOnce(); expect(sounded).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'a' })
    await waitFor(() => expect(heir.queryByText(/next click or key press/)).not.toBeInTheDocument())
    act(() => sinks[1]!({ ...frame(3, 'attention.invalidation'), notices: [{ key: 'after-gesture', work_key: 'another-work', kind: 'finished' }] }))
    expect(delivered).toHaveBeenCalledTimes(2); expect(sounded).toHaveBeenCalledOnce()
    second.unmount()
  })
  it('keeps alert-delivery problems out of data freshness, so a live stream survives a return to the tab', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback()) } })
    class Channel { postMessage() {} close() {} onmessage = null }
    vi.stubGlobal('BroadcastChannel', Channel)
    vi.stubGlobal('Notification', class { static permission = 'default'; static requestPermission = vi.fn().mockResolvedValue('denied') })
    render(show())
    act(() => sinks[0]!(frame()))
    await waitFor(() => expect(screen.getByLabelText('Enable desktop alerts')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('Enable desktop alerts'))
    expect(await screen.findByText('Alert delivery unavailable or permission refused')).toBeVisible()
    expect(screen.getByText('live:103:0')).toBeVisible()
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), page: null }))
    expect(screen.getByText('Alert delivery unavailable or permission refused')).toBeVisible()
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(agentAttentionApi.stream).toHaveBeenCalledTimes(1)
  })
  it('backs off failed reconnects exponentially with jitter and resets after a live frame', async () => {
    expect(reconnectDelay(0, () => 0)).toBe(RECONNECT_BASE_MS / 2)
    expect(reconnectDelay(20, () => 1)).toBe(RECONNECT_MAX_MS)
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(1)
    const stream = vi.mocked(agentAttentionApi.stream)
    stream.mockRejectedValueOnce(new TypeError('network')).mockRejectedValueOnce(new TypeError('network'))
      .mockImplementationOnce(async sink => { sink(frame()); throw new TypeError('network') })
    render(show())
    const after = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
    await after(0); expect(stream).toHaveBeenCalledTimes(1)
    await after(RECONNECT_BASE_MS - 1); expect(stream).toHaveBeenCalledTimes(1)
    await after(1); expect(stream).toHaveBeenCalledTimes(2)
    await after(RECONNECT_BASE_MS * 2 - 1); expect(stream).toHaveBeenCalledTimes(2)
    await after(1); expect(stream).toHaveBeenCalledTimes(3)
    // That connection delivered a live frame before failing: the delay starts over.
    await after(RECONNECT_BASE_MS); expect(stream).toHaveBeenCalledTimes(4)
  })
  it('defaults optional delivery off and clearly disables it when coordination is unavailable', () => {
    render(show())
    expect(screen.getByLabelText('Enable sound')).not.toBeChecked()
    expect(screen.getByLabelText('Enable desktop alerts')).not.toBeChecked()
    expect(screen.getByLabelText('Enable sound')).toBeDisabled()
    expect(screen.getByText(/Tab coordination unavailable/)).toBeVisible()
  })
  it('keeps filtered invalidation subscriptions alive after StrictMode effect replay', async () => {
    render(<StrictMode>{show('user', true)}</StrictMode>)
    expect(await screen.findByText('Filtered work')).toBeVisible()
    const before = vi.mocked(agentAttentionApi.list).mock.calls.length
    act(() => sinks[sinks.length - 1]!(frame()))
    await waitFor(() => expect(vi.mocked(agentAttentionApi.list).mock.calls.length).toBeGreaterThan(before))
    expect(screen.getByText('Filtered work')).toBeVisible()
  })

  it('reauthorizes mounted filters on a reconnect snapshot even when business revisions are unchanged', async () => {
    render(show('user', true))
    expect(await screen.findByText('Filtered work')).toBeVisible()
    await act(async () => sinks[0]!(frame()))
    act(() => window.dispatchEvent(new Event('offline')))
    expect(screen.getByTestId('list-error')).toHaveTextContent('offline')
    const before = vi.mocked(agentAttentionApi.list).mock.calls.filter(([query]) => query?.project_id === 'project-b').length
    act(() => window.dispatchEvent(new Event('online')))
    await act(async () => sinks[sinks.length - 1]!(frame()))
    await waitFor(() => expect(screen.getByTestId('list-error')).toBeEmptyDOMElement())
    expect(vi.mocked(agentAttentionApi.list).mock.calls.filter(([query]) => query?.project_id === 'project-b').length).toBeGreaterThan(before)
  })

  it('shows exactly one local toast in a visible follower while the lock holder is in the background', async () => {
    let lockCalls=0
    Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async (_name,_options,callback)=>{
      if (++lockCalls===1) return callback()
      await new Promise(()=>{})
    })}})
    class Channel { postMessage() {} close() {} onmessage=null }
    vi.stubGlobal('BroadcastChannel',Channel)
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    const background=new AttentionDelivery('user',vi.fn())
    const notice={key:'foreground-follower',kind:'finished' as const,work_key:'unopened-work'}
    expect(background.leader).toBe(true); expect(background.acceptToast(notice)).toBe(false)
    visibility.mockReturnValue('visible')
    const view=render(show())
    expect(await screen.findByText(/Another tab delivers/)).toBeVisible()
    act(()=>sinks[0]!(frame()))
    act(()=>sinks[0]!({...frame(2,'attention.invalidation'),notices:[notice]}))
    act(()=>sinks[0]!({...frame(3,'attention.invalidation'),notices:[notice]}))
    expect(toast).toHaveBeenCalledTimes(1)
    view.unmount(); background.close()
  })
  it('keeps a background arrival pending and displays it once on return without reconnecting a live stream', () => {
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    render(show()); act(()=>sinks[0]!(frame()))
    act(()=>sinks[0]!({...frame(2,'attention.invalidation'),notices:[{key:'pending-local',kind:'answer',work_key:'unopened-work'}]}))
    expect(toast).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(()=>document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).toHaveBeenCalledTimes(1); expect(agentAttentionApi.stream).toHaveBeenCalledTimes(1)
    act(()=>document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).toHaveBeenCalledTimes(1)
  })
  it('disposes pending local notices on account replacement', () => {
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    const view=render(show()); act(()=>sinks[0]!(frame()))
    act(()=>sinks[0]!({...frame(2,'attention.invalidation'),notices:[{key:'old-account',kind:'failed',work_key:'old-work'}]}))
    view.rerender(show('other')); act(()=>sinks[1]!(frame()))
    visibility.mockReturnValue('visible'); act(()=>document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).not.toHaveBeenCalled()
  })
  it('coalesces filtered invalidations within five seconds and cancels deferred reads on disposal', async () => {
    vi.useFakeTimers()
    const store=new AttentionStore(); const entry=store.entry(JSON.stringify({project_id:'project-b'}))
    entry.listeners.add(vi.fn()); await store.refresh(entry)
    store.apply(frame()) // initial reconciliation can reread mounted filters immediately
    await Promise.resolve(); await Promise.resolve()
    vi.mocked(agentAttentionApi.list).mockClear()
    store.apply({...frame(2,'attention.invalidation'),page:null,counts:{...page().counts,needs_you:4}})
    store.apply({...frame(3,'attention.invalidation'),page:null})
    expect(store.state.needsYou).toBe(4); expect(agentAttentionApi.list).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FILTER_REFRESH_MS)
    expect(agentAttentionApi.list).toHaveBeenCalledTimes(1)
    store.apply({...frame(4,'attention.invalidation'),page:null}); store.close()
    await vi.advanceTimersByTimeAsync(FILTER_REFRESH_MS)
    expect(agentAttentionApi.list).toHaveBeenCalledTimes(1)
  })

  it.each([true,false])('shares shown toast identities between providers (hidden pending tab=%s)', pending => {
    let owner=false
    Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async (_name,options,callback)=>{
      if (!owner) {owner=true;return callback()}
      await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}))
    })}})
    class Channel {
      static all=new Set<Channel>(); onmessage:((event:{data:unknown})=>void)|null=null
      constructor(public name:string) {Channel.all.add(this)}
      postMessage(data:unknown) {for(const peer of Channel.all) if(peer!==this && peer.name===this.name) peer.onmessage?.({data})}
      close() {Channel.all.delete(this)}
    }
    vi.stubGlobal('BroadcastChannel',Channel)
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue(pending?'hidden':'visible')
    render(<MemoryRouter><AgentAttentionProvider userId="user"><Probe /></AgentAttentionProvider><AgentAttentionProvider userId="user"><Probe /></AgentAttentionProvider></MemoryRouter>)
    act(()=>{sinks[0]!(frame());sinks[1]!(frame())})
    const notice={key:'one-toast-across-tabs',kind:'finished' as const,work_key:'unopened-work'}
    if(pending) act(()=>sinks[1]!({...frame(2,'attention.invalidation'),notices:[notice]}))
    expect(toast).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(()=>sinks[0]!({...frame(2,'attention.invalidation'),notices:[notice]}))
    expect(toast).toHaveBeenCalledTimes(1)
    act(()=>document.dispatchEvent(new Event('visibilitychange')))
    act(()=>sinks[1]!({...frame(pending?3:2,'attention.invalidation'),notices:[notice]}))
    expect(toast).toHaveBeenCalledTimes(1)
  })
  it('does not replay a background notice once an authorized frame marks that work read elsewhere', () => {
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    render(show());act(()=>sinks[0]!(frame()))
    act(()=>sinks[0]!({...frame(2,'attention.invalidation'),notices:[{key:'now-read',kind:'finished',work_key:'opaque-b'}]}))
    const read=work({unread:false,read_states:work().read_states.map(state=>({...state,unread:false,state_version:1,read_at:'2026-10-21T12:00:00Z'}))})
    act(()=>sinks[0]!({...frame(3,'attention.invalidation'),page:page([read])}))
    visibility.mockReturnValue('visible');act(()=>document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).not.toHaveBeenCalled();expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    expect(agentAttentionApi.stream).toHaveBeenCalledTimes(1)
  })

  it('shows a new background result once after loading more and leaving, and returns to the current personal window', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([work({ work_key: 'older-work', title: 'Older work' })]))
    const view = render(paginatedShow())
    act(() => sinks[0]!({ ...frame(), page: page([readWork()], { next_cursor: 'next-page' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'More works' }))
    expect(await screen.findByText('Older work:unread')).toBeVisible()
    expect(screen.getByText('Build the report:read')).toBeVisible()
    view.rerender(paginatedShow(false))
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), page: page([work({ title: 'New result' })]),
      notices: [{ key: 'after-leaving-paginated-list', kind: 'finished', work_key: 'opaque-b' }] }))
    expect(toast).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).toHaveBeenCalledTimes(1)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).toHaveBeenCalledTimes(1)
    view.rerender(paginatedShow())
    expect(screen.getByText('New result:unread')).toBeVisible()
    expect(screen.queryByText('Older work:unread')).not.toBeInTheDocument()
    expect(agentAttentionApi.list).toHaveBeenCalledTimes(1)
    expect(agentAttentionApi.stream).toHaveBeenCalledTimes(1)
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })

  it('keeps a background notice when a mounted multipage window still shows read data during refresh', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work({ work_key: 'older-work', title: 'Older work' })]))
    render(paginatedShow())
    act(() => sinks[0]!({ ...frame(), page: page([readWork()], { next_cursor: 'next-page' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'More works' }))
    expect(await screen.findByText('Older work:unread')).toBeVisible()
    const pending = deferred<ReturnType<typeof page>>()
    vi.mocked(agentAttentionApi.list).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh works' }))
    expect(screen.getByText('Loading works')).toBeVisible()
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), page: page([work({ title: 'New result' })]),
      notices: [{ key: 'during-paginated-refresh', kind: 'finished', work_key: 'opaque-b' }] }))
    expect(screen.getByText('Build the report:read')).toBeVisible()
    expect(toast).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(page([work({ title: 'New result' })])))
    expect(screen.getByText('New result:unread')).toBeVisible()
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(toast).toHaveBeenCalledTimes(1)
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })

  it('reauthorizes a retained multipage personal window on return even without a replacement stream page', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work({ work_key: 'older-work', title: 'Older work' })]))
    const view = render(paginatedShow())
    act(() => sinks[0]!({ ...frame(), page: page([readWork()], { next_cursor: 'next-page' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'More works' }))
    expect(await screen.findByText('Older work:unread')).toBeVisible()
    view.rerender(paginatedShow(false))
    act(() => sinks[0]!({ ...frame(2, 'attention.invalidation'), page: null }))
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work({ title: 'Current window' })]))
    view.rerender(paginatedShow())
    expect(await screen.findByText('Current window:unread')).toBeVisible()
    expect(screen.queryByText('Older work:unread')).not.toBeInTheDocument()
    expect(agentAttentionApi.list).toHaveBeenCalledTimes(2)
  })

})
