import i18n from '../../../i18n'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, Link, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import LibraryItemReaderPage from '../LibraryItemReaderPage'
import { InformationDigestView } from '../InformationDigestView'
import { readerApi, sourcesApi, informationDigestsApi } from '../../../api/client'
import type { TextSelection } from '../../../components/editor/ReadOnlyTiptapReader'
import { clearSessionResidue } from '../../../lib/sessionResidue'
import { useSpace } from '../../../contexts/SpaceContext'
import { __clearCommentDraftsForTests, __commentDraftCountForTests, writeCommentDraft } from '../../../components/reader/commentDrafts'
import type {
  InformationDigest,
  ReaderAnnotation,
  ReaderCommentThread,
  ReaderDocumentPayload,
  SourcePostProcessingBriefingDetail,
} from '../../../types/api'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: vi.fn(() => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' })),
}))

vi.mock('../../../core/spaceNav', async () => {
  const { Link, useNavigate } = await import('react-router-dom')
  return {
    useSpaceNavigate: useNavigate,
    SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
      <Link to={to} {...props}>{children}</Link>
    ),
  }
})

vi.mock('../../../api/client', () => ({
  informationDigestsApi:{readingState:vi.fn()},
  sourcesApi: {
    itemAction: vi.fn(),
    materialProcessing: vi.fn(),prepareMaterial: vi.fn(),showAgentTextAsMarkdown: vi.fn(),cancelMaterialProcessing: vi.fn(),requestMaterialStorage:vi.fn(),
    jobs: vi.fn(),
    runJob: vi.fn(),
    briefing: vi.fn(),
  },
  readerApi: {
    getDocument: vi.fn(), sourceVersions: vi.fn(), sourceVersion: vi.fn(),
    listAnnotations: vi.fn(),
    createAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    listThreads: vi.fn(),
    createComment: vi.fn(),
    updateThread: vi.fn(),
    createEvidence: vi.fn(),
    createProposal: vi.fn(),
    getAppearance: vi.fn(async () => ({ font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' })), getPosition: vi.fn(async () => ({ position: null, accepted: true })), putPosition: vi.fn(async () => ({ position: null, accepted: true })), putAppearance: vi.fn(async (value: unknown) => value), updateAnnotation: vi.fn(),
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
  readingAnchor: vi.fn(() => null),
  locate: vi.fn(() => null),
  scrollToPos: vi.fn(),
  headings: vi.fn(() => []),
  find: vi.fn(() => 0),
  findGo: vi.fn(),
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
  selectedText: 'Second paragraph.',
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

/** Read again asks first when the item already has text; confirm it. */
async function readAgain() {
  await userEvent.click(screen.getByRole('button', { name: 'Read again' }))
  const dialog = await screen.findByRole('dialog', { name: 'Read this material again?' })
  await userEvent.click(within(dialog).getByRole('button', { name: 'Read again' }))
}

function simulateSelection(selection: TextSelection | null) {
  act(() => { readerProps?.onTextSelected?.(selection) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useSpace).mockReturnValue({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' } as ReturnType<typeof useSpace>)
  __clearCommentDraftsForTests()
  mockedSourcesApi.materialProcessing.mockReset().mockResolvedValue({status:"idle"})
  mockedSourcesApi.prepareMaterial.mockReset().mockResolvedValue({status:"queued",run_id:"processing-run"})
  mockedSourcesApi.cancelMaterialProcessing.mockReset().mockResolvedValue({status:"failed",reason:"Cancelled"})
  blockHandle.blockSelection.mockReset()
  readerProps = null
  mockedApi.getDocument.mockResolvedValue(docPayload)
  mockedApi.listAnnotations.mockResolvedValue({ items: [makeAnnotation()] })
  mockedApi.listThreads.mockResolvedValue({ items: [] })
  mockedSourcesApi.jobs.mockResolvedValue({ items: [], total: 0, limit: 1, offset: 0 })
})

describe('LibraryItemReaderPage', () => {
  it('discards an initial document response after the session ends', async () => {
    let answer!: (value: ReaderDocumentPayload) => void
    mockedApi.getDocument.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    render(<MemoryRouter initialEntries={['/library/items/item-1']}><Routes>
      <Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} />
    </Routes></MemoryRouter>)
    await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledOnce())
    clearSessionResidue()
    await act(async () => { answer(docPayload) })
    expect(screen.queryByTestId('reader-content')).not.toBeInTheDocument()
  })

  it.each(['loaded', 'pending'])('revalidates the daily navigation on a Space switch with a %s old briefing', async state => {
    let answer!: (value: SourcePostProcessingBriefingDetail) => void
    const oldBriefing = makeBriefing({ connection_name: 'Private old source', item_decisions: [makeDecision('item-1', 'relevant'), makeDecision('item-2', 'relevant')] })
    mockedSourcesApi.briefing.mockReset()
      .mockReturnValueOnce(state === 'loaded' ? Promise.resolve(oldBriefing) : new Promise(resolve => { answer = resolve }))
      .mockRejectedValueOnce(Object.assign(new Error('Not accessible'), { status: 404 }))
    const page = () => <MemoryRouter initialEntries={['/library/digests/conn-1/2026-07-07/items/item-1']}><Routes>
      <Route path="/library/digests/:connectionId/:date/items/:itemId" element={<LibraryItemReaderPage />} />
    </Routes></MemoryRouter>
    const view = render(page())
    await screen.findByTestId('reader-content')
    if (state === 'loaded') expect(await screen.findByRole('link', { name: 'Private old source' })).toBeInTheDocument()
    vi.mocked(useSpace).mockReturnValue({ activeSpaceId: 'space-2', activeSpaceName: 'Space Two' } as ReturnType<typeof useSpace>)
    mockedApi.getDocument.mockResolvedValue({ ...docPayload, space_id: 'space-2' })
    view.rerender(page())
    await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledTimes(2))
    if (state === 'pending') await act(async () => { answer(oldBriefing) })
    expect(screen.queryByRole('link', { name: 'Private old source' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Next item' })).not.toBeInTheDocument()
    expect(mockedSourcesApi.briefing).toHaveBeenCalledTimes(2)
  })

  it('loads the reader document and active annotations', async () => {
    await renderPage()

    expect(mockedApi.getDocument).toHaveBeenCalledWith('source_item', 'item-1', { origin: undefined })
    expect(mockedApi.listAnnotations).toHaveBeenCalledWith('source_item', 'item-1')
    // The full title is the article heading; the header repeats it only as short orientation text.
    expect(screen.getByRole('heading', { level: 1, name: 'Signals in Long-Form Reading' })).toBeInTheDocument()
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

    // The created annotation is appended and the selection is cleared. A highlight
    // is quiet: it is not opened in the panel; the confirmation offers to view it.
    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    await waitFor(() => expect(notebook).toHaveTextContent('Second paragraph.'))
    expect(screen.queryByRole('toolbar', { name: 'Annotate selection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Selected annotation' })).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Highlighted', expect.objectContaining({ action: expect.objectContaining({ label: 'View' }) }))
  })

  it('prepares an existing material and reloads its canonical document',async()=>{
    mockedApi.getDocument.mockResolvedValueOnce(docPayload).mockResolvedValue({...docPayload,plain_text:'Fresh structured text.',normalized_text:'Fresh structured text.'});
    mockedSourcesApi.materialProcessing.mockResolvedValueOnce({status:'idle'}).mockResolvedValue({status:'succeeded',run_id:'processing-run'});
    await renderPage();await readAgain();
    await waitFor(()=>expect(mockedSourcesApi.prepareMaterial).toHaveBeenCalledWith('item-1',{investigation:true}, {spaceId:'space-1'}));
    await waitFor(()=>expect(screen.getByTestId('reader-content')).toHaveTextContent('Fresh structured text.'));
    expect(mockedSourcesApi.itemAction).not.toHaveBeenCalled();expect(mockedSourcesApi.runJob).not.toHaveBeenCalled();
  });
  it('shows a persisted processing failure after reload',async()=>{
    mockedSourcesApi.materialProcessing.mockResolvedValue({status:'failed',reason:'The source page rejected the request.',run_id:'failed-run'});
    await renderPage();expect(await screen.findByRole('alert')).toHaveTextContent('Could not prepare this material.');expect(screen.getByRole('alert')).toHaveTextContent('The source page rejected the request.');
  });
  it('shows only the latest operation and does not read an old extraction error',async()=>{
    mockedSourcesApi.materialProcessing.mockResolvedValue({status:'succeeded'});await renderPage();expect(await screen.findByText('Reading content saved.')).toBeInTheDocument();expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(mockedSourcesApi.jobs).not.toHaveBeenCalled();
  });

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
      expect(mockedApi.getDocument).toHaveBeenLastCalledWith('source_item', 'item-2', { origin: undefined })
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Second item' })).toBeInTheDocument()
    expect(screen.getByTestId('reader-content')).toHaveTextContent('Next item text.')
    expect(screen.queryByRole('region', { name: 'Selected annotation' })).not.toBeInTheDocument()
    expect(screen.queryByText('Existing comment body')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Annotation notebook' })).toHaveTextContent('Next item quote.')
  })

  it('drops preparation replies after navigation to another material',async()=>{
    mockedSourcesApi.briefing.mockResolvedValue(makeBriefing({item_decisions:[makeDecision('item-1','relevant'),makeDecision('item-2','relevant')]}));
    const next={...docPayload,document_id:'item-2',source_item_id:'item-2',title:'Second item',normalized_text:'Next item text.'};mockedApi.getDocument.mockImplementation(async(_type,id)=>id==='item-2'?next:docPayload);
    let finish:((value:{status:string})=>void)|undefined;mockedSourcesApi.prepareMaterial.mockReturnValue(new Promise(resolve=>{finish=resolve}));
    await renderPage('/library/digests/conn-1/2026-07-07/items/item-1');await readAgain();await waitFor(()=>expect(mockedSourcesApi.prepareMaterial).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('link',{name:'Next item'}));expect(await screen.findByRole('heading', { level: 1, name: 'Second item' })).toBeInTheDocument();await act(async()=>{finish?.({status:'queued'})});expect(screen.getByTestId('reader-content')).toHaveTextContent('Next item text.');
  });

  it('moves paragraph focus with arrows and highlights the focused paragraph with H', async () => {
    const blockSelection: TextSelection = {
      quoteText: 'First paragraph.',
      selectedText: 'First paragraph.',
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
    await userEvent.keyboard(']')
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
    await userEvent.keyboard(']')
    expect(screen.getByRole('complementary', { name: 'Reader inspector' })).toBeInTheDocument()
    // [ shows and hides the contents, independently of the inspector.
    await userEvent.keyboard('[[')
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Reader inspector' })).toBeInTheDocument()
    await userEvent.keyboard('[[')
    expect(screen.queryByRole('navigation', { name: 'Contents' })).not.toBeInTheDocument()

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

    expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('href', '/library/items')
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

it.each(['candidates','settings'])('preserves a project %s origin and bounded return destination',async tab=>{
  await renderPage(`/library/items/item-1?from=project&returnTo=${encodeURIComponent(`/projects/project-a/sources?tab=${tab}`)}`)
  expect(mockedApi.getDocument).toHaveBeenCalledWith('source_item','item-1',{origin:'project'})
  expect(screen.getByRole('link',{name:'Source management'})).toHaveAttribute('href',`/projects/project-a/sources?tab=${tab}`)
})
it.each(['/projects/project-a/sources?tab=untrusted&redirect=https://other.test', '/projects/project-a/research?tab=reading&redirect=https://other.test', 'https://other.test/projects/project-a/research?tab=reading'])('rejects an unbounded Reader return: %s',async returnTo=>{
  await renderPage(`/library/items/item-1?from=project&returnTo=${encodeURIComponent(returnTo)}`)
  expect(screen.getByRole('link',{name:'Reading'})).toHaveAttribute('href','/library/items')
})

it('returns research Readers to the bounded reading-list tab and keeps project origin during re-extraction', async () => {
  await renderPage(`/library/items/item-1?from=project&returnTo=${encodeURIComponent('/projects/project-a/research?tab=reading')}`)
  expect(screen.getByRole('link', { name: 'Research reading list' })).toHaveAttribute('href', '/projects/project-a/research?tab=reading')
  mockedSourcesApi.materialProcessing.mockResolvedValue({status:'succeeded'});await readAgain()
  await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledTimes(2))
  expect(mockedApi.getDocument).toHaveBeenLastCalledWith('source_item', 'item-1', { origin: 'project' })
})

afterEach(async () => { await i18n.changeLanguage('en') })
it('localizes Reader controls and names the actual Source management return in Chinese', async () => {
  await i18n.changeLanguage('zh-CN')
  mockedApi.listAnnotations.mockResolvedValue({ items: [] })
  await renderPage(`/library/items/item-1?from=project&returnTo=${encodeURIComponent('/projects/project-a/sources?tab=settings')}`)
  expect(screen.getByRole('link', { name: '来源管理' })).toHaveAttribute('href', '/projects/project-a/sources?tab=settings')
  expect(screen.getByRole('button', { name: '重新读取整理' })).toBeEnabled()
  expect(screen.getByRole('complementary', { name: '阅读检查面板' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '关闭检查面板' }))
  await userEvent.click(screen.getByRole('button', { name: '显示检查面板' }))
  expect(screen.getByText('检查面板')).toBeInTheDocument()
  expect(screen.getByText('0 条批注')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '批注笔记本' })).toHaveTextContent('批注笔记')
  expect(screen.getByText('在正文中选择文字，使用工具栏创建第一条批注。')).toBeInTheDocument()
  expect(screen.getByText('来源资料 · 已保存正文')).toBeInTheDocument()
})

it.each([
  [1, 0, '1 annotation · 0 open threads'],
  [1, 1, '1 annotation · 1 open thread'],
  [2, 2, '2 annotations · 2 open threads'],
] as const)('uses English plural rules for %i annotations and %i open threads', async (annotations, open, expected) => {
  mockedApi.listAnnotations.mockResolvedValue({ items: Array.from({ length: annotations }, (_, n) => makeAnnotation({ id: `ann-${n}`, quote_text: `Passage ${n}` })) })
  mockedApi.listThreads.mockResolvedValue({ items: [
    ...Array.from({ length: open }, (_, n) => makeThread({ id: `open-${n}` })),
    makeThread({ id: 'resolved', status: 'resolved' }),
  ] })
  await renderPage()
  await userEvent.click(within(screen.getByRole('region', { name: 'Annotation notebook' })).getAllByRole('button')[0])
  expect(await screen.findByText(expected)).toBeInTheDocument()
})

it.each([0, 1, 2])('localizes the Chinese Inspector with %i open threads', async open => {
  await i18n.changeLanguage('zh-CN')
  mockedApi.listThreads.mockResolvedValue({ items: Array.from({ length: open }, (_, n) => makeThread({ id: `thread-${n}` })) })
  await renderPage()
  await userEvent.click(within(screen.getByRole('region', { name: '批注笔记本' })).getAllByRole('button')[0])
  expect(await screen.findByText(`1 条批注 · ${open} 个未解决讨论`)).toBeInTheDocument()
  if (open === 0) expect(screen.getByText('暂无评论。')).toBeInTheDocument()
  expect(screen.getByPlaceholderText('添加评论…')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存为证据' })).toBeInTheDocument()
})

it.each([['queued','排队中'],['running','正在读取、整理'],['failed','此材料未能整理完成。']] as const)('shows canonical processing state %s in Chinese',async(status,expected)=>{
 await i18n.changeLanguage('zh-CN');mockedSourcesApi.materialProcessing.mockResolvedValue({status,reason:status==='failed'?'原始服务端错误详情':null,run_id:'processing-run'});await renderPage('/library/items/item-1?from=project');expect(await screen.findByText(expected,{exact:false})).toBeInTheDocument();expect(mockedApi.getDocument).toHaveBeenCalledWith('source_item','item-1',{origin:'project'});
});

it.each([
  ['en', 'project', 'interest', 'project'], ['zh-CN', 'project', 'interest', 'project'],
  ['en', 'personal', 'interest', undefined], ['zh-CN', 'personal', 'interest', undefined],
  ['en', 'personal', 'serendipity', 'serendipity'], ['zh-CN', 'personal', 'serendipity', 'serendipity'],
] as const)('returns from %s %s/%s edition through Reader to the snapshot day', async (locale, scope, section, origin) => {
  await i18n.changeLanguage(locale)
  const date = '2024-02-29'
  const destination = scope === 'project' ? `/projects/project-a/sources?tab=digest&date=${date}` : `/library/digests?date=${date}`
  // Source ownership is not the edition's Project context.
  mockedApi.getDocument.mockResolvedValue({ ...docPayload, project_id: 'source-owning-project' })
  const snapshot: InformationDigest = {
    id: 'fixed-edition', digest_type: scope, owner_user_id: scope === 'personal' ? 'user-1' : null,
    project_id: scope === 'project' ? 'project-a' : null, digest_date: date, timezone: 'Asia/Shanghai',
    period_start_utc: '2024-02-28T16:00:00Z', period_end_utc: '2024-02-29T16:00:00Z',
    generation_kind: 'backfill', generated_at: '2026-01-04T10:00:00Z', profile_maturity: null,
    status: 'ready', settings: {}, created_at: '2026-01-04T10:00:00Z', updated_at: '2026-01-04T10:00:00Z',
    team_aggregates_available: false, team_blind_spot_domains: [],
    items: [{ id: 'edition-item', source_item_id: 'item-1', title: 'Snapshot article', section,
      position: 0, quota_slot: section, score: 1, component_scores: {}, rationale: null,
      matched_topic_id: null, serendipity_pool_item_id: null, target_domain_key: null, discovery_origin: null,
      source_uri: null, source_domain: null, author: null, excerpt: null, occurred_at: '2023-12-01T00:00:00Z',
      domain_key: 'history', depth: 'analysis', genre: 'paper', summary: null, stance_target: null,
      stance_target_key: null, stance_polarity: 'neutral', stance_confidence: 0, read_status: 'read',
      serendipity_feedback: null, anonymous_read_count: null }],
  }
  function Edition() {
    const location = useLocation()
    return <><output aria-label="Edition address">{location.pathname + location.search}</output><InformationDigestView digest={snapshot} project={scope === 'project'} /></>
  }
  render(<MemoryRouter initialEntries={[destination]}><Routes>
    <Route path="/projects/:projectId/sources" element={<Edition />} />
    <Route path="/library/digests" element={<Edition />} />
    <Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} />
  </Routes></MemoryRouter>)
  await userEvent.click(screen.getByRole('link', { name: 'Snapshot article' }))
  await screen.findByTestId('reader-content')
  expect(mockedApi.getDocument).toHaveBeenCalledWith('source_item', 'item-1', { origin })
  const back = screen.getByRole('link', { name: locale === 'en' ? 'Daily editions' : '每日版' })
  expect(back).toHaveAttribute('href', destination)
  await userEvent.click(back)
  expect(screen.getByLabelText('Edition address')).toHaveTextContent(destination)
  expect(screen.getByRole('link', { name: 'Snapshot article' })).toBeInTheDocument()
})

it('rejects a Reader return to a different Project edition from its declared context', async () => {
  await renderPage(`/library/items/item-1?from=project&projectId=project-a&returnTo=${encodeURIComponent('/projects/project-b/sources?tab=digest&date=2026-01-02')}`)
  expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('href', '/library/items')
})
it.each(['en','zh-CN'])('M2: metadata-only Reader preserves the provenance label (%s)',async locale=>{
 await i18n.changeLanguage(locale);mockedApi.getDocument.mockResolvedValue({...docPayload,result_provenance:'agent_provided_unverified',plain_text:'',normalized_text:'',content_state:'metadata_only'});await renderPage();expect(await screen.findByText(locale==='en'?'Agent-provided · Not independently verified':'Agent 提供 · 未经独立核验')).toBeInTheDocument();
});

it('shows an explicit original-source route for Agent links without retained text',async()=>{
 mockedApi.getDocument.mockResolvedValue({...docPayload,result_provenance:'agent_provided_unverified',plain_text:'',normalized_text:'',content_state:'metadata_only',source_uri:'https://example.test/original'});
 await renderPage();expect(screen.getByText(/No readable content was saved/)).toBeInTheDocument();expect(within(screen.getByRole('status')).getByRole('link',{name:'Open source URL'})).toHaveAttribute('href','https://example.test/original');
});
it('labels repository synthesis and exposes its actual supporting sources',async()=>{
 mockedApi.getDocument.mockResolvedValue({...docPayload,result_provenance:'agent_provided_unverified',reading_info:{kind:'repository',format:'agent_summary',method:'agent',sources:['https://example.test/README']}});
 await renderPage();expect(screen.getByText(/Agent synthesis based on the linked sources/)).toBeInTheDocument();expect(screen.getByText(/Repository overview/)).toBeInTheDocument();expect(screen.getByRole('link',{name:'https://example.test/README'})).toHaveAttribute('href','https://example.test/README');
});

it.each([['/library/reading/goals/topic-a?selection=all','Back to topic'],['/library/reading?view=read&topic=topic-a&topic_selection=all','Reading'],['/projects/project-a/sources/goals/topic-a','Back to topic']])('returns to the exact topic or filtered Reading view %s',async(returnTo,label)=>{
  await renderPage(`/library/items/item-1?from=library&returnTo=${encodeURIComponent(returnTo)}`)
  expect(screen.getByRole('link',{name:label})).toHaveAttribute('href',returnTo)
})

it('confirms only the exact cited topic change, without altering document read state',async()=>{
 vi.mocked(informationDigestsApi.readingState).mockResolvedValue({updated:1});await renderPage('/library/items/item-1?change=change-v2');
 expect(informationDigestsApi.readingState).not.toHaveBeenCalled();await userEvent.click(screen.getByRole('button',{name:'Mark this update read'}));
 await waitFor(()=>expect(informationDigestsApi.readingState).toHaveBeenCalledWith('space-1','item-1',{topic_change_id:'change-v2',read_status:'read'},undefined));
 expect(await screen.findByRole('button',{name:'This update is read'})).toBeDisabled();expect(mockedSourcesApi.itemAction).not.toHaveBeenCalled();
});

it('a late v2 confirmation cannot show a newly navigated v3 as acknowledged',async()=>{
 let finish!:(value:{updated:number})=>void;vi.mocked(informationDigestsApi.readingState).mockReturnValue(new Promise(resolve=>{finish=resolve}));
 render(<MemoryRouter initialEntries={['/library/items/item-1?change=v2']}><Routes><Route path="/library/items/:itemId" element={<><Link to="/library/items/item-1?change=v3">Next update</Link><LibraryItemReaderPage/></>}/></Routes></MemoryRouter>);
 await screen.findByTestId('reader-content');await userEvent.click(screen.getByRole('button',{name:'Mark this update read'}));await userEvent.click(screen.getByRole('link',{name:'Next update'}));
 await act(async()=>finish({updated:1}));expect(screen.getByRole('button',{name:'Mark this update read'})).toBeEnabled();expect(screen.queryByRole('button',{name:'This update is read'})).not.toBeInTheDocument();
});

describe('LibraryItemReaderPage stage-one reliability', () => {
  const withNarrowViewport = (narrow: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: narrow && query.includes('max-width'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })
  }
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia') })

  it('keeps the document readable when annotations fail, without claiming zero, and retries only the list', async () => {
    mockedApi.listAnnotations.mockRejectedValueOnce(Object.assign(new Error('annotation service unavailable'), { status: 500 }))
    await renderPage()

    expect(screen.getByTestId('reader-content')).toHaveTextContent('First paragraph.')
    const inspector = screen.getByRole('complementary', { name: 'Reader inspector' })
    expect(within(inspector).getByRole('alert')).toHaveTextContent('annotation service unavailable')
    expect(inspector).not.toHaveTextContent('0 annotations')
    expect(inspector).not.toHaveTextContent('Select text in the document')

    await userEvent.click(within(inspector).getByRole('button', { name: 'Try again' }))
    expect(await within(inspector).findByText('1 annotation')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Annotation notebook' })).getByText('First paragraph.')).toBeInTheDocument()
    expect(mockedApi.getDocument).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a forbidden document (no blind retry) from a failed load (retry)', async () => {
    mockedApi.getDocument.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
    const { unmount } = render(<MemoryRouter initialEntries={['/library/items/item-1']}><Routes><Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} /></Routes></MemoryRouter>)
    expect(await screen.findByText('Reading is not available to you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    unmount()

    mockedApi.getDocument.mockRejectedValueOnce(Object.assign(new Error('gateway timeout'), { status: 504 })).mockResolvedValueOnce(docPayload)
    render(<MemoryRouter initialEntries={['/library/items/item-1']}><Routes><Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} /></Routes></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('gateway timeout')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('reader-content')).toHaveTextContent('First paragraph.')
  })

  it('does not run reading shortcuts during IME composition or while a menu is open', async () => {
    blockHandle.blockSelection.mockReturnValue(textSelection)
    mockedApi.createAnnotation.mockResolvedValue(makeAnnotation({ id: 'ann-kb' }))
    await renderPage()
    await userEvent.keyboard('{ArrowDown}')

    fireEvent.keyDown(document.body, { key: 'h', isComposing: true })
    fireEvent.keyDown(document.body, { key: 'n', keyCode: 229 })
    // Keys typed inside an open menu belong to the menu.
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu')
    const item = document.createElement('button'); item.setAttribute('role', 'menuitem'); menu.append(item); document.body.append(menu)
    fireEvent.keyDown(item, { key: 'h' })
    fireEvent.keyDown(item, { key: 'ArrowDown' })
    expect(readerProps?.focusedBlockIndex).toBe(0)
    // A menu left in the page without focus does not disable reading keys.
    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    expect(readerProps?.focusedBlockIndex).toBe(1)
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    menu.remove()
    expect(mockedApi.createAnnotation).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'h', repeat: true })
    expect(mockedApi.createAnnotation).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'h' })
    fireEvent.keyDown(document.body, { key: 'h' })
    await waitFor(() => expect(mockedApi.createAnnotation).toHaveBeenCalledTimes(1))
  })

  it('keeps the stored selection when pressing the toolbar collapses the browser selection', async () => {
    mockedApi.createAnnotation.mockResolvedValue(makeAnnotation({ id: 'ann-touch', quote_text: 'Second paragraph.' }))
    await renderPage()
    simulateSelection(textSelection)
    const toolbar = screen.getByRole('toolbar', { name: 'Annotate selection' })
    fireEvent.pointerDown(toolbar)
    simulateSelection(null)
    expect(screen.getByRole('toolbar', { name: 'Annotate selection' })).toBeInTheDocument()
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Highlight' }))
    expect(mockedApi.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ quote_text: 'Second paragraph.' }))
  })

  it('drops an annotation saved for the previous item after navigating to the next one', async () => {
    mockedSourcesApi.briefing.mockResolvedValue(makeBriefing({ item_decisions: [makeDecision('item-1', 'relevant'), makeDecision('item-2', 'relevant')] }))
    const next = { ...docPayload, document_id: 'item-2', source_item_id: 'item-2', title: 'Second item', normalized_text: 'Next item text.' }
    mockedApi.getDocument.mockImplementation(async (_type, id) => id === 'item-2' ? next : docPayload)
    mockedApi.listAnnotations.mockImplementation(async (_type, id) => ({ items: id === 'item-2' ? [] : [makeAnnotation()] }))
    let answer: (value: ReaderAnnotation) => void = () => {}
    mockedApi.createAnnotation.mockReturnValue(new Promise(resolve => { answer = resolve }))
    await renderPage('/library/digests/conn-1/2026-07-07/items/item-1')

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    await userEvent.click(screen.getByRole('link', { name: 'Next item' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Second item' })).toBeInTheDocument()
    await act(async () => { answer(makeAnnotation({ id: 'late', quote_text: 'Late quote from item one' })) })

    expect(screen.queryByText('Late quote from item one')).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalledWith('Highlighted', expect.anything())
  })

  it('opens on the text on a phone; a highlight stays quiet and a comment opens the drawer', async () => {
    withNarrowViewport(true)
    mockedApi.createAnnotation
      .mockResolvedValueOnce(makeAnnotation({ id: 'ann-h', quote_text: 'Second paragraph.' }))
      .mockResolvedValueOnce(makeAnnotation({ id: 'ann-c', annotation_type: 'comment', quote_text: 'Second paragraph.' }))
    await renderPage()
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Highlighted', expect.anything()))
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByRole('complementary', { name: 'Reader inspector' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByPlaceholderText('Add a comment…')).toHaveFocus())
    // Escape first leaves the text field to the field; from the page it closes the drawer.
    act(() => { (document.activeElement as HTMLElement).blur() })
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: 'Reader inspector' })).not.toBeInTheDocument()
  })

  it('shows the body title once when the document opens with the same heading', async () => {
    mockedApi.getDocument.mockResolvedValue({ ...docPayload, content_json: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Signals in Long-Form Reading' }] }] } })
    await renderPage()
    // The mocked body does not render headings: no lead heading means the body's own heading is the title.
    expect(screen.queryByRole('heading', { level: 1, name: 'Signals in Long-Form Reading' })).not.toBeInTheDocument()
    expect(screen.getByText('example.test')).toBeInTheDocument()
  })

  it('does not let a list requested before a new highlight erase it; the list is fetched again', async () => {
    let answerStale: (value: { items: ReaderAnnotation[] }) => void = () => {}
    mockedApi.listAnnotations.mockImplementationOnce(() => new Promise(resolve => { answerStale = resolve }))
      .mockResolvedValueOnce({ items: [makeAnnotation({ id: 'ann-new', quote_text: 'Saved review annotation' })] })
    mockedApi.createAnnotation.mockResolvedValue(makeAnnotation({ id: 'ann-new', quote_text: 'Saved review annotation' }))
    await renderPage()
    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    const notebook = screen.getByRole('region', { name: 'Annotation notebook' })
    expect(await within(notebook).findByText('Saved review annotation')).toBeInTheDocument()
    await act(async () => { answerStale({ items: [] }) })
    await waitFor(() => expect(mockedApi.listAnnotations).toHaveBeenCalledTimes(2))
    expect(within(notebook).getByText('Saved review annotation')).toBeInTheDocument()
  })

  it('clears the list and unsent drafts when annotations become forbidden', async () => {
    writeCommentDraft({ spaceId: 'space-1', documentType: 'source_item', documentId: 'item-1' }, 'ann-1', 'Private draft')
    mockedApi.listAnnotations.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
    await renderPage()
    expect(await within(screen.getByRole('complementary', { name: 'Reader inspector' })).findByRole('alert')).toHaveTextContent('forbidden')
    expect(__commentDraftCountForTests()).toBe(0)
    expect(screen.queryByText('Private draft')).not.toBeInTheDocument()
  })

  it('makes the next document annotatable at once while the previous item’s save is still running', async () => {
    mockedSourcesApi.briefing.mockResolvedValue(makeBriefing({ item_decisions: [makeDecision('item-1', 'relevant'), makeDecision('item-2', 'relevant')] }))
    const next = { ...docPayload, document_id: 'item-2', source_item_id: 'item-2', title: 'Second item', normalized_text: 'Next item text.' }
    mockedApi.getDocument.mockImplementation(async (_type, id) => id === 'item-2' ? next : docPayload)
    mockedApi.listAnnotations.mockImplementation(async () => ({ items: [] }))
    let answerOld: (value: ReaderAnnotation) => void = () => {}
    let answerNew: (value: ReaderAnnotation) => void = () => {}
    mockedApi.createAnnotation.mockImplementationOnce(() => new Promise(resolve => { answerOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { answerNew = resolve }))
    await renderPage('/library/digests/conn-1/2026-07-07/items/item-1')

    simulateSelection(textSelection)
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeDisabled()
    await userEvent.click(screen.getByRole('link', { name: 'Next item' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Second item' })).toBeInTheDocument()

    simulateSelection(textSelection)
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))
    expect(mockedApi.createAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({ document_id: 'item-2' }))
    // The old save finishing must not release the new one.
    await act(async () => { answerOld(makeAnnotation({ id: 'old' })) })
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeDisabled()
    await act(async () => { answerNew(makeAnnotation({ id: 'new', document_id: 'item-2', quote_text: 'Second paragraph.' })) })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Highlighted', expect.anything()))
  })

  it('keeps an unsent comment across Shell navigation and restores it on return', async () => {
    mockedApi.listThreads.mockResolvedValue({ items: [] })
    render(<MemoryRouter initialEntries={['/library/items/item-1']}>
      <Link to="/home">Shell home</Link><Link to="/library/items/item-1">Back to item</Link>
      <Routes>
        <Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} />
        <Route path="/home" element={<p>Home page</p>} />
      </Routes>
    </MemoryRouter>)
    await screen.findByTestId('reader-content')
    await userEvent.click(within(screen.getByRole('region', { name: 'Annotation notebook' })).getByRole('button', { name: /First paragraph/ }))
    await userEvent.type(await screen.findByPlaceholderText('Add a comment…'), 'Draft before leaving')
    await userEvent.click(screen.getByRole('link', { name: 'Shell home' }))
    expect(await screen.findByText('Home page')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'Back to item' }))
    await screen.findByTestId('reader-content')
    expect(await screen.findByText('1 unsent comment is kept here')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('region', { name: 'Annotation notebook' })).getByRole('button', { name: /First paragraph/ }))
    await waitFor(() => expect(screen.getByPlaceholderText('Add a comment…')).toHaveValue('Draft before leaving'))
  })

  describe('annotation authority', () => {
    const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
    const shownQuotes = () => ((readerProps as unknown as { annotations?: ReaderAnnotation[] })?.annotations ?? []).map(item => item.quote_text)
    const late = makeAnnotation({ id: 'ann-late', quote_text: 'Created before refusal' })

    async function startLateCreate() {
      const list = deferred<{ items: ReaderAnnotation[] }>()
      const post = deferred<ReaderAnnotation>()
      mockedApi.listAnnotations.mockImplementationOnce(() => list.promise)
      mockedApi.createAnnotation.mockImplementationOnce(() => post.promise)
      await renderPage()
      simulateSelection(textSelection)
      await userEvent.click(screen.getByRole('button', { name: 'Highlight' }))
      return { list, post }
    }

    it('does not let a create that answers after a 403 bring the quote back', async () => {
      const { list, post } = await startLateCreate()
      await act(async () => { list.reject(Object.assign(new Error('forbidden'), { status: 403 })) })
      const inspector = screen.getByRole('complementary', { name: 'Reader inspector' })
      expect(within(inspector).getByRole('alert')).toHaveTextContent('forbidden')
      await act(async () => { post.resolve(late) })
      expect(screen.queryByText('Created before refusal')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'highlight: Created before refusal' })).not.toBeInTheDocument()
      expect(shownQuotes()).toEqual([])
      expect(toast.success).not.toHaveBeenCalledWith('Highlighted', expect.anything())
      // The pending state was released: the next selection can be annotated.
      simulateSelection(textSelection)
      expect(screen.getByRole('button', { name: 'Highlight' })).toBeEnabled()
    })

    it('does not apply a pre-refusal create after access is restored; only the new read shows annotations', async () => {
      const { list, post } = await startLateCreate()
      await act(async () => { list.reject(Object.assign(new Error('forbidden'), { status: 403 })) })
      mockedApi.listAnnotations.mockResolvedValueOnce({ items: [makeAnnotation({ id: 'ann-authoritative', quote_text: 'From the new read' })] })
      const inspector = screen.getByRole('complementary', { name: 'Reader inspector' })
      await userEvent.click(within(inspector).getByRole('button', { name: 'Try again' }))
      expect(await within(inspector).findByText('From the new read')).toBeInTheDocument()
      await act(async () => { post.resolve(late) })
      expect(screen.queryByText('Created before refusal')).not.toBeInTheDocument()
      expect(shownQuotes()).toEqual(['From the new read'])
      expect(toast.success).not.toHaveBeenCalledWith('Highlighted', expect.anything())
    })

    it('treats an ordinary list failure as no refusal: the confirmed create and the drafts stay', async () => {
      writeCommentDraft({ spaceId: 'space-1', documentType: 'source_item', documentId: 'item-1' }, 'ann-1', 'Kept through 500')
      const { list, post } = await startLateCreate()
      await act(async () => { list.reject(Object.assign(new Error('server error'), { status: 500 })) })
      await act(async () => { post.resolve(late) })
      expect(within(screen.getByRole('region', { name: 'Annotation notebook' })).getByText('Created before refusal')).toBeInTheDocument()
      expect(toast.success).toHaveBeenCalledWith('Highlighted', expect.anything())
      expect(__commentDraftCountForTests()).toBe(1)
    })
  })

  it('offers to show undeclared Agent text as Markdown for the version shown, only after confirming, and shows the new version', async () => {
    const literal = { ...docPayload, artifact_id: 'art-a', source_snapshot_id: null, result_provenance: 'agent_provided_unverified' as const, plain_text: '# Penchan', normalized_text: '# Penchan',
      reading_info: { kind: 'article' as const, format: 'source_text' as const, sources: ['https://example.test/article'], method: 'agent' as const }, agent_text_syntax: 'undeclared' as const }
    const structured = { ...literal, artifact_id: 'art-b', agent_text_syntax: 'markdown' as const, plain_text: 'Penchan', normalized_text: 'Penchan', content_json: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Penchan' }] }] } }
    mockedApi.getDocument.mockResolvedValueOnce(literal).mockResolvedValue(structured)
    mockedSourcesApi.showAgentTextAsMarkdown.mockResolvedValue({ artifact_id: 'art-b' })
    await renderPage()
    expect(screen.getByText(/did not say how it is written/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show as Markdown' }))
    const dialog = await screen.findByRole('dialog', { name: 'Show this material as Markdown?' })
    expect(dialog).toHaveTextContent('the current version is kept')
    expect(mockedSourcesApi.showAgentTextAsMarkdown).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show as Markdown' }))
    await waitFor(() => expect(mockedSourcesApi.showAgentTextAsMarkdown).toHaveBeenCalledWith('item-1', { artifact_id: 'art-a', source_snapshot_id: null }, { spaceId: 'space-1' }))
    await waitFor(() => expect(screen.queryByText(/did not say how it is written/)).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith('Shown as Markdown')
  })

  it('does not show a reloaded document whose request was made before logout', async () => {
    const literal = { ...docPayload, artifact_id: 'art-a', normalized_text: 'Literal A', reading_info: { kind: 'article' as const, format: 'source_text' as const, sources: ['https://example.test/article'], method: 'agent' as const }, agent_text_syntax: 'undeclared' as const }
    let answer: (value: unknown) => void = () => {}
    mockedApi.getDocument.mockResolvedValueOnce(literal).mockImplementationOnce(() => new Promise(resolve => { answer = resolve }) as never)
    mockedSourcesApi.showAgentTextAsMarkdown.mockResolvedValue({ artifact_id: 'art-b' })
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Show as Markdown' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Show as Markdown' }))
    await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledTimes(2))
    act(() => clearSessionResidue())
    await act(async () => answer({ ...literal, artifact_id: 'art-b', normalized_text: 'Reloaded B', agent_text_syntax: 'markdown' }))
    expect(screen.getByTestId('reader-content')).toHaveTextContent('Literal A')
    expect(toast.success).not.toHaveBeenCalledWith('Shown as Markdown')
  })

  describe('the reload after showing as Markdown belongs to the page that asked', () => {
    const literal = { ...docPayload, artifact_id: 'art-a', source_snapshot_id: null, normalized_text: 'Literal A', reading_info: { kind: 'article' as const, format: 'source_text' as const, sources: ['https://example.test/article'], method: 'agent' as const }, agent_text_syntax: 'undeclared' as const }
    const converted = { ...literal, artifact_id: 'art-b', normalized_text: 'Converted B', agent_text_syntax: 'markdown' as const }
    async function convert() {
      await userEvent.click(screen.getByRole('button', { name: 'Show as Markdown' }))
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Show as Markdown' }))
    }
    beforeEach(() => { mockedSourcesApi.showAgentTextAsMarkdown.mockResolvedValue({ artifact_id: 'art-b' }) })

    it('a reply after the page is gone changes nothing and says nothing', async () => {
      let answer: (value: unknown) => void = () => {}
      mockedApi.getDocument.mockResolvedValueOnce(literal).mockImplementationOnce(() => new Promise(resolve => { answer = resolve }) as never)
      await renderPage()
      await convert()
      await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledTimes(2))
      const annotationReads = mockedApi.listAnnotations.mock.calls.length
      cleanup()
      await act(async () => answer(converted))
      expect(toast.success).not.toHaveBeenCalledWith('Shown as Markdown')
      expect(mockedApi.listAnnotations).toHaveBeenCalledTimes(annotationReads)
    })

    it('a reply after leaving for another item and coming back (A→B→A) is not shown and not reported', async () => {
      let answer: (value: unknown) => void = () => {}
      const other = { ...docPayload, document_id: 'item-2', source_item_id: 'item-2', normalized_text: 'Other item' }
      mockedApi.getDocument.mockImplementation(async (_type, id) => id === 'item-2' ? other : literal)
      mockedApi.getDocument.mockResolvedValueOnce(literal).mockImplementationOnce(() => new Promise(resolve => { answer = resolve }) as never)
      render(<MemoryRouter initialEntries={['/library/items/item-1']}>
        <Link to="/library/items/item-2">to B</Link><Link to="/library/items/item-1">to A</Link>
        <Routes><Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} /></Routes>
      </MemoryRouter>)
      await screen.findByTestId('reader-content')
      await convert()
      await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledTimes(2))
      await userEvent.click(screen.getByRole('link', { name: 'to B' }))
      await waitFor(() => expect(screen.getByTestId('reader-content')).toHaveTextContent('Other item'))
      await userEvent.click(screen.getByRole('link', { name: 'to A' }))
      await waitFor(() => expect(screen.getByTestId('reader-content')).toHaveTextContent('Literal A'))
      await act(async () => answer(converted))
      expect(screen.getByTestId('reader-content')).toHaveTextContent('Literal A')
      expect(toast.success).not.toHaveBeenCalledWith('Shown as Markdown')
    })

    it.each([401, 403, 404])('a reload refused with %s removes the text, its drafts and its annotations, as on first load', async status => {
      writeCommentDraft({ spaceId: 'space-1', documentType: 'source_item', documentId: 'item-1' }, 'ann-1', 'Draft on the old text')
      mockedApi.getDocument.mockResolvedValueOnce(literal).mockRejectedValueOnce(Object.assign(new Error('refused'), { status }))
      await renderPage()
      const annotationReads = mockedApi.listAnnotations.mock.calls.length
      await convert()
      await waitFor(() => expect(screen.queryByTestId('reader-content')).not.toBeInTheDocument())
      expect(screen.queryByText('Literal A')).not.toBeInTheDocument()
      expect(__commentDraftCountForTests()).toBe(0)
      // The annotation list is read again under the refusal (which clears it).
      expect(mockedApi.listAnnotations.mock.calls.length).toBeGreaterThan(annotationReads)
      expect(toast.success).not.toHaveBeenCalledWith('Shown as Markdown')
      expect(toast.error).not.toHaveBeenCalledWith('Saved as Markdown in a new version, but the text could not be reloaded; open it again.')
    })

    it('an ordinary failure keeps the text and says the new version was saved but not reloaded', async () => {
      mockedApi.getDocument.mockResolvedValueOnce(literal).mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      await renderPage()
      await convert()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Saved as Markdown in a new version, but the text could not be reloaded; open it again.'))
      expect(screen.getByTestId('reader-content')).toHaveTextContent('Literal A')
      expect(toast.success).not.toHaveBeenCalledWith('Shown as Markdown')
    })

    it('a refusal of a reload a newer load has replaced does not clear the newer text', async () => {
      let refuse: (error: unknown) => void = () => {}
      const other = { ...docPayload, document_id: 'item-2', source_item_id: 'item-2', normalized_text: 'Other item' }
      mockedApi.getDocument.mockImplementation(async (_type, id) => id === 'item-2' ? other : literal)
      mockedApi.getDocument.mockResolvedValueOnce(literal).mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }) as never)
      render(<MemoryRouter initialEntries={['/library/items/item-1']}>
        <Link to="/library/items/item-2">to B</Link>
        <Routes><Route path="/library/items/:itemId" element={<LibraryItemReaderPage />} /></Routes>
      </MemoryRouter>)
      await screen.findByTestId('reader-content')
      await convert()
      await waitFor(() => expect(mockedApi.getDocument).toHaveBeenCalledTimes(2))
      await userEvent.click(screen.getByRole('link', { name: 'to B' }))
      await waitFor(() => expect(screen.getByTestId('reader-content')).toHaveTextContent('Other item'))
      await act(async () => refuse(Object.assign(new Error('refused'), { status: 403 })))
      expect(screen.getByTestId('reader-content')).toHaveTextContent('Other item')
    })
  })

  it('offers it for text declared plain, with words that say so, and not for Markdown or other text', async () => {
    const agent = (syntax?: 'plain' | 'markdown') => ({ ...docPayload, artifact_id: 'art-a', reading_info: { kind: 'article' as const, format: 'source_text' as const, ...(syntax ? { syntax } : {}), sources: ['https://example.test/article'], method: 'agent' as const }, ...(syntax ? { agent_text_syntax: syntax } : {}) })
    mockedApi.getDocument.mockResolvedValue(agent('plain'))
    await renderPage()
    expect(screen.getByText(/declared it plain text/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show as Markdown' })).toBeInTheDocument()
    cleanup()
    mockedApi.getDocument.mockResolvedValue(agent('markdown'))
    await renderPage()
    expect(screen.queryByRole('button', { name: 'Show as Markdown' })).not.toBeInTheDocument()
    cleanup()
    mockedApi.getDocument.mockResolvedValue(docPayload)
    await renderPage()
    expect(screen.queryByRole('button', { name: 'Show as Markdown' })).not.toBeInTheDocument()
  })

  it('explains what reading an item again does to its annotations and starts nothing until confirmed', async () => {
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Read again' }))
    const dialog = await screen.findByRole('dialog', { name: 'Read this material again?' })
    expect(dialog).toHaveTextContent('the current version is kept, not overwritten')
    expect(dialog).toHaveTextContent('listed as not located')
    expect(dialog).toHaveTextContent('Nothing else is reprocessed.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep current text' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockedSourcesApi.prepareMaterial).not.toHaveBeenCalled()
  })

  it('renders with the stored image policy, and a reprocess that changes it switches the reader before the new text shows', async () => {
    mockedApi.getDocument.mockResolvedValueOnce({ ...docPayload, image_policy: 'remote_reference' })
      .mockResolvedValue({ ...docPayload, image_policy: 'none', plain_text: 'Agent text.', normalized_text: 'Agent text.' })
    mockedSourcesApi.materialProcessing.mockResolvedValueOnce({ status: 'idle' }).mockResolvedValue({ status: 'succeeded', run_id: 'processing-run' })
    await renderPage()
    expect((readerProps as unknown as { remoteImages: boolean }).remoteImages).toBe(true)
    await readAgain()
    await waitFor(() => expect(screen.getByTestId('reader-content')).toHaveTextContent('Agent text.'))
    // The text and the stricter policy arrive in the same render of the reader.
    expect((readerProps as unknown as { remoteImages: boolean; normalizedText: string })).toMatchObject({ remoteImages: false, normalizedText: 'Agent text.' })
  })
})

