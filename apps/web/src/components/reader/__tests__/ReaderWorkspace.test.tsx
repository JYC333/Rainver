import { forwardRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderAnnotation, ReaderCommentThread, ReaderDocumentPayload } from '../../../types/api'

const { listThreads, createComment } = vi.hoisted(() => ({ listThreads: vi.fn(), createComment: vi.fn() }))

vi.mock('../../../api/client', () => ({
  readerApi: { listThreads, createComment, updateThread: vi.fn(), deleteAnnotation: vi.fn(), createEvidence: vi.fn(), createProposal: vi.fn(), createAnnotation: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The document itself is not under test; the real reader needs a browser
// layout the test environment does not have.
vi.mock('../../editor/ReadOnlyTiptapReader', () => ({
  ReadOnlyTiptapReader: forwardRef(function ReadOnlyTiptapReader() { return <div data-testid="reader" /> }),
}))

import { ReaderWorkspace } from '../ReaderWorkspace'

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
