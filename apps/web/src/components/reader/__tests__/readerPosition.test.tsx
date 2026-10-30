import { act, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderPosition } from '@rainver/protocol'
import type { ReaderAnnotation, ReaderDocumentPayload } from '../../../types/api'

const api = vi.hoisted(() => ({
  getPosition: vi.fn(), putPosition: vi.fn(), getAppearance: vi.fn(), putAppearance: vi.fn(),
  deleteAnnotation: vi.fn(), updateAnnotation: vi.fn(), listThreads: vi.fn(), createAnnotation: vi.fn(),
}))
vi.mock('../../../api/client', () => ({ readerApi: api }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
// The real reader needs browser layout; the handle stands in for where the text is.
const handle = vi.hoisted(() => ({
  blockCount: vi.fn(() => 3), blockSelection: vi.fn(), scrollToBlock: vi.fn(),
  readingAnchor: vi.fn(), locate: vi.fn(), scrollToPos: vi.fn(), headings: vi.fn(() => []), find: vi.fn(() => 0), findGo: vi.fn(),
}))
vi.mock('../../editor/ReadOnlyTiptapReader', () => ({
  ReadOnlyTiptapReader: forwardRef(function Reader(_props, ref) { useImperativeHandle(ref, () => handle); return <div data-testid="reader" /> }),
}))

import { ReaderWorkspace } from '../ReaderWorkspace'
import { clearSessionResidue } from '../../../lib/sessionResidue'
import { POSITION_DWELL_MS, POSITION_IDLE_MS } from '../useReaderPosition'

const doc = (id = 'item-1', structure = 'struct-1') => ({
  document_type: 'source_item', document_id: id, space_id: 'space-1', project_id: null, title: 'Article',
  plain_text: 'Alpha.', normalized_text: 'Alpha.', content_hash: 'hash-1', structure_hash: structure, content_format: 'tiptap_json',
  content_schema_version: 1, content_json: { type: 'doc', content: [] }, source_item_id: id,
}) as unknown as ReaderDocumentPayload
const anchor = (pm_pos: number) => ({ block_index: 1, pm_pos, text_offset: pm_pos, quote: 'Second paragraph text', before_context: 'First. ' })
const saved = (over: Partial<ReaderPosition> = {}): ReaderPosition => ({
  content_hash: 'hash-1', structure_hash: 'struct-1', current: { anchor: anchor(40), progress: 0.4 }, furthest: { anchor: anchor(60), progress: 0.6 },
  current_client_at: '2026-10-29T00:00:00.000Z', updated_at: '2026-10-29T00:00:00.000Z', revision: 1, ...over,
})
const shell = () => document.querySelector('.reader-document-shell') as HTMLElement
const view = (document = doc()) => <ReaderWorkspace document={document} annotations={[] as ReaderAnnotation[]} onAnnotationsChange={() => {}} />
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  Object.values(api).forEach(fn => fn.mockReset())
  Object.values(handle).forEach(fn => fn.mockClear())
  Object.values(toasts).forEach(fn => fn.mockReset())
  api.getAppearance.mockResolvedValue({ font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' })
  api.putPosition.mockResolvedValue({ position: null, accepted: true })
  handle.readingAnchor.mockImplementation(() => anchor(50))
  handle.locate.mockImplementation((value: { pm_pos: number }) => ({ pos: value.pm_pos, how: 'exact' }))
  window.localStorage.clear()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

// Lets loads, the fonts wait (at most 1s) and the frame after it run.
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(1000); await Promise.resolve() })
}

describe('reading position', () => {
  it('reports nothing until the saved place has been restored, then goes back to it', async () => {
    const position = deferred<{ position: ReaderPosition; accepted: boolean }>()
    api.getPosition.mockReturnValue(position.promise)
    render(view())
    // Scrolling done by the browser while the position loads (layout, anchors) is not reported.
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS * 2) })
    expect(api.putPosition).not.toHaveBeenCalled()
    await act(async () => { position.resolve({ position: saved(), accepted: true }) })
    await settle()
    expect(handle.scrollToPos).toHaveBeenCalledWith(40, shell())
    expect(handle.locate).toHaveBeenCalledWith(anchor(40), true)
    expect(api.getPosition).toHaveBeenCalledWith('space-1', 'source_item', 'item-1')
  })

  it('does not move a person who started reading before the saved place arrived, and offers the way back', async () => {
    const position = deferred<{ position: ReaderPosition; accepted: boolean }>()
    api.getPosition.mockReturnValue(position.promise)
    render(view())
    fireEvent.wheel(shell())
    await act(async () => { position.resolve({ position: saved(), accepted: true }) })
    await settle()
    expect(screen.getByText(/did not jump to your last position/)).toBeInTheDocument()
    expect(handle.scrollToPos).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to where I was' }))
    expect(handle.scrollToPos).toHaveBeenCalledWith(40, shell())
  })

  it('saves the current place after scrolling stops, and the furthest only after staying there', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    render(view())
    await settle()
    fireEvent.scroll(shell())
    // The report carries the time the place was measured, for ordering across tabs and devices.
    const measuredAt = new Date(Date.now() + POSITION_IDLE_MS).toISOString()
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    expect(api.putPosition).toHaveBeenCalledTimes(1)
    expect(api.putPosition.mock.calls[0]).toEqual(['space-1', 'source_item', 'item-1', expect.objectContaining({
      content_hash: 'hash-1', structure_hash: 'struct-1', dwelled: false, reset_furthest: false, current: expect.objectContaining({ anchor: anchor(50) }),
      client_at: measuredAt,
    }), { keepalive: undefined }])
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS - POSITION_IDLE_MS) })
    expect(api.putPosition).toHaveBeenCalledTimes(2)
    expect(api.putPosition.mock.calls[1][3]).toMatchObject({ dwelled: true })
    // Scrolling on before the dwell time has passed does not count as reading.
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS + 1000) })
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    expect(api.putPosition.mock.calls.slice(2).every(call => call[3].dwelled === false)).toBe(true)
  })

  it('sends the last place in a request that outlives the page when the page is left', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    render(view())
    await settle()
    handle.readingAnchor.mockImplementation(() => anchor(77))
    fireEvent(window, new Event('pagehide'))
    expect(api.putPosition).toHaveBeenLastCalledWith('space-1', 'source_item', 'item-1', expect.objectContaining({ current: expect.objectContaining({ anchor: anchor(77) }) }), { keepalive: true })
  })

  it('stops saving into a document the person can no longer read', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    api.putPosition.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    render(view())
    await settle()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    await settle()
    handle.readingAnchor.mockImplementation(() => anchor(90))
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS * 2) })
    fireEvent(window, new Event('pagehide'))
    expect(api.putPosition).toHaveBeenCalledTimes(1)
  })

  it('does not jump to the same fraction of a changed version whose text it cannot find; the person may choose to', async () => {
    api.getPosition.mockResolvedValue({ position: saved({ structure_hash: 'struct-0' }), accepted: true })
    handle.locate.mockReturnValue(null)
    render(view())
    await settle()
    expect(handle.locate).toHaveBeenCalledWith(anchor(40), false)
    expect(screen.getByText(/did not jump/)).toBeInTheDocument()
    expect(handle.scrollToPos).not.toHaveBeenCalled()
    expect(shell().scrollTop).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /Go to about the same point/ }))
    expect(screen.queryByText(/did not jump/)).not.toBeInTheDocument()
  })

  it('keeps each document’s reports to itself when the Reader moves to another document', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    const { rerender } = render(view(doc('item-1')))
    await settle()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(300) })
    rerender(view(doc('item-2')))
    await settle()
    // The place measured in the first document is sent for the first document only.
    const forFirst = api.putPosition.mock.calls.filter(call => call[2] === 'item-1')
    expect(forFirst.every(call => call[4].keepalive === true)).toBe(true)
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS * 2) })
    expect(api.putPosition.mock.calls.filter(call => call[2] === 'item-1')).toHaveLength(forFirst.length)
    expect(api.getPosition).toHaveBeenLastCalledWith('space-1', 'source_item', 'item-2')
  })

  it('resets the furthest position only on request, from the place shown now', async () => {
    api.getPosition.mockResolvedValue({ position: saved(), accepted: true })
    render(view())
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Reading progress' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make this my reading progress' }))
    await settle()
    expect(api.putPosition).toHaveBeenLastCalledWith('space-1', 'source_item', 'item-1', expect.objectContaining({ reset_furthest: true, dwelled: false }), { keepalive: undefined })
    expect(toasts.success).toHaveBeenCalledWith('Reading progress set to this position')
  })

  it('sends a place measured before a document switch with that document’s own version, not the next one’s', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    const { rerender } = render(view(doc('item-1', 'old-structure')))
    await settle()
    fireEvent.scroll(shell())
    rerender(view(doc('item-2', 'new-structure')))
    await settle()
    const forFirst = api.putPosition.mock.calls.filter(call => call[2] === 'item-1')
    expect(forFirst.length).toBeGreaterThan(0)
    expect(forFirst.every(call => call[3].structure_hash === 'old-structure')).toBe(true)
  })

  it('treats a new version of the same document as a new run: the old place keeps its version and the new one is restored', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    const { rerender } = render(view(doc('item-1', 'old-structure')))
    await settle()
    fireEvent.scroll(shell())
    rerender(view(doc('item-1', 'new-structure')))
    await settle()
    expect(api.getPosition).toHaveBeenCalledTimes(2)
    const leaving = api.putPosition.mock.calls.find(call => call[4].keepalive)
    expect(leaving?.[3].structure_hash).toBe('old-structure')
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    expect(api.putPosition.mock.calls[api.putPosition.mock.calls.length - 1][3].structure_hash).toBe('new-structure')
  })

  it('forgets the saved place and its actions when access is refused, and later replies change nothing', async () => {
    api.getPosition.mockResolvedValue({ position: saved(), accepted: true })
    let late: (value: unknown) => void = () => {}
    api.putPosition
      .mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
    render(view())
    await settle()
    handle.scrollToPos.mockClear()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    handle.readingAnchor.mockImplementation(() => anchor(70))
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    await settle()
    // The first, slower save answers after the refusal: it must not bring progress back.
    await act(async () => { late({ position: saved({ revision: 5, furthest: { anchor: anchor(90), progress: 0.9 } }), accepted: true }) })
    fireEvent.click(screen.getByRole('button', { name: 'Reading progress' }))
    expect(screen.getByRole('button', { name: 'Back to where I was' })).toBeDisabled()
    expect(screen.getByText('No reading progress recorded yet.')).toBeInTheDocument()
    expect(screen.getByText('No access to your reading position; nothing is saved.')).toBeInTheDocument()
    fireEvent(window, new Event('pagehide'))
    expect(api.putPosition).toHaveBeenCalledTimes(2)
    expect(handle.scrollToPos).not.toHaveBeenCalled()
  })

  it('drops a position that arrives after the session ended, and sends nothing on leaving', async () => {
    const position = deferred<{ position: ReaderPosition; accepted: boolean }>()
    api.getPosition.mockReturnValue(position.promise)
    const { unmount } = render(view())
    act(() => clearSessionResidue())
    await act(async () => { position.resolve({ position: saved(), accepted: true }) })
    await settle()
    expect(handle.scrollToPos).not.toHaveBeenCalled()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS * 2) })
    unmount()
    expect(api.putPosition).not.toHaveBeenCalled()
  })

  it('shows the newest stored progress whatever order replies arrive in', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    const first = deferred<unknown>(), second = deferred<unknown>()
    api.putPosition.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    render(view())
    await settle()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS - POSITION_IDLE_MS) })
    await act(async () => { second.resolve({ position: saved({ revision: 2, furthest: { anchor: anchor(80), progress: 0.8 } }), accepted: true }) })
    await act(async () => { first.resolve({ position: saved({ revision: 1, furthest: { anchor: anchor(20), progress: 0.2 } }), accepted: true }) })
    fireEvent.click(screen.getByRole('button', { name: 'Reading progress' }))
    expect(screen.getByText('Read to 80%')).toBeInTheDocument()
  })

  it('does not report a reset the server did not accept as done', async () => {
    api.getPosition.mockResolvedValue({ position: saved(), accepted: true })
    api.putPosition.mockResolvedValue({ position: saved({ revision: 3 }), accepted: false })
    render(view())
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Reading progress' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make this my reading progress' }))
    await settle()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/^Not set/))
  })

  it('offers a retry when the position fails to load, and does not save until it has loaded', async () => {
    api.getPosition.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 })).mockResolvedValueOnce({ position: saved(), accepted: true })
    render(view())
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded')
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS * 2) })
    expect(api.putPosition).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(handle.scrollToPos).toHaveBeenCalledWith(40, shell())
  })

  it('shows a failed save and retries the same measurement on request', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    api.putPosition.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 })).mockResolvedValue({ position: saved({ revision: 2 }), accepted: true })
    render(view())
    await settle()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    // Before the dwell report (which would itself retry), the failure is visible.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Position not synced')).toBeInTheDocument()
    const failed = api.putPosition.mock.calls[0][3]
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.putPosition.mock.calls[1][3]).toEqual(failed)
    expect(screen.queryByText('Position not synced')).not.toBeInTheDocument()
  })

  it('retries a failed reset as a reset, with its own measurement time, and reports what the server did', async () => {
    api.getPosition.mockResolvedValue({ position: saved(), accepted: true })
    api.putPosition
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce({ position: saved({ revision: 4, furthest: { anchor: anchor(50), progress: 0.3 } }), accepted: true })
    render(view())
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Reading progress' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make this my reading progress' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const failed = api.putPosition.mock.calls[0][3]
    expect(failed.reset_furthest).toBe(true)
    expect(toasts.error).toHaveBeenCalledWith('Could not set your reading progress; try again later.')
    // An ordinary report failing meanwhile does not replace the reset waiting for its retry.
    handle.readingAnchor.mockImplementation(() => anchor(80))
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_IDLE_MS) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.putPosition.mock.calls[1][3].reset_furthest).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(api.putPosition.mock.calls[2][3]).toEqual(failed)
    expect(toasts.success).toHaveBeenCalledWith('Reading progress set to this position')
  })

  it('reports a retried reset the server did not accept as not set', async () => {
    api.getPosition.mockResolvedValue({ position: saved(), accepted: true })
    api.putPosition
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce({ position: saved({ revision: 4 }), accepted: false })
    render(view())
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Reading progress' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make this my reading progress' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(api.putPosition.mock.calls[1][3].reset_furthest).toBe(true)
    expect(toasts.success).not.toHaveBeenCalled()
    expect(toasts.error).toHaveBeenLastCalledWith(expect.stringMatching(/^Not set/))
  })

  it('shows no reading percentage, saved place or reset for a document without text, until its text arrives', async () => {
    api.getPosition.mockResolvedValue({ position: saved(), accepted: true })
    const empty = { ...doc(), plain_text: '', normalized_text: '', content_hash: 'empty', structure_hash: 'empty-tree', content_state: 'metadata_only' } as unknown as ReaderDocumentPayload
    const { rerender } = render(view(empty))
    await settle()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reading progress' })).not.toBeInTheDocument()
    fireEvent.scroll(shell())
    await act(async () => { vi.advanceTimersByTime(POSITION_DWELL_MS * 2) })
    fireEvent(window, new Event('pagehide'))
    expect(api.getPosition).not.toHaveBeenCalled()
    expect(api.putPosition).not.toHaveBeenCalled()
    // The prepared text arrives for the same document: the position is loaded and shown.
    rerender(view(doc()))
    await settle()
    expect(api.getPosition).toHaveBeenCalledWith('space-1', 'source_item', 'item-1')
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reading progress' })).toBeInTheDocument()
  })

  it('treats a short real text that fits on screen as read through, which is different from no text', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    render(view())
    await settle()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('leaves no window or document listeners behind after reading ten documents', async () => {
    api.getPosition.mockResolvedValue({ position: null, accepted: true })
    const count = (target: Window | Document) => {
      const live = new Map<string, number>()
      const originalAdd = target.addEventListener.bind(target), originalRemove = target.removeEventListener.bind(target)
      const add = vi.spyOn(target, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => { live.set(type, (live.get(type) ?? 0) + 1); originalAdd(type, listener as EventListenerOrEventListenerObject, options) })
      const remove = vi.spyOn(target, 'removeEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => { live.set(type, (live.get(type) ?? 0) - 1); originalRemove(type, listener as EventListenerOrEventListenerObject, options) })
      return { live, restore: () => { add.mockRestore(); remove.mockRestore() } }
    }
    const { rerender, unmount } = render(view(doc('item-0')))
    await settle()
    const onWindow = count(window), onDocument = count(document)
    for (let n = 1; n <= 10; n++) { rerender(view(doc(`item-${n}`))); await settle() }
    unmount()
    // Every listener added while switching was removed again, plus the ones of the first document.
    expect([...onWindow.live.values(), ...onDocument.live.values()].every(n => n <= 0)).toBe(true)
    onWindow.restore(); onDocument.restore()
  })
})
