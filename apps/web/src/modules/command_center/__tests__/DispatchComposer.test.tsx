import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import DispatchComposer from '../DispatchComposer'
import { hostsApi, projectFoldersApi, projectsApi, tasksApi } from '../../../api/client'
import type { DispatchOptions } from '../../../types/api'

// The composer renders what `dispatch-options` says can be chosen and sends
// back the choice. Which backends exist, whether each is usable and why,
// and what models/efforts each offers are the server's decisions (covered
// in server/test/hostDispatchOptionsDb.test.ts); here the fixture states
// them and the assertions are about rendering, gating and the request body.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  hostsApi: { list: vi.fn(), listRuntimeAdapters: vi.fn(), dispatchOptions: vi.fn() },
  projectFoldersApi: { list: vi.fn(), locations: vi.fn() },
  projectsApi: { list: vi.fn(), create: vi.fn() },
  tasksApi: { createRunWithoutTask: vi.fn() },
}))

const REMOTE_HOST = {
  id: 'host-1', owner_user_id: 'user-1', name: 'Laptop', kind: 'remote' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: 'linux', arch: 'x64',
  daemon_version: '0.1.0',
  capabilities_json: { runtimes: ['claude', 'git'], versions: {}, installations: { claude_code: [{ id: 'own', version: null, logged_in: null, options: null }] } },
  created_at: '', updated_at: '',
}

const REMOTE_FOLDER = {
  id: 'folder-1', space_id: 'space-1', project_id: 'project-1', created_by_user_id: 'user-1',
  name: 'mapping', slug: null, description: null, kind: 'code' as const, is_primary: true,
  repo_url: null, root_path: null, default_branch: null, status: 'active' as const,
  protected: false, system_managed: false, registered_from: null, metadata_json: null,
  snapshot_retention_days: null, snapshot_max_count: null,
  created_at: '', updated_at: '',
}

const REMOTE_LOCATION = {
  id: 'location-1', project_folder_id: 'folder-1', execution_host_id: 'host-1',
  execution_host_kind: 'remote' as const, display_path: '/home/user/mapping', root_path: null,
  branch: 'main', git_head: 'abc123', dirty: false, status: 'active' as const,
  execution_ready: true, last_seen_at: '', created_at: '', updated_at: '',
}

const CLAUDE_ADAPTER = { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true }
const OPENCODE_ADAPTER = { adapter_type: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true }

const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, name: value, description: null }))
const CLAUDE_MODELS = [
  { value: 'default', name: 'Default (recommended)', description: 'Opus (1M context)' },
  { value: 'claude-fable-5[1m]', name: 'Fable', description: 'Fable 5' },
  { value: 'sonnet', name: 'Sonnet', description: null },
]
const AMBIENT = {
  id: 'ambient', label: "This machine's login · Fable · high", usable: true, reason: null, resolves_to: null,
  models: CLAUDE_MODELS, current_model: 'claude-fable-5[1m]', efforts: EFFORTS, current_effort: 'high',
}
const MINIMAX = {
  id: 'prov-1', label: 'MiniMax', usable: true, reason: null, resolves_to: null,
  models: [{ value: 'MiniMax-M3', name: null, description: null }, { value: 'MiniMax-M2', name: null, description: null }],
  current_model: 'MiniMax-M3', efforts: EFFORTS, current_effort: 'high',
}
/** A host whose default is the machine's login, one own copy of Claude. */
const OPTIONS: DispatchOptions = {
  adapters: [{ adapter_type: 'claude_code', display_name: 'Claude Code', installations: [{ id: 'own', version: null, logged_in: true }] }],
  adapter_type: 'claude_code',
  installation: 'own',
  backends: [
    { ...AMBIENT, id: 'inherit', label: "This host's default · this machine's login · Fable · high", resolves_to: 'ambient' },
    AMBIENT,
    MINIMAX,
  ],
}

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [REMOTE_HOST] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER, OPENCODE_ADAPTER] })
  vi.mocked(hostsApi.dispatchOptions).mockResolvedValue(OPTIONS)
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [REMOTE_FOLDER], total: 1 } as never)
  vi.mocked(projectFoldersApi.locations).mockResolvedValue([REMOTE_LOCATION] as never)
  vi.mocked(projectsApi.list).mockResolvedValue({ items: [{ id: 'project-1', name: 'Mapping' }], total: 1 } as never)
  vi.mocked(tasksApi.createRunWithoutTask).mockResolvedValue({ message_id: 'message-1', run_id: 'run-1', thread_id: 'thread-1', status: 'dispatched' } as never)
})

/** The dispatch mock is shared across this file; only the newest call is ours. */
function lastDispatchBody(): Record<string, unknown> {
  const calls = vi.mocked(tasksApi.createRunWithoutTask).mock.calls
  return calls[calls.length - 1]![0] as Record<string, unknown>
}

/** The Select is a custom listbox, not a native <select>. */
async function choose(label: string, optionName: string | RegExp) {
  await userEvent.click(screen.getByRole('button', { name: label }))
  await userEvent.click(screen.getByRole('option', { name: optionName }))
}

