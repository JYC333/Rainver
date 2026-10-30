import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, Run } from '../../types/api'

const { artifactsApiMock, runsApiMock, authorizationApiMock } = vi.hoisted(() => ({
  artifactsApiMock: { get: vi.fn() },
  authorizationApiMock: { approve: vi.fn(), reject: vi.fn() },
  runsApiMock: { artifacts: vi.fn(), get: vi.fn(), stop: vi.fn(), resume: vi.fn(), authorizationRequests: vi.fn(), quotaRecovery: vi.fn() },
}))

vi.mock('../../api/client', () => ({
  artifactsApi: artifactsApiMock,
  authorizationRequestsApi: authorizationApiMock,
  runsApi: runsApiMock,
}))

vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

import { ConversationRunControls } from './ConversationRunControls'
import { ConversationScope } from './ConversationScope'
import { ConversationActivity } from './ConversationActivity'

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    space_id: 'space-1',
    agent_id: 'agent-1',
    agent_version_id: 'agent-version-1',
    execution_kind: 'agent',
    run_role: 'execution',
    project_folder_id: null,
    session_id: 'session-1',
    parent_run_id: null,
    run_type: 'conversation',
    trigger_origin: 'user',
    status: 'succeeded',
    mode: 'live',
    prompt: null,
    instruction: null,
    scheduled_at: null,
    started_at: null,
    ended_at: null,
    created_at: '2026-09-13T00:00:00Z',
    updated_at: '2026-09-13T00:00:00Z',
    error_message: null,
    error_json: null,
    output_json: null,
    usage: null,
    ...overrides,
  }
}

const diffSummary = {
  id: 'artifact-diff',
  artifact_type: 'remote_diff',
} as never

const diff = {
  id: 'artifact-diff',
  space_id: 'space-1',
  run_id: 'run-1',
  proposal_id: null,
  artifact_type: 'remote_diff',
  surface_role: 'operational',
  title: 'Run diff',
  mime_type: 'text/plain',
  exportable: true,
  preview: true,
  storage_ref: null,
  storage_path: null,
  metadata_json: {},
  has_inline_content: true,
  content: 'diff --git a/src/index.ts b/src/index.ts',
  created_at: '2026-09-13T00:00:01Z',
  updated_at: '2026-09-13T00:00:01Z',
} as Artifact

