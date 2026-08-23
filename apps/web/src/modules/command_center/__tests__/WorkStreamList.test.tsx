import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import WorkStreamList from '../WorkStreamList'
import { hostsApi, projectFoldersApi, runsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../api/client', () => ({
  hostsApi: { listThreads: vi.fn(), listRecentThreads: vi.fn(), list: vi.fn() },
  projectFoldersApi: { list: vi.fn() },
  runsApi: { list: vi.fn(), streamEvents: vi.fn(), stop: vi.fn() },
}))

const HOST = {
  id: 'host-1', owner_user_id: 'user-1', name: 'Laptop', kind: 'remote' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: 'linux', arch: 'x64',
  daemon_version: '0.1.0', capabilities_json: { runtimes: ['claude'] }, created_at: '', updated_at: '',
}
const FOLDER = {
  id: 'folder-1', space_id: 'space-1', project_id: 'project-1', created_by_user_id: 'user-1',
  name: 'mapping', slug: null, description: null, kind: 'code' as const, is_primary: true,
  execution_enabled: true, repo_url: null, root_path: null, default_branch: null, status: 'active' as const,
  protected: false, system_managed: false, registered_from: null, metadata_json: null,
  snapshot_retention_days: null, snapshot_max_count: null,
  host_id: 'host-1', host_kind: 'remote' as const, display_path: '/home/user/mapping',
  created_at: '', updated_at: '',
}
const THREAD = {
  id: 'thread-1', project_folder_id: 'folder-1', host_id: 'host-1', adapter_type: 'claude_code',
  vendor_session_id: 'vs-1', last_run_id: 'run-1', status: 'active' as const,
  created_by_user_id: 'user-1', created_at: '', updated_at: '', queue_paused_at: null,
}
const RECENT_THREAD = { ...THREAD, project_id: 'project-1', project_name: 'Mapping', folder_name: 'mapping' }

function runFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1', space_id: 'space-1', agent_id: 'agent-1', agent_version_id: 'v1', run_role: 'execution' as const,
    project_folder_id: 'folder-1', host_task_thread_id: 'thread-1', session_id: null, parent_run_id: null,
    run_type: 'system', trigger_origin: 'manual', status: 'succeeded', mode: 'live', prompt: 'do the thing',
    instruction: null, scheduled_at: null, started_at: '2026-08-21T00:00:00.000Z', ended_at: '2026-08-21T00:01:00.000Z',
    created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-21T00:01:00.000Z', error_message: null,
    error_json: null, output_json: null, usage: null, project_id: 'project-1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [THREAD] })
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [HOST] })
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [FOLDER], total: 1 } as never)
})

describe('WorkStreamList', () => {
  it('groups runs by thread and shows the host and workspace', async () => {
    vi.mocked(runsApi.list).mockResolvedValue([runFixture()] as never)
    render(<MemoryRouter><WorkStreamList projectId="project-1" onDiagnose={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.getByText('mapping')).toBeInTheDocument()
    expect(screen.getByText('Open thread')).toHaveAttribute(
      'href',
      '/command-center/threads/thread-1?project_id=project-1&folder_id=folder-1',
    )
  })

  it('shows a session-reset notice for a degraded thread', async () => {
    vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [{ ...THREAD, status: 'session_reset' }] })
    vi.mocked(runsApi.list).mockResolvedValue([runFixture()] as never)
    render(<MemoryRouter><WorkStreamList projectId="project-1" onDiagnose={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByText(/session reset/)).toBeInTheDocument()
  })

  it('summarizes a thread by its latest run, not every run in it, and offers a diagnostic-dispatch quick action only when the latest run failed', async () => {
    vi.mocked(runsApi.list).mockResolvedValue([
      runFixture({ id: 'run-older', status: 'succeeded', created_at: '2026-08-21T00:00:00.000Z' }),
      runFixture({ id: 'run-latest', status: 'failed', error_message: 'boom', created_at: '2026-08-21T00:05:00.000Z' }),
    ] as never)
    const onDiagnose = vi.fn()
    render(<MemoryRouter><WorkStreamList projectId="project-1" onDiagnose={onDiagnose} /></MemoryRouter>)

    // One row for the thread (not one per run), reflecting the latest run's status.
    expect(await screen.findByText(/2 messages/)).toBeInTheDocument()
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThan(0)
    const diagnoseButton = await screen.findByRole('button', { name: 'Dispatch diagnostic run' })
    expect(screen.getAllByRole('button', { name: 'Dispatch diagnostic run' })).toHaveLength(1)
    await userEvent.click(diagnoseButton)
    expect(onDiagnose).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-latest' }), 'folder-1')
  })

  it('offers Cancel only when the latest run is queued or running', async () => {
    vi.mocked(runsApi.list).mockResolvedValue([
      runFixture({ id: 'run-done', status: 'succeeded', created_at: '2026-08-21T00:00:00.000Z' }),
      runFixture({ id: 'run-latest', status: 'running', created_at: '2026-08-21T00:05:00.000Z' }),
    ] as never)
    vi.mocked(runsApi.streamEvents).mockReturnValue(new Promise(() => {}))
    render(<MemoryRouter><WorkStreamList projectId="project-1" onDiagnose={vi.fn()} /></MemoryRouter>)
    await screen.findByText('Laptop')
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
  })

  it('shows a thread-count summary line, pluralized correctly', async () => {
    vi.mocked(runsApi.list).mockResolvedValue([runFixture()] as never)
    render(<MemoryRouter><WorkStreamList projectId="project-1" onDiagnose={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByText('1 thread')).toBeInTheDocument()
  })

  it('shows an empty state when there are no dispatched threads', async () => {
    vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [] })
    vi.mocked(runsApi.list).mockResolvedValue([] as never)
    render(<MemoryRouter><WorkStreamList projectId="project-1" onDiagnose={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByText('No dispatched tasks yet')).toBeInTheDocument()
  })

  it('renders the cross-project landing view (no project filter) using recent threads, with a project badge', async () => {
    const callsBefore = vi.mocked(hostsApi.listThreads).mock.calls.length
    vi.mocked(hostsApi.listRecentThreads).mockResolvedValue({ items: [RECENT_THREAD] })
    vi.mocked(runsApi.list).mockResolvedValue([runFixture()] as never)
    render(<MemoryRouter><WorkStreamList projectId={null} onDiagnose={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.getByText('Mapping')).toBeInTheDocument()
    expect(screen.getByText('1 thread across 1 project')).toBeInTheDocument()
    expect(vi.mocked(hostsApi.listThreads).mock.calls.length).toBe(callsBefore)
    expect(runsApi.list).toHaveBeenCalledWith({ limit: 200 })
  })
})
