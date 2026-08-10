import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

const { runsApiMock, evolutionApiMock, useRunMock } = vi.hoisted(() => ({
  runsApiMock: {
    activities: vi.fn(),
    artifacts: vi.fn(),
    proposals: vi.fn(),
    authorizationRequests: vi.fn(),
    attempts: vi.fn(),
    evaluations: vi.fn(),
    verifications: vi.fn(),
    finalizations: vi.fn(),
    routeDecision: vi.fn(),
    resume: vi.fn(),
    abandon: vi.fn(),
  },
  evolutionApiMock: {
    previewWorkflowFromRun: vi.fn(),
    saveWorkflowFromRun: vi.fn(),
  },
  useRunMock: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  runsApi: runsApiMock,
  authorizationRequestsApi: { approve: vi.fn(), reject: vi.fn() },
  artifactsApi: { export: vi.fn() },
  evolutionApi: evolutionApiMock,
}))
vi.mock('../../../hooks/useRun', () => ({
  useRun: useRunMock,
  RUN_TERMINAL_STATUSES: new Set(['succeeded', 'failed', 'cancelled', 'degraded']),
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [{ id: 'space-1', name: 'Test Space', role: 'owner' }],
    activeSpaceId: 'space-1',
    activeSpaceName: 'Test Space',
    personalSpaceId: 'space-1',
    userId: 'user-1',
  }),
}))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock('../PersonalContextPanel', () => ({ PersonalContextPanel: () => null }))
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => null }))

import RunDetailPage from '../RunDetailPage'

const run = {
  id: 'run-1', status: 'succeeded', mode: 'live', run_type: 'task',
  trigger_origin: 'user', space_id: 'space-1', project_folder_id: null,
  agent_id: 'agent-1', agent_version_id: 'agent-version-1',
  instructed_by_user_id: 'user-1', instructed_by_agent_id: null, owner_user_id: 'user-1',
  created_at: '2026-07-12T00:00:00Z', started_at: '2026-07-12T00:00:01Z', ended_at: '2026-07-12T00:00:02Z',
  error_message: null, task_id: null, visibility: 'space_shared',
  resolved_model: null, prompt_asset_key: null, prompt_version_id: null, prompt_content_hash: null,
  output_json: null, required_sandbox_level: 'worktree', workflow_version_id: null,
  contract_snapshot_json: { run_id: 'run-1' },
} as never

const run2 = { ...(run as Record<string, unknown>), id: 'run-2', contract_snapshot_json: { run_id: 'run-2' } } as never
const waitingRun = { ...(run as Record<string, unknown>), status: 'waiting_for_review', error_message: 'Supervisor review required' } as never

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/runs/run-1']}>
      <Routes>
        <Route path="/spaces/:spaceId/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderPageWithSwitcher() {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/runs/run-1']}>
      <RunSwitcher />
      <Routes>
        <Route path="/spaces/:spaceId/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function RunSwitcher() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate('/spaces/space-1/runs/run-2')}>Switch run</button>
}

