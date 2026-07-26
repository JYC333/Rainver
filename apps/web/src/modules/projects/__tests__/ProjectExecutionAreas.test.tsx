import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectAreaLayout from '../ProjectAreaLayout'
import DeliveryAreaPage from '../DeliveryAreaPage'
import OperationsAreaPage from '../OperationsAreaPage'
import { agentsApi, automationsApi, projectsApi, runsApi, tasksApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ userId: 'user-1' }),
}))

vi.mock('../../../api/client', () => ({
  projectsApi: { get: vi.fn(), getOverview: vi.fn(), operations: vi.fn() },
  tasksApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  agentsApi: { list: vi.fn() },
  automationsApi: { list: vi.fn(), update: vi.fn(), fire: vi.fn() },
  runsApi: { list: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.get).mockResolvedValue({
    id: 'project-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    name: 'Execution Project',
    description: null,
    status: 'active',
    current_focus: null,
    settings_json: null,
    template_key: 'blank',
    primary_mode: 'delivery',
    active_brief_version_id: null,
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
    archived_at: null,
  })
  vi.mocked(projectsApi.getOverview).mockResolvedValue({
    project: { id: 'project-1', name: 'Execution Project', primary_mode: 'delivery', template_key: 'blank', status: 'active' },
    brief: null,
    mode_projection: { mode: 'delivery', current_state_summary: '', progress_indicators: [], focus_set: [], next_actions: [] },
    available_modes: ['inquiry', 'decision', 'delivery', 'operations', 'learning'],
    attention: [
      { id: 'task:task-1', title: 'Ship release', summary: null, href: '/tasks/task-1', source_type: 'task', source_id: 'task-1' },
      { id: 'operational_alert:alert-1', title: 'Health check failed', summary: 'Deployment is unhealthy', href: '/projects/project-1/operations?alert=alert-1', source_type: 'operational_alert', source_id: 'alert-1' },
    ],
    template: { key: 'blank', name: 'Blank', description: 'General purpose', starter_workflow_template_keys: [] },
    setup_checklist: [
      { id: 'brief', label: 'Project Brief goal', status: 'missing', required: true, href: '/projects/project-1', detail: 'Add the intended outcome' },
      { id: 'folder', label: 'Execution-enabled Folder', status: 'missing', required: false, href: '/projects/project-1/files', detail: 'Optional for file/code work' },
    ],
    area_summaries: [],
  })
  vi.mocked(tasksApi.list).mockResolvedValue({
    items: [{
      id: 'task-1',
      space_id: 'space-1',
      project_id: 'project-1',
      title: 'Ship release',
      status: 'in_progress',
      blocked_reason: null,
      due_at: null,
    }],
    total: 1,
    limit: 100,
    offset: 0,
  } as never)
  vi.mocked(tasksApi.update).mockImplementation(async (id, patch) => ({
    ...(await tasksApi.list({})).items[0],
    id,
    ...patch,
  }) as never)
  vi.mocked(agentsApi.list).mockResolvedValue([{ id: 'agent-1', name: 'Builder', status: 'active' }] as never)
  vi.mocked(automationsApi.list).mockResolvedValue([{
    id: 'automation-1',
    name: 'Monitor release',
    status: 'active',
  }] as never)
  vi.mocked(runsApi.list).mockResolvedValue([{
    id: 'run-1',
    status: 'failed',
    instruction: 'Check deployment health',
    error_message: 'Health endpoint timed out',
  }] as never)
  vi.mocked(projectsApi.operations).mockResolvedValue([{
    id: 'operation-1',
    project_id: 'project-1',
    kind: 'custom',
    title: 'Release review',
    status: 'waiting_review',
    progress_json: {},
    created_at: '',
    updated_at: '',
    steps: [],
  }])
})

describe('Project execution Areas', () => {
  it('keeps every Project domain reachable through persistent grouped navigation', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/delivery']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectAreaLayout />}>
            <Route index element={<div>Overview content</div>} />
            <Route path="inquiry" element={<div>Inquiry content</div>} />
            <Route path="delivery" element={<div>Delivery content</div>} />
            <Route path="operations" element={<div>Operations content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Execution Project')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('Decide & learn')).toBeInTheDocument()
    expect(screen.getByText('Execute')).toBeInTheDocument()
    const destinations = [
      ['Overview', ''],
      ['Rooms', '/rooms'],
      ['Inquiry', '/inquiry'],
      ['Research', '/research'],
      ['Sources', '/sources'],
      ['Files & Code', '/files'],
      ['Experiments', '/experiments'],
      ['Decisions', '/decisions'],
      ['Learning', '/learning'],
      ['Knowledge review', '/knowledge-review'],
      ['Delivery', '/delivery'],
      ['Operations', '/operations'],
    ] as const
    for (const [destination, suffix] of destinations) {
      expect(screen.getByRole('link', {
        name: destination === 'Overview' ? /^Overview/ : destination,
      })).toHaveAttribute('href', `/spaces/space-1/projects/project-1${suffix}`)
    }
    expect(screen.getByText('Delivery content')).toBeInTheDocument()
    expect(screen.getByText('Blank template')).toBeInTheDocument()
    expect(screen.getByText('Project Brief goal *')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Project Brief goal/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1')
    expect(screen.getByRole('link', { name: /Execution-enabled Folder/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/files')

    fireEvent.click(screen.getByRole('link', { name: 'Inquiry' }))
    expect(screen.getByText('Inquiry content')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Operations' }))
    expect(screen.getByText('Operations content')).toBeInTheDocument()
  })

  it('loads only the selected Project Tasks in Delivery', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/project-1/delivery']}>
        <Routes>
          <Route path="/projects/:projectId/delivery" element={<DeliveryAreaPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Ship release')).toBeInTheDocument()
    expect(tasksApi.list).toHaveBeenCalledWith({ project_id: 'project-1', limit: '100' })
    expect(screen.getByRole('link', { name: /Ship release/ })).toHaveAttribute('href', '/tasks/task-1')
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledWith('task-1', { status: 'done' }))
  })

  it('loads only the selected Project Automations and Runs in Operations', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/project-1/operations?open=operation-1&alert=alert-1']}>
        <Routes>
          <Route path="/projects/:projectId/operations" element={<OperationsAreaPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Monitor release')).toBeInTheDocument()
    expect(screen.getByText('Check deployment health')).toBeInTheDocument()
    expect(screen.getByText('Health check failed')).toBeInTheDocument()
    expect(screen.getByText('Release review')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Check deployment health/ })).toHaveAttribute('href', '/runs/run-1')
    await waitFor(() => {
      expect(automationsApi.list).toHaveBeenCalledWith({ project_id: 'project-1' })
      expect(runsApi.list).toHaveBeenCalledWith({ project_id: 'project-1', limit: 100 })
      expect(projectsApi.operations).toHaveBeenCalledWith('project-1')
    })
  })
})
