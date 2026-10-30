import { forwardRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderAnnotation, ReaderCommentThread, ReaderDocumentPayload } from '../../../types/api'

const { listThreads, createComment, updateThread, createAnnotation, listAnnotations, updateAnnotationRange, documentNote, createDocumentNote } = vi.hoisted(() => ({ documentNote: vi.fn(), createDocumentNote: vi.fn(), updateAnnotationRange: vi.fn(), listAnnotations: vi.fn(), listThreads: vi.fn(), createComment: vi.fn(), updateThread: vi.fn(), createAnnotation: vi.fn() }))

vi.mock('../../../api/client', () => ({
  readerApi: { documentNote, createDocumentNote, updateAnnotationRange, listAnnotations, listThreads, createComment, updateThread, deleteAnnotation: vi.fn(), createEvidence: vi.fn(), createProposal: vi.fn(), createAnnotation, getAppearance: vi.fn(async () => ({ font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' })), getPosition: vi.fn(async () => ({ position: null, accepted: true })), putPosition: vi.fn(async () => ({ position: null, accepted: true })), putAppearance: vi.fn(async (value: unknown) => value), updateAnnotation: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The document itself is not under test; the real reader needs a browser
// layout the test environment does not have.
const reader = vi.hoisted(() => ({ onTextSelected: null as null | ((value: unknown) => void), onAnchorsResolved: null as null | ((value: Map<string, unknown>) => void), props: null as null | Record<string, unknown> }))
vi.mock('../../editor/ReadOnlyTiptapReader', () => ({
  ReadOnlyTiptapReader: forwardRef(function ReadOnlyTiptapReader(props: { onTextSelected?: (value: unknown) => void; onAnchorsResolved?: (value: Map<string, unknown>) => void }) {
    reader.onTextSelected = props.onTextSelected ?? null
    reader.onAnchorsResolved = props.onAnchorsResolved ?? null
    reader.props = props as Record<string, unknown>
    return <div data-testid="reader" />
  }),
}))

import { ReaderWorkspace } from '../ReaderWorkspace'
import { ReaderDocumentNote } from '../ReaderDocumentNote'
import { ReaderRangeEditor } from '../ReaderRangeEditor'
import type { ReadOnlyTiptapReaderHandle, TextSelection } from '../../editor/ReadOnlyTiptapReader'
import { ReaderAnnotationExport } from '../ReaderAnnotationExport'
import { __clearCommentDraftsForTests, __commentDraftCountForTests, readCommentDrafts, writeCommentDraft } from '../commentDrafts'
import { clearSessionResidue } from '../../../lib/sessionResidue'

const document: ReaderDocumentPayload = {
  document_type: 'source_item', document_id: 'item-1', space_id: 'space-1', project_id: null, title: 'Article',
  plain_text: 'Alpha. Beta.', normalized_text: 'Alpha. Beta.', content_hash: 'hash', content_format: 'tiptap_json',
  content_schema_version: 1, content_json: { type: 'doc', content: [] }, source_item_id: 'item-1', artifact_id: null, source_snapshot_id: null,
} as unknown as ReaderDocumentPayload

function annotation(id: string, quote: string): ReaderAnnotation {
  return {
    id, space_id: 'space-1', project_id: null, document_type: 'source_item', document_id: 'item-1', annotation_type: 'comment',
    quote_text: quote, anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: quote, text_range: { start: 0, end: 5 } },
    color: null, label: null, visibility: 'private', status: 'active', anchor_state: 'verified', created_by_user_id: 'user-1',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  } as ReaderAnnotation
}

function thread(id: string, annotationId: string, body: string): ReaderCommentThread {
  return {
    id, space_id: 'space-1', annotation_id: annotationId, status: 'open', created_by_user_id: 'user-1',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    comments: [{ id: `${id}-c`, space_id: 'space-1', thread_id: id, body, status: 'active', created_by_user_id: 'user-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }],
  } as ReaderCommentThread
}

const alpha = annotation('ann-a', 'Alpha')
const beta = annotation('ann-b', 'Beta')

beforeEach(() => {
  listThreads.mockReset()
  createComment.mockReset()
  updateThread.mockReset()
  __clearCommentDraftsForTests()
})

describe('ReaderWorkspace comment threads', () => {
  it('shows the threads of the annotation selected last, not of a slower earlier request', async () => {
    let answerAlpha: (value: { items: ReaderCommentThread[] }) => void = () => {}
    listThreads.mockImplementation((annotationId: string) => annotationId === 'ann-a'
      ? new Promise(resolve => { answerAlpha = resolve })
      : Promise.resolve({ items: [thread('t-b', 'ann-b', 'From Beta')] }))
    render(<ReaderWorkspace document={document} annotations={[alpha, beta]} onAnnotationsChange={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    expect(await screen.findByText('From Beta')).toBeInTheDocument()

    answerAlpha({ items: [thread('t-a', 'ann-a', 'From Alpha')] })
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2))
    expect(screen.getByText('From Beta')).toBeInTheDocument()
    expect(screen.queryByText('From Alpha')).toBeNull()
  })

  it('does not file a comment posted on one annotation under the annotation selected since', async () => {
    listThreads.mockImplementation((annotationId: string) => Promise.resolve({
      items: annotationId === 'ann-b' ? [thread('t-b', 'ann-b', 'From Beta')] : [],
    }))
    let answerComment: (value: { thread: ReaderCommentThread }) => void = () => {}
    createComment.mockImplementation(() => new Promise(resolve => { answerComment = resolve }))
    render(<ReaderWorkspace document={document} annotations={[alpha, beta]} onAnnotationsChange={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    expect(await screen.findByText('No comments yet.')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'Late reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(createComment).toHaveBeenCalledWith('ann-a', { body: 'Late reply' }))

    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    expect(await screen.findByText('From Beta')).toBeInTheDocument()
    answerComment({ thread: thread('t-a', 'ann-a', 'Late reply') })
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Late reply')).toBeNull()
    expect(screen.getByText('From Beta')).toBeInTheDocument()
  })
})

describe('ReaderWorkspace comment drafts', () => {
  beforeEach(() => { listThreads.mockResolvedValue({ items: [] }) })
  const field = () => screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement

  it('keeps each annotation’s draft, also across closing and reopening the inspector', async () => {
    render(<ReaderWorkspace document={document} annotations={[alpha, beta]} onAnnotationsChange={() => {}}
      header={({ togglePanel }) => <button onClick={togglePanel}>toggle</button>} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Draft for Alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    await waitFor(() => expect(field().value).toBe(''))
    fireEvent.change(field(), { target: { value: 'Draft for Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(field().value).toBe('Draft for Beta')
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(field().value).toBe('Draft for Alpha'))
  })

  it('clears only the sent text when a slow save lands, and keeps the draft when saving fails', async () => {
    let answer: (value: { thread: ReaderCommentThread }) => void = () => {}
    createComment.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
      .mockRejectedValueOnce(new Error('comment rejected'))
    render(<ReaderWorkspace document={document} annotations={[alpha, beta]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Sent from Alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    await waitFor(() => expect(field().value).toBe(''))
    fireEvent.change(field(), { target: { value: 'Typed in Beta meanwhile' } })
    answer({ thread: thread('t-a', 'ann-a', 'Sent from Alpha') })
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1))
    expect(field().value).toBe('Typed in Beta meanwhile')

    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(field().value).toBe(''))

    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    await waitFor(() => expect(field().value).toBe('Typed in Beta meanwhile'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(createComment).toHaveBeenLastCalledWith('ann-b', { body: 'Typed in Beta meanwhile' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled())
    expect(field().value).toBe('Typed in Beta meanwhile')
  })

  it('keeps an unsent comment when the Reader unmounts by any route, restores it, and discards only on request', async () => {
    const { unmount } = render(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Not sent yet' } })
    unmount() // Shell link, browser history, programmatic navigation: the component just goes away.

    render(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    expect(screen.getByText('1 unsent comment is kept here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(field().value).toBe('Not sent yet'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    expect(field().value).toBe('')
    expect(__commentDraftCountForTests()).toBe(0)
  })

  it('keeps drafts per Space and document, and clears every draft on logout or a 401', async () => {
    const otherSpace = { ...document, space_id: 'space-2' } as ReaderDocumentPayload
    const { unmount } = render(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Space one only' } })
    unmount()

    const second = render(<ReaderWorkspace document={otherSpace} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(field().value).toBe(''))
    second.unmount()

    expect(readCommentDrafts({ spaceId: 'space-1', documentType: 'source_item', documentId: 'item-1' })).toEqual({ 'ann-a': 'Space one only' })
    clearSessionResidue()
    expect(__commentDraftCountForTests()).toBe(0)
  })

  it('drops drafts of annotations that are no longer listed', async () => {
    const { rerender } = render(<ReaderWorkspace document={document} annotations={[alpha, beta]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Draft on Beta' } })
    rerender(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    expect(screen.queryByText(/unsent comment/)).not.toBeInTheDocument()
  })
})

describe('ReaderWorkspace comment threads ordering and status', () => {
  const field = () => screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement
  const deferredThreads = () => { let resolve!: (value: { items: ReaderCommentThread[] }) => void; let reject!: (error: unknown) => void; const promise = new Promise<{ items: ReaderCommentThread[] }>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }

  it('shows the newest list after A→B→A even when the first A request answers last', async () => {
    const first = deferredThreads()
    listThreads.mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve({ items: [thread('t-b', 'ann-b', 'From Beta')] }))
      .mockImplementationOnce(() => Promise.resolve({ items: [thread('t-a', 'ann-a', 'Newest Alpha')] }))
    render(<ReaderWorkspace document={document} annotations={[alpha, beta]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    expect(await screen.findByText('Newest Alpha')).toBeInTheDocument()
    first.resolve({ items: [] })
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(3))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByText('Newest Alpha')).toBeInTheDocument()
  })

  it('does not let a list fetched before a saved comment remove it; the list is fetched again', async () => {
    const stale = deferredThreads()
    listThreads.mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => Promise.resolve({ items: [thread('t-a', 'ann-a', 'Just saved')] }))
    createComment.mockResolvedValue({ thread: thread('t-a', 'ann-a', 'Just saved') })
    render(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    expect(screen.getByText('Loading comments…')).toBeInTheDocument()
    expect(screen.queryByText('No comments yet.')).not.toBeInTheDocument()
    fireEvent.change(field(), { target: { value: 'Just saved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByText('Just saved')).toBeInTheDocument()
    stale.resolve({ items: [] })
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Just saved')).toBeInTheDocument()
    expect(screen.queryByText('No comments yet.')).not.toBeInTheDocument()
  })

  it('does not let a list fetched before a resolve roll the thread back', async () => {
    const stale = deferredThreads()
    const open = thread('t-a', 'ann-a', 'Fresh comment')
    const resolved = { ...open, status: 'resolved' as const }
    listThreads.mockImplementationOnce(() => stale.promise).mockResolvedValueOnce({ items: [resolved] })
    createComment.mockResolvedValue({ thread: open })
    updateThread.mockResolvedValue(resolved)
    render(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(field(), { target: { value: 'Fresh comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }))
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    stale.resolve({ items: [open] })
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
  })

  it('shows a failed thread load as a failure with a retry, not as no comments', async () => {
    listThreads.mockRejectedValueOnce(Object.assign(new Error('threads unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ items: [thread('t-a', 'ann-a', 'Recovered comment')] })
    render(<ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    const alert = await screen.findByText('Comments could not be loaded. Nothing here means they are missing.')
    expect(screen.queryByText('No comments yet.')).not.toBeInTheDocument()
    expect(alert.closest('[role="alert"]')).toHaveTextContent('threads unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Recovered comment')).toBeInTheDocument()
  })
})

describe('ReaderWorkspace annotation creation ownership', () => {
  const selection = { quoteText: 'Alpha', selectionRect: null, anchorDraft: { quote_text: 'Alpha', text_range: { start: 0, end: 5, unit: 'utf16' }, before_context: '', after_context: '' } }
  const select = () => act(() => { reader.onTextSelected?.(selection) })

  it('frees a newly shown document at once while the previous document’s save runs, and the old save cannot free the new one', async () => {
    let answerOld: (value: ReaderAnnotation) => void = () => {}
    let answerNew: (value: ReaderAnnotation) => void = () => {}
    createAnnotation.mockReset()
      .mockImplementationOnce(() => new Promise(resolve => { answerOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { answerNew = resolve }))
    const second = { ...document, document_id: 'item-2', source_item_id: 'item-2' } as ReaderDocumentPayload
    const onChange = vi.fn()
    const { rerender } = render(<ReaderWorkspace document={document} annotations={[]} onAnnotationsChange={onChange} />)
    select()
    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeDisabled()

    rerender(<ReaderWorkspace document={second} annotations={[]} onAnnotationsChange={onChange} />)
    select()
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    expect(createAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({ document_id: 'item-2' }))

    await act(async () => { answerOld(annotation('old', 'Alpha')) })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeDisabled()
    await act(async () => { answerNew(annotation('new', 'Alpha')) })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('ReaderWorkspace stage-one rereview fixes', () => {
  const field = () => screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement
  const scope = { spaceId: 'space-1', documentType: 'source_item', documentId: 'item-1' }
  const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
  const forbidden = () => Object.assign(new Error('forbidden'), { status: 403 })
  const workspace = (props: Partial<Parameters<typeof ReaderWorkspace>[0]> = {}) =>
    <ReaderWorkspace document={document} annotations={[alpha]} onAnnotationsChange={() => {}} {...props} />

  async function openAlphaWithComment(text = 'Private old comment') {
    listThreads.mockResolvedValueOnce({ items: [thread('t-a', 'ann-a', text)] })
    const view = render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
    return view
  }

  // F1
  it('drops the shown quote and comments when the annotation list is refused, and ignores late replies', async () => {
    const late = deferred<{ items: ReaderCommentThread[] }>()
    const view = await openAlphaWithComment()
    fireEvent.change(field(), { target: { value: 'Draft on revoked' } })
    listThreads.mockImplementationOnce(() => late.promise)
    // Reselecting starts a thread read that will answer only after access is refused.
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    view.rerender(workspace({ annotations: [], annotationsStatus: { state: 'error', error: forbidden(), retry: () => {} } }))
    expect(screen.queryByText('Private old comment')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Selected annotation' })).not.toBeInTheDocument()
    await act(async () => { late.resolve({ items: [thread('t-a', 'ann-a', 'Late private comment')] }) })
    expect(screen.queryByText('Late private comment')).not.toBeInTheDocument()
  })

  it('keeps the selection and draft through an ordinary list failure', async () => {
    const view = await openAlphaWithComment()
    fireEvent.change(field(), { target: { value: 'Keep through 500' } })
    view.rerender(workspace({ annotationsStatus: { state: 'error', error: Object.assign(new Error('server error'), { status: 500 }), retry: () => {} } }))
    expect(screen.getByRole('region', { name: 'Selected annotation' })).toHaveTextContent('Alpha')
    expect(field().value).toBe('Keep through 500')
    expect(readCommentDrafts(scope)).toEqual({ 'ann-a': 'Keep through 500' })
  })

  it.each([
    ['removed from', [] as ReaderAnnotation[]],
    ['listed without its body in', [{ ...alpha, quote_text: '', anchor_json: {} } as unknown as ReaderAnnotation]],
  ])('drops the selection and its draft when the annotation is %s the authoritative list', async (_case, annotations) => {
    const view = await openAlphaWithComment()
    fireEvent.change(field(), { target: { value: 'Draft for a hidden body' } })
    view.rerender(workspace({ annotations }))
    expect(screen.queryByText('Private old comment')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Selected annotation' })).not.toBeInTheDocument()
    expect(readCommentDrafts(scope)).toEqual({})
  })

  it('drops the quote and draft when the threads themselves are refused', async () => {
    writeCommentDraft(scope, 'ann-a', 'Draft before refusal')
    listThreads.mockRejectedValueOnce(forbidden())
    render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected annotation' })).not.toBeInTheDocument())
    expect(readCommentDrafts(scope)).toEqual({})
  })

  // F2
  it('shows a send started before leaving as pending on return, never posts it twice, and rereads when it lands', async () => {
    const post = deferred<{ thread: ReaderCommentThread }>()
    listThreads.mockResolvedValue({ items: [] })
    createComment.mockImplementationOnce(() => post.promise)
    const first = render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Sent once' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    first.unmount()

    render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(field().value).toBe('Sent once'))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(createComment).toHaveBeenCalledTimes(1)

    listThreads.mockResolvedValueOnce({ items: [thread('t-a', 'ann-a', 'Sent once')] })
    await act(async () => { post.resolve({ thread: thread('t-a', 'ann-a', 'Sent once') }) })
    expect(await screen.findByText('Sent once', { selector: 'p' })).toBeInTheDocument()
    expect(field().value).toBe('')
    expect(createComment).toHaveBeenCalledTimes(1)
  })

  it('keeps a draft whose send failed after leaving, ready for an explicit retry', async () => {
    const post = deferred<{ thread: ReaderCommentThread }>()
    listThreads.mockResolvedValue({ items: [] })
    createComment.mockImplementationOnce(() => post.promise).mockResolvedValueOnce({ thread: thread('t-a', 'ann-a', 'Retry later') })
    const first = render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    fireEvent.change(await waitFor(field), { target: { value: 'Retry later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    first.unmount()
    await act(async () => { post.reject(new Error('network down')) })

    render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await waitFor(() => expect(field().value).toBe('Retry later'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(2))
  })

  // F3
  it.each([
    ['the comment POST answers after the resolve', true],
    ['the resolve answers after the comment POST', false],
  ])('keeps the new comment and the resolved status when %s', async (_case, postLast) => {
    const existing = thread('t-a', 'ann-a', 'Existing')
    const withComment = { ...existing, comments: [...existing.comments, ...thread('x', 'ann-a', 'New comment').comments] }
    listThreads.mockResolvedValueOnce({ items: [existing] })
      .mockResolvedValueOnce({ items: [{ ...withComment, status: 'resolved' }] })
    const post = deferred<{ thread: ReaderCommentThread }>()
    const resolve = deferred<ReaderCommentThread>()
    createComment.mockImplementationOnce(() => post.promise)
    updateThread.mockImplementationOnce(() => resolve.promise)
    render(workspace())
    fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
    await screen.findByText('Existing')
    fireEvent.change(field(), { target: { value: 'New comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    const first = postLast ? () => resolve.resolve({ ...existing, status: 'resolved' }) : () => post.resolve({ thread: { ...withComment, status: 'open' } })
    const second = postLast ? () => post.resolve({ thread: { ...withComment, status: 'open' } }) : () => resolve.resolve({ ...existing, status: 'resolved' })
    await act(async () => { first() })
    // Each confirmed change shows at once, without waiting for the other write.
    if (postLast) expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    else expect(screen.getByText('New comment', { selector: 'p' })).toBeInTheDocument()
    await act(async () => { second() })
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(screen.getByText('New comment', { selector: 'p' })).toBeInTheDocument()
  })

  // F4
  it('removes an expired draft from view on the next render and when the store sweeps it', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T00:00:00Z'), shouldAdvanceTime: true })
    try {
      writeCommentDraft(scope, 'ann-a', 'Expired secret')
      listThreads.mockResolvedValue({ items: [] })
      const view = render(workspace())
      fireEvent.click(screen.getByRole('button', { name: 'comment: Alpha' }))
      expect(field().value).toBe('Expired secret')
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
      view.rerender(workspace())
      expect(field().value).toBe('')
      expect(screen.queryByText(/unsent comment/)).not.toBeInTheDocument()

      act(() => writeCommentDraft(scope, 'ann-a', 'Expires while idle'))
      expect(field().value).toBe('Expires while idle')
      await act(async () => { vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 5) })
      expect(field().value).toBe('')
      expect(__commentDraftCountForTests()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

describe('ReaderWorkspace annotations the current text cannot place', () => {
  it('passes the document versions to the reader and lists unlocated annotations with their quote and comments', async () => {
    listThreads.mockResolvedValue({ items: [thread('t-b', 'ann-b', 'Comment kept on Beta')] })
    const versioned = { ...document, content_hash: 'text-v2', structure_hash: 'tree-v2' } as ReaderDocumentPayload
    render(<ReaderWorkspace document={versioned} annotations={[alpha, beta]} onAnnotationsChange={() => {}} />)
    expect(reader.props?.documentVersion).toEqual({ contentHash: 'text-v2', structureHash: 'tree-v2' })
    act(() => reader.onAnchorsResolved?.(new Map([['ann-a', { state: 'located', from: 1, to: 6, by: 'range' }], ['ann-b', { state: 'unlocated', reason: 'ambiguous' }]])))
    expect(screen.getByText('The text has changed: 1 annotation cannot be placed in it. Its quote and comments are kept below.')).toBeInTheDocument()
    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    expect(notebook).toHaveTextContent('Not located')
    fireEvent.click(screen.getByRole('button', { name: 'comment: Beta' }))
    expect(await screen.findByText('Comment kept on Beta')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Selected annotation' })).toHaveTextContent('Beta')
    expect(screen.getByText(/no longer shows which/)).toBeInTheDocument()
  })
})


describe('authorized annotation quote export', () => {
  it('reads a fresh list and excludes archived, withheld and unrelated annotations', async () => {
    const active = annotation('readable', 'Current authorized quote')
    listAnnotations.mockResolvedValueOnce({ items: [active, { ...annotation('archived', 'Archived secret'), status: 'archived' }, { ...annotation('withheld', ''), anchor_json: {} }, { ...annotation('other', 'Other document'), document_id: 'other' }] })
    const create = vi.fn((_blob: Blob) => 'blob:quotes')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ReaderAnnotationExport documentType="source_item" documentId="item-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export annotation quotes' }))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(listAnnotations).toHaveBeenCalledWith('source_item', 'item-1')
    const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(create.mock.calls[0][0]) })
    expect(text).toContain('Current authorized quote')
    expect(text).not.toContain('Archived secret')
    expect(text).not.toContain('Other document')
    expect(JSON.parse(text).quotes).toHaveLength(1)
    click.mockRestore(); vi.unstubAllGlobals()
  })

  it('downloads nothing on authorization refusal or a late response after unmount', async () => {
    const create = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
    listAnnotations.mockRejectedValueOnce({ status: 403 })
    const view = render(<ReaderAnnotationExport documentType="source_item" documentId="item-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export annotation quotes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export annotation quotes' })).not.toBeDisabled())
    let finish!: (value: unknown) => void
    listAnnotations.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Export annotation quotes' }))
    view.unmount()
    await act(async () => finish({ items: [annotation('late', 'Late quote')] }))
    expect(create).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})


describe('range editing confirmation', () => {
  const selected = (from = 1, to = 6) => ({ quoteText: 'Alpha', selectedText: 'Alpha', selectionRect: null, anchorDraft: { quote_text: 'Alpha', before_context: '', after_context: ' Beta.', text_range: { start: 0, end: 5, unit: 'utf16' }, tiptap_range: { from, to } } }) as TextSelection
  const handle = { documentSize: () => 14, rangeSelection: (from: number, to: number) => selected(from, to) } as ReadOnlyTiptapReaderHandle
  it('previews without writing and leaves the original intact on cancel', () => {
    const cancel = vi.fn(), saved = vi.fn()
    updateAnnotationRange.mockReset()
    render(<ReaderRangeEditor annotation={alpha} document={{ ...document, structure_hash: 'tree' }} initial={selected()} reader={handle} live={() => true} onSaved={saved} onCancel={cancel} />)
    fireEvent.change(screen.getByRole('slider', { name: 'End' }), { target: { value: 12 } })
    expect(updateAnnotationRange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled()
  })
  it('keeps a failed preview for retry, then applies only a confirmed current response', async () => {
    const saved = vi.fn(); let live = true
    updateAnnotationRange.mockRejectedValueOnce(new Error('Conflict'))
    const view = render(<ReaderRangeEditor annotation={alpha} document={{ ...document, structure_hash: 'tree' }} initial={selected()} reader={handle} live={() => live} onSaved={saved} onCancel={() => { live = false }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save range' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflict')
    expect(saved).not.toHaveBeenCalled()
    let finish!: (value: ReaderAnnotation) => void
    updateAnnotationRange.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Save range' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    live = false; view.unmount()
    await act(async () => finish({ ...alpha, quote_text: 'New quote' }))
    expect(saved).not.toHaveBeenCalled()
  })
})


it('range save releases its own pending state when authority becomes invalid without applying the reply', async () => {
  const initial = { quoteText: 'Alpha', selectedText: 'Alpha', selectionRect: null, anchorDraft: { quote_text: 'Alpha', text_range: { start: 0, end: 5, unit: 'utf16' }, before_context: '', after_context: ' Beta.', tiptap_range: { from: 1, to: 6 } } } as TextSelection
  const handle = { documentSize: () => 14, rangeSelection: () => initial } as unknown as ReadOnlyTiptapReaderHandle
  let accepted = true; let finish!: (value: ReaderAnnotation) => void
  updateAnnotationRange.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const saved = vi.fn(), pending = vi.fn()
  render(<ReaderRangeEditor annotation={alpha} document={{ ...document, structure_hash: 'tree' }} initial={initial} reader={handle}
    authority={{ begin: () => ({ scopeKey: 'doc', epoch: 1 }), accepts: () => accepted }} live={() => true} onSaved={saved} onPendingChange={pending} onCancel={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }))
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  accepted = false
  await act(async () => finish({ ...alpha, quote_text: 'New quote' }))
  expect(saved).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled()
  expect(pending).toHaveBeenLastCalledWith(false)
})


describe('document notes use Notes explicitly', () => {
  it('reads without creating, then confirms a private note and opens its actual Personal Space', async () => {
    documentNote.mockResolvedValueOnce({ note: null })
    createDocumentNote.mockResolvedValueOnce({ note: { id: 'my-note', space_id: 'personal-space', status: 'active' } })
    render(<ReaderDocumentNote spaceId="team-space" documentType="source_item" documentId="article" />)
    expect(documentNote).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Document note' }))
    await screen.findByRole('button', { name: 'Create private document note' })
    expect(createDocumentNote).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Create private document note' }))
    expect(await screen.findByRole('link', { name: 'Open in Notes' })).toHaveAttribute('href', '/spaces/personal-space/knowledge/notes/my-note')
    expect(createDocumentNote).toHaveBeenCalledWith('source_item', 'article', 'Document notes')
  })
  it('does not expose an old note after switching documents or a refused request', async () => {
    let finish!: (value: unknown) => void
    documentNote.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockRejectedValueOnce({ status: 403, message: 'Denied' })
    const view = render(<ReaderDocumentNote spaceId="team-space" documentType="source_item" documentId="A" />)
    fireEvent.click(screen.getByRole('button', { name: 'Document note' }))
    view.rerender(<ReaderDocumentNote spaceId="team-space" documentType="source_item" documentId="B" />)
    await act(async () => finish({ note: { id: 'old-private-note', space_id: 'personal', status: 'active' } }))
    expect(screen.queryByRole('link', { name: 'Open in Notes' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Document note' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('link', { name: 'Open in Notes' })).not.toBeInTheDocument()
  })
})
