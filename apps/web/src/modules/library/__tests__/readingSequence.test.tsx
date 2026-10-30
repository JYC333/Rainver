import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../api/client', () => ({ informationDigestsApi: { reading: vi.fn(), readingState: vi.fn() } }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link, useNavigate } = await import('react-router-dom')
  return { SpaceLink: Link, useSpaceNavigate: useNavigate }
})
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import { informationDigestsApi } from '../../../api/client'
import { neighbours, readingReturnFor, readingSequenceFor, saveReadingReturn, saveReadingSequence, type ReadingSequence, type SequenceEntry } from '../readingSequence'
import { ReadingSequenceNav } from '../ReadingSequenceNav'
import { readingReturnTo } from '../readingLinks'
import { clearSessionResidue } from '../../../lib/sessionResidue'

const entry = (id: string, over: Partial<SequenceEntry> = {}): SequenceEntry => ({ source_item_id: id, key: `key-${id}`, reader_origin: 'library', full: true, topic_change_id: null, unread: true, ...over })
const sequence = (entries: SequenceEntry[], next_cursor: string | null = null): ReadingSequence => ({
  spaceId: 'space-a', projectId: null, returnTo: '/library/reading?sort=oldest', query: { view: 'pending', sort: 'oldest' }, entries, next_cursor,
})
const readingItem = (id: string) => ({ key: `key-${id}`, source_item_id: id, source_item_ids: [id], title: id, source_uri: null, occurred_at: null, summary: null, access_level: 'full', reader_origin: 'library', read_status: 'unread', dismissed: false, available_at: '2026-10-01T00:00:00.000Z', contributions: [], topics: [], material_links: [] })

function Where() { const location = useLocation(); return <p data-testid="where">{location.pathname}{location.search}</p> }
function nav(itemId: string, changeId: string | null = null) {
  return render(<MemoryRouter initialEntries={[`/library/items/${itemId}`]}><Routes><Route path="/library/items/:id" element={<><ReadingSequenceNav spaceId="space-a" itemId={itemId} changeId={changeId} returnTo="/library/reading?sort=oldest" /><Where /></>} /></Routes></MemoryRouter>)
}
const at = (itemId: string, changeId: string | null = null) => ({ itemId, changeId })

beforeEach(() => {
  window.sessionStorage.clear()
  vi.mocked(informationDigestsApi.reading).mockReset()
  vi.mocked(informationDigestsApi.readingState).mockReset()
  Object.values(toasts).forEach(fn => fn.mockReset())
})

