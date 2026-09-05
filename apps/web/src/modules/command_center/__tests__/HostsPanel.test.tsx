import { act, render, screen, waitFor } from '@testing-library/react'
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
  },
  providersApi: { list: vi.fn() },
}))

const SERVER_HOST = {
  id: 'host-server', owner_user_id: null, name: 'server', kind: 'server' as const,
  status: 'online' as const, last_heartbeat_at: null, platform: null, arch: null,
  daemon_version: null, capabilities_json: null, created_at: '', updated_at: '',
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
  vi.mocked(providersApi.list).mockResolvedValue([])
})

describe('HostsPanel', () => {
  it('lists hosts without duplicating the Agent inventory above it, and only offers Revoke for a remote host', async () => {
    render(<HostsPanel />)
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.getAllByText('server').length).toBeGreaterThan(0)
    expect(screen.getByText('Built-in server execution host')).toBeInTheDocument()
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

  it("explains that the server host uses the machine's own logins", async () => {
    render(<HostsPanel />)
    expect(await screen.findByText(/manage login and model source per Agent/)).toBeInTheDocument()
  })
})
