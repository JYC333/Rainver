import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderAnnotation, ReaderDocumentPayload } from '../../../types/api'

const api = vi.hoisted(() => ({
  getPosition: vi.fn(), putPosition: vi.fn(), getAppearance: vi.fn(), putAppearance: vi.fn(),
  deleteAnnotation: vi.fn(), updateAnnotation: vi.fn(), listThreads: vi.fn(), createAnnotation: vi.fn(),
}))
vi.mock('../../../api/client', () => ({ readerApi: api }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
const reader = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
const handle = vi.hoisted(() => ({
  blockCount: vi.fn(() => 3), blockSelection: vi.fn(), scrollToBlock: vi.fn(),
  readingAnchor: vi.fn(() => null), locate: vi.fn(() => null), scrollToPos: vi.fn(),
  headings: vi.fn(() => [{ level: 2, text: 'Methods', pos: 30, blockIndex: 2 }]), find: vi.fn(() => 3), findGo: vi.fn(),
}))
vi.mock('../../editor/ReadOnlyTiptapReader', () => ({
  ReadOnlyTiptapReader: forwardRef(function Reader(props: Record<string, unknown>, ref) {
    reader.props = props
    useImperativeHandle(ref, () => handle)
    return <div data-testid="reader" />
  }),
}))

import { ReaderWorkspace } from '../ReaderWorkspace'

const doc = (id = 'item-1') => ({
  document_type: 'source_item', document_id: id, space_id: 'space-1', project_id: null, title: 'Article',
  plain_text: 'Alpha.', normalized_text: 'Alpha.', content_hash: 'hash-1', structure_hash: 'struct-1', content_format: 'tiptap_json',
  content_schema_version: 1, content_json: { type: 'doc', content: [] }, source_item_id: id,
}) as unknown as ReaderDocumentPayload
const annotation = (id: string, type = 'highlight'): ReaderAnnotation => ({
  id, space_id: 'space-1', project_id: null, document_type: 'source_item', document_id: 'item-1', annotation_type: type, quote_text: `Quote ${id}`,
  anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: `Quote ${id}`, text_range: { start: 0, end: 5 } },
  color: null, label: null, visibility: 'private', status: 'active', anchor_state: 'verified', created_by_user_id: 'user-1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}) as ReaderAnnotation
const selection = { quoteText: 'Alpha', selectionRect: null, anchorDraft: { quote_text: 'Alpha', text_range: { start: 0, end: 5, unit: 'utf16' }, before_context: '', after_context: '' } }

function Harness({ document = doc(), initial = [] as ReaderAnnotation[] }) {
  // Owns the list like the page wrappers do.
  const [items, setItems] = (globalThis as unknown as { React: typeof import('react') }).React.useState(initial)
  return <ReaderWorkspace document={document} annotations={items} onAnnotationsChange={setItems} />
}

beforeEach(async () => {
  ;(globalThis as unknown as { React: unknown }).React = await import('react')
  Object.values(api).forEach(fn => fn.mockReset())
  Object.values(toasts).forEach(fn => fn.mockReset())
  api.getAppearance.mockResolvedValue({ font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' })
  api.putAppearance.mockImplementation(async (value: unknown) => value)
  api.getPosition.mockResolvedValue({ position: null, accepted: true })
  api.putPosition.mockResolvedValue({ position: null, accepted: true })
  api.listThreads.mockResolvedValue({ items: [] })
  window.localStorage.clear()
  delete document.documentElement.dataset.readerFocus
})

const notebook = () => screen.getByRole('region', { name: 'Annotation notebook' })
const lastToastAction = () => (toasts.success.mock.calls[toasts.success.mock.calls.length - 1]?.[1] as { action: { label: string; onClick: () => void } }).action

describe('annotation feedback and undo', () => {
  it('keeps a new highlight quiet: no panel, no selection, a View action that opens it', async () => {
    window.localStorage.setItem('rainver:reader-layout', JSON.stringify({ outline: false, inspector: false }))
    api.createAnnotation.mockResolvedValue(annotation('ann-new'))
    render(<Harness />)
    act(() => { (reader.props!.onTextSelected as (value: unknown) => void)(selection) })
    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Highlighted', expect.anything()))
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
    act(() => lastToastAction().onClick())
    expect(within(screen.getByRole('complementary', { name: 'Reader inspector' })).getByRole('region', { name: 'Selected annotation' })).toHaveTextContent('Quote ann-new')
  })

  it('undoes a removal through the server, which restores the annotation with its comments', async () => {
    api.deleteAnnotation.mockResolvedValue(null)
    api.updateAnnotation.mockResolvedValue(annotation('ann-1'))
    render(<Harness initial={[annotation('ann-1')]} />)
    fireEvent.click(within(notebook()).getByRole('button', { name: /Quote ann-1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove annotation' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Annotation removed', expect.anything()))
    expect(within(notebook()).queryByRole('button', { name: /Quote ann-1/ })).not.toBeInTheDocument()
    expect(lastToastAction().label).toBe('Undo')
    await act(async () => lastToastAction().onClick())
    expect(api.updateAnnotation).toHaveBeenCalledWith('ann-1', { status: 'active' })
    expect(await within(notebook()).findByRole('button', { name: /Quote ann-1/ })).toBeInTheDocument()
  })

  it('does not put a restored annotation into a document opened since', async () => {
    api.deleteAnnotation.mockResolvedValue(null)
    let answer: (value: ReaderAnnotation) => void = () => {}
    api.updateAnnotation.mockReturnValue(new Promise(resolve => { answer = resolve }))
    const { rerender } = render(<Harness initial={[annotation('ann-1')]} />)
    fireEvent.click(within(notebook()).getByRole('button', { name: /Quote ann-1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove annotation' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Annotation removed', expect.anything()))
    act(() => lastToastAction().onClick())
    rerender(<Harness document={doc('item-2')} />)
    await act(async () => answer(annotation('ann-1')))
    expect(within(notebook()).queryByRole('button', { name: /Quote ann-1/ })).not.toBeInTheDocument()
  })
})

describe('copying a selection', () => {
  it('copies the text as it reads, not the collapsed quote used for anchoring', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      render(<Harness />)
      act(() => { (reader.props!.onTextSelected as (value: unknown) => void)({ ...selection, quoteText: 'def f(): return 1', selectedText: 'def f():\n    return  1' }) })
      fireEvent.click(screen.getByRole('button', { name: 'Copy text' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('def f():\n    return  1'))
    } finally { Reflect.deleteProperty(navigator, 'clipboard') }
  })
})

describe('notebook', () => {
  it('filters annotations by type and back to all', () => {
    render(<Harness initial={[annotation('ann-h'), annotation('ann-c', 'comment'), annotation('ann-e', 'excerpt')]} />)
    const filters = screen.getByRole('group', { name: 'Filter annotations by type' })
    fireEvent.click(within(filters).getByRole('button', { name: 'Comment 1' }))
    expect(within(notebook()).getAllByRole('button', { name: /Quote ann-/ }).map(button => button.textContent)).toEqual([expect.stringContaining('Quote ann-c')])
    fireEvent.click(within(filters).getByRole('button', { name: 'All 3' }))
    expect(within(notebook()).getAllByRole('button', { name: /Quote ann-/ })).toHaveLength(3)
  })
})

describe('Reader tools', () => {
  it('finds in the document and Escape returns to where finding started', async () => {
    render(<Harness />)
    const shell = document.querySelector('.reader-document-shell') as HTMLElement
    shell.scrollTo = vi.fn()
    shell.scrollTop = 120
    fireEvent.keyDown(window, { key: '/' })
    const field = screen.getByRole('textbox', { name: 'Find in this document' })
    fireEvent.change(field, { target: { value: 'alpha' } })
    await waitFor(() => expect(handle.find).toHaveBeenCalledWith('alpha'))
    await waitFor(() => expect(screen.getByText('1/3')).toBeInTheDocument())
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(handle.findGo).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(handle.find).toHaveBeenLastCalledWith('')
    expect(shell.scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'auto' })
  })

  it('hides the app’s navigation in focus mode and restores it on Escape or unmount', () => {
    const { unmount } = render(<Harness />)
    fireEvent.keyDown(window, { key: 'f' })
    expect(document.documentElement.dataset.readerFocus).toBe('true')
    expect(screen.getAllByRole('button', { name: 'Exit focus mode' }).length).toBeGreaterThan(0)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.documentElement.dataset.readerFocus).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Focus mode' }))
    unmount()
    expect(document.documentElement.dataset.readerFocus).toBeUndefined()
  })

  it('applies appearance at once, saves it to the person’s settings, and restores the defaults', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      render(<Harness />)
      fireEvent.click(screen.getByRole('button', { name: 'Reader appearance' }))
      fireEvent.click(screen.getByRole('button', { name: 'Larger text' }))
      fireEvent.click(screen.getByRole('button', { name: 'Sepia' }))
      const column = document.querySelector('.reader-column') as HTMLElement
      expect(column.style.getPropertyValue('--reader-font-size')).toBe('19px')
      expect(document.querySelector('.reader-document-shell')).toHaveAttribute('data-reader-theme', 'sepia')
      expect(api.putAppearance).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(600) })
      expect(api.putAppearance).toHaveBeenCalledTimes(1)
      expect(api.putAppearance).toHaveBeenCalledWith({ font_size: 19, line_height: 'normal', width: 'medium', font: 'sans', theme: 'sepia' })
      fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
      expect(column.style.getPropertyValue('--reader-font-size')).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens contents and inspector independently and remembers them for the next document', () => {
    const { unmount } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Show contents' }))
    const outline = screen.getByRole('navigation', { name: 'Contents' })
    fireEvent.click(within(outline).getByRole('button', { name: 'Methods' }))
    expect(handle.scrollToPos).toHaveBeenCalledWith(30, expect.any(HTMLElement), true)
    fireEvent.keyDown(window, { key: ']' })
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
    unmount()
    render(<Harness />)
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
  })

  it('enlarges only an image the reader rendered, with the address it already loaded', () => {
    render(<Harness />)
    act(() => { (reader.props!.onImageOpen as (value: unknown) => void)({ src: 'https://news.example/a.jpg', alt: 'Chart' }) })
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'https://news.example/a.jpg')
  })
})

describe('Reader panel width preferences', () => {
  it('validates stored widths and keeps the browser panel-open preferences on width changes', async () => {
    const { readReaderLayout, writeReaderLayout } = await import('../readerLayout')
    window.localStorage.setItem('rainver:reader-layout', JSON.stringify({ outline: true, inspector: false, outlineWidth: -100, inspectorWidth: 'bad' }))
    expect(readReaderLayout()).toMatchObject({ outline: true, inspector: false, outlineWidth: 200, inspectorWidth: 320 })
    writeReaderLayout({ inspectorWidth: 420 })
    expect(readReaderLayout()).toMatchObject({ outline: true, inspector: false, inspectorWidth: 420 })
    writeReaderLayout({ outline: false })
    expect(readReaderLayout()).toMatchObject({ outline: false, inspector: false, inspectorWidth: 420 })
  })
})


describe('Reader keyboard customization', () => {
  it('uses the new key immediately, rejects conflicts and restores defaults', async () => {
    render(<ReaderWorkspace document={doc()} annotations={[]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    const key = screen.getByRole('textbox', { name: /Enter or leave focus mode/ })
    fireEvent.change(key, { target: { value: 'x' } })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.keyDown(document.body, { key: 'f' })
    expect(screen.getByRole('button', { name: 'Focus mode' })).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'x' })
    expect(screen.getAllByRole('button', { name: 'Exit focus mode' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Enter or leave focus mode/ }), { target: { value: 'h' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Key is invalid')
    fireEvent.click(screen.getByRole('button', { name: 'Reset keyboard shortcuts' }))
    expect(screen.getByRole('textbox', { name: /Enter or leave focus mode/ })).toHaveValue('f')
  })
})

describe('opt-in automatic highlights', () => {
  it('does not write by default, permits explicit opt-in, and resets when the document changes', async () => {
    const view = render(<Harness document={{ ...doc(), can_annotate: true }} />)
    const commit = () => (reader.props?.onSelectionCommitted as (value: unknown) => void)(selection)
    act(commit)
    expect(api.createAnnotation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reader appearance' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Automatically highlight selected text/ }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    api.createAnnotation.mockResolvedValueOnce(annotation('auto-1'))
    act(commit)
    await waitFor(() => expect(api.createAnnotation).toHaveBeenCalledOnce())
    view.rerender(<Harness document={{ ...doc('item-2'), can_annotate: true }} />)
    act(commit)
    expect(api.createAnnotation).toHaveBeenCalledOnce()
  })

  it('refuses automatic creation when the document cannot be annotated', () => {
    render(<Harness document={doc()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reader appearance' }))
    expect(screen.getByRole('checkbox', { name: /Automatically highlight selected text/ })).toBeDisabled()
    act(() => (reader.props?.onSelectionCommitted as (value: unknown) => void)(selection))
    expect(api.createAnnotation).not.toHaveBeenCalled()
  })
})
