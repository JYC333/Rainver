import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import LibraryItemReaderPage from '../LibraryItemReaderPage'
import { readerApi, sourcesApi } from '../../../api/client'
import type { TextSelection } from '../../../components/editor/ReadOnlyTiptapReader'
import type {
  ReaderAnnotation,
  ReaderCommentThread,
  ReaderDocumentPayload,
  SourcePostProcessingBriefingDetail,
} from '../../../types/api'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return {
    SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
      <Link to={to} {...props}>{children}</Link>
    ),
  }
})

vi.mock('../../../api/client', () => ({
  sourcesApi: {
    itemAction: vi.fn(),
    jobs: vi.fn(),
    runJob: vi.fn(),
    briefing: vi.fn(),
  },
  readerApi: {
    getDocument: vi.fn(),
    listAnnotations: vi.fn(),
    createAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    listThreads: vi.fn(),
    createComment: vi.fn(),
    updateThread: vi.fn(),
    createEvidence: vi.fn(),
    createProposal: vi.fn(),
  },
}))

// The page is tested against the reader's contract: capture the props the page
// passes down, drive onTextSelected/onAnnotationClick from the tests, and
// expose a fake imperative block handle for the keyboard flow.
let readerProps: {
  normalizedText: string
  focusedBlockIndex?: number | null
  onTextSelected?: (selection: TextSelection | null) => void
  onBlockFocused?: (index: number | null) => void
  onAnnotationClick?: (annotationId: string) => void
} | null = null

const blockHandle = {
  blockCount: vi.fn(() => 2),
  blockSelection: vi.fn(),
  scrollToBlock: vi.fn(),
}

vi.mock('../../../components/editor/ReadOnlyTiptapReader', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    ReadOnlyTiptapReader: forwardRef((props: never, ref) => {
      readerProps = props
      useImperativeHandle(ref, () => blockHandle)
      return <div data-testid="reader-content">{(props as { normalizedText: string }).normalizedText}</div>
    }),
  }
})

const mockedApi = vi.mocked(readerApi)
const mockedSourcesApi = vi.mocked(sourcesApi)

const docPayload: ReaderDocumentPayload = {
  document_type: 'source_item',
  document_id: 'item-1',
  space_id: 'space-1',
  project_id: null,
  title: 'Signals in Long-Form Reading',
  plain_text: 'First paragraph.\n\nSecond paragraph.',
  normalized_text: 'First paragraph. Second paragraph.',
  content_hash: 'hash-1',
  content_format: 'tiptap_json',
  content_schema_version: 1,
  content_json: { type: 'doc', content: [] },
  source_item_id: 'item-1',
  artifact_id: null,
  source_snapshot_id: null,
  raw_artifact_id: null,
  extracted_artifact_id: null,
  source_uri: 'https://example.test/article',
  content_state: 'content_saved',
  retention_policy: null,
  can_annotate: true,
}

