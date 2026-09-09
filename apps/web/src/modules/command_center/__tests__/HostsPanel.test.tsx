import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import HostsPanel from '../HostsPanel'
import { hostsApi, providersApi, type ModelProviderOut } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: null }) }))
vi.mock('../../../api/client', () => ({
  acpAgentsApi: { list: vi.fn().mockResolvedValue({ items: [] }), registry: vi.fn().mockResolvedValue({ items: [] }) },
  hostsApi: {
    list: vi.fn(), pairingCode: vi.fn(), revoke: vi.fn(), listRuntimeAdapters: vi.fn(),
    // The per-host model-backend selector mounts inside each remote host card.
    listProviderBindings: vi.fn(), setProviderBinding: vi.fn(), clearProviderBinding: vi.fn(),
    // Subscription quota is read on the host and cached server-side; the card
    // reads the cache when it mounts.
    usage: vi.fn(), refreshUsage: vi.fn(), rollbackRuntime: vi.fn(),
  },
  providersApi: { list: vi.fn() },
}))

const SERVER_HOST = {
  id: 'host-server', owner_user_id: null, name: 'server', kind: 'server' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: null, arch: null,
  daemon_version: null, capabilities_json: null, created_at: '', updated_at: '',
  max_concurrent_runs: 3,
}
const REMOTE_HOST = {
  id: 'host-1', owner_user_id: 'user-1', name: 'Laptop', kind: 'remote' as const,
  status: 'offline' as const, last_heartbeat_at: null, platform: 'linux', arch: 'x64',
  daemon_version: '0.1.0', capabilities_json: { runtimes: ['claude', 'git'], versions: {}, installations: { claude_code: [{ id: 'own', version: null, logged_in: null, options: null }] } }, created_at: '', updated_at: '',
}

const CLAUDE_ADAPTER = { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true, provider_api: 'claude_compatible' as const }
// ACP runtime replatform P3: codex_cli's own executable is the pinned
// codex-acp adapter, not the vendor `codex` binary a host's capability probe
// reports — capability_probe carries that distinction.
const CODEX_ADAPTER = { adapter_type: 'codex_cli', display_name: 'Codex', command: 'codex-acp', capability_probe: 'codex', remote_eligible: true, provider_api: 'openai_compatible' as const }
const CLAUDE_PROVIDER = {
  id: 'provider-1', space_id: 'space-1', name: 'Claude proxy', provider_type: 'anthropic', base_url: 'https://example.test',
  network_profile_id: null, claude_compatible_base_url: 'https://example.test', openai_compatible_base_url: null,
  default_model: 'claude-sonnet', available_models: ['claude-sonnet'], enabled: true, is_default: false,
  has_api_key: true, has_subscription: false, grant_enabled: true, created_at: '', updated_at: '',
} satisfies ModelProviderOut

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER_HOST, REMOTE_HOST] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER] })
  vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
  vi.mocked(providersApi.list).mockResolvedValue([])
})

