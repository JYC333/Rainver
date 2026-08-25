import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import ThreadDetailPage from '../ThreadDetailPage'
import { artifactsApi, hostsApi, projectFoldersApi, runsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../api/client', () => ({
  hostsApi: {
    listThreads: vi.fn(), list: vi.fn(), dispatch: vi.fn(), listRuntimeAdapters: vi.fn(),
    listMessages: vi.fn(), listEvents: vi.fn(), cancel: vi.fn(), resumeQueue: vi.fn(), withdrawMessage: vi.fn(),
  },
  projectFoldersApi: { list: vi.fn(), get: vi.fn() },
  runsApi: { list: vi.fn() },
  artifactsApi: { list: vi.fn(), get: vi.fn() },
  providersApi: { list: vi.fn().mockResolvedValue([]) },
}))

const HOST = {
  id: 'host-1', owner_user_id: 'user-1', name: 'Laptop', kind: 'remote' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: 'linux', arch: 'x64',
  daemon_version: '0.1.0', capabilities_json: { runtimes: ['claude'] }, created_at: '', updated_at: '',
}
const FOLDER = {
  id: 'folder-1', space_id: 'space-1', project_id: 'project-1', created_by_user_id: 'user-1',
  name: 'mapping', slug: null, description: null, kind: 'code' as const, is_primary: true,
  repo_url: null, root_path: null, default_branch: null, status: 'active' as const,
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
const RUN = {
  id: 'run-1', space_id: 'space-1', agent_id: 'agent-1', agent_version_id: 'v1', run_role: 'execution' as const,
  project_folder_id: 'folder-1', host_task_thread_id: 'thread-1', session_id: null, parent_run_id: null,
  run_type: 'system', trigger_origin: 'manual', status: 'succeeded', mode: 'live', prompt: 'fix the bug',
  instruction: null, scheduled_at: null, started_at: '2026-08-21T00:00:00.000Z', ended_at: '2026-08-21T00:01:00.000Z',
  created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-21T00:01:00.000Z', error_message: null,
  error_json: null, output_json: null, usage: null, project_id: 'project-1',
}
const MESSAGE = {
  id: 'message-1', host_task_thread_id: 'thread-1', prompt: 'fix the bug', status: 'dispatched' as const,
  model_provider_id: null, model: null, run_id: 'run-1', created_by_user_id: 'user-1', created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-21T00:00:00.000Z',
}
const EVENT = {
  id: 'event-1', host_task_thread_id: 'thread-1', run_id: 'run-1', event_index: 0, event_type: 'assistant_text' as const,
  text: 'Fixed it.', tool_call_id: null, tool_name: null, tool_input_summary: null,
  tool_kind: null, tool_result_summary: null, status: null, created_at: '2026-08-21T00:00:30.000Z',
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/command-center/threads/thread-1?project_id=project-1&folder_id=folder-1']}>
      <Routes>
        <Route path="/command-center/threads/:threadId" element={<ThreadDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [THREAD] })
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [HOST] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.listMessages).mockResolvedValue({ items: [MESSAGE] })
  vi.mocked(hostsApi.listEvents).mockResolvedValue({ items: [EVENT] })
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [FOLDER], total: 1 } as never)
  vi.mocked(projectFoldersApi.get).mockResolvedValue(FOLDER as never)
  vi.mocked(runsApi.list).mockResolvedValue([RUN] as never)
})

describe('ThreadDetailPage', () => {
  it('names the session after the runtime the thread is actually pinned to', async () => {
    // This page said "Remote Claude session" over a Codex thread: the vendor
    // was written into the label while `thread.adapter_type` sat one line
    // away. The name now comes from the adapter catalog.
    vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [{ ...THREAD, adapter_type: 'codex_cli' }] })
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({
      items: [
        { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true },
        { adapter_type: 'codex_cli', display_name: 'Codex CLI', command: 'codex-acp', capability_probe: 'codex', remote_eligible: true },
      ],
    })

    renderPage()
    expect(await screen.findByText(/Codex CLI session/)).toBeInTheDocument()
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument()
  })

  it('falls back to the raw adapter type rather than naming some other vendor', async () => {
    vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [{ ...THREAD, adapter_type: 'something_new' }] })
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [] })

    renderPage()
    expect(await screen.findByText(/something_new session/)).toBeInTheDocument()
  })

  it('renders the conversation with the host, workspace, user turn, and assistant reply', async () => {
    renderPage()
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.getByText('mapping')).toBeInTheDocument()
    expect(await screen.findByText('fix the bug')).toBeInTheDocument()
    expect(await screen.findByText('Fixed it.')).toBeInTheDocument()
    expect(screen.getByText('vs-1')).toBeInTheDocument()
  })

  it('fetches and renders the uploaded diff on request', async () => {
    vi.mocked(artifactsApi.list).mockResolvedValue({ items: [{ id: 'artifact-1' }], total: 1 } as never)
    vi.mocked(artifactsApi.get).mockResolvedValue({ content: '+new line\n-old line' } as never)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Review diff' }))
    await waitFor(() => expect(artifactsApi.list).toHaveBeenCalledWith({ run_id: 'run-1', artifact_type: 'remote_diff' }))
    expect(await screen.findByText('+new line')).toBeInTheDocument()
  })

  it('shows a message when no diff was uploaded for the run', async () => {
    vi.mocked(artifactsApi.list).mockResolvedValue({ items: [], total: 0 } as never)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Review diff' }))
    expect(await screen.findByText('No diff was uploaded for this run.')).toBeInTheDocument()
  })

  it('shows a paused-queue banner with Resume when the thread queue is paused', async () => {
    vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [{ ...THREAD, queue_paused_at: '2026-08-21T00:02:00.000Z' }] })
    renderPage()
    expect(await screen.findByText('Queue paused')).toBeInTheDocument()
    const resumeButton = screen.getByRole('button', { name: 'Resume' })
    await userEvent.click(resumeButton)
    await waitFor(() => expect(hostsApi.resumeQueue).toHaveBeenCalledWith('thread-1'))
  })
})