function makeAnnotation(overrides: Partial<ReaderAnnotation> = {}): ReaderAnnotation {
  return {
    id: 'ann-1',
    space_id: 'space-1',
    project_id: null,
    document_type: 'source_item',
    document_id: 'item-1',
    annotation_type: 'highlight',
    quote_text: 'First paragraph.',
    anchor_json: {
      schema_version: 1,
      normalizer: 'plain_text_v1',
      quote_text: 'First paragraph.',
      text_range: { start: 0, end: 16, unit: 'utf16' },
      before_context: '',
      after_context: ' Second paragraph.',
      tiptap_range: { from: 1, to: 17 },
    },
    color: null,
    label: null,
    visibility: 'private',
    status: 'active',
    anchor_state: 'verified',
    created_by_user_id: 'user-1',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

const textSelection: TextSelection = {
  quoteText: 'Second paragraph.',
  selectionRect: null,
  anchorDraft: {
    quote_text: 'Second paragraph.',
    text_range: { start: 17, end: 34, unit: 'utf16' },
    before_context: 'First paragraph. ',
    after_context: '',
    tiptap_range: { from: 19, to: 36 },
    block_ref: { index: 1, node_type: 'paragraph', from: 18, to: 37 },
  },
}

function makeThread(overrides: Partial<ReaderCommentThread> = {}): ReaderCommentThread {
  return {
    id: 'thread-1',
    space_id: 'space-1',
    annotation_id: 'ann-1',
    status: 'open',
    created_by_user_id: 'user-1',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    comments: [{
      id: 'comment-1',
      space_id: 'space-1',
      thread_id: 'thread-1',
      body: 'Existing comment body',
      status: 'active',
      created_by_user_id: 'user-1',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
    ...overrides,
  }
}

async function renderPage(initialEntry = '/library/items/item-1') {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} />
        <Route path="/library/digests/:connectionId/:date/items/:itemId" element={<LibraryItemReaderPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByTestId('reader-content')
}

function makeBriefing(overrides: Partial<SourcePostProcessingBriefingDetail> = {}): SourcePostProcessingBriefingDetail {
  return {
    source_channel_id: 'channel-1',
    connection_name: 'arXiv: 3dgs',
    project_id: null,
    date: '2026-07-07',
    runs: [],
    digests: [],
    item_summaries: [],
    item_decisions: [],
    ...overrides,
  }
}

function makeDecision(
  itemId: string,
  relevance: SourcePostProcessingBriefingDetail['item_decisions'][number]['relevance'],
): SourcePostProcessingBriefingDetail['item_decisions'][number] {
  return {
    id: `decision-${itemId}`,
    space_id: 'space-1',
    source_channel_id: 'channel-1',
    rule_id: 'rule-1',
    run_id: 'run-1',
    project_id: null,
    source_item_id: itemId,
    relevance,
    confidence: 0.8,
    reason: null,
    matched_context_refs: [],
    review_status: 'pending' as const,
    action_json: {},
    item: {
      title: `Item ${itemId}`,
      source_uri: null,
      source_domain: null,
      author: null,
      library_status: 'new',
      read_status: 'unread',
      content_state: 'excerpt_saved',
    },
    rule_name: 'Screening',
    run_status: 'succeeded',
    run_created_at: '2026-07-07T00:00:00.000Z',
    created_at: '2026-07-07T00:00:00.000Z',
    updated_at: '2026-07-07T00:00:00.000Z',
  }
}

function simulateSelection(selection: TextSelection | null) {
  act(() => { readerProps?.onTextSelected?.(selection) })
}

beforeEach(() => {
  vi.clearAllMocks()
  blockHandle.blockSelection.mockReset()
  readerProps = null
  mockedApi.getDocument.mockResolvedValue(docPayload)
  mockedApi.listAnnotations.mockResolvedValue({ items: [makeAnnotation()] })
  mockedApi.listThreads.mockResolvedValue({ items: [] })
  mockedSourcesApi.jobs.mockResolvedValue({ items: [], total: 0, limit: 1, offset: 0 })
})

describe('LibraryItemReaderPage', () => {
  it('loads the reader document and active annotations', async () => {
    await renderPage()

    expect(mockedApi.getDocument).toHaveBeenCalledWith('source_item', 'item-1')
    expect(mockedApi.listAnnotations).toHaveBeenCalledWith('source_item', 'item-1')
    expect(screen.getByText('Signals in Long-Form Reading')).toBeInTheDocument()
    expect(screen.getByTestId('reader-content')).toHaveTextContent('First paragraph.')
  })

  it('renders existing annotations in the notebook list', async () => {
    await renderPage()

    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    expect(notebook).toHaveTextContent('First paragraph.')
    expect(notebook).toHaveTextContent('highlight')
  })

  it('shows the selection toolbar for a text selection and hides it for empty selections', async () => {
    await renderPage()

    expect(screen.queryByRole('toolbar', { name: 'Annotate selection' })).not.toBeInTheDocument()

    simulateSelection(textSelection)
    expect(screen.getByRole('toolbar', { name: 'Annotate selection' })).toBeInTheDocument()

    simulateSelection(null)
    expect(screen.queryByRole('toolbar', { name: 'Annotate selection' })).not.toBeInTheDocument()
  })

  it('creates a highlight from the toolbar with the document target and anchor payload', async () => {
    const created = makeAnnotation({
      id: 'ann-2',
      quote_text: 'Second paragraph.',
      anchor_json: {
        ...makeAnnotation().anchor_json,
        quote_text: 'Second paragraph.',
        tiptap_range: { from: 19, to: 36 },
      },
    })
    mockedApi.createAnnotation.mockResolvedValue(created)
    await renderPage()

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))

    expect(mockedApi.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      document_type: 'source_item',
      document_id: 'item-1',
      annotation_type: 'highlight',
      quote_text: 'Second paragraph.',
      anchor_json: expect.objectContaining({
        schema_version: 1,
        normalizer: 'plain_text_v1',
        quote_text: 'Second paragraph.',
        text_range: { start: 17, end: 34, unit: 'utf16' },
        tiptap_range: { from: 19, to: 36 },
        block_ref: { index: 1, node_type: 'paragraph', from: 18, to: 37 },
        content_hash: 'hash-1',
        document_ref: { document_type: 'source_item', document_id: 'item-1' },
      }),
    }))

    // The created annotation is appended, selected, and the selection is cleared.
    const detail = await screen.findByRole('region', { name: 'Selected annotation' })
    expect(detail).toHaveTextContent('Second paragraph.')
    expect(screen.queryByRole('toolbar', { name: 'Annotate selection' })).not.toBeInTheDocument()
    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    expect(notebook).toHaveTextContent('Second paragraph.')
  })

  it('re-extracts the current item from the reader header and reloads the document', async () => {
    const updatedDoc = {
      ...docPayload,
      content_hash: 'hash-2',
      normalized_text: 'Fresh structured text.',
    }
    mockedApi.getDocument
      .mockResolvedValueOnce(docPayload)
      .mockResolvedValueOnce(updatedDoc)
    mockedSourcesApi.itemAction.mockResolvedValue({} as never)
    const pendingJob = {
        id: 'extract-job-1',
        space_id: 'space-1',
        connection_id: null,
        source_item_id: 'item-1',
        source_object_type: null,
        source_object_id: null,
        source_snapshot_id: null,
        job_type: 'extract_text',
        status: 'pending',
        error_code: null,
        error_message: null,
        items_seen: null,
        items_created: null,
        items_updated: null,
        started_at: null,
        completed_at: null,
        created_at: '2026-07-01T00:00:00.000Z',
        metadata_json: null,
      }
    mockedSourcesApi.jobs.mockImplementation(async params => ({
      items: params?.status === 'pending' ? [pendingJob] : [],
      total: params?.status === 'pending' ? 1 : 0,
      limit: 1,
      offset: 0,
    }))
    mockedSourcesApi.runJob.mockResolvedValue({ status: 'succeeded' } as never)
    await renderPage()

    await userEvent.click(screen.getByRole('button', { name: 'Re-extract' }))

    await waitFor(() => {
      expect(mockedSourcesApi.itemAction).toHaveBeenCalledWith('item-1', 'queue_content')
      expect(mockedSourcesApi.jobs).toHaveBeenCalledWith({
        source_item_id: 'item-1',
        job_type: 'extract_text',
        status: 'pending',
        limit: 1,
      })
      expect(mockedSourcesApi.runJob).toHaveBeenCalledWith('extract-job-1')
      expect(screen.getByTestId('reader-content')).toHaveTextContent('Fresh structured text.')
    })
  })

  it('shows the recorded extraction failure on the reader page', async () => {
    mockedApi.getDocument.mockResolvedValue({ ...docPayload, content_state: 'extraction_failed' })
    mockedSourcesApi.jobs.mockResolvedValue({
      items: [{
        id: 'extract-job-failed',
        space_id: 'space-1',
        connection_id: 'conn-1',
        source_item_id: 'item-1',
        source_snapshot_id: null,
        source_object_type: null,
        source_object_id: null,
        job_type: 'extract_text',
        status: 'failed',
        started_at: '2026-07-02T10:00:00.000Z',
        completed_at: '2026-07-02T10:01:00.000Z',
        items_seen: null,
        items_created: null,
        items_updated: null,
        error_code: '502',
        error_message: 'The source page rejected the request.',
        metadata_json: null,
        created_at: '2026-07-02T10:00:00.000Z',
      }],
      total: 1,
      limit: 1,
      offset: 0,
    })

    await renderPage()

    expect(screen.getByRole('alert')).toHaveTextContent('Text extraction failed')
    expect(screen.getByRole('alert')).toHaveTextContent('The source page rejected the request.')
    expect(mockedSourcesApi.jobs).toHaveBeenCalledWith({
      source_item_id: 'item-1',
      job_type: 'extract_text',
      limit: 1,
    })
  })

  it('hides an older failed extraction when the latest extraction succeeded', async () => {
    mockedApi.getDocument.mockResolvedValue({ ...docPayload, content_state: 'content_saved' })
    mockedSourcesApi.jobs.mockResolvedValue({
      items: [{
        id: 'extract-job-succeeded', space_id: 'space-1', connection_id: 'conn-1', source_item_id: 'item-1',
        source_snapshot_id: null, source_object_type: null, source_object_id: null, job_type: 'extract_text', status: 'succeeded',
        started_at: '2026-07-02T10:00:00.000Z', completed_at: '2026-07-02T10:01:00.000Z',
        items_seen: null, items_created: null, items_updated: null, error_code: null, error_message: null,
        metadata_json: null, created_at: '2026-07-02T10:00:00.000Z',
      }], total: 1, limit: 1, offset: 0,
    })

    await renderPage()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the selection when annotation creation fails', async () => {
    mockedApi.createAnnotation.mockRejectedValue(new Error('nope'))
    await renderPage()

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))

    await waitFor(() => {
      expect(screen.getByRole('toolbar', { name: 'Annotate selection' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeEnabled()
  })

  it('loads comment threads when an existing annotation is selected from the notebook', async () => {
    mockedApi.listThreads.mockResolvedValue({ items: [makeThread()] })
    await renderPage()

    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    await userEvent.click(notebook.querySelector('button')!)

    expect(mockedApi.listThreads).toHaveBeenCalledWith('ann-1')
    const detail = await screen.findByRole('region', { name: 'Selected annotation' })
    expect(detail).toHaveTextContent('Existing comment body')
  })

  it('creates a comment annotation, opens the inspector, and focuses the comment field', async () => {
    const created = makeAnnotation({ id: 'ann-3', annotation_type: 'comment' })
    mockedApi.createAnnotation.mockResolvedValue(created)
    await renderPage()

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(mockedApi.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      annotation_type: 'comment',
    }))
    const commentInput = await screen.findByPlaceholderText('Add a comment…')
    await waitFor(() => expect(commentInput).toHaveFocus())
  })

  it('submits a comment and shows the updated thread', async () => {
    mockedApi.listThreads.mockResolvedValue({ items: [] })
    mockedApi.createComment.mockResolvedValue({
      thread: makeThread({
        comments: [{
          id: 'comment-2',
          space_id: 'space-1',
          thread_id: 'thread-1',
          body: 'A fresh thought',
          status: 'active',
          created_by_user_id: 'user-1',
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        }],
      }),
    })
    await renderPage()

    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    await userEvent.click(notebook.querySelector('button')!)
    await screen.findByRole('region', { name: 'Selected annotation' })

    await userEvent.type(screen.getByPlaceholderText('Add a comment…'), 'A fresh thought')
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    expect(mockedApi.createComment).toHaveBeenCalledWith('ann-1', { body: 'A fresh thought' })
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Selected annotation' }))
        .toHaveTextContent('A fresh thought')
    })
  })

  it('keeps reader content and the selected annotation across inspector collapse/reopen', async () => {
    await renderPage()

    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    await userEvent.click(notebook.querySelector('button')!)
    await screen.findByRole('region', { name: 'Selected annotation' })

    await userEvent.click(screen.getByRole('button', { name: 'Close inspector' }))
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
    expect(screen.getByTestId('reader-content')).toHaveTextContent('First paragraph.')

    await userEvent.click(screen.getByRole('button', { name: 'Show inspector' }))
    const detail = await screen.findByRole('region', { name: 'Selected annotation' })
    expect(detail).toHaveTextContent('First paragraph.')
  })

  it('clears item-scoped annotation state when navigating to another item in the same day', async () => {
    mockedSourcesApi.briefing.mockResolvedValue(makeBriefing({
      item_decisions: [
        makeDecision('item-1', 'relevant'),
        makeDecision('item-2', 'maybe'),
      ],
    }))
    mockedApi.getDocument
      .mockResolvedValueOnce(docPayload)
      .mockResolvedValueOnce({
        ...docPayload,
        document_id: 'item-2',
        source_item_id: 'item-2',
        title: 'Second item',
        normalized_text: 'Next item text.',
      })
    mockedApi.listAnnotations
      .mockResolvedValueOnce({ items: [makeAnnotation()] })
      .mockResolvedValueOnce({
        items: [makeAnnotation({
          id: 'ann-2',
          document_id: 'item-2',
          quote_text: 'Next item quote.',
          anchor_json: {
            ...makeAnnotation().anchor_json,
            quote_text: 'Next item quote.',
          },
        })],
      })
    mockedApi.listThreads.mockResolvedValue({ items: [makeThread()] })

    await renderPage('/library/digests/conn-1/2026-07-07/items/item-1')

    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    await userEvent.click(notebook.querySelector('button')!)
    expect(await screen.findByRole('region', { name: 'Selected annotation' })).toHaveTextContent('First paragraph.')
    expect(await screen.findByText('Existing comment body')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'Next item' }))

    await waitFor(() => {
      expect(mockedApi.getDocument).toHaveBeenLastCalledWith('source_item', 'item-2')
    })
    expect(await screen.findByText('Second item')).toBeInTheDocument()
    expect(screen.getByTestId('reader-content')).toHaveTextContent('Next item text.')
    expect(screen.queryByRole('region', { name: 'Selected annotation' })).not.toBeInTheDocument()
    expect(screen.queryByText('Existing comment body')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Annotation notebook' })).toHaveTextContent('Next item quote.')
  })

  it('moves paragraph focus with arrows and highlights the focused paragraph with H', async () => {
    const blockSelection: TextSelection = {
      quoteText: 'First paragraph.',
      selectionRect: null,
      anchorDraft: {
        quote_text: 'First paragraph.',
        text_range: { start: 0, end: 16, unit: 'utf16' },
        before_context: '',
        after_context: ' Second paragraph.',
        tiptap_range: { from: 1, to: 17 },
        block_ref: { index: 0, node_type: 'paragraph', from: 0, to: 18 },
      },
    }
    blockHandle.blockSelection.mockReturnValue(blockSelection)
    mockedApi.createAnnotation.mockResolvedValue(makeAnnotation({ id: 'ann-kb' }))
    await renderPage()

    await userEvent.keyboard('{ArrowDown}')
    expect(readerProps?.focusedBlockIndex).toBe(0)
    expect(blockHandle.scrollToBlock).toHaveBeenCalledWith(0)

    await userEvent.keyboard('{ArrowDown}')
    expect(readerProps?.focusedBlockIndex).toBe(1)

    await userEvent.keyboard('{ArrowUp}')
    expect(readerProps?.focusedBlockIndex).toBe(0)

    await userEvent.keyboard('h')
    expect(blockHandle.blockSelection).toHaveBeenCalledWith(0)
    await waitFor(() => {
      expect(mockedApi.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
        annotation_type: 'highlight',
        quote_text: 'First paragraph.',
      }))
    })
  })

  it('uses clicked block focus for the reader focus indicator', async () => {
    await renderPage()

    act(() => { readerProps?.onBlockFocused?.(1) })

    expect(readerProps?.focusedBlockIndex).toBe(1)
  })

  it('shows feedback instead of silently ignoring keyboard annotation on empty focused blocks', async () => {
    blockHandle.blockSelection.mockReturnValue(null)
    await renderPage()

    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('h')

    expect(blockHandle.blockSelection).toHaveBeenCalledWith(0)
    expect(mockedApi.createAnnotation).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Focused block has no text to annotate')
  })

  it('toggles the inspector with bracket keys and clears state with Escape', async () => {
    await renderPage()

    expect(screen.getByRole('complementary', { name: 'Reader inspector' })).toBeInTheDocument()
    await userEvent.keyboard('[[')
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
    await userEvent.keyboard(']')
    expect(screen.getByRole('complementary', { name: 'Reader inspector' })).toBeInTheDocument()

    simulateSelection(textSelection)
    expect(screen.getByRole('toolbar', { name: 'Annotate selection' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('toolbar', { name: 'Annotate selection' })).not.toBeInTheDocument()
  })

  it('opens the shortcut reference with ? and ignores shortcuts while typing', async () => {
    await renderPage()

    simulateSelection(textSelection)
    await userEvent.type(screen.getByPlaceholderText('Label (optional)'), 'h')
    expect(mockedApi.createAnnotation).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('reader-content'))
    await userEvent.keyboard('{Escape}')
    await userEvent.keyboard('?')
    expect(await screen.findByText('Keyboard shortcuts')).toBeInTheDocument()
  })

  it('on the standalone route (no day context), backs to Library and shows no prev/next', async () => {
    await renderPage('/library/items/item-1')

    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/library/items')
    expect(screen.queryByRole('link', { name: 'Previous item' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Next item' })).not.toBeInTheDocument()
    expect(mockedSourcesApi.briefing).not.toHaveBeenCalled()
  })

  it('on a day-scoped route, backs to the day and steps prev/next across that day\'s items in relevance order', async () => {
    mockedSourcesApi.briefing.mockResolvedValue(makeBriefing({
      connection_name: 'arXiv: 3dgs',
      item_decisions: [
        makeDecision('item-2', 'maybe'),
        makeDecision('item-1', 'relevant'),
        makeDecision('item-3', 'not_relevant'),
      ],
    }))

    await renderPage('/library/digests/conn-1/2026-07-07/items/item-1')

    expect(mockedSourcesApi.briefing).toHaveBeenCalledWith('conn-1', '2026-07-07')
    expect(await screen.findByRole('link', { name: 'arXiv: 3dgs' })).toHaveAttribute('href', '/library/digests/conn-1/2026-07-07')
    // item-1 is 'relevant' — first in section order — so there is no previous item.
    expect(screen.queryByRole('link', { name: 'Previous item' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Next item' })).toHaveAttribute('href', '/library/digests/conn-1/2026-07-07/items/item-2')
  })

  it('disables the next button on the last item of the day and still degrades gracefully if the briefing fetch fails', async () => {
    mockedSourcesApi.briefing.mockRejectedValue(new Error('boom'))

    await renderPage('/library/digests/conn-1/2026-07-07/items/item-1')

    // Falls back to a generic "Day" label and no prev/next rather than failing to render.
    expect(await screen.findByRole('link', { name: 'Day' })).toHaveAttribute('href', '/library/digests/conn-1/2026-07-07')
    expect(screen.queryByRole('link', { name: 'Previous item' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Next item' })).not.toBeInTheDocument()
  })
})