describe('the kept Reading list', () => {
  it('offers neighbours in list order, skipping items the person may only see a summary of', () => {
    const list = sequence([entry('a'), entry('b', { full: false }), entry('c'), entry('d', { full: false })])
    expect(neighbours(list, at('c'))).toMatchObject({ previous: { source_item_id: 'a' }, next: null })
    expect(neighbours(list, at('a'))).toMatchObject({ previous: null, next: { source_item_id: 'c' } })
  })

  it('belongs to its Space and list address only', () => {
    saveReadingSequence(sequence([entry('a'), entry('b')]))
    expect(readingSequenceFor('space-a', '/library/reading?sort=oldest', at('b'))).not.toBeNull()
    expect(readingSequenceFor('space-b', '/library/reading?sort=oldest', at('b'))).toBeNull()
    expect(readingSequenceFor('space-a', '/library/reading', at('b'))).toBeNull()
    expect(readingSequenceFor('space-a', '/library/reading?sort=oldest', at('z'))).toBeNull()
  })

  it('remembers where the list was left for a while, not for ever', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      saveReadingReturn({ spaceId: 'space-a', returnTo: '/library/reading', key: 'key-a', loaded: 60 })
      expect(readingReturnFor('space-a', '/library/reading')).toMatchObject({ key: 'key-a', loaded: 60 })
      expect(readingReturnFor('space-b', '/library/reading')).toBeNull()
      vi.advanceTimersByTime(31 * 60_000)
      expect(readingReturnFor('space-a', '/library/reading')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('accepts the list order in a return address and nothing else new', () => {
    expect(readingReturnTo('/library/reading?sort=oldest')).toBe('/library/reading?sort=oldest')
    expect(readingReturnTo('/library/reading?view=read&sort=oldest')).toBe('/library/reading?view=read&sort=oldest')
    expect(readingReturnTo('/library/reading?sort=newest')).toBeNull()
    expect(readingReturnTo('/library/reading?sort=random')).toBeNull()
  })
})

describe('previous and next in the Reader', () => {
  it('links the neighbours with the same list address, and marks the ends', () => {
    saveReadingSequence(sequence([entry('a'), entry('b')]))
    nav('a')
    expect(screen.getByLabelText('First item in the list')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Next item' })).toHaveAttribute('href', '/library/items/b?from=library&returnTo=%2Flibrary%2Freading%3Fsort%3Doldest')
  })

  it('moves on only after the read is recorded, and stays on a failure', async () => {
    saveReadingSequence(sequence([entry('a'), entry('b')]))
    vi.mocked(informationDigestsApi.readingState).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ updated: 1 })
    nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Mark read and next' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not open the next item; you are still here: offline'))
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
    fireEvent.click(screen.getByRole('button', { name: 'Mark read and next' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/library/items/b'))
    expect(informationDigestsApi.readingState).toHaveBeenLastCalledWith('space-a', 'a', { read_status: 'read' }, undefined)
  })

  it('asks the server for the list’s next page at the end of the loaded rows, with the same query', async () => {
    saveReadingSequence(sequence([entry('a')], 'cursor-1'))
    vi.mocked(informationDigestsApi.reading).mockResolvedValue({ items: [readingItem('b')], next_cursor: null, total: 2 } as never)
    nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/library/items/b'))
    expect(informationDigestsApi.reading).toHaveBeenCalledWith('space-a', { view: 'pending', sort: 'oldest', cursor: 'cursor-1', limit: 30 }, undefined)
  })

  it('stays put when the list changed and its cursor is refused', async () => {
    saveReadingSequence(sequence([entry('a')], 'cursor-1'))
    vi.mocked(informationDigestsApi.reading).mockRejectedValue(Object.assign(new Error('Reading cursor is stale'), { status: 409 }))
    nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
  })

  it('tells apart rows of the same item for different topic updates', () => {
    saveReadingSequence(sequence([entry('a', { key: 'a-c1', topic_change_id: 'c1' }), entry('a', { key: 'a-c2', topic_change_id: 'c2' }), entry('b')]))
    nav('a', 'c2')
    expect(screen.getByRole('link', { name: 'Next item' })).toHaveAttribute('href', '/library/items/b?from=library&returnTo=%2Flibrary%2Freading%3Fsort%3Doldest')
    expect(JSON.parse(window.sessionStorage.getItem('rainver:reading-return')!).key).toBe('a-c2')
    cleanup()
    nav('a', 'c1')
    expect(screen.getByRole('link', { name: 'Next item' }).getAttribute('href')).toContain('change=c2')
    cleanup()
    // An ordinary row of the same item is its own row; the update row offers no "mark read".
    saveReadingSequence(sequence([entry('a'), entry('a', { key: 'a-c1', topic_change_id: 'c1' }), entry('b')]))
    nav('a', 'c1')
    expect(screen.queryByRole('button', { name: 'Mark read and next' })).not.toBeInTheDocument()
  })

  it('follows the list past pages of summary-only rows, and says so instead of claiming the end when it stops', async () => {
    const summaries = (from: number) => Array.from({ length: 3 }, (_, n) => ({ ...readingItem(`s${from + n}`), access_level: 'summary' }))
    saveReadingSequence(sequence([entry('a')], 'p1'))
    vi.mocked(informationDigestsApi.reading)
      .mockResolvedValueOnce({ items: summaries(0), next_cursor: 'p2', total: 9 } as never)
      .mockResolvedValueOnce({ items: [readingItem('b')], next_cursor: null, total: 9 } as never)
    nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/library/items/b'))
    cleanup()
    // Only summaries for longer than it follows: not "last item", a pointer back to the list.
    window.sessionStorage.clear()
    saveReadingSequence(sequence([entry('a')], 'q0'))
    vi.mocked(informationDigestsApi.reading).mockReset().mockImplementation(async (_space, query) => ({ items: summaries(Number(String(query?.cursor).slice(1)) * 3), next_cursor: `q${Number(String(query?.cursor).slice(1)) + 1}`, total: 99 }) as never)
    nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    await waitFor(() => expect(toasts.message).toHaveBeenCalledWith(expect.stringMatching(/only summaries/)))
    expect(informationDigestsApi.reading).toHaveBeenCalledTimes(5)
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('keeps no reply that arrives after the session ended', async () => {
    saveReadingSequence(sequence([entry('a')], 'p1'))
    let answer: (value: unknown) => void = () => {}
    vi.mocked(informationDigestsApi.reading).mockReturnValue(new Promise(resolve => { answer = resolve }) as never)
    nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    act(() => clearSessionResidue())
    await act(async () => answer({ items: [readingItem('b')], next_cursor: null, total: 2 }))
    expect(window.sessionStorage.getItem('rainver:reading-sequence')).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
  })

  it('keeps nothing from a reply that arrives after the Reader left, in the same session', async () => {
    saveReadingSequence(sequence([entry('a')], 'p1'))
    let answer: (value: unknown) => void = () => {}
    vi.mocked(informationDigestsApi.reading).mockReturnValue(new Promise(resolve => { answer = resolve }) as never)
    const rendered = nav('a')
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    rendered.unmount()
    window.sessionStorage.removeItem('rainver:reading-sequence')
    await act(async () => answer({ items: [readingItem('b')], next_cursor: null, total: 2 }))
    expect(window.sessionStorage.getItem('rainver:reading-sequence')).toBeNull()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('ignores a reply started before the Reader moved away and back to the same row (A→B→A)', async () => {
    saveReadingSequence(sequence([entry('a'), entry('b', { full: false })], 'p1'))
    let answer: (value: unknown) => void = () => {}
    vi.mocked(informationDigestsApi.reading).mockReturnValueOnce(new Promise(resolve => { answer = resolve }) as never)
    function Switching({ itemId }: { itemId: string }) {
      return <><ReadingSequenceNav spaceId="space-a" itemId={itemId} changeId={null} returnTo="/library/reading?sort=oldest" /><Where /></>
    }
    const view = (itemId: string) => <MemoryRouter initialEntries={['/library/items/a']}><Routes><Route path="/library/items/:id" element={<Switching itemId={itemId} />} /></Routes></MemoryRouter>
    const rendered = render(view('a'))
    fireEvent.click(screen.getByRole('button', { name: 'Next item' }))
    rendered.rerender(view('b'))
    rendered.rerender(view('a'))
    const before = window.sessionStorage.getItem('rainver:reading-sequence')
    await act(async () => answer({ items: [readingItem('c')], next_cursor: null, total: 3 }))
    expect(window.sessionStorage.getItem('rainver:reading-sequence')).toBe(before)
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
    // The current run is not left busy by the old one.
    expect(screen.getByRole('button', { name: 'Next item' })).toBeEnabled()
  })

  it('offers no "mark read" for an item already read or for a topic change, which has its own control', () => {
    saveReadingSequence(sequence([entry('a', { unread: false }), entry('b', { topic_change_id: 'change-1' })]))
    nav('a')
    expect(screen.queryByRole('button', { name: 'Mark read and next' })).not.toBeInTheDocument()
  })
})

describe('optional article swipes', () => {
  function touch(target: Element, type: string, x: number, y = 10) {
    const event = new Event(type, { bubbles: true })
    Object.assign(event, { pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y })
    fireEvent(target, event)
  }
  it('is opt-in, ignores tables and vertical scrolling, and only follows actual list neighbours', async () => {
    saveReadingSequence(sequence([entry('a'), entry('b')]))
    render(<MemoryRouter initialEntries={['/library/items/a']}><div className="reader-workspace">
      <ReadingSequenceNav spaceId="space-a" itemId="a" changeId={null} returnTo="/library/reading?sort=oldest" />
      <main className="reader-document-shell"><div className="reader-surface"><p>Ordinary text</p><table><tbody><tr><td>Wide table</td></tr></tbody></table></div></main><Where />
    </div></MemoryRouter>)
    const paragraph = screen.getByText('Ordinary text'), table = screen.getByText('Wide table')
    touch(paragraph, 'pointerdown', 200); touch(paragraph, 'pointerup', 20)
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
    fireEvent.click(screen.getByRole('button', { name: 'Swipe between articles' }))
    touch(table, 'pointerdown', 200); touch(table, 'pointerup', 20)
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
    touch(paragraph, 'pointerdown', 200); touch(paragraph, 'pointermove', 20, 90); touch(paragraph, 'pointerup', 20, 90)
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/a')
    touch(paragraph, 'pointerdown', 200); touch(paragraph, 'pointerup', 20)
    expect(screen.getByTestId('where')).toHaveTextContent('/library/items/b')
    expect(informationDigestsApi.readingState).not.toHaveBeenCalled()
  })
})
