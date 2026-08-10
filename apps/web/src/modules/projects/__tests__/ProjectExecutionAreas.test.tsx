import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectAreaLayout from '../ProjectAreaLayout'
import DeliveryAreaPage from '../DeliveryAreaPage'
import OperationsAreaPage from '../OperationsAreaPage'
import { agentsApi, automationsApi, inquiryApi, projectResearchApi, projectsApi, runsApi, tasksApi } from '../../../api/client'
import { notifyReviewAttentionChanged, REVIEW_ATTENTION_CHANGED_EVENT } from '../../../core/reviewAttention'
import { toast } from 'sonner'

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
  inquiryApi: { listThreads: vi.fn().mockResolvedValue([]) },
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
    mode_projection: { mode: 'delivery', current_state_summary: '', progress_indicators: [], focus_set: [], next_actions: [] },
    available_modes: ['research', 'delivery', 'operations', 'learning'],
    attention: [
      { id: 'task:task-1', title: 'Ship release', summary: null, href: '/tasks/task-1', source_type: 'task', source_id: 'task-1' },
      { id: 'operational_alert:alert-1', title: 'Health check failed', summary: 'Deployment is unhealthy', href: '/projects/project-1/operations?alert=alert-1', source_type: 'operational_alert', source_id: 'alert-1' },
    ],
    setup_checklist: [
      { id: 'brief', label: 'Project Brief goal', status: 'missing', required: true, href: '/projects/project-1/inquiry?setup=goal', detail: 'Add the intended outcome' },
      { id: 'folder', label: 'Execution-enabled Folder', status: 'missing', required: false, href: '/projects/project-1/files', detail: 'Optional for file/code work' },
    ],
    entity_summaries: [],
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
      ['Notes', '/notes'],
      ['Rooms', '/rooms'],
      ['Inquiry', '/inquiry'],
      ['Research', '/research'],
      ['Sources', '/sources'],
      ['Digest', '/digest'],
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
    // The shell shows how the Project advances. It used to also badge the
    // Template it was created from — a provenance label for a concept that
    // presets nothing.
    expect(screen.getByText('delivery mode')).toBeInTheDocument()
    expect(screen.queryByText(/template/i)).toBeNull()
    expect(screen.getByText('Project Brief goal *')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Project Brief goal/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/inquiry?setup=goal')
    expect(screen.getByRole('link', { name: /Execution-enabled Folder/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/files')

    // The "Needs attention" list is the one surface visible from every Area
    // (not just Overview) that points back at exactly what's pending and where.
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Ship release/ })).toHaveAttribute('href', '/spaces/space-1/tasks/task-1')
    expect(screen.getByRole('link', { name: /Health check failed/ })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/operations?alert=alert-1')

    fireEvent.click(screen.getByRole('link', { name: 'Inquiry' }))
    expect(screen.getByText('Inquiry content')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Operations' }))
    expect(screen.getByText('Operations content')).toBeInTheDocument()
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

    expect(await screen.findByRole('link', { name: /^Overview/ })).toHaveTextContent('2')

    fireEvent.click(screen.getByRole('link', { name: 'Inquiry' }))
    expect(await screen.findByText('Inquiry content')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: /^Overview/ })).not.toHaveTextContent('2'))
  })

  it('refreshes the sidebar attention badge immediately after a review decision event', async () => {
    const baseOverview = await projectsApi.getOverview('project-1')
    vi.mocked(projectsApi.getOverview)
      .mockReset()
      .mockResolvedValueOnce(baseOverview)
      .mockResolvedValueOnce({ ...baseOverview, attention: [] })

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/operations']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectAreaLayout />}>
            <Route path="operations" element={<div>Operations content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('link', { name: /^Overview/ })).toHaveTextContent('2')
    notifyReviewAttentionChanged()
    await waitFor(() => expect(screen.getByRole('link', { name: /^Overview/ })).not.toHaveTextContent('2'))
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

  it('lists every research Workflow as its own row in Operations and lets a pending Checkpoint be decided there', async () => {
    vi.mocked(projectsApi.operations).mockResolvedValue([
      {
        id: 'operation-1', project_id: 'project-1', kind: 'research', title: 'Incremental literature search',
        status: 'waiting_review', progress_json: { workflow_id: 'workflow-1', current_stage: 'screening' },
        created_at: '2026-07-30T22:57:05.000Z', updated_at: '', steps: [],
      },
      {
        id: 'operation-baseline', project_id: 'project-1', kind: 'research', title: 'Initial literature search',
        status: 'completed', progress_json: { workflow_id: 'workflow-1', current_stage: 'complete' },
        created_at: '2026-07-30T20:24:33.000Z', updated_at: '', steps: [],
      },
    ])
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: { research_question: 'Does batching improve throughput?' },
      primary_thread_id: 'thread-1', started_by_user_id: null, started_run_id: null,
      created_at: '', updated_at: '',
    }])
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([{
      id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'hypothesis', statement: 'Does batching improve throughput?',
      lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
      owner_user_id: null, next_focus_kind: null, next_focus_note: null, blocked_reason: null,
      version: 1, created_from: 'user', created_by_user_id: 'user-1', created_at: '', updated_at: '',
    } as never])
    vi.mocked(projectResearchApi.checkpoints).mockResolvedValue([{
      id: 'checkpoint-1', project_id: 'project-1', workflow_id: 'workflow-1', stage_key: 'screening',
      checkpoint_type: 'screening_gate', status: 'pending',
      machine_result_json: { operation_id: 'operation-1', total: 4, relevant: 3, maybe: 1 },
      review: null, user_decision: null, decision_reason: null, decided_by_user_id: null, decided_at: null,
      created_at: '', updated_at: '',
    }])
    vi.mocked(projectResearchApi.decideCheckpoint).mockResolvedValue({} as never)
    const reviewAttentionChanged = vi.fn()
    window.addEventListener(REVIEW_ATTENTION_CHANGED_EVENT, reviewAttentionChanged)

    render(
      <MemoryRouter initialEntries={['/projects/project-1/operations']}>
        <Routes>
          <Route path="/projects/:projectId/operations" element={<OperationsAreaPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findAllByText('Does batching improve throughput?')).toHaveLength(2)
    expect(screen.getAllByText('Review needed')).toHaveLength(1)
    // Question/Hypothesis definition lives on the Inquiry page now — "+ New
    // search" always routes there first instead of opening a dialog with no
    // Thread to target.
    expect(screen.getByRole('link', { name: /New search/ })).toHaveAttribute('href', '/projects/project-1/inquiry?research_intent=1')

    fireEvent.click(screen.getByRole('button', { name: 'Approve screening' }))
    await waitFor(() => expect(projectResearchApi.decideCheckpoint).toHaveBeenCalledWith(
      'project-1', 'workflow-1', 'checkpoint-1', { decision: 'approved' },
    ))
    expect(toast.dismiss).toHaveBeenCalledWith('research-review:project-1:checkpoint-1')
    await waitFor(() => expect(reviewAttentionChanged).toHaveBeenCalled())
    window.removeEventListener(REVIEW_ATTENTION_CHANGED_EVENT, reviewAttentionChanged)
  })

  it('keeps the research review toast when the checkpoint decision fails', async () => {
    vi.mocked(projectsApi.operations).mockResolvedValue([{
      id: 'operation-1', project_id: 'project-1', kind: 'research', title: 'Initial literature search',
      status: 'waiting_review', progress_json: { workflow_id: 'workflow-1', current_stage: 'screening' },
      created_at: '', updated_at: '', steps: [],
    }])
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: { research_question: 'Does batching improve throughput?' },
      primary_thread_id: 'thread-1', started_by_user_id: null, started_run_id: null,
      created_at: '', updated_at: '',
    }])
    vi.mocked(projectResearchApi.checkpoints).mockResolvedValue([{
      id: 'checkpoint-1', project_id: 'project-1', workflow_id: 'workflow-1', stage_key: 'screening',
      checkpoint_type: 'screening_gate', status: 'pending',
      machine_result_json: { operation_id: 'operation-1', total: 4, relevant: 3, maybe: 1 },
      review: null, user_decision: null, decision_reason: null, decided_by_user_id: null, decided_at: null,
      created_at: '', updated_at: '',
    }])
    vi.mocked(projectResearchApi.decideCheckpoint).mockRejectedValueOnce(new Error('Decision failed'))

    render(
      <MemoryRouter initialEntries={['/projects/project-1/operations']}>
        <Routes>
          <Route path="/projects/:projectId/operations" element={<OperationsAreaPage />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Approve screening' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Decision failed'))
    expect(toast.dismiss).not.toHaveBeenCalled()
  })
})
