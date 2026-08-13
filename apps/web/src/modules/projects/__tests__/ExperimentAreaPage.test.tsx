import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ExperimentAreaPage from '../ExperimentAreaPage'
import { agentsApi, experimentsApi, inquiryApi, projectFoldersApi, projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={`/spaces/space-1${to}`} {...props}>{children}</a>,
}))
vi.mock('../../../api/client', () => ({
  projectsApi: { get: vi.fn() },
  inquiryApi: {
    listOpenSteps: vi.fn().mockResolvedValue([]), listThreads: vi.fn() },
  agentsApi: { list: vi.fn() },
  projectFoldersApi: { list: vi.fn() },
  experimentsApi: {
    listDefinitions: vi.fn(),
    createDefinition: vi.fn(),
    getDefinition: vi.fn(),
    updateDefinition: vi.fn(),
    createVersion: vi.fn(),
    approveVersion: vi.fn(),
    listRuns: vi.fn(),
    createRun: vi.fn(),
    completeRun: vi.fn(),
    listInterpretations: vi.fn(),
    createInterpretation: vi.fn(),
    reviewInterpretation: vi.fn(),
    convertInterpretation: vi.fn(),
  },
}))

const PROJECT = {
  id: 'project-1', space_id: 'space-1', owner_user_id: 'user-1', name: 'Lab',
  description: null, status: 'active' as const, current_focus: null, settings_json: null, primary_mode: 'research' as const, active_brief_version_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', archived_at: null,
}
const DEFINITION = {
  id: 'definition-1', project_id: 'project-1', name: 'Cache test', objective: 'Measure latency',
  primary_hypothesis_thread_id: null, status: 'draft' as const, baseline_run_id: null,
  best_run_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.get).mockResolvedValue(PROJECT)
  vi.mocked(inquiryApi.listThreads).mockResolvedValue([])
  vi.mocked(agentsApi.list).mockResolvedValue([])
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
  vi.mocked(experimentsApi.listDefinitions).mockResolvedValue([DEFINITION])
  vi.mocked(experimentsApi.getDefinition).mockResolvedValue({ ...DEFINITION, versions: [] })
  vi.mocked(experimentsApi.listRuns).mockResolvedValue([])
  vi.mocked(experimentsApi.listInterpretations).mockResolvedValue([])
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/experiments']}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/experiments" element={<ExperimentAreaPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ExperimentAreaPage', () => {
  it('links to a preselected Hypothesis creation flow when none exist', async () => {
    renderPage()

    const links = await screen.findAllByRole('link', { name: /create (a )?hypothesis in inquiry/i })
    expect(links.length).toBeGreaterThan(0)
    expect(links.every(link => link.getAttribute('href') === '/spaces/space-1/projects/project-1/inquiry?new=hypothesis')).toBe(true)
    expect(screen.queryByRole('button', { name: /link hypothesis/i })).not.toBeInTheDocument()
  })

  it('loads the manual Experiment vertical slice and creates a protocol Version', async () => {
    vi.mocked(experimentsApi.createVersion).mockResolvedValue({
      id: 'version-1', definition_id: DEFINITION.id, version: 1, executor_type: 'manual',
      config: {}, planned_summary: 'Manual observation protocol', status: 'draft',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    })
    renderPage()

    expect(await screen.findByText('Cache test')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /new manual protocol version/i }))

    await waitFor(() => expect(experimentsApi.createVersion).toHaveBeenCalledWith(
      'project-1',
      DEFINITION.id,
      expect.objectContaining({ executor_type: 'manual' }),
    ))
    expect(experimentsApi.approveVersion).not.toHaveBeenCalled()
  })

  it('requires a separate review action to approve a draft protocol Version', async () => {
    const draft = {
      id: 'version-1', definition_id: DEFINITION.id, version: 1, executor_type: 'manual' as const,
      config: {}, planned_summary: 'Manual observation protocol', status: 'draft' as const,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }
    vi.mocked(experimentsApi.getDefinition).mockResolvedValue({ ...DEFINITION, versions: [draft] })
    vi.mocked(experimentsApi.approveVersion).mockResolvedValue({ ...draft, status: 'approved' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(experimentsApi.approveVersion).toHaveBeenCalledWith(
      'project-1', DEFINITION.id, 'version-1',
    ))
  })

  it('selects managed execution resources by user-facing names', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{ id: 'folder-1', name: 'Analysis repo', execution_enabled: true, is_primary: true } as never],
      total: 1, limit: 100, offset: 0,
    })
    vi.mocked(agentsApi.list).mockResolvedValue([
      { id: 'agent-1', name: 'Data analyst', status: 'active', current_version_id: 'version-1', adapter_type: 'opencode_cli' } as never,
    ])
    renderPage()

    expect(await screen.findByRole('option', { name: 'Analysis repo (primary)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Data analyst · opencode cli/ })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Folder ID|Agent ID/i)).not.toBeInTheDocument()
  })
})