async function typePrompt(text = 'fix the bug') {
  await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), text)
}

describe('DispatchComposer — follow-up (fixed thread)', () => {
  async function ready() {
    render(<DispatchComposer initialProjectId="project-1" fixedThreadId="thread-1" fixedFolderId="folder-1" fixedAdapterType="claude_code" onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model backend' })).toBeInTheDocument())
  }

  it('disables Send until a prompt is present, and never sends agent_id or a copy', async () => {
    await ready()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await typePrompt()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalledWith({
      project_id: 'project-1', project_folder_id: 'folder-1', workspace_location_id: 'location-1',
      adapter_type: 'claude_code', prompt: 'fix the bug', thread_id: 'thread-1',
    }))
    // The thread decides the runtime and copy; the request only names the thread.
    expect(hostsApi.dispatchOptions).toHaveBeenCalledWith('host-1', expect.objectContaining({ thread_id: 'thread-1' }))
  })

  it('disables Send when the selected host is offline, and says so', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, status: 'offline' as const }] })
    render(<DispatchComposer initialProjectId="project-1" fixedThreadId="thread-1" fixedFolderId="folder-1" fixedAdapterType="claude_code" onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByText(/offline/).length).toBeGreaterThan(0))
    await typePrompt()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('disables Send when the host has no copy of the runtime, and says so', async () => {
    vi.mocked(hostsApi.dispatchOptions).mockResolvedValue({ adapters: [], adapter_type: 'claude_code', installation: null, backends: [] })
    render(<DispatchComposer initialProjectId="project-1" fixedThreadId="thread-1" fixedFolderId="folder-1" fixedAdapterType="claude_code" onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/not installed on this host/)).toBeInTheDocument())
    await typePrompt()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText(/Claude Code is not on Laptop/)).toBeInTheDocument()
  })

  it('sends no backend keys by default, so the thread keeps the one it has', async () => {
    await ready()
    await typePrompt()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect(lastDispatchBody()).not.toHaveProperty('model_provider_id')
    expect(lastDispatchBody()).not.toHaveProperty('model')
  })

  it('sends the chosen provider and model', async () => {
    await ready()
    await choose('Model backend', 'MiniMax')
    await choose('Model', 'MiniMax-M2')
    await typePrompt()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect(lastDispatchBody()).toMatchObject({ model_provider_id: 'prov-1', model: 'MiniMax-M2' })
  })

  it("sends an explicit null for the machine's own login", async () => {
    await ready()
    await choose('Model backend', /^This machine's login/)
    await typePrompt()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect('model_provider_id' in lastDispatchBody()).toBe(true)
    expect(lastDispatchBody().model_provider_id).toBeNull()
  })

  it('renders the backends as the server named them, with their models and efforts, selecting what is in force', async () => {
    await ready()
    expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent("This host's default · this machine's login · Fable · high")
    await userEvent.click(screen.getByRole('button', { name: 'Model backend' }))
    expect(screen.getByRole('option', { name: "This machine's login · Fable · high" })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'MiniMax' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    // The model in force is named the runtime's way; the bracket suffix is part of the id, not the name.
    const modelTrigger = screen.getByRole('button', { name: 'Model' })
    expect(modelTrigger).toHaveTextContent('Fable')
    expect(modelTrigger).not.toHaveTextContent('[1m]')
    await userEvent.click(modelTrigger)
    expect(screen.getByRole('option', { name: 'Default (Opus (1M context))' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Reasoning effort' })).toHaveTextContent('high')
  })

  it('sends model and effort as two fields, never encoded into one, with the whole model id', async () => {
    await ready()
    await choose('Model', 'Fable')
    await choose('Reasoning effort', 'max')
    await typePrompt()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect(lastDispatchBody()).toMatchObject({ model: 'claude-fable-5[1m]', reasoning_effort: 'max' })
    expect(lastDispatchBody()).not.toHaveProperty('model_provider_id')
  })

  it('lists an unusable backend disabled with its reason, and moves the selection to a usable one', async () => {
    const reason = 'The managed:0.70.0 copy is not logged in — log it in under Hosts, or use a provider.'
    vi.mocked(hostsApi.dispatchOptions).mockResolvedValue({
      ...OPTIONS,
      installation: 'managed:0.70.0',
      backends: [{ ...OPTIONS.backends[0], usable: false, reason }, { ...AMBIENT, usable: false, reason }, MINIMAX],
    })
    await ready()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent('MiniMax'))
    await userEvent.click(screen.getByRole('button', { name: 'Model backend' }))
    const unusable = screen.getByRole('option', { name: new RegExp(`This machine's login .* — ${reason.slice(0, 20)}`) })
    expect(unusable).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await typePrompt()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
  })

  it('refuses to send when no backend is usable, and says why', async () => {
    const reason = "This machine's copy is not logged in — log it in under Hosts, or use a provider."
    vi.mocked(hostsApi.dispatchOptions).mockResolvedValue({
      ...OPTIONS,
      backends: [{ ...OPTIONS.backends[0], usable: false, reason }, { ...AMBIENT, usable: false, reason }],
    })
    await ready()
    await typePrompt()
    expect(screen.getByRole('button', { name: 'Model backend' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText(reason)).toBeInTheDocument()
  })
})

describe('DispatchComposer — new conversation', () => {
  it('follows the host to its sole runtime, auto-picks the primary workspace, and dispatches with the chosen copy', async () => {
    const onDispatched = vi.fn()
    render(<DispatchComposer initialProjectId="project-1" onDispatched={onDispatched} />)
    await waitFor(() => expect(screen.getByText(/claude installed/)).toBeInTheDocument())
    // One runtime on the host: chosen for the person, no Runtime select shown.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Runtime' })).toBeNull())
    await typePrompt('start something new')
    const button = screen.getByRole('button', { name: 'Start conversation' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalledWith({
      project_id: 'project-1', project_folder_id: 'folder-1', workspace_location_id: 'location-1',
      adapter_type: 'claude_code', installation: 'own', prompt: 'start something new', thread_id: null,
    }))
    expect(onDispatched).toHaveBeenCalled()
  })

  it('offers runtimes only once a host is chosen, and only those the host has a copy of', async () => {
    vi.mocked(hostsApi.dispatchOptions).mockResolvedValue({
      ...OPTIONS,
      adapters: [
        { adapter_type: 'claude_code', display_name: 'Claude Code', installations: [{ id: 'own', version: null, logged_in: true }] },
        { adapter_type: 'opencode', display_name: 'OpenCode', installations: [{ id: 'own', version: null, logged_in: true }] },
      ],
      adapter_type: null,
    })
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([] as never)
    render(<DispatchComposer onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Runtime' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Runtime' })).toHaveTextContent('Select a host first')
    await choose('Host', 'Laptop')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Runtime' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Runtime' }))
    expect(screen.getByRole('option', { name: 'Claude Code' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'OpenCode' })).toBeInTheDocument()
  })

  it('lets a copy be chosen when the host has more than one, and sends it', async () => {
    vi.mocked(hostsApi.dispatchOptions).mockImplementation(async (_host, params) => ({
      ...OPTIONS,
      adapters: [{ adapter_type: 'claude_code', display_name: 'Claude Code', installations: [
        { id: 'own', version: null, logged_in: true },
        { id: 'managed:0.70.0', version: '0.70.0', logged_in: true },
      ] }],
      installation: params?.installation ?? 'own',
    }))
    render(<DispatchComposer initialProjectId="project-1" onDispatched={vi.fn()} />)
    const copies = await screen.findByRole('button', { name: 'Installation' })
    expect(copies).toHaveTextContent("This machine's own install · logged in")
    await choose('Installation', 'Managed 0.70.0 · logged in')
    await waitFor(() => expect(hostsApi.dispatchOptions).toHaveBeenCalledWith('host-1', expect.objectContaining({ installation: 'managed:0.70.0' })))
    await typePrompt('go')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start conversation' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect(lastDispatchBody()).toMatchObject({ installation: 'managed:0.70.0' })
  })

  it('shows the workspace-registration CLI command when a project has no registered workspace', async () => {
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([] as never)
    render(<DispatchComposer initialProjectId="project-1" onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/rainver-host workspace add/)).toBeInTheDocument())
  })

  it('shows the newly created project by name, not its raw id, after an inline "+ New project" create (discovery review, P3)', async () => {
    vi.mocked(projectsApi.create).mockResolvedValue({ id: 'project-new', name: 'Freshly Created' } as never)
    vi.mocked(projectsApi.list)
      .mockResolvedValueOnce({ items: [{ id: 'project-1', name: 'Mapping' }], total: 1 } as never)
      .mockResolvedValue({ items: [{ id: 'project-1', name: 'Mapping' }, { id: 'project-new', name: 'Freshly Created' }], total: 2 } as never)
    render(<DispatchComposer onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('New project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('New project'))
    await userEvent.type(screen.getByPlaceholderText('Project name'), 'Freshly Created')
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(projectsApi.create).toHaveBeenCalledWith({ name: 'Freshly Created' }))
    await waitFor(() => expect(screen.getByText('Freshly Created')).toBeInTheDocument())
  })

  it('shows an offline host in the Host dropdown but does not let it be selected', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [REMOTE_HOST, { ...REMOTE_HOST, id: 'host-2', name: 'Desk', status: 'offline' as const }] })
    render(<DispatchComposer onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Host' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Host' }))
    expect(screen.getByRole('option', { name: 'Desk (offline)' })).toBeDisabled()
  })

  it('refreshes the host list in the background so a host going offline is reflected without a remount (discovery, P3 follow-up)', async () => {
    vi.useFakeTimers()
    try {
      render(<DispatchComposer onDispatched={vi.fn()} />)
      await act(async () => { await Promise.resolve() })
      vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, status: 'offline' as const }] })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await Promise.resolve() })
      expect(vi.mocked(hostsApi.list).mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
