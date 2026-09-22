import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeProfileOut, Task } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), message: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', userId: 'user-1' }),
}))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))
vi.mock('../TaskWorkTab', () => ({ default: () => <div data-testid="task-work-tab" /> }))
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => null }))
vi.mock('react-router-dom', async orig => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ taskId: 'task-1', projectId: '' }),
}))

const mocked = vi.hoisted(() => ({
  get: vi.fn(),
  runs: vi.fn(),
  artifacts: vi.fn(),
  proposals: vi.fn(),
  plan: vi.fn(),
  createRun: vi.fn(),
  requestPlan: vi.fn(),
  listRuntimeProfiles: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  tasksApi: {
    get: mocked.get,
    runs: mocked.runs,
    artifacts: mocked.artifacts,
    proposals: mocked.proposals,
    plan: mocked.plan,
    createRun: mocked.createRun,
    requestPlan: mocked.requestPlan,
    update: vi.fn(),
  },
  agentsApi: { list: vi.fn(async () => []), listRuntimeProfiles: mocked.listRuntimeProfiles },
  artifactsApi: { export: vi.fn() },
  boardsApi: { list: vi.fn(async () => ({ items: [] })) },
}))

import TaskDetailPage from '../TaskDetailPage'

const TASK = {
  id: 'task-1', space_id: 'space-1', task_role: 'subtask', owner_user_id: 'user-1',
  project_folder_id: null, board_id: null, column_id: null, parent_task_id: null,
  title: 'Ship it', description: null, task_type: 'build', status: 'open',
  priority: 'normal', risk_level: 'low', visibility: 'private', access_level: 'full',
  created_by_user_id: 'user-1', created_by_agent_id: null, assigned_user_id: null,
  assigned_agent_id: 'agent-1', claimed_by_user_id: null, claimed_by_agent_id: null,
  source_activity_id: null, source_run_id: null, source_proposal_id: null, source_artifact_id: null,
  due_at: null, start_after: null, completed_at: null, cancelled_at: null, blocked_reason: null,
  created_at: '', updated_at: '', deleted_at: null,
} as unknown as Task

function profile(overrides: Partial<AgentRuntimeProfileOut>): AgentRuntimeProfileOut {
  return {
    id: 'profile-default', space_id: 'space-1', agent_id: 'agent-1', name: 'Default',
    runtime_key: 'opencode', backend_mode: 'runtime_native', execution_host_id: 'host-server',
    workspace_location_id: null, workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
    model: null, provider_binding: { state: 'unbound', provider_id: null, model: null },
    runtime_config_json: {}, runtime_policy_json: {}, enabled: true, is_default: true,
    created_at: '', updated_at: '',
    ...overrides,
  } as AgentRuntimeProfileOut
}

function renderPage() {
  return render(<MemoryRouter><TaskDetailPage /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.get.mockResolvedValue(TASK)
  mocked.runs.mockResolvedValue({ items: [] })
  mocked.artifacts.mockResolvedValue({ items: [] })
  mocked.proposals.mockResolvedValue({ items: [] })
  mocked.plan.mockResolvedValue(null)
  mocked.createRun.mockResolvedValue({ id: 'run-1' })
  mocked.requestPlan.mockResolvedValue({ id: 'run-2' })
})

describe('TaskDetailPage — runtime profile on the default path', () => {
  it('queues a run with no runtime form and no runtime_profile_id when the Agent has one Profile', async () => {
    // Phase 4 gate: the default path needs no runtime form, and the Run must
    // be recorded as a `default` selection rather than an explicit one.
    mocked.listRuntimeProfiles.mockResolvedValue([profile({})])
    renderPage()

    const create = await screen.findByRole('button', { name: 'Create queued run' })
    await waitFor(() => expect(mocked.listRuntimeProfiles).toHaveBeenCalledWith('agent-1'))
    expect(screen.queryByRole('button', { name: 'Runtime Profile' })).toBeNull()
    expect(create).toBeEnabled()

    fireEvent.click(create)
    await waitFor(() => expect(mocked.createRun).toHaveBeenCalledWith('task-1', { mode: 'live', agent_id: 'agent-1' }))
  })

  it('offers the picker and sends an explicit Profile only when a second one is chosen', async () => {
    mocked.listRuntimeProfiles.mockResolvedValue([
      profile({}),
      profile({ id: 'profile-alt', name: 'Alternate', is_default: false, backend_mode: 'model_provider' }),
    ])
    renderPage()

    const picker = await screen.findByRole('button', { name: 'Runtime Profile' })
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('option', { name: /Alternate/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create queued run' }))

    await waitFor(() => expect(mocked.createRun).toHaveBeenCalledWith('task-1', {
      mode: 'live', runtime_profile_id: 'profile-alt', agent_id: 'agent-1',
    }))
  })

  it('shows a Profile load failure as an alert instead of a disabled placeholder', async () => {
    mocked.listRuntimeProfiles.mockRejectedValue(new Error('offline'))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime Profiles could not be loaded.')
    // The server still resolves the Agent's default, so the button stays live.
    expect(screen.getByRole('button', { name: 'Create queued run' })).toBeEnabled()
  })
})
