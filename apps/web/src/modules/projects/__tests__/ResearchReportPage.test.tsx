import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResearchReportPage from '../ResearchReportPage'
import { projectResearchApi, readerApi } from '../../../api/client'
import { toast } from 'sonner'
import type { ProjectResearchReport, ReaderAnnotation, ReaderDocumentPayload } from '../../../types/api'
import type { ReaderAnnotationsStatus } from '../../../components/reader/readerModel'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))
// The workspace is the shared Reader's own concern; this page supplies its
// header, lead, banner, document and annotation list state.
vi.mock('../../../components/reader/ReaderWorkspace', () => ({
  ReaderWorkspace: ({ header, lead, banner, document, annotations, annotationsStatus }: {
    header?: (value: { panelOpen: boolean; togglePanel: () => void; unsentComments: number }) => ReactNode
    lead?: ReactNode; banner?: ReactNode; document: ReaderDocumentPayload; annotations: ReaderAnnotation[]; annotationsStatus?: ReaderAnnotationsStatus
  }) => <div data-testid="report-reader" data-document={document.document_id}>
    {header?.({ panelOpen: true, togglePanel: vi.fn(), unsentComments: 0 })}{banner}{lead}
    <p data-testid="annotation-quotes">{annotations.map(item => item.quote_text).join('|')}</p>
    {annotationsStatus?.state === 'error' && <button onClick={annotationsStatus.retry}>Retry annotations</button>}
  </div>,
}))
vi.mock('../../../api/client', () => ({
  projectResearchApi: { report: vi.fn(), runReportIntegrity: vi.fn() },
  readerApi: { getDocument: vi.fn(), listAnnotations: vi.fn(), getAppearance: vi.fn(async () => ({ font_size: null, line_height: 'normal', width: 'medium', font: 'sans', theme: 'app' })), getPosition: vi.fn(async () => ({ position: null, accepted: true })), putPosition: vi.fn(async () => ({ position: null, accepted: true })), putAppearance: vi.fn(async (value: unknown) => value), updateAnnotation: vi.fn() },
}))

const report: ProjectResearchReport = {
  id: 'report-1', project_id: 'project-1', workflow_id: 'workflow-1', operation_id: 'operation-1', synthesis_run_id: 'run-1',
  run_kind: 'historical_backfill', research_question: 'Previous question', current_research_question: 'Current question', research_question_version: 2,
  status: 'awaiting_review', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
  content: { schema_version: 'research_report.v1', research_question: 'Previous question', summary: 'Summary', findings: [], sources: [], limitations: [], ideas: [] },
  integrity: { artifact_id: null, status: 'not_run' },
  archive_descriptors: [{ kind: 'archive', artifact_id: 'artifact-1' }],
  resolved_references: [
    {
      id: 'ref-1', availability: 'available', title: 'Readable paper', authors: ['Ada'], year: 2025, library_path: '/library/items/item-1', external_url: 'https://doi.org/10.1/example',
      excerpts: [{ id: 'ref-1a', title: 'Excerpt one' }, { id: 'ref-1b', title: 'Excerpt two' }],
    },
    { id: 'ref-2', availability: 'unavailable' },
  ],
}
const documentPayload: ReaderDocumentPayload = {
  document_type: 'research_report', document_id: 'report-1', space_id: 'space-1', project_id: 'project-1', title: 'Research report', plain_text: 'Summary', normalized_text: 'Summary', content_hash: 'hash',
  content_format: 'tiptap_json', content_schema_version: 1, content_json: { type: 'doc', content: [] }, source_item_id: null, artifact_id: null, source_snapshot_id: null,
  raw_artifact_id: null, extracted_artifact_id: null, source_uri: null, content_state: null, retention_policy: null, can_annotate: true,
}