describe('RunDetailPage route decision panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRunMock.mockReturnValue({ run, loading: false, error: null })
    runsApiMock.activities.mockResolvedValue({ items: [] })
    runsApiMock.artifacts.mockResolvedValue({ items: [] })
    runsApiMock.proposals.mockResolvedValue({ items: [] })
    runsApiMock.authorizationRequests.mockResolvedValue([])
    runsApiMock.attempts.mockResolvedValue({ attempts: [], supervisor_decisions: [] })
    runsApiMock.evaluations.mockResolvedValue([])
    runsApiMock.verifications.mockResolvedValue([])
    runsApiMock.finalizations.mockResolvedValue([])
  })

  it('renders the persisted decision when the route API returns one', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1', trust_level: 'high' })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('tab', { name: 'Route' }))
    expect(await screen.findByText(/adapter_id/)).toBeInTheDocument()
    expect(screen.getByText(/adapter-1/)).toBeInTheDocument()
    expect(runsApiMock.routeDecision).toHaveBeenCalledWith('run-1')
  })

  it('shows an explicit unavailable state instead of an empty JSON placeholder', async () => {
    runsApiMock.routeDecision.mockRejectedValue(new Error('route decision unavailable'))
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('tab', { name: 'Route' }))
    expect(await screen.findByText('Route decision unavailable')).toBeInTheDocument()
    expect(screen.getByText('route decision unavailable')).toBeInTheDocument()
  })

  it('does not turn optional subresource failures into empty history', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    runsApiMock.attempts.mockRejectedValue(new Error('attempt history unavailable'))
    runsApiMock.evaluations.mockRejectedValue(new Error('evaluation history unavailable'))
    runsApiMock.verifications.mockRejectedValue(new Error('verification history unavailable'))
    runsApiMock.finalizations.mockRejectedValue(new Error('finalization history unavailable'))
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('tab', { name: /Attempts/ }))
    expect(await screen.findByText('Attempts unavailable')).toBeInTheDocument()
    expect(screen.getAllByText('attempt history unavailable')).toHaveLength(2)
    await user.click(screen.getByRole('tab', { name: 'Verification' }))
    expect(await screen.findByText('Evaluations unavailable')).toBeInTheDocument()
    expect(screen.getByText('Verification results unavailable')).toBeInTheDocument()
    expect(screen.getByText('Finalization history unavailable')).toBeInTheDocument()
  })

  it('invalidates a workflow preview when its inputs change', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    evolutionApiMock.previewWorkflowFromRun.mockResolvedValue({ display_name: 'Original preview' })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save as workflow' }))
    await user.type(screen.getByPlaceholderText('Saved workflow'), 'Original')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/Original preview/)).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Saved workflow'), ' changed')
    expect(screen.queryByText(/Original preview/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save workflow' })).toBeDisabled()
  })

  it('ignores a preview response when its inputs change while the request is pending', async () => {
    let resolvePreview: (value: Record<string, unknown>) => void = () => {}
    evolutionApiMock.previewWorkflowFromRun.mockReturnValue(new Promise(resolve => {
      resolvePreview = resolve
    }))
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save as workflow' }))
    const nameInput = screen.getByPlaceholderText('Saved workflow')
    await user.type(nameInput, 'Original')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()

    await user.type(nameInput, ' changed')
    expect(screen.getByRole('button', { name: 'Save workflow' })).toBeDisabled()

    resolvePreview({ display_name: 'Stale preview' })
    await waitFor(() => expect(screen.queryByText(/Stale preview/)).not.toBeInTheDocument())
  })

  it('clears the previous preview when a subsequent preview fails', async () => {
    evolutionApiMock.previewWorkflowFromRun
      .mockResolvedValueOnce({ display_name: 'Initial preview' })
      .mockRejectedValueOnce(new Error('preview failed'))
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Save as workflow' }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/Initial preview/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(screen.queryByText(/Initial preview/)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Save workflow' })).toBeDisabled()
  })

  it('resets the workflow dialog when switching to another run', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    evolutionApiMock.previewWorkflowFromRun.mockResolvedValue({ display_name: 'Run A preview' })
    useRunMock.mockImplementation((requestedId: string | null) => ({
      run: requestedId === 'run-2' ? run2 : run,
      loading: false,
      error: null,
    }))
    const user = userEvent.setup()
    renderPageWithSwitcher()

    await user.click(screen.getByRole('button', { name: 'Save as workflow' }))
    await user.type(screen.getByPlaceholderText('Saved workflow'), 'Run A')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/Run A preview/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Switch run', hidden: true }))
    expect(await screen.findByText('run-2')).toBeInTheDocument()
    expect(screen.queryByText(/Run A preview/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save as workflow' }))
    expect(screen.getByPlaceholderText('Saved workflow')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save workflow' })).toBeDisabled()
  })

  it('ignores a late child-resource response from the previous run', async () => {
    let resolveRunAActivities: (value: { items: Array<Record<string, unknown>>; total: number; limit: number; offset: number }) => void = () => {}
    const runAActivities = new Promise<{ items: Array<Record<string, unknown>>; total: number; limit: number; offset: number }>(resolve => {
      resolveRunAActivities = resolve
    })
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    runsApiMock.activities.mockImplementation((id: string) => id === 'run-1'
      ? runAActivities
      : Promise.resolve({
          items: [{ id: 'activity-b', title: 'Run B activity', activity_type: 'run', occurred_at: '2026-07-12T00:00:00Z', visibility: 'space_shared', content: null }],
          total: 1, limit: 100, offset: 0,
        }))
    useRunMock.mockImplementation((requestedId: string | null) => ({
      run: requestedId === 'run-2' ? run2 : run,
      loading: false,
      error: null,
    }))
    const user = userEvent.setup()
    renderPageWithSwitcher()

    await user.click(screen.getByRole('button', { name: 'Switch run' }))
    await user.click(screen.getByRole('tab', { name: 'Activities' }))
    expect(await screen.findByText('Run B activity')).toBeInTheDocument()
    resolveRunAActivities({
      items: [{ id: 'activity-a', title: 'Run A activity', activity_type: 'run', occurred_at: '2026-07-12T00:00:00Z', visibility: 'space_shared', content: null }],
      total: 1, limit: 100, offset: 0,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText('Run A activity')).not.toBeInTheDocument()
  })

  it('offers resume and abandon only for a run waiting for review', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    runsApiMock.resume.mockResolvedValue({ id: 'run-1', status: 'queued', resumed_at: '2026-07-12T00:00:00Z', resume_kind: 'new_attempt' })
    runsApiMock.abandon.mockResolvedValue({ id: 'run-1', status: 'cancelled', abandoned_at: '2026-07-12T00:00:00Z' })
    useRunMock.mockReturnValue({ run: waitingRun, loading: false, error: null })
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(runsApiMock.resume).toHaveBeenCalledWith('run-1')
    await user.click(screen.getByRole('button', { name: 'Abandon' }))
    await user.type(screen.getByPlaceholderText('Why is this review being abandoned?'), 'No longer needed')
    await user.click(screen.getByRole('button', { name: 'Abandon Run' }))
    expect(runsApiMock.abandon).toHaveBeenCalledWith('run-1', { reason: 'No longer needed' })
  })

  it('requires the authorization decision instead of exposing generic resume', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    const authorizationWaitingRun = {
      ...(waitingRun as Record<string, unknown>),
      error_json: {
        error_code: 'authorization_request_pending',
        authorization_request_id: 'request-1',
      },
    } as never
    useRunMock.mockReturnValue({ run: authorizationWaitingRun, loading: false, error: null })
    runsApiMock.authorizationRequests.mockResolvedValue([{
      id: 'request-1',
      space_id: 'space-1',
      run_id: 'run-1',
      agent_id: 'agent-1',
      instructed_by_user_id: 'user-1',
      policy_decision_record_id: 'decision-1',
      action_id: 'project.source.propose_bind',
      policy_action: 'project.source.bind',
      project_id: null,
      resource_kind: 'projects',
      resource_id: 'project-1',
      reason: 'Need source binding approval',
      status: 'pending',
      resulting_action_grant_id: null,
      decided_by_user_id: null,
      requested_at: '2026-07-12T00:00:00Z',
      decided_at: null,
    }])
    renderPage()

    expect(await screen.findByText('Authorization requests')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Abandon' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('reloads authorization requests when polling reaches waiting_for_review', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    const running = { ...(run as Record<string, unknown>), status: 'running' } as never
    const polledWaiting = {
      ...(running as Record<string, unknown>),
      status: 'waiting_for_review',
      error_json: null,
    } as never
    const request = {
      id: 'request-1',
      space_id: 'space-1',
      run_id: 'run-1',
      agent_id: 'agent-1',
      instructed_by_user_id: 'user-1',
      policy_decision_record_id: 'decision-1',
      action_id: 'project.source.propose_bind',
      policy_action: 'project.source.bind',
      project_id: 'project-1',
      resource_kind: 'projects',
      resource_id: 'project-1',
      reason: 'Need source binding approval',
      status: 'pending',
      resulting_action_grant_id: null,
      decided_by_user_id: null,
      requested_at: '2026-07-12T00:00:00Z',
      decided_at: null,
    }
    useRunMock.mockReturnValue({ run: running, loading: false, error: null })
    runsApiMock.authorizationRequests
      .mockResolvedValueOnce([])
      .mockResolvedValue([request])
    const rendered = renderPage()
    await waitFor(() => expect(runsApiMock.authorizationRequests).toHaveBeenCalledTimes(1))

    useRunMock.mockReturnValue({ run: polledWaiting, loading: false, error: null })
    rendered.rerender(
      <MemoryRouter initialEntries={['/spaces/space-1/runs/run-1']}>
        <Routes>
          <Route path="/spaces/:spaceId/runs/:runId" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(runsApiMock.authorizationRequests).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('shows a retry action when authorization requests cannot be loaded', async () => {
    runsApiMock.routeDecision.mockResolvedValue({ adapter_id: 'adapter-1' })
    const authorizationWaitingRun = {
      ...(waitingRun as Record<string, unknown>),
      error_json: {
        error_code: 'authorization_request_pending',
        authorization_request_id: 'request-1',
      },
    } as never
    useRunMock.mockReturnValue({ run: authorizationWaitingRun, loading: false, error: null })
    runsApiMock.authorizationRequests.mockRejectedValue(new Error('authorization service unavailable'))
    renderPage()

    expect(await screen.findByText('Authorization requests unavailable')).toBeInTheDocument()
    expect(screen.getByText('authorization service unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry authorization requests' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })
})
