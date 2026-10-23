// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttentionViewResult } from '@rainver/protocol'
import { shownVersion, ViewReporter, VIEW_REPORT_DELAY_MS } from './viewReports'
import { deferred, work } from './fixtures.test-support'

type Send = ConstructorParameters<typeof ViewReporter>[0]
const none: AgentAttentionViewResult = { read_count: 0, read_states: [] }
const messageRead = (id: string, version: number) => ({ ...work().read_states[0]!, subject: { kind: 'message' as const, schema_version: 1 as const, message_id: id, revision: `${id}-rev` }, unread: false, state_version: version })
const sentIds = (send: ReturnType<typeof vi.fn<Send>>) => send.mock.calls.map(([body]) => body.message_ids)
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ViewReporter', () => {
  it('pauses unsent view batches and changed display sets until another explicit open', async () => {
    const pending = deferred<AgentAttentionViewResult>()
    const send = vi.fn<Send>(() => pending.promise)
    const views = new ViewReporter(send, () => true)
    const surface = {}, open = {}
    const ids = Array.from({ length: 205 }, (_, i) => `m${i}`)
    views.displayed(surface, 'space', 'session', ids, open)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledOnce()
    const stopped = views.pause(open, 'space', 'session')
    views.displayed(surface, 'space', 'session', [...ids, 'new-message'], open)
    views.resume()
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    pending.resolve({ read_count: 1, read_states: [messageRead('m0', 1)] })
    expect(await stopped).toEqual([messageRead('m0', 1)])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([ids.slice(0, 200)])
    views.left(surface, 'space', 'session'); views.release(open, 'space', 'session')
    send.mockResolvedValue(none)
    views.displayed({}, 'space', 'session', ['new-message'], {})
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([ids.slice(0, 200), ['new-message']])
    views.close()
  })

  it.each([false, true])('waits for an older open before a reopened manual-reading decision (transcript still loading=%s)', async loading => {
    const old = deferred<AgentAttentionViewResult>()
    const send = vi.fn<Send>().mockReturnValueOnce(old.promise).mockResolvedValue(none)
    const views = new ViewReporter(send, () => true)
    const read = messageRead('message', 3)
    const first = {}, firstOpen = {}
    views.displayed(first, 'space', 'session', ['message'], firstOpen)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    views.left(first, 'space', 'session')
    const second = {}, secondOpen = {}
    if (!loading) {
      views.displayed(second, 'space', 'session', ['message'], secondOpen)
      await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    }
    let finished = false
    const stopped = views.pause(secondOpen, 'space', 'session').then(reads => { finished = true; return reads })
    if (loading) {
      views.displayed(second, 'space', 'session', ['message'], secondOpen)
      await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    }
    await Promise.resolve(); await Promise.resolve()
    expect(finished).toBe(false)
    old.resolve({ read_count: 1, read_states: [read] })
    expect(await stopped).toEqual([read])
    views.resume()
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledTimes(loading ? 1 : 2)
    // A subsequent actual open remains a new view and may consume manual unread.
    views.left(second, 'space', 'session'); views.release(secondOpen, 'space', 'session')
    views.displayed({}, 'space', 'session', ['message'], {})
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledTimes(loading ? 2 : 3)
    views.close()
  })

  it('fails a manual decision only for a report it awaited, not an earlier transient failure', async () => {
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error('503')).mockResolvedValue({ read_count: 1, read_states: [messageRead('m2', 2)] })
    const views = new ViewReporter(send, () => true)
    const surface = {}, open = {}
    views.displayed(surface, 'space', 'session', ['m1'], open)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledOnce()
    // The failed id stays unreported and is retried with the next change.
    views.displayed(surface, 'space', 'session', ['m1', 'm2'], open)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['m1'], ['m1', 'm2']])
    expect(await views.pause(open, 'space', 'session')).toEqual([messageRead('m2', 2)])
    views.close()

    const inFlight = deferred<AgentAttentionViewResult>()
    const failing = new ViewReporter(vi.fn<Send>(() => inFlight.promise), () => true)
    failing.displayed(surface, 'space', 'session', ['m1'], open)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    const decision = failing.pause(open, 'space', 'session')
    inFlight.reject(new Error('awaited 503'))
    await expect(decision).rejects.toThrow('awaited 503')
    failing.close()
  })

  it('sends only newly displayed ids, one batch at a time, and everything again when the tab returns', async () => {
    const first = deferred<AgentAttentionViewResult>()
    const send = vi.fn<Send>().mockReturnValueOnce(first.promise).mockResolvedValue(none)
    const views = new ViewReporter(send, () => true)
    const surface = {}
    const ids = Array.from({ length: 1000 }, (_, i) => `m${i}`)
    views.displayed(surface, 'space', 'session', ids)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    views.displayed(surface, 'space', 'session', [...ids, 'm1000'])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS * 3)
    expect(send).toHaveBeenCalledOnce() // no concurrent loop while the first batch is in flight
    first.resolve(none)
    await vi.advanceTimersByTimeAsync(0)
    expect(sentIds(send).flat()).toEqual([...ids, 'm1000'])
    expect(send).toHaveBeenCalledTimes(6)
    views.displayed(surface, 'space', 'session', [...ids, 'm1000', 'm1001'])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ message_ids: ['m1001'] }), expect.any(AbortSignal))
    expect(send).toHaveBeenCalledTimes(7)
    views.resume()
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledTimes(13)
    views.close()
  })

  it('keeps separate surfaces of one Session independent: union, leaving and pausing', async () => {
    const send = vi.fn<Send>().mockResolvedValue(none)
    const views = new ViewReporter(send, () => true)
    const workbench = {}, sidecar = {}, open = {}
    views.displayed(workbench, 'space', 'session', ['m1'], open)
    views.displayed(sidecar, 'space', 'session', ['m2'])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['m1', 'm2']])
    await views.pause(open, 'space', 'session')
    views.displayed(workbench, 'space', 'session', ['m1', 'm3'], open)
    views.displayed(sidecar, 'space', 'session', ['m2', 'm4'])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['m1', 'm2'], ['m4']]) // the paused open's m3 waits for another open
    views.left(workbench, 'space', 'session'); views.release(open, 'space', 'session')
    views.displayed(sidecar, 'space', 'session', ['m2', 'm4', 'm5'])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['m1', 'm2'], ['m4'], ['m5']])
    views.close()
  })
  it('reports a reply updated in place again without consuming a manual unread on the body already reported', async () => {
    const send = vi.fn<Send>().mockResolvedValue(none)
    const views = new ViewReporter(send, () => true)
    const workbench = {}, sidecar = {}, open = {}
    views.displayed(workbench, 'space', 'session', [{ id: 'reply', shown: 'placeholder' }], open)
    views.displayed(sidecar, 'space', 'session', ['m0', { id: 'reply', shown: 'placeholder' }])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['reply', 'm0']])
    // A manual unread on the placeholder: rerendering the same body is no new view.
    await views.pause(open, 'space', 'session')
    views.displayed(sidecar, 'space', 'session', ['m0', { id: 'reply', shown: 'placeholder' }])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledOnce()
    // The paused open's own update waits for another open.
    views.displayed(workbench, 'space', 'session', [{ id: 'reply', shown: 'final' }], open)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledOnce()
    // Another surface displaying the final body is a view of the new revision.
    views.displayed(sidecar, 'space', 'session', ['m0', { id: 'reply', shown: 'final' }])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['reply', 'm0'], ['reply']])
    views.close()
  })

  it('keeps a body that changed while its report was in flight unreported', async () => {
    const first = deferred<AgentAttentionViewResult>()
    const send = vi.fn<Send>().mockReturnValueOnce(first.promise).mockResolvedValue(none)
    const views = new ViewReporter(send, () => true)
    const surface = {}
    views.displayed(surface, 'space', 'session', [{ id: 'reply', shown: 'placeholder' }])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    views.displayed(surface, 'space', 'session', [{ id: 'reply', shown: 'final' }])
    first.resolve(none)
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(sentIds(send)).toEqual([['reply'], ['reply']])
    await vi.advanceTimersByTimeAsync(VIEW_REPORT_DELAY_MS)
    expect(send).toHaveBeenCalledTimes(2)
    views.close()
  })

  it('fingerprints the body and open question the server revision covers', () => {
    expect(shownVersion('Final answer')).toBe(shownVersion('Final answer'))
    expect(shownVersion('Final answer')).not.toBe(shownVersion('Waiting for approval'))
    expect(shownVersion('Question?', true)).not.toBe(shownVersion('Question?', false))
  })
})