describe('HostsPanel', () => {
  it('lists hosts without duplicating the Agent inventory above it, and only offers Revoke for a remote host', async () => {
    render(<HostsPanel />)
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.getAllByText('server').length).toBeGreaterThan(0)
    expect(screen.getByText(/Built-in execution host/)).toBeInTheDocument()
    expect(screen.getByTestId('host-agent-host-1-claude_code')).toHaveTextContent('Claude Code')
    expect(screen.getByTestId('host-agent-host-1-claude_code')).toHaveTextContent('Model source')
    expect(screen.getByLabelText('Model source for Claude Code on Laptop')).toBeInTheDocument()
    expect(screen.queryByText('Model backend')).toBeNull()
    expect(screen.queryByText('git')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('shows versions on installed Agent rows and omits uninstalled runtime badges', async () => {
    // ACP runtime replatform P3: codex_cli is remote-eligible now (its own
    // adapter is codex-acp), so a still-genuinely-ineligible adapter
    // (gemini_cli, implementation_status "planned") exercises this case.
    const GEMINI_ADAPTER = { adapter_type: 'gemini_cli', display_name: 'Gemini CLI', command: 'gemini', capability_probe: 'gemini', remote_eligible: false }
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER, GEMINI_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['claude', 'gemini'], versions: { claude: '1.2.3' }, installations: { claude_code: [{ id: 'own', version: '1.2.3 (Claude Code)', logged_in: null, options: null }] } } }],
    })
    render(<HostsPanel />)
    expect(await screen.findByTestId('host-agent-host-1-claude_code')).toHaveTextContent('own · 1.2.3')
    expect(screen.getByTestId('host-agent-host-1-claude_code')).not.toHaveTextContent('(Claude Code)')
    expect(screen.queryByText(/gemini.*next phase/i)).toBeNull()
  })

  it('lists an installed registry agent even though it is not dispatch-eligible', async () => {
    // A registry agent's managed copy is installable and managed on the host
    // while `remote_eligible` stays false (no login/state-root contract yet).
    // Filtering the host list by eligibility hid the copy right after install.
    const CURSOR_ADAPTER = { adapter_type: 'acp_cursor', display_name: 'Cursor', command: 'acp_cursor', capability_probe: 'acp_cursor', remote_eligible: false, provider_binding: false }
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER, CURSOR_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: [], versions: {}, installations: { acp_cursor: [{ id: 'managed:2.0.0', version: '2.0.0', logged_in: false, options: null }] } } }],
    })
    render(<HostsPanel />)
    expect(await screen.findByTestId('host-agent-host-1-acp_cursor')).toHaveTextContent('managed · 2.0.0')
    // Not offered as the host's default adapter: that choice is dispatch.
    expect(screen.queryByRole('option', { name: 'Cursor' })).toBeNull()
  })

  it('changes a supported Agent model source from inside that Agent row', async () => {
    vi.mocked(providersApi.list).mockResolvedValue([CLAUDE_PROVIDER])
    vi.mocked(hostsApi.setProviderBinding).mockResolvedValue({
      host_id: 'host-1', adapter_type: 'claude_code', model_provider_id: CLAUDE_PROVIDER.id, model: null, updated_at: '',
    })
    render(<HostsPanel />)
    const modelSource = await screen.findByLabelText('Model source for Claude Code on Laptop')
    await userEvent.click(modelSource)
    await userEvent.click(await screen.findByRole('option', { name: 'Claude proxy · claude-sonnet' }))
    await waitFor(() => expect(hostsApi.setProviderBinding).toHaveBeenCalledWith('host-1', 'claude_code', 'provider-1'))
    expect(modelSource).toHaveTextContent('Claude proxy · claude-sonnet')
  })

  it('issues a pairing code and shows it for copying', async () => {
    vi.mocked(hostsApi.pairingCode).mockResolvedValue({
      host_id: 'host-2', pairing_code: 'abc-123', expires_at: '2026-08-21T01:00:00.000Z',
    })
    render(<HostsPanel />)
    await screen.findByText('Laptop')
    await userEvent.type(screen.getByPlaceholderText('e.g. laptop'), 'desktop')
    await userEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
    await waitFor(() => expect(hostsApi.pairingCode).toHaveBeenCalledWith('desktop'))
    expect(await screen.findByText('abc-123')).toBeInTheDocument()
    const command = screen.getByLabelText('Linux host installation command')
    expect(command.textContent).toContain('releases/download/host-installer/install-host.sh | bash')
    expect(command.textContent).toContain('rainver-host register --server')
    expect(command.textContent).toContain('--code abc-123')
  })

  it('revokes a host and refreshes the list', async () => {
    vi.mocked(hostsApi.revoke).mockResolvedValue(null)
    render(<HostsPanel />)
    await screen.findByText('Laptop')
    const callsBeforeRevoke = vi.mocked(hostsApi.list).mock.calls.length
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(hostsApi.revoke).toHaveBeenCalledWith('host-1'))
    await waitFor(() => expect(vi.mocked(hostsApi.list).mock.calls.length).toBeGreaterThan(callsBeforeRevoke))
  })

  it('refreshes only the mounted hosts panel while it is open', async () => {
    vi.useFakeTimers()
    try {
      render(<HostsPanel />)
      await act(async () => { await Promise.resolve() })
      // The host card and the agents panel below it both name the host.
      expect(screen.getAllByText('Laptop').length).toBeGreaterThan(0)
      const callsBeforePolling = vi.mocked(hostsApi.list).mock.calls.length

      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

      expect(vi.mocked(hostsApi.list).mock.calls.length).toBeGreaterThan(callsBeforePolling)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the unified Agents empty state when no runtime has been reported', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, capabilities_json: null }] })
    render(<HostsPanel />)
    expect(await screen.findByText('No agent on this host yet.')).toBeInTheDocument()
    expect(screen.queryByText('Model backend')).toBeNull()
  })

  // The built-in host used to be described as having no controls of its own.
  // It is a daemon in strict mode now: it carries the same managed copies and
  // logins a paired host does, and every Run on it is isolated in its own
  // namespace — which is what makes it safe for a Space to share.
  it('describes the built-in host as isolated, and names the capacity it runs at', async () => {
    render(<HostsPanel />)
    expect(await screen.findByText(/every Run is isolated in its own namespace/)).toBeInTheDocument()
    expect(screen.getByText(/up to 3 runs execute at once/)).toBeInTheDocument()
  })

  it('shows a member the built-in host\'s copies without the controls that would 403', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{
        ...SERVER_HOST,
        capabilities_json: { runtimes: [], versions: {}, installations: { claude_code: [{ id: 'own', version: '1.2.3', logged_in: true, options: null }] } },
      }],
    })
    render(<HostsPanel />)
    // What is installed and whether it is logged in: that is what says whether
    // a member's Run can run here at all.
    expect(await screen.findByTestId('host-agent-host-server-claude_code')).toHaveTextContent('logged in')
    expect(screen.getByText(/Installing and logging in its agents is instance-admin work/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Log in/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add agent…' })).toBeNull()
    // The built-in host has no host×adapter model source and its bindings
    // route answers 404, so asking would put a "Host not found" toast in front
    // of every member the moment an admin installed a bindable copy on it.
    expect(vi.mocked(hostsApi.listProviderBindings)).not.toHaveBeenCalledWith('host-server')
    expect(screen.queryByLabelText(/^Model source for/)).toBeNull()
  })
})

