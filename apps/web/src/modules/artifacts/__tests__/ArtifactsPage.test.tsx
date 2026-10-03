import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import ArtifactsPage from '../ArtifactsPage'
import { artifactsApi, knowledgeApi } from '../../../api/client'
import type { Artifact } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Research Space' }) }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../components/ProjectFolderSelectors', () => ({ ProjectFolderSelectors: () => null }))
vi.mock('../../../api/client', () => ({
  artifactsApi: { list: vi.fn(), export: vi.fn() },
  knowledgeApi: { diagnosticsReport: vi.fn(), explain: vi.fn(), calibrationDecision: vi.fn() },
}))

function artifact(id: string, title: string, artifact_type: string): Artifact {
  return {
    id, space_id: 'space-1', run_id: null, proposal_id: null, artifact_type, surface_role: 'operational', title,
    mime_type: 'application/json', exportable: true, preview: false, storage_ref: null, storage_path: null,
    has_inline_content: true, created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
  }
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/artifacts']}>
      <Routes>
        <Route path="/artifacts" element={<><ArtifactsPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ArtifactsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(artifactsApi.list).mockResolvedValue({ items: [artifact('a-1', 'Context brief', 'context_brief')], total: 1, limit: 100, offset: 0 })
  })

  it('tells the person when the eval delta cannot be parsed instead of failing silently', async () => {
    const { container } = renderPage()
    expect(await screen.findByText('Context brief')).toBeInTheDocument()

    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'No private content crosses the boundary.' } })
    fireEvent.change(screen.getByPlaceholderText('recall_10=0.03'), { target: { value: 'recall_10:0.03' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(toast.error).toHaveBeenCalledWith('eval delta must be JSON or comma-separated key=value pairs')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('filters the list to the generated report type, writes it to the URL, and ignores the stale unfiltered reload', async () => {
    let answerUnfiltered: (value: unknown) => void = () => {}
    let unfilteredCalls = 0
    vi.mocked(artifactsApi.list).mockImplementation(async params => {
      if (params?.artifact_type === 'retrieval_eval_report') {
        return { items: [artifact('r-1', 'Eval report', 'retrieval_eval_report')], total: 1, limit: 100, offset: 0 }
      }
      unfilteredCalls += 1
      if (unfilteredCalls === 1) return { items: [artifact('a-1', 'Context brief', 'context_brief')], total: 1, limit: 100, offset: 0 }
      return new Promise(resolve => { answerUnfiltered = resolve }) as never
    })
    vi.mocked(knowledgeApi.diagnosticsReport).mockResolvedValue({ artifact_id: 'r-1', proposal_id: null, diagnostic_codes: [] } as never)
    renderPage()
    expect(await screen.findByText('Context brief')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(await screen.findByText('Eval report')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('artifact_type=retrieval_eval_report')
    await waitFor(() => expect(unfilteredCalls).toBe(2))

    await act(async () => {
      answerUnfiltered({ items: [artifact('a-1', 'Context brief', 'context_brief'), artifact('r-1', 'Eval report', 'retrieval_eval_report')], total: 2, limit: 100, offset: 0 })
    })
    expect(screen.queryByText('Context brief')).not.toBeInTheDocument()
    expect(screen.getByText('Eval report')).toBeInTheDocument()
  })
})