describe('ResearchReportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectResearchApi.report).mockResolvedValue(report)
    vi.mocked(projectResearchApi.runReportIntegrity).mockResolvedValue({})
    vi.mocked(readerApi.getDocument).mockResolvedValue(documentPayload)
    vi.mocked(readerApi.listAnnotations).mockResolvedValue({ items: [] })
  })

  async function renderPage() {
    render(<MemoryRouter initialEntries={['/projects/project-1/research/reports/report-1']}><Routes><Route path="/projects/:projectId/research/reports/:reportId" element={<ResearchReportPage/>}/></Routes></MemoryRouter>)
    await screen.findByTestId('report-reader')
  }

  it('shows report status, stale-question warning, review entry, and safe resolved references', async () => {
    await renderPage()
    expect(screen.getByText('Awaiting review')).toBeInTheDocument()
    // The research question is the page heading; the stale-question badge sits in its metadata.
    expect(screen.getByRole('heading', { level: 1, name: 'Previous question' })).toBeInTheDocument()
    expect(screen.getAllByText('Previous question')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Return to idea review' })).toHaveAttribute('href', '/projects/project-1#research-checkpoints')
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/library/items/item-1')
    expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText(/item-2/)).not.toBeInTheDocument()
  })

  it('collapses evidence excerpts by default and expands them on demand', async () => {
    await renderPage()
    expect(screen.queryByText(/Excerpt one/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '2 excerpts' }))
    expect(screen.getByText(/Excerpt one/)).toBeInTheDocument()
    expect(screen.getByText(/Excerpt two/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hide excerpts' }))
    expect(screen.queryByText(/Excerpt one/)).not.toBeInTheDocument()
  })

  it('runs integrity and refreshes report detail', async () => {
    await renderPage()
    await userEvent.click(screen.getByText('Advanced'))
    await userEvent.click(screen.getByRole('button', { name: /run integrity check/i }))
    await waitFor(() => expect(projectResearchApi.runReportIntegrity).toHaveBeenCalledWith('project-1', 'report-1'))
    expect(projectResearchApi.report).toHaveBeenCalledTimes(2)
  })

  const annotation = (id: string, quote: string) => ({ id, quote_text: quote, status: 'active' }) as unknown as ReaderAnnotation
  const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
  const reportB = { ...report, id: 'report-2', research_question: 'Second question', current_research_question: 'Second question' }
  const documentB = { ...documentPayload, document_id: 'report-2' }
  function renderRoutes() {
    render(<MemoryRouter initialEntries={['/projects/project-1/research/reports/report-1']}>
      <Link to="/projects/project-1/research/reports/report-2">Go B</Link><Link to="/projects/project-1/research/reports/report-1">Go A</Link>
      <Routes><Route path="/projects/:projectId/research/reports/:reportId" element={<ResearchReportPage/>}/></Routes>
    </MemoryRouter>)
  }

  it.each([
    [403, 'This research report is not available to you', false],
    [404, 'Research report not found', false],
    [500, 'The research report could not be loaded', true],
  ])('replaces report A with B’s own %i state instead of showing A again', async (status, message, retry) => {
    vi.mocked(projectResearchApi.report).mockImplementation(async (_project, id) => {
      if (id === 'report-2') throw Object.assign(new Error(`status ${status}`), { status })
      return report
    })
    renderRoutes()
    expect(await screen.findByRole('heading', { level: 1, name: 'Previous question' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: 'Go B' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByTestId('report-reader')).not.toBeInTheDocument()
    expect(screen.queryByText('Previous question')).not.toBeInTheDocument()
    expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(retry)
  })

  it('shows the latest report after A→B→A even when B answers last', async () => {
    const slowB = deferred<ProjectResearchReport>()
    vi.mocked(projectResearchApi.report).mockImplementation((_project, id) => id === 'report-2' ? slowB.promise : Promise.resolve(report))
    vi.mocked(readerApi.getDocument).mockImplementation(async (_type, id) => id === 'report-2' ? documentB : documentPayload)
    renderRoutes()
    await screen.findByTestId('report-reader')
    await userEvent.click(screen.getByRole('link', { name: 'Go B' }))
    await userEvent.click(screen.getByRole('link', { name: 'Go A' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Previous question' })).toBeInTheDocument()
    await act(async () => { slowB.resolve(reportB) })
    expect(screen.getByTestId('report-reader')).toHaveAttribute('data-document', 'report-1')
    expect(screen.queryByText('Second question')).not.toBeInTheDocument()
  })

  it('keeps the report readable when its annotations fail, and retries only the list', async () => {
    vi.mocked(readerApi.listAnnotations).mockRejectedValueOnce(Object.assign(new Error('annotations down'), { status: 500 }))
      .mockResolvedValueOnce({ items: [annotation('ann-1', 'Recovered quote')] })
    await renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Previous question' })).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Retry annotations' }))
    expect(await screen.findByText('Recovered quote')).toBeInTheDocument()
    expect(projectResearchApi.report).toHaveBeenCalledTimes(1)
  })

  it('does not apply an integrity result to a report opened since', async () => {
    const integrity = deferred<unknown>()
    vi.mocked(projectResearchApi.runReportIntegrity).mockReturnValue(integrity.promise as never)
    vi.mocked(projectResearchApi.report).mockImplementation(async (_project, id) => id === 'report-2' ? reportB : report)
    vi.mocked(readerApi.getDocument).mockImplementation(async (_type, id) => id === 'report-2' ? documentB : documentPayload)
    renderRoutes()
    await screen.findByTestId('report-reader')
    await userEvent.click(screen.getByText('Advanced'))
    await userEvent.click(screen.getByRole('button', { name: /run integrity check/i }))
    await userEvent.click(screen.getByRole('link', { name: 'Go B' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Second question' })).toBeInTheDocument()
    vi.mocked(projectResearchApi.report).mockResolvedValue({ ...report, integrity: { artifact_id: 'a', status: 'available' } })
    await act(async () => { integrity.resolve({}) })
    expect(screen.getByRole('heading', { level: 1, name: 'Second question' })).toBeInTheDocument()
    expect(screen.getByText('Integrity: not checked')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
