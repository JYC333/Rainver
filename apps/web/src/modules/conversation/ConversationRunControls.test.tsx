import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, Run } from '../../types/api'

const { artifactsApiMock, runsApiMock } = vi.hoisted(() => ({
  artifactsApiMock: { get: vi.fn() },
  runsApiMock: { artifacts: vi.fn(), get: vi.fn(), stop: vi.fn() },
}))

vi.mock('../../api/client', () => ({
  artifactsApi: artifactsApiMock,
  runsApi: runsApiMock,
}))

vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

import { ConversationRunControls } from './ConversationRunControls'

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
  })

  it('loads the exact diff for a managed Host Run', async () => {
    runsApiMock.artifacts.mockResolvedValue({ items: [diffSummary], total: 1, limit: 50, offset: 0 })
    artifactsApiMock.get.mockResolvedValue(diff)

    render(
      <MemoryRouter>
        <ConversationRunControls runId="run-1" run={run({ host_task_thread_id: 'host-thread-1' })} projectId="project-1" />
      </MemoryRouter>,
    )

    await waitFor(() => expect(runsApiMock.artifacts).toHaveBeenCalledWith('run-1', { limit: '50' }))
    expect(await screen.findByText('Open exact diff')).toHaveAttribute('href', '/artifacts/artifact-diff')
    expect(screen.getByText('Files & Code')).toHaveAttribute('href', '/projects/project-1/files')
    expect(screen.getByTestId('changes-run-1')).toHaveClass('w-full', 'min-w-0', 'max-w-full')
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
    expect(runsApiMock.stop).toHaveBeenCalledWith('run-1')
    expect(await screen.findByText('Turn cancelled; partial output is retained.')).toBeInTheDocument()
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
})
