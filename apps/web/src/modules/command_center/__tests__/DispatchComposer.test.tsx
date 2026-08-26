import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import DispatchComposer from '../DispatchComposer'
import { hostsApi, projectFoldersApi, projectsApi, providersApi, tasksApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  hostsApi: { list: vi.fn(), listRuntimeAdapters: vi.fn(), listProviderBindings: vi.fn().mockResolvedValue({ items: [] }) },
  projectFoldersApi: { list: vi.fn(), locations: vi.fn() },
  projectsApi: { list: vi.fn(), create: vi.fn() },
  tasksApi: { createRunWithoutTask: vi.fn() },
  providersApi: { list: vi.fn() },
}))

const REMOTE_HOST = {
  id: 'host-1', owner_user_id: 'user-1', name: 'Laptop', kind: 'remote' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: 'linux', arch: 'x64',
  daemon_version: '0.1.0',
  // As the runtime itself reported over ACP: brackets are part of a model's
  // name, and the effort levels are its own, not a guessed three.
  capabilities_json: {
    runtimes: ['claude', 'git'],
    options: {
      claude: {
        // As the runtime describes them: it names `claude-fable-5[1m]` "Fable",
        // and only `default`'s description says which model it resolves to.
        models: [
          { value: 'default', name: 'Default (recommended)', description: 'Opus (1M context)' },
          { value: 'claude-fable-5[1m]', name: 'Fable', description: 'Fable 5' },
          { value: 'sonnet', name: 'Sonnet', description: null },
        ],
        current_model: 'claude-fable-5[1m]',
        efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max']
          .map(value => ({ value, name: value, description: null })),
        current_effort: 'high',
      },
    },
  },
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
  preferred: true, execution_ready: true, last_seen_at: '', created_at: '', updated_at: '',
}