describe('ConversationRunControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runsApiMock.artifacts.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 })
    runsApiMock.get.mockResolvedValue(run({ status: 'cancelled' }))
    runsApiMock.authorizationRequests.mockResolvedValue([])
  })

  it('stops the selected old waiting run without stopping the replacement', async () => {
    const changed = vi.fn()
    runsApiMock.stop.mockResolvedValue({})
    runsApiMock.get.mockResolvedValue(run({ id: 'old-wait', status: 'cancelled' }))
    render(<ConversationScope spaceId="space-1" actionUserId="owner">
      <ConversationActivity runs={[
        run({ id: 'old-wait', status: 'waiting_for_dependency', instructed_by_user_id: 'owner' }),
        run({ id: 'replacement', status: 'running', instructed_by_user_id: 'owner' }),
      ]} turns={{}} agentName={() => 'Assistant'} onChanged={changed} />
    </ConversationScope>)
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!)
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: 'old-wait', status: 'cancelled' })))
    expect(runsApiMock.stop).toHaveBeenCalledTimes(1)
    expect(runsApiMock.stop).toHaveBeenCalledWith('old-wait', expect.objectContaining({ spaceId: 'space-1' }))
  })

  it('does not offer per-run stop to another person or in read-only mode', () => {
    const { rerender } = render(<ConversationScope spaceId="space-1" actionUserId="viewer">
      <ConversationActivity runs={[run({ status: 'queued', instructed_by_user_id: 'owner' })]} turns={{}} agentName={() => 'Claude'} />
    </ConversationScope>)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    rerender(<ConversationScope spaceId="space-1" actionUserId="owner">
      <ConversationActivity runs={[run({ status: 'queued', instructed_by_user_id: 'owner' })]} turns={{}} agentName={() => 'Claude'} allowCommands={false} />
    </ConversationScope>)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  const quotaRun = (automatic = true) => run({ status: 'queued', owner_user_id: 'owner', output_json: {
    waiting_for_quota: { resets_at: '2026-10-22T00:00:00Z', recovery: {
      auto_continue: automatic, refused_at: '2026-10-21T22:00:00Z', intent_at: '2026-10-21T22:00:00Z',
      next_check_at: '2026-10-22T00:00:00Z', expires_at: '2026-10-28T22:00:00Z', pause_reason: automatic ? null : 'user',
    } },
  } })

  it('cancels automatic continuation in the source Space and shows the canonical paused choice', async () => {
    runsApiMock.quotaRecovery.mockResolvedValue({})
    runsApiMock.get.mockResolvedValue(quotaRun(false))
    render(<MemoryRouter><ConversationScope spaceId="source" actionUserId="owner">
      <ConversationRunControls runId="run-1" run={quotaRun()} spaceId="source" />
    </ConversationScope></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel automatic continuation' }))
    await waitFor(() => expect(runsApiMock.quotaRecovery).toHaveBeenCalledWith('run-1', false, expect.objectContaining({ spaceId: 'source' })))
    expect(await screen.findByRole('button', { name: 'Continue automatically when quota recovers' })).toBeInTheDocument()
    expect(runsApiMock.stop).not.toHaveBeenCalled()
    expect(screen.getByText(/Paused · manual continuation required/)).toBeInTheDocument()
  })

  it('keeps the recovery control in the bottom activity bar and hides it from other viewers', () => {
    const view = render(<MemoryRouter><ConversationScope actionUserId="owner">
      <ConversationActivity runs={[quotaRun()]} turns={{}} agentName={() => 'Claude'} />
    </ConversationScope></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'Cancel automatic continuation' })).toBeInTheDocument()
    view.rerender(<MemoryRouter><ConversationScope actionUserId="viewer">
      <ConversationActivity runs={[quotaRun()]} turns={{}} agentName={() => 'Claude'} />
    </ConversationScope></MemoryRouter>)
    expect(screen.queryByRole('button', { name: 'Cancel automatic continuation' })).not.toBeInTheDocument()
    expect(screen.getByText(/Waiting for quota/)).toBeInTheDocument()
  })

  it('reports an admission race without claiming automatic continuation was cancelled', async () => {
    runsApiMock.quotaRecovery.mockRejectedValue(new Error('Already resumed; stop the current Run.'))
    render(<MemoryRouter><ConversationRunControls runId="run-1" run={quotaRun()} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel automatic continuation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Already resumed')
    expect(screen.getByRole('button', { name: 'Cancel automatic continuation' })).toBeInTheDocument()
  })

  it('loads the exact diff for a managed Host Run', async () => {
    runsApiMock.artifacts.mockResolvedValue({ items: [diffSummary], total: 1, limit: 50, offset: 0 })
    artifactsApiMock.get.mockResolvedValue(diff)

    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ host_task_thread_id: 'host-thread-1' })} projectId="project-1" />
      </MemoryRouter>,
    )

    await waitFor(() => expect(runsApiMock.artifacts).toHaveBeenCalledWith('run-1', { limit: '50' }, expect.any(Object)))
    expect(await screen.findByText('Open exact diff')).toHaveAttribute('href', '/spaces/space-1/artifacts/artifact-diff')
    expect(screen.getByText('Files & Code')).toHaveAttribute('href', '/spaces/space-1/projects/project-1/files')
    expect(screen.getByTestId('changes-run-1')).toHaveClass('w-full', 'min-w-0', 'max-w-full')
  })

  it('omits the Changes card when an uploaded diff is empty', async () => {
    runsApiMock.artifacts.mockResolvedValue({ items: [diffSummary], total: 1, limit: 50, offset: 0 })
    artifactsApiMock.get.mockResolvedValue({ ...diff, content: '', has_inline_content: false })

    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ host_task_thread_id: 'host-thread-1' })} projectId="project-1" agentLabel="Reviewer" />
      </MemoryRouter>,
    )

    await waitFor(() => expect(artifactsApiMock.get).toHaveBeenCalledWith('artifact-diff', undefined, expect.any(Object)))
    await waitFor(() => expect(screen.getByTestId('conversation-run-controls-run-1')).toBeEmptyDOMElement())
    expect(screen.queryByTestId('changes-run-1')).not.toBeInTheDocument()
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument()
    expect(screen.queryByText('Open exact diff')).not.toBeInTheDocument()
  })

  it('keeps the Changes card when diff content is withheld but the artifact has content', async () => {
    runsApiMock.artifacts.mockResolvedValue({ items: [diffSummary], total: 1, limit: 50, offset: 0 })
    artifactsApiMock.get.mockResolvedValue({ ...diff, content: null, has_inline_content: true })

    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ host_task_thread_id: 'host-thread-1' })} agentLabel="Reviewer" />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('changes-run-1')).toHaveTextContent('Changes recorded.')
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Open exact diff')).toBeInTheDocument()
    expect(screen.queryByText('Preview diff')).not.toBeInTheDocument()
  })

  it('omits the Changes card for a terminal Run without a Host diff', async () => {
    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run()} projectId="project-1" />
      </MemoryRouter>,
    )

    expect(screen.queryByTestId('changes-run-1')).not.toBeInTheDocument()
    expect(runsApiMock.artifacts).not.toHaveBeenCalled()
  })

  it('keeps upload failure visible instead of calling it no change', async () => {
    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ host_task_thread_id: 'host-thread-1' })} />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/Changes are unavailable\./, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('stops an active Run and renders its cancelled state', async () => {
    runsApiMock.stop.mockResolvedValue({})
    runsApiMock.get.mockResolvedValue(run({ status: 'cancelled' }))

    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ status: 'running' })} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(runsApiMock.stop).toHaveBeenCalledWith('run-1', expect.any(Object))
    expect(await screen.findByText('Turn cancelled; partial output is retained.')).toBeInTheDocument()
  })

  it('names whose controls these are when told, so a fan-out does not show identical blocks', () => {
    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ status: 'running' })} agentLabel="Critical Reviewer" />
      </MemoryRouter>,
    )

    const controls = screen.getByTestId('conversation-run-controls-run-1')
    expect(controls).toHaveTextContent('Critical Reviewer')
    expect(controls).toHaveTextContent('Working…')
  })

  it('surfaces a retry error without changing the transcript itself', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('backend changed'))

    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ status: 'failed' })} onRetry={onRetry} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /retry turn/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('backend changed')
    expect(onRetry).toHaveBeenCalledWith('run-1')
  })
  it('approves the exact authorization in its source Space without generic resume', async () => {
    runsApiMock.authorizationRequests.mockResolvedValue([{ id: 'authorization-b', status: 'pending', reason: 'Allow this operation' }])
    runsApiMock.get.mockResolvedValue(run({ status: 'running' }))
    render(<MemoryRouter><ConversationRunControls spaceId="source-b" runId="run-1" run={run({ status: 'waiting_for_review', error_json: { authorization_request_id: 'authorization-b' } })} /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve authorization' }))
    await waitFor(() => expect(authorizationApiMock.approve).toHaveBeenCalledWith('authorization-b', expect.objectContaining({ spaceId: 'source-b' })))
    expect(runsApiMock.resume).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })
  it('resumes supervisor review through the shared Run command and refreshes its caller', async () => {
    runsApiMock.get.mockResolvedValue(run({ status: 'running' }))
    const changed = vi.fn()
    render(<MemoryRouter><ConversationRunControls spaceId="source-b" runId="run-1" run={run({ status: 'waiting_for_review', error_json: { supervisor_review: true } })} onChanged={changed} /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(runsApiMock.resume).toHaveBeenCalledWith('run-1', expect.objectContaining({ spaceId: 'source-b' }))
  })

  it.each([
    ['owner', 'low', true], ['owner', 'medium', true], ['owner', 'high', true], ['owner', 'critical', true], ['owner', undefined, false],
    ['admin', 'low', true], ['admin', 'medium', true], ['admin', 'high', true], ['admin', 'critical', false], ['admin', undefined, false],
    ['reviewer', 'low', true], ['reviewer', 'medium', true], ['reviewer', 'high', false], ['reviewer', 'critical', false], ['reviewer', undefined, false],
    ['member', 'low', false], ['guest', 'low', false], ['owner', 'invalid', false],
  ] as const)('offers policy resume for %s at %s only with approval authority (%s)', async (role, risk, allowed) => {
    render(<MemoryRouter><ConversationScope spaceId="source-b" actionUserId="viewer" actionRole={role}>
      <ConversationRunControls spaceId="source-b" runId="run-1" run={run({ status: 'waiting_for_review', owner_user_id: 'viewer', error_json: { risk_level: risk } })} />
    </ConversationScope></MemoryRouter>)
    await screen.findByRole('button', { name: 'Abandon Run' })
    if (allowed) {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
      await waitFor(() => expect(runsApiMock.resume).toHaveBeenCalledWith('run-1', expect.objectContaining({ spaceId: 'source-b' })))
    } else {
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
      expect(screen.getByText(risk === undefined || risk === 'invalid'
        ? /no valid recorded risk/ : new RegExp(`approval authority for ${risk} risk`))).toBeVisible()
      expect(runsApiMock.resume).not.toHaveBeenCalled()
    }
  })

  it('allows a qualified policy approver to resume without Run standing, but cannot stop or abandon it', async () => {
    render(<MemoryRouter><ConversationScope spaceId="source-b" actionUserId="viewer" actionRole="admin">
      <ConversationRunControls spaceId="source-b" runId="run-1" run={run({ status: 'waiting_for_review', owner_user_id: 'other', error_json: { risk_level: 'high' } })} />
    </ConversationScope></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Abandon Run' })).not.toBeInTheDocument()
  })

  it.each([true, false])('uses the supplied retry callback independently of Run standing (available=%s)', async available => {
    const onRetry = vi.fn().mockResolvedValue(undefined)
    render(<MemoryRouter><ConversationScope spaceId="source-b" actionUserId="viewer" actionRole="member">
      <ConversationRunControls spaceId="source-b" runId="run-1" run={run({ status: 'failed', owner_user_id: 'other', instructed_by_user_id: 'other' })} onRetry={available ? onRetry : undefined} />
    </ConversationScope></MemoryRouter>)
    if (available) {
      fireEvent.click(screen.getByRole('button', { name: 'Retry turn' }))
      await waitFor(() => expect(onRetry).toHaveBeenCalledWith('run-1'))
    } else expect(screen.queryByRole('button', { name: 'Retry turn' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Only the Run owner/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('does not flash a Run authority reason before loading or on a completed Run', async () => {
    runsApiMock.get.mockResolvedValue(run({ owner_user_id: 'other' }))
    render(<MemoryRouter><ConversationScope spaceId="source-b" actionUserId="viewer" actionRole="member">
      <ConversationRunControls runId="run-1" />
    </ConversationScope></MemoryRouter>)
    expect(screen.queryByText(/Only the Run owner/)).not.toBeInTheDocument()
    await waitFor(() => expect(runsApiMock.get).toHaveBeenCalled())
    expect(screen.queryByText(/Only the Run owner/)).not.toBeInTheDocument()
  })

})
