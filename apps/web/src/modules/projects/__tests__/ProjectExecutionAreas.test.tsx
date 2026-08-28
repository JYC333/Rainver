import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectAreaLayout from '../ProjectAreaLayout'
import { agentsApi, automationsApi, projectsApi, runsApi, tasksApi } from '../../../api/client'
import { notifyReviewAttentionChanged } from '../../../core/reviewAttention'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
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
  projectResearchApi: {
    workflows: vi.fn().mockResolvedValue([]),
    checkpoints: vi.fn().mockResolvedValue([]),
    decideCheckpoint: vi.fn(),
    retryOperation: vi.fn(),
    reconcileOperation: vi.fn(),
  },
  inquiryApi: {
    listOpenSteps: vi.fn().mockResolvedValue([]), listThreads: vi.fn().mockResolvedValue([]) },
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
    primary_mode: 'delivery',
    active_brief_version_id: null,
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
    archived_at: null,
  })
  vi.mocked(projectsApi.getOverview).mockResolvedValue({
    project: { id: 'project-1', name: 'Execution Project', primary_mode: 'delivery', status: 'active' },
    brief: null,
    available_modes: ['research', 'delivery', 'operations', 'learning'],
    attention: [
      { id: 'task:task-1', title: 'Ship release', summary: null, href: '/tasks/task-1', attention_class: 'gate', severity: 'high', source_type: 'task', source_id: 'task-1' },
      { id: 'operational_alert:alert-1', title: 'Health check failed', summary: 'Deployment is unhealthy', href: '/projects/project-1/operations?alert=alert-1', attention_class: 'gate', severity: 'high', source_type: 'operational_alert', source_id: 'alert-1' },
    ],
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
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/board']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectAreaLayout />}>
            <Route index element={<div>Overview content</div>} />
            <Route path="inquiry" element={<div>Inquiry content</div>} />
            <Route path="board" element={<div>Board content</div>} />
            <Route path="operations" element={<div>Operations content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Execution Project')).toBeInTheDocument()
    // Three promoted destinations, then everything else under Areas. The
    // promotion must not cost reachability: every route that existed before is
    // still one click away.
    expect(screen.getByRole('link', { name: /^Pulse/ })).toBeInTheDocument()
    for (const gone of ['Explore', 'Decide & learn', 'Digest', 'Raw material', 'Experiments', 'Knowledge review', 'Learning', 'Operations']) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument()
    }
    // Six Areas, flat. What used to be thirteen entries in four groups is
    // three tabs of Sources, two views of Inquiry, a link to the Room, and
    // two Areas retired to the Space; every old route still resolves.
    const destinations = [
      ['Pulse', ''],
      ['Board', '/board'],
      ['Updates', '/updates'],
      ['Conversations', '/conversations'],
      ['Notes', '/notes'],
      ['Inquiry', '/inquiry'],
      ['Research', '/research'],
      ['Sources', '/sources'],
      ['Files & Code', '/files'],
      ['Decisions', '/decisions'],
    ] as const
    for (const [destination, suffix] of destinations) {
      expect(screen.getByRole('link', {
        name: destination === 'Pulse' ? /^Pulse/ : destination,
      })).toHaveAttribute('href', `/spaces/space-1/projects/project-1${suffix}`)
    }
    expect(screen.getByText('Board content')).toBeInTheDocument()
    // The shell names the Project and the way into its Room, and nothing about
    // how it advances: Mode changes only the Loop's wording and lives in
    // Settings. It used to also badge the Template it was created from.
    expect(screen.queryByText(/mode$/)).toBeNull()
    expect(screen.queryByText(/template/i)).toBeNull()
    // No readiness checklist in the shell: it listed configuration state as
    // to-dos from every Area. The one Project-level fact — a missing goal —
    // is Pulse's to say.
    expect(screen.queryByText('Setup')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Execution-enabled Folder/ })).not.toBeInTheDocument()

    // The "Needs attention" list is the one surface visible from every Area
    // (not just the landing tab) that points back at exactly what's pending
    // and where.
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    // A Project's Task opens inside the Project, from here too — this list is
    // the one nav element on screen from every Area, so a raw /tasks href here
    // would drop the person out of the shell from anywhere.
    expect(screen.getByRole('link', { name: /Ship release/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/tasks/task-1')
    expect(screen.getByRole('link', { name: /Health check failed/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/operations?alert=alert-1')

    fireEvent.click(screen.getByRole('link', { name: 'Inquiry' }))
    expect(screen.getByText('Inquiry content')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
  })

  it('can put the Areas list away and remembers that', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/board']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectAreaLayout />}>
            <Route path="board" element={<div>Board content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('link', { name: 'Inquiry' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Areas/ }))
    // The three promoted destinations stay; the Areas do not.
    expect(screen.queryByRole('link', { name: 'Inquiry' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(localStorage.getItem('project.areas.open')).toBe('false')
  })

  it('refreshes the sidebar attention badge after navigating within the Project, without a page reload', async () => {
    const baseOverview = await projectsApi.getOverview('project-1')
    vi.mocked(projectsApi.getOverview)
      .mockReset()
      .mockResolvedValueOnce(baseOverview)
      .mockResolvedValueOnce({ ...baseOverview, attention: [] })

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectAreaLayout />}>
            <Route index element={<div>Overview content</div>} />
            <Route path="inquiry" element={<div>Inquiry content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('link', { name: /^Pulse/ })).toHaveTextContent('2')

    fireEvent.click(screen.getByRole('link', { name: 'Inquiry' }))
    expect(await screen.findByText('Inquiry content')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: /^Pulse/ })).not.toHaveTextContent('2'))
  })

  it('refreshes the sidebar attention badge immediately after a review decision event', async () => {
    const baseOverview = await projectsApi.getOverview('project-1')
    vi.mocked(projectsApi.getOverview)
      .mockReset()
      .mockResolvedValueOnce(baseOverview)
      .mockResolvedValueOnce({ ...baseOverview, attention: [] })

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/inquiry']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectAreaLayout />}>
            <Route path="inquiry" element={<div>Inquiry content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('link', { name: /^Pulse/ })).toHaveTextContent('2')
    notifyReviewAttentionChanged()
    await waitFor(() => expect(screen.getByRole('link', { name: /^Pulse/ })).not.toHaveTextContent('2'))
  })
})