describe('article version history', () => {
  it('opens a retained version read-only and returns to latest without changing the source item', async () => {
    mockedApi.sourceVersions.mockResolvedValue({ items: [
      { snapshot_id: 'latest-snapshot', captured_at: '2026-10-31T15:00:00Z', is_current: true },
      { snapshot_id: 'old-snapshot', captured_at: '2026-10-30T15:00:00Z', is_current: false },
    ], next_offset: null })
    mockedApi.sourceVersion.mockResolvedValue({ ...docPayload, document_type: 'source_snapshot', document_id: 'old-snapshot', can_annotate: false,
      version_captured_at: '2026-10-30T15:00:00Z', plain_text: 'Earlier body', normalized_text: 'Earlier body',
      content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Earlier body' }] }] } })
    await renderPage('/library/items/item-1?from=project&returnTo=%2Flibrary%2Freading')
    await userEvent.click(screen.getByRole('button', { name: 'Version history' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('Current')).toBeInTheDocument())
    await userEvent.click(within(dialog).getAllByRole('button').find(button => button.querySelector('time') && !button.textContent?.includes('Current'))!)
    await screen.findByText(/Historical version/)
    expect(mockedApi.sourceVersion).toHaveBeenCalledWith('item-1', 'old-snapshot')
    expect(screen.queryByRole('button', { name: 'Read again' })).not.toBeInTheDocument()
    act(() => readerProps!.onTextSelected!(textSelection))
    expect(screen.queryByRole('button', { name: /Highlight/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to latest' }))
    await waitFor(() => expect(screen.queryByText(/Historical version/)).not.toBeInTheDocument())
    expect(mockedApi.getDocument).toHaveBeenLastCalledWith('source_item', 'item-1', { origin: 'project' })
    expect(mockedApi.createAnnotation).not.toHaveBeenCalled()
    expect(mockedSourcesApi.prepareMaterial).not.toHaveBeenCalled()
  })

  it('explains a failed history load and retries without replacing the article', async () => {
    mockedApi.sourceVersions.mockRejectedValueOnce(new Error('History temporarily unavailable')).mockResolvedValueOnce({ items: [], next_offset: null })
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Version history' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('History temporarily unavailable')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await within(dialog).findByText('No retained reading versions.')
    expect(screen.getByTestId('reader-content')).toBeInTheDocument()
  })
})

it('drops the article and its drafts when listing its versions reveals lost parent access', async () => {
  mockedApi.sourceVersions.mockRejectedValueOnce({ status: 403, message: 'Access withdrawn' })
  await renderPage()
  writeCommentDraft({ spaceId: 'space-1', documentType: 'source_item', documentId: 'item-1' }, 'ann-1', 'Private draft')
  await userEvent.click(screen.getByRole('button', { name: 'Version history' }))
  await waitFor(() => expect(screen.queryByTestId('reader-content')).not.toBeInTheDocument())
  expect(__commentDraftCountForTests()).toBe(0)
})

it('ignores a historical-body reply after returning to the current version', async () => {
  let resolveOld!: (doc: ReaderDocumentPayload) => void
  mockedApi.sourceVersion.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
  render(<MemoryRouter initialEntries={['/library/items/item-1?version=old-snapshot']}><Routes>
    <Route path="/library/items/:itemId" element={<><Link to="/library/items/item-1">Latest test route</Link><LibraryItemReaderPage /></>} />
  </Routes></MemoryRouter>)
  await waitFor(() => expect(mockedApi.sourceVersion).toHaveBeenCalled())
  await userEvent.click(screen.getByRole('link', { name: 'Latest test route' }))
  await screen.findByTestId('reader-content')
  await act(async () => resolveOld({ ...docPayload, document_type: 'source_snapshot', document_id: 'old-snapshot', can_annotate: false, normalized_text: 'Stale historical reply' }))
  expect(screen.getByTestId('reader-content')).not.toHaveTextContent('Stale historical reply')
  expect(screen.queryByText(/Historical version/)).not.toBeInTheDocument()
})
