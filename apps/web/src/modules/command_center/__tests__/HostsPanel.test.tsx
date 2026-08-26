import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import HostsPanel from '../HostsPanel'
import { hostsApi, providersApi } from '../../../api/client'

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

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER_HOST, REMOTE_HOST] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER] })
  vi.mocked(hostsApi.listProviderBindings).mockResolvedValue({ items: [] })
  vi.mocked(providersApi.list).mockResolvedValue([])
})

describe('HostsPanel', () => {
  it('lists hosts with their status and reported runtimes, and only offers Revoke for a remote host', async () => {
    render(<HostsPanel />)
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(screen.getAllByText('server').length).toBeGreaterThan(0)
    expect(screen.getByText('Built-in server execution host')).toBeInTheDocument()
    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('shows a version next to a runtime badge and marks a detected-but-ineligible runtime as next phase', async () => {
    // ACP runtime replatform P3: codex_cli is remote-eligible now (its own
    // adapter is codex-acp), so a still-genuinely-ineligible adapter
    // (gemini_cli, implementation_status "planned") exercises this case.
    const GEMINI_ADAPTER = { adapter_type: 'gemini_cli', display_name: 'Gemini CLI', command: 'gemini', capability_probe: 'gemini', remote_eligible: false }
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER, GEMINI_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['claude', 'gemini'], versions: { claude: '1.2.3' }, installations: { claude_code: [{ id: 'own', version: '1.2.3', logged_in: null, options: null }] } } }],
    })
    render(<HostsPanel />)
    expect(await screen.findByText('claude 1.2.3')).toBeInTheDocument()
    expect(screen.getByText(/gemini.*next phase/)).toBeInTheDocument()
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

  it('says why a model backend cannot be chosen instead of hiding the control', async () => {
    // A host with no reported runtime has nothing to bind, but someone looking
    // for this control must be told that rather than shown a blank card.
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, capabilities_json: null }] })
    render(<HostsPanel />)
    expect(await screen.findByText(/has not reported an installed runtime/)).toBeInTheDocument()
  })

  it("explains that the server host uses the machine's own logins", async () => {
    render(<HostsPanel />)
    expect(await screen.findByText(/A model backend is chosen per paired remote host/)).toBeInTheDocument()
  })

  it('names the runtimes a host has when none of them can be dispatched to', async () => {
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [CLAUDE_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['git'], versions: {}, installations: {} } }] })
    render(<HostsPanel />)
    expect(await screen.findByText(/runtimes \(git\) can be dispatched to remotely/)).toBeInTheDocument()
  })
})
