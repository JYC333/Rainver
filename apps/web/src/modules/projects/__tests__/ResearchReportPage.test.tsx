import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResearchReportPage from '../ResearchReportPage'
import { projectResearchApi, readerApi } from '../../../api/client'
import type { ProjectResearchReport, ReaderDocumentPayload } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../components/reader/ReaderWorkspace', () => ({
  ReaderWorkspace: ({ header }: { header?: (value: { panelOpen: boolean; togglePanel: () => void }) => ReactNode }) => <div data-testid="report-reader">{header?.({ panelOpen: true, togglePanel: vi.fn() })}</div>,
}))
vi.mock('../../../api/client', () => ({
  projectResearchApi: { report: vi.fn(), runReportIntegrity: vi.fn() },
  readerApi: { getDocument: vi.fn(), listAnnotations: vi.fn() },
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
})