const CLAUDE_ADAPTER = { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true }

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [REMOTE_HOST] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER] })
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [REMOTE_FOLDER], total: 1 } as never)
  vi.mocked(projectFoldersApi.locations).mockResolvedValue([REMOTE_LOCATION] as never)
  vi.mocked(projectsApi.list).mockResolvedValue({ items: [{ id: 'project-1', name: 'Mapping' }], total: 1 } as never)
  vi.mocked(tasksApi.createRunWithoutTask).mockResolvedValue({ message_id: 'message-1', run_id: 'run-1', thread_id: 'thread-1', status: 'dispatched' } as never)
  vi.mocked(providersApi.list).mockResolvedValue([
    {
      id: 'prov-1', name: 'MiniMax', enabled: true, default_model: 'MiniMax-M3',
      available_models: ['MiniMax-M3', 'MiniMax-M2'],
      claude_compatible_base_url: 'https://api.minimaxi.com/anthropic', openai_compatible_base_url: null,
    },
  ] as never)
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

    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalledWith({
      project_id: 'project-1',
      project_folder_id: 'folder-1',
      workspace_location_id: 'location-1',
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

    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalledWith({
      project_id: 'project-1',
      project_folder_id: 'folder-1',
      workspace_location_id: 'location-1',
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

describe('DispatchComposer — choosing a backend', () => {
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

  async function ready() {
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
    await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), 'hello')
  }

  it('sends no backend keys by default, so the thread keeps the one it has', async () => {
    // Sending `model_provider_id: null` here would silently move the thread
    // onto the machine's own login; the key has to be absent, not null.
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    const body = lastDispatchBody()
    expect('model_provider_id' in body).toBe(false)
    expect('model' in body).toBe(false)
  })

  it('sends the chosen provider and model', async () => {
    await ready()
    await choose('Model backend', 'MiniMax')
    await choose('Model', 'MiniMax-M2')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect(lastDispatchBody()).toMatchObject({ model_provider_id: 'prov-1', model: 'MiniMax-M2' })
  })

  it("sends an explicit null for the machine's own login", async () => {
    // Distinct from omitting the key: this is a real choice to ignore the
    // thread's backend for this dispatch.
    await ready()
    await choose('Model backend', /This machine's login/)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    const body = lastDispatchBody()
    expect('model_provider_id' in body).toBe(true)
    expect(body.model_provider_id).toBeNull()
  })

  it('offers only providers that can back the thread\'s runtime', async () => {
    // claude_code needs a Claude-compatible endpoint; an OpenAI-only provider
    // would be rejected at dispatch, so it is not offered. The menu has to be
    // open for this to mean anything — Select renders its options only while
    // open, so asserting against a closed one passes no matter what the filter
    // does.
    vi.mocked(providersApi.list).mockResolvedValue([
      { id: 'oa', name: 'OpenAI only', enabled: true, default_model: null, available_models: [], claude_compatible_base_url: null, openai_compatible_base_url: 'https://x/v1' },
      { id: 'both', name: 'Claude capable', enabled: true, default_model: null, available_models: [], claude_compatible_base_url: 'https://y/anthropic', openai_compatible_base_url: 'https://y/v1' },
    ] as never)
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Model backend' }))
    expect(screen.getByRole('option', { name: 'Claude capable' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OpenAI only' })).not.toBeInTheDocument()
  })

  it('drops a backend choice that the newly selected runtime cannot use', async () => {
    // A Claude-capable provider often cannot back codex or opencode. Keeping
    // the selection would render a bare id and send a provider the server
    // rejects, as a 422 that reads like a permissions problem.
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({
      items: [
        CLAUDE_ADAPTER,
        { adapter_type: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true },
      ],
    })
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['claude', 'opencode'] } }],
    })
    render(<DispatchComposer initialProjectId="project-1" onDispatched={vi.fn()} />)
    // The host appears both in the Host select's trigger and the readiness
    // badge row, so wait on the Runtime select instead.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Runtime' })).toBeInTheDocument())

    await choose('Runtime', 'Claude Code')
    await choose('Model backend', 'MiniMax')
    expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent('MiniMax')

    await choose('Runtime', 'OpenCode')
    expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent("This host's default")
  })

  /** A brand-new conversation, where "inherit" means this host's default. */
  async function readyNew() {
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER] })
    render(<DispatchComposer initialProjectId="project-1" onDispatched={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model backend' })).toBeInTheDocument())
    await userEvent.type(screen.getByPlaceholderText(/Describe what to do/), 'hello')
  }

  it("names the host's default instead of only promising one", async () => {
    // "This host's default" on its own tells you nothing about which model you
    // are about to run on — which is the question being asked at the moment of
    // picking a runtime.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({
      items: [{ host_id: 'host-1', adapter_type: 'claude_code', model_provider_id: 'prov-1', model: 'MiniMax-M2', updated_at: '' }],
    })
    await readyNew()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent('MiniMax'))
    expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent('MiniMax-M2')
  })

  it("says so when the host's default is the machine's own login", async () => {
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent("this machine's login"))
  })

  it("offers the inherited provider's models without restating the provider", async () => {
    // The server keeps the resolved provider and narrows only the model when
    // `model` travels without `model_provider_id`; before this the composer
    // could not produce that request at all.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({
      items: [{ host_id: 'host-1', adapter_type: 'claude_code', model_provider_id: 'prov-1', model: null, updated_at: '' }],
    })
    await readyNew()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Model' })).toBeInTheDocument())
    await choose('Model', 'MiniMax-M2')
    // A new conversation's button reads differently from a follow-up's.
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())

    const body = lastDispatchBody()
    expect(body.model).toBe('MiniMax-M2')
    expect('model_provider_id' in body).toBe(false)
  })

  it("names the model the machine's own login would use", async () => {
    // With no binding the model is the CLI's own business — its configured
    // model is the only thing that can answer "opus or sonnet, sol or luna"
    // at the moment someone is choosing.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await userEvent.click(screen.getByRole('button', { name: 'Model backend' }))
    // By name, with the effort — not the raw id with its variant suffix.
    const option = screen.getByRole('option', { name: /This machine's login · Fable/ })
    expect(option).toBeInTheDocument()
    expect(option).not.toHaveTextContent('[1m]')
    expect(option).toHaveTextContent('high')
  })

  it("still offers the machine's login when its CLI pins no model", async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['claude', 'git'] } }],
    })
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await userEvent.click(screen.getByRole('button', { name: 'Model backend' }))
    expect(screen.getByRole('option', { name: "This machine's login" })).toBeInTheDocument()
  })

  it("offers the runtime's models on a host default that is itself the machine's login", async () => {
    // The backend is the same either way. Requiring "This machine's login" to
    // be restated just to see a model list made the default look as if it had
    // none.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    // Still on the inherited default — nothing was selected.
    expect(screen.getByRole('button', { name: 'Model backend' })).toHaveTextContent("This host's default")
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument())
    await choose('Model', 'Sonnet')
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())

    const body = lastDispatchBody()
    expect(body.model).toBe('sonnet')
    // Inheriting, so the provider key stays absent rather than pinning one.
    expect('model_provider_id' in body).toBe(false)
  })

  it("offers a bound host default's own models, not the runtime's", async () => {
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({
      items: [{ host_id: 'host-1', adapter_type: 'claude_code', model_provider_id: 'prov-1', model: null, updated_at: '' }],
    })
    await readyNew()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByRole('option', { name: 'MiniMax-M2' })).toBeInTheDocument()
    // The runtime's own catalogue belongs to the machine's login, not to this.
    expect(screen.queryByRole('option', { name: 'Sonnet' })).not.toBeInTheDocument()
  })

  it('shows the model in force, by name, without a synthetic default entry', async () => {
    // One name for one thing: the list is what can be chosen, the selection is
    // what is chosen. An "as configured" entry beside a list the current value
    // had been removed from said it twice and hid the real name.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    const trigger = await screen.findByRole('button', { name: 'Model' })
    // The bracketed variant suffix is part of the value, not of the name.
    // The runtime's own name for it, not the raw id.
    expect(trigger).toHaveTextContent('Fable')
    expect(trigger).not.toHaveTextContent('[1m]')
    expect(trigger).not.toHaveTextContent(/As configured/)

    await userEvent.click(trigger)
    // Every option is listed, the current one included.
    expect(screen.getByRole('option', { name: 'Fable' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /As configured/ })).not.toBeInTheDocument()

    // `Default` alone answers nothing, so it carries what it resolves to.
    expect(screen.getByRole('option', { name: 'Default (Opus (1M context))' })).toBeInTheDocument()
  })

  it('selects the effort in force rather than describing it', async () => {
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    const trigger = await screen.findByRole('button', { name: 'Reasoning effort' })
    expect(trigger).toHaveTextContent('high')
    expect(trigger).not.toHaveTextContent(/As configured/)
  })

  it('sends the whole model id, suffix included, when one is chosen', async () => {
    // The suffix is trimmed for reading only — it is part of what identifies
    // the model to the runtime.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await choose('Model', 'Fable')
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())
    expect(lastDispatchBody().model).toBe('claude-fable-5[1m]')
  })

  it("lets the machine's own login be given a different model", async () => {
    // The whole point of naming it: with no binding the model is the CLI's,
    // and until now there was no way to run this one turn on another.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await choose('Model backend', /This machine's login/)
    await choose('Model', 'Sonnet')
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())

    const body = lastDispatchBody()
    expect(body.model_provider_id).toBeNull()
    expect(body.model).toBe('sonnet')
  })

  it('sends model and effort as two fields, never encoded into one', async () => {
    // A model id can carry brackets of its own — `claude-fable-5[1m]` is one
    // name — so an encoded pair cannot be decoded again.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await choose('Model backend', /This machine's login/)
    await choose('Model', 'Sonnet')
    await choose('Reasoning effort', 'xhigh')
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())

    expect(lastDispatchBody()).toMatchObject({ model: 'sonnet', reasoning_effort: 'xhigh' })
  })

  it('offers the effort levels the runtime reported, not a guessed three', async () => {
    // Claude's are default/low/medium/high/xhigh/max; hardcoding three both
    // omitted real levels and would have invented them for other runtimes.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await userEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }))
    expect(screen.getByRole('option', { name: 'xhigh' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'max' })).toBeInTheDocument()
  })

  it("applies an effort to the CLI's own model without renaming it", async () => {
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
    await readyNew()
    await choose('Model backend', /This machine's login/)
    await choose('Reasoning effort', 'low')
    await userEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(tasksApi.createRunWithoutTask).toHaveBeenCalled())

    const body = lastDispatchBody()
    expect(body.reasoning_effort).toBe('low')
    // The model is untouched: it was never renamed to carry the effort.
    expect('model' in body).toBe(false)
  })

  it("does not guess an existing thread's backend from the host default", async () => {
    // A thread carries its own backend and may have overridden it on an
    // earlier message. The composer cannot see that, so naming the host's
    // default here would state something it does not know.
    vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({
      items: [{ host_id: 'host-1', adapter_type: 'claude_code', model_provider_id: 'prov-1', model: 'MiniMax-M2', updated_at: '' }],
    })
    await ready()
    const trigger = screen.getByRole('button', { name: 'Model backend' })
    expect(trigger).toHaveTextContent("Keep this conversation's backend")
    expect(trigger).not.toHaveTextContent('MiniMax')
    // And no model catalog, which would be the host default's, not the thread's.
    expect(screen.queryByRole('button', { name: 'Model' })).not.toBeInTheDocument()
  })

  it('does not offer a subscription-credentialed provider the server would reject', async () => {
    // A CLI binding's provider is resolved with no user id, which excludes
    // subscription credentials — they have no API key for the proxy to
    // present. Offering one produced a dispatch rejected as "not available in
    // this Space", which reads as a permissions problem instead.
    vi.mocked(providersApi.list).mockResolvedValue([
      { id: 'sub', name: 'Claude subscription', enabled: true, has_subscription: true, default_model: null, available_models: [], claude_compatible_base_url: 'https://api.anthropic.com', openai_compatible_base_url: null },
    ] as never)
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Model backend' }))
    expect(screen.queryByRole('option', { name: 'Claude subscription' })).not.toBeInTheDocument()
  })
})