/**
 * The host card is where a copy's subscription and its upgrade history are
 * acted on. None of it had a test, and the rollback button shipped unreachable
 * because the server dropped `rollback_version` on the way in — a defect one
 * assertion here would have caught.
 */
describe('HostAgentRow subscription and upgrade controls', () => {
  const CLAUDE_HOST = {
    ...REMOTE_HOST,
    status: 'online' as const,
    capabilities_json: {
      runtimes: [], versions: {},
      installations: {
        claude_code: [{
          id: 'managed:2.0.0', version: '2.0.0', logged_in: true, options: null,
          rollback_version: '1.0.0', reports_subscription_quota: true,
        }],
      },
    },
  }

  it('shows what a copy has left, and offers a fresh reading before one is cached', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [CLAUDE_HOST] })
    vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
    vi.mocked(hostsApi.refreshUsage).mockResolvedValue({
      host_id: 'host-1', adapter_type: 'claude_code', installation: 'managed:2.0.0',
      quota: { available: true, session_pct: 61, session_resets: null, week_pct: 18, week_resets: null, error: null },
      checked_at: '2026-09-08T00:00:00.000Z',
    })
    render(<HostsPanel />)

    // The button must exist before the first probe — that is exactly the
    // moment someone wants it, and the scheduled sweep is up to three hours
    // away.
    const refresh = await screen.findByRole('button', { name: /refresh usage for managed:2\.0\.0 of claude code/i })
    fireEvent.click(refresh)

    await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledWith('host-1', 'claude_code', 'managed:2.0.0'))
    expect(await screen.findByText('session 61% · week 18%')).toBeInTheDocument()
  })

  it('says a copy could not be read instead of leaving it looking healthy', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [CLAUDE_HOST] })
    vi.mocked(hostsApi.usage).mockResolvedValue({ items: [{
      host_id: 'host-1', adapter_type: 'claude_code', installation: 'managed:2.0.0',
      quota: { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: 'Log in to Claude Code on this host before reading usage.' },
      checked_at: '2026-09-08T00:00:00.000Z',
    }] })
    render(<HostsPanel />)

    const badge = await screen.findByText('usage unavailable')
    expect(badge).toHaveAttribute('title', expect.stringContaining('Log in to Claude Code'))
  })

  it('offers the rollback the host says it kept, and asks for it by adapter', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [CLAUDE_HOST] })
    vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
    vi.mocked(hostsApi.rollbackRuntime).mockResolvedValue({
      host_id: 'host-1', adapter_type: 'claude_code', ok: true, error: null, installation: 'managed:1.0.0',
    })
    render(<HostsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /roll claude code on laptop back to 1\.0\.0/i }))

    await waitFor(() => expect(hostsApi.rollbackRuntime).toHaveBeenCalledWith('host-1', 'claude_code'))
  })

  it('offers no rollback for the first version installed', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{
      ...CLAUDE_HOST,
      capabilities_json: {
        runtimes: [], versions: {},
        installations: { claude_code: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: true, options: null, rollback_version: null, reports_subscription_quota: true }] },
      },
    }] })
    vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
    render(<HostsPanel />)

    await screen.findByText('managed · 1.0.0 · logged in')
    expect(screen.queryByRole('button', { name: /roll .* back to/i })).toBeNull()
  })
})
