import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import DispatchComposer from '../DispatchComposer'
import { hostsApi, projectFoldersApi, projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  hostsApi: { list: vi.fn(), dispatch: vi.fn(), listRuntimeAdapters: vi.fn() },
  projectFoldersApi: { list: vi.fn() },
  projectsApi: { list: vi.fn(), create: vi.fn() },
}))

const REMOTE_HOST = {
  id: 'host-1', owner_user_id: 'user-1', name: 'Laptop', kind: 'remote' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: 'linux', arch: 'x64',
  daemon_version: '0.1.0', capabilities_json: { runtimes: ['claude', 'git'] },
  created_at: '', updated_at: '',
}

const REMOTE_FOLDER = {
  id: 'folder-1', space_id: 'space-1', project_id: 'project-1', created_by_user_id: 'user-1',
  name: 'mapping', slug: null, description: null, kind: 'code' as const, is_primary: true,
  execution_enabled: true, repo_url: null, root_path: null, default_branch: null, status: 'active' as const,
  protected: false, system_managed: false, registered_from: null, metadata_json: null,
  snapshot_retention_days: null, snapshot_max_count: null,
  host_id: 'host-1', host_kind: 'remote' as const, display_path: '/home/user/mapping',
  created_at: '', updated_at: '',
}

const CLAUDE_ADAPTER = { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true }

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [REMOTE_HOST] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER] })
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [REMOTE_FOLDER], total: 1 } as never)
  vi.mocked(projectsApi.list).mockResolvedValue({ items: [{ id: 'project-1', name: 'Mapping' }], total: 1 } as never)
  vi.mocked(hostsApi.dispatch).mockResolvedValue({ message_id: 'message-1', run_id: 'run-1', thread_id: 'thread-1', status: 'dispatched' })
})

describe('DispatchComposer — follow-up (fixed thread)', () => {
  it('disables Send until a prompt is present, and never sends agent_id', async () => {
    render(
      <DispatchComposer
        initialProjectId="project-1"
        fixedThreadId="thread-1"
        fixedFolderId="folder-1"
        fixedAdapterType="claude_code"
        onDispatched={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/Laptop/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), 'fix the bug')
    const button = screen.getByRole('button', { name: 'Send' })
    await waitFor(() => expect(button).not.toBeDisabled())
    await userEvent.click(button)

    await waitFor(() => expect(hostsApi.dispatch).toHaveBeenCalledWith({
      project_folder_id: 'folder-1',
      adapter_type: 'claude_code',
      prompt: 'fix the bug',
      thread_id: 'thread-1',
    }))
  })

  it('disables Send when the selected host is offline', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, status: 'offline' }] })
    render(
      <DispatchComposer
        initialProjectId="project-1"
        fixedThreadId="thread-1"
        fixedFolderId="folder-1"
        fixedAdapterType="claude_code"
        onDispatched={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/offline/)).toBeInTheDocument())
    await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), 'fix the bug')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('disables Send when the host does not report the runtime as installed', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['git'] } }] })
    render(
      <DispatchComposer
        initialProjectId="project-1"
        fixedThreadId="thread-1"
        fixedFolderId="folder-1"
        fixedAdapterType="claude_code"
        onDispatched={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/not installed on this host/)).toBeInTheDocument())
    await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), 'fix the bug')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('DispatchComposer — new conversation', () => {
  it('shows host/project/workspace pickers, auto-selects the sole eligible runtime, auto-picks the primary workspace, and dispatches without agent_id', async () => {
    const onDispatched = vi.fn()
    render(<DispatchComposer initialProjectId="project-1" onDispatched={onDispatched} />)

    await waitFor(() => expect(screen.getByText('Host')).toBeInTheDocument())
    expect(screen.getByText('Workspace')).toBeInTheDocument()

    // Single eligible workspace (REMOTE_FOLDER is primary) and a single
    // eligible runtime (claude_code) both auto-select — the same
    // "kill the ceremony" effect C8/C10 call for.
    await waitFor(() => expect(screen.getByText(/claude installed/)).toBeInTheDocument())
    await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), 'start something new')
    const button = screen.getByRole('button', { name: 'Start conversation' })
    await waitFor(() => expect(button).not.toBeDisabled())
    await userEvent.click(button)

    await waitFor(() => expect(hostsApi.dispatch).toHaveBeenCalledWith({
      project_folder_id: 'folder-1',
      adapter_type: 'claude_code',
      prompt: 'start something new',
      thread_id: null,
    }))
    expect(onDispatched).toHaveBeenCalled()
  })

  it('shows the workspace-registration CLI command when a project has no registered workspace', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [], total: 0 } as never)
    render(<DispatchComposer initialProjectId="project-1" onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/workspace add/)).toBeInTheDocument())
  })

  it('shows the newly created project by name, not its raw id, after an inline "+ New project" create (discovery review, P3)', async () => {
    const callsBefore = vi.mocked(projectsApi.list).mock.calls.length
    vi.mocked(projectsApi.list)
      .mockResolvedValueOnce({ items: [{ id: 'project-1', name: 'Mapping' }], total: 1 } as never)
      .mockResolvedValue({ items: [{ id: 'project-1', name: 'Mapping' }, { id: 'project-new', name: 'Freshly Created' }], total: 2 } as never)
    vi.mocked(projectsApi.create).mockResolvedValue({ id: 'project-new', name: 'Freshly Created' } as never)

    render(<DispatchComposer onDispatched={vi.fn()} />)
    await waitFor(() => expect(vi.mocked(projectsApi.list).mock.calls.length).toBe(callsBefore + 1))

    await userEvent.click(screen.getByText('New project'))
    await userEvent.type(screen.getByPlaceholderText('Project name'), 'Freshly Created')
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(projectsApi.create).toHaveBeenCalledWith({ name: 'Freshly Created' }))
    // The remount this triggers is what proves the selector picked up the
    // new project's real name instead of falling back to its raw id.
    await waitFor(() => expect(screen.getByText('Freshly Created')).toBeInTheDocument())
    expect(screen.queryByText('project-new')).not.toBeInTheDocument()
  })

  it('shows an offline host in the Host dropdown but does not let it be selected', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [REMOTE_HOST, { ...REMOTE_HOST, id: 'host-2', name: 'Offline Box', status: 'offline' as const }],
    })
    render(<DispatchComposer onDispatched={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /Select a host/ }))
    const offlineOption = await screen.findByRole('option', { name: /Offline Box \(offline\)/ })
    expect(offlineOption).toBeDisabled()
    await userEvent.click(offlineOption)
    expect(screen.getByRole('button', { name: /Select a host/ })).toBeInTheDocument()
  })

  it('refreshes the host list in the background so a host going offline is reflected without a remount (discovery, P3 follow-up)', async () => {
    vi.useFakeTimers()
    try {
      const callsBefore = vi.mocked(hostsApi.list).mock.calls.length
      render(<DispatchComposer onDispatched={vi.fn()} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(vi.mocked(hostsApi.list).mock.calls.length).toBe(callsBefore + 1)

      vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, status: 'offline' as const }] })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

      expect(vi.mocked(hostsApi.list).mock.calls.length).toBe(callsBefore + 2)
    } finally {
      vi.useRealTimers()
    }
  })
})
