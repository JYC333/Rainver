import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import HostsPanel from '../HostsPanel'
import { hostsApi } from '../../../api/client'

vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const authState = vi.hoisted(() => ({ currentUser: null as null | { is_instance_admin: boolean } }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => authState }))
vi.mock('../../../api/client', () => ({
  acpAgentsApi: { list: vi.fn().mockResolvedValue({ items: [] }), registry: vi.fn().mockResolvedValue({ items: [] }) },
  hostsApi: {
    list: vi.fn(), pairingCode: vi.fn(), revoke: vi.fn(), listRuntimeDefinitions: vi.fn(),
    // Subscription quota is read on the host and cached server-side; the card
    // reads the cache when it mounts.
    usage: vi.fn(), refreshUsage: vi.fn(), installRuntime: vi.fn(), updateManagedRuntime: vi.fn(), rollbackRuntime: vi.fn(),
    serverRuntimeProvisioning: vi.fn(), retryServerRuntimeProvisioning: vi.fn(),
  },
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

const CLAUDE_ADAPTER = { runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'claude_compatible' as const }
// codex_cli's own executable is the pinned
// codex-acp adapter, not the vendor `codex` binary a host's capability probe
// reports — capability_probe carries that distinction.
const CODEX_ADAPTER = { runtime_key: 'codex_cli', display_name: 'Codex', command: 'codex-acp', capability_probe: 'codex', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'openai_compatible' as const }
beforeEach(() => {
  authState.currentUser = null
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER_HOST, REMOTE_HOST] })
  vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER] })
  vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.serverRuntimeProvisioning).mockResolvedValue({
    host_id: SERVER_HOST.id,
    runtime_key: 'opencode',
    installation: { state: 'ready', desired_version: '1.2.3', installed_version: '1.2.3', active_version: '1.2.3', error: null, attempts: 1 },
    native_account: { installation_id: 'managed:1.2.3', logged_in: false, accounts: [] },
  })
})

function Location() {
  const location = useLocation()
  return <span hidden data-testid="location">{location.search}</span>
}
/** The panel as Command Center mounts it, at a given URL. */
function renderPanel(search = '') {
  return render(<MemoryRouter initialEntries={[`/command-center${search}`]}><HostsPanel /><Location /></MemoryRouter>)
}
const params = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '')

describe('HostsPanel', () => {
  it('lists hosts without duplicating the Agent inventory above it, and only offers Revoke for a remote host', async () => {
    renderPanel()
    // The list names both; the detail opens on the instance's own Host.
    const list = await screen.findByRole('navigation', { name: 'Execution environments' })
    expect(within(list).getByRole('button', { name: /Laptop/ })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: /Built-in sandbox/ })).toHaveAttribute('aria-current', 'true')
    expect(await screen.findByText('ACP health passed')).toBeInTheDocument()
    expect(screen.getByText(/Selected version/)).toBeInTheDocument()
    expect(screen.getByText(/every Run is isolated in its own namespace/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()

    fireEvent.click(within(list).getByRole('button', { name: /Laptop/ }))
    expect(await screen.findByTestId('host-agent-host-1-claude_code')).toHaveTextContent('Claude Code')
    expect(screen.queryByText('ACP health passed')).toBeNull()
    expect(screen.queryByLabelText(/^Model source for/)).toBeNull()
    expect(screen.queryByText('Model backend')).toBeNull()
    expect(screen.queryByText('git')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
    expect(params().get('host')).toBe('host-1')
  })

  it('shows Server provisioning failure and lets an instance admin retry it', async () => {
    authState.currentUser = { is_instance_admin: true }
    vi.mocked(hostsApi.serverRuntimeProvisioning)
      .mockResolvedValueOnce({
        host_id: SERVER_HOST.id,
        runtime_key: 'opencode',
        installation: { state: 'failed', desired_version: '1.2.3', installed_version: '1.2.2', active_version: null, error: 'ACP health check failed', attempts: 2 },
        native_account: { installation_id: null, logged_in: null, accounts: null },
      })
      .mockResolvedValueOnce({
        host_id: SERVER_HOST.id,
        runtime_key: 'opencode',
        installation: { state: 'queued', desired_version: '1.2.3', installed_version: '1.2.2', active_version: null, error: null, attempts: 2 },
        native_account: { installation_id: null, logged_in: null, accounts: null },
      })
    vi.mocked(hostsApi.retryServerRuntimeProvisioning).mockResolvedValue({
      host_id: SERVER_HOST.id, runtime_key: 'opencode', state: 'queued', desired_version: '1.2.3',
    })
    renderPanel()

    expect(await screen.findByText('Provisioning failed')).toBeInTheDocument()
    expect(screen.getByText('ACP health check failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry Server Runtime provisioning' }))
    await waitFor(() => expect(hostsApi.retryServerRuntimeProvisioning).toHaveBeenCalledWith(SERVER_HOST.id))
    expect(await screen.findByText('Provisioning: queued')).toBeInTheDocument()
  })

  it('marks a loaded Server Runtime status as stale when the next read fails', async () => {
    // The panel keeps the last good status on a failed read. Do not leave the
    // "could not load" branch unreachable once one has landed, or the badge
    // would claim to be current. The indicator is what says otherwise.
    vi.useFakeTimers()
    try {
      renderPanel()
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText('ACP health passed')).toBeInTheDocument()
      expect(screen.queryByText(/Status stale/)).toBeNull()

      vi.mocked(hostsApi.serverRuntimeProvisioning).mockRejectedValue(new Error('server runtime unreachable'))
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

      expect(screen.getByText(/Status stale: server runtime unreachable/)).toBeInTheDocument()
      // The status it had is still on screen — a failed read is not a missing copy.
      expect(screen.getByText('ACP health passed')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows versions on installed Agent rows and omits uninstalled runtime badges', async () => {
    // codex_cli is remote-eligible. gemini_cli is not. An ineligible runtime
    // does not get a phase badge on the host row.
    const GEMINI_ADAPTER = { runtime_key: 'gemini_cli', display_name: 'Gemini CLI', command: 'gemini', capability_probe: 'gemini', remote_eligible: false, supports_runtime_native: false, supports_model_provider: false }
    vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER, GEMINI_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: ['claude', 'gemini'], versions: { claude: '1.2.3' }, installations: { claude_code: [{ id: 'own', version: '1.2.3 (Claude Code)', logged_in: null, options: null }] } } }],
    })
    renderPanel()
    expect(await screen.findByTestId('host-agent-host-1-claude_code')).toHaveTextContent('own · 1.2.3')
    expect(screen.getByTestId('host-agent-host-1-claude_code')).not.toHaveTextContent('(Claude Code)')
    expect(screen.queryByText(/gemini.*next phase/i)).toBeNull()
  })

  it('lists an installed registry agent even though it is not dispatch-eligible', async () => {
    // A registry agent's managed copy is installable on the host while
    // `remote_eligible` stays false. Do not filter the host list by
    // eligibility. The copy would disappear right after install.
    const CURSOR_ADAPTER = { runtime_key: 'acp_cursor', display_name: 'Cursor', command: 'acp_cursor', capability_probe: 'acp_cursor', remote_eligible: false, supports_runtime_native: true, supports_model_provider: false }
    vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [CLAUDE_ADAPTER, CODEX_ADAPTER, CURSOR_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{ ...REMOTE_HOST, capabilities_json: { runtimes: [], versions: {}, installations: { acp_cursor: [{ id: 'managed:2.0.0', version: '2.0.0', logged_in: false, options: null }] } } }],
    })
    renderPanel()
    expect(await screen.findByTestId('host-agent-host-1-acp_cursor')).toHaveTextContent('managed · 2.0.0')
    // Runtime copies are visible here even when dispatch is disabled for them.
    expect(screen.queryByRole('option', { name: 'Cursor' })).toBeNull()
  })

  it('issues a pairing code and shows it for copying', async () => {
    vi.mocked(hostsApi.pairingCode).mockResolvedValue({
      host_id: 'host-2', pairing_code: 'abc-123', expires_at: '2026-08-21T01:00:00.000Z',
    })
    renderPanel()
    await screen.findByText('Laptop')
    // Pairing is a header action; its form opens on request.
    expect(screen.queryByPlaceholderText('e.g. laptop')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Pair an environment' }))
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
    renderPanel('?host=host-1')
    await screen.findByTestId('host-agent-host-1-claude_code')
    const callsBeforeRevoke = vi.mocked(hostsApi.list).mock.calls.length
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(hostsApi.revoke).toHaveBeenCalledWith('host-1'))
    await waitFor(() => expect(vi.mocked(hostsApi.list).mock.calls.length).toBeGreaterThan(callsBeforeRevoke))
  })

  it('keeps the newer hosts list when an earlier poll answers later', async () => {
    vi.useFakeTimers()
    try {
      const renamed = { ...REMOTE_HOST, name: 'Laptop renamed' }
      let releaseSlow!: (value: { items: Array<typeof REMOTE_HOST | typeof SERVER_HOST> }) => void
      vi.mocked(hostsApi.list)
        .mockResolvedValueOnce({ items: [SERVER_HOST, REMOTE_HOST] })
        .mockImplementationOnce(() => new Promise(resolve => { releaseSlow = resolve }) as never)
        .mockResolvedValue({ items: [SERVER_HOST, renamed] })
      renderPanel()
      await act(async () => { await Promise.resolve() })
      expect(screen.getAllByText('Laptop').length).toBeGreaterThan(0)

      // The slow poll starts, and the one after it answers first with the rename.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(screen.getAllByText('Laptop renamed').length).toBeGreaterThan(0)

      await act(async () => {
        releaseSlow({ items: [SERVER_HOST, REMOTE_HOST] })
        await Promise.resolve()
      })
      expect(screen.getAllByText('Laptop renamed').length).toBeGreaterThan(0)
      expect(screen.queryByText('Laptop')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stack provisioning reads while one is still in flight', async () => {
    // The 3s tick is shorter than a slow provisioning read. Do not open
    // another request while one is in flight. An older answer could overwrite
    // a newer one.
    vi.useFakeTimers()
    try {
      type ProvisioningStatus = Awaited<ReturnType<typeof hostsApi.serverRuntimeProvisioning>>
      let release: (status: ProvisioningStatus) => void = () => undefined
      const provisioningCalls = () => vi.mocked(hostsApi.serverRuntimeProvisioning).mock.calls.length
      const before = provisioningCalls()
      vi.mocked(hostsApi.serverRuntimeProvisioning).mockImplementationOnce(
        () => new Promise(resolve => { release = resolve }) as ReturnType<typeof hostsApi.serverRuntimeProvisioning>,
      )
      renderPanel()
      await act(async () => { await Promise.resolve() })
      expect(provisioningCalls()).toBe(before + 1)

      await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
      expect(provisioningCalls()).toBe(before + 1)

      await act(async () => {
        release({
          host_id: SERVER_HOST.id,
          runtime_key: 'opencode',
          installation: { state: 'ready', desired_version: '4.5.6', installed_version: '4.5.6', active_version: '4.5.6', error: null, attempts: 1 },
          native_account: { installation_id: 'managed:4.5.6', logged_in: true, accounts: [] },
        })
        await Promise.resolve()
      })
      expect(screen.getByText(/Selected version 4\.5\.6/)).toBeInTheDocument()

      // The next tick is free to read again once that one settled.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(provisioningCalls()).toBeGreaterThan(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the unified Agents empty state when no runtime has been reported', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...REMOTE_HOST, capabilities_json: null }] })
    renderPanel()
    expect(await screen.findByText('No runtime copies are reported on this host yet.')).toBeInTheDocument()
    expect(screen.queryByText('Model backend')).toBeNull()
  })

  // The built-in host is a daemon in strict mode. It carries the same managed
  // copies and logins a paired host does, and every Run on it is isolated in
  // its own namespace, which is what makes it safe for a Space to share.
  // Do not describe it as having no controls of its own.
  it('describes the built-in host as isolated, and names the capacity it runs at', async () => {
    renderPanel()
    expect(await screen.findByText(/every Run is isolated in its own namespace/)).toBeInTheDocument()
    expect(screen.getByText(/up to 3 runs execute at once/)).toBeInTheDocument()
  })

  it('explains that native login is optional for ACP models but a signed-in Server account is shared', async () => {
    // A native account is not a prerequisite for every ACP model, but a signed-in
    // Server copy is usable by everyone authorized to run Agents there.
    renderPanel()
    expect(await screen.findByText(/ACP models may still work without an account/)).toBeInTheDocument()
    expect(screen.getByText(/If signed in, this account is instance-wide: every person authorized to run Agents on the Server Runtime can use it\./))
      .toBeInTheDocument()
  })

  it('lets an administrator upgrade and roll back Server OpenCode through the shared Host controls', async () => {
    authState.currentUser = { is_instance_admin: true }
    const OPENCODE_ADAPTER = {
      runtime_key: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode',
      remote_eligible: true, latest_managed_version: '9.9.9', supports_runtime_native: true, supports_model_provider: true,
    }
    const CURSOR_ADAPTER = {
      runtime_key: 'acp_cursor', display_name: 'Cursor', command: 'acp_cursor', capability_probe: 'acp_cursor',
      remote_eligible: false, supports_runtime_native: true, supports_model_provider: false,
    }
    vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [OPENCODE_ADAPTER, CURSOR_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{
      ...SERVER_HOST,
      capabilities_json: {
        runtimes: [], versions: {},
        installations: {
          opencode: [{ id: 'managed:1.2.3', version: '1.2.3', logged_in: true, options: null, rollback_version: '1.2.2' }],
          acp_cursor: [{ id: 'managed:2.0.0', version: '2.0.0', logged_in: true, options: null, rollback_version: '1.0.0' }],
        },
      },
    }] })
    renderPanel()

    await screen.findByTestId('host-agent-host-server-opencode')
    expect(screen.getByTestId('host-agent-host-server-opencode')).toHaveTextContent('managed · 1.2.3')
    // Retry is shown only for a failed install. A healthy one must not
    // point at a button that is not on the page.
    expect(screen.getByTestId('host-agent-host-server-opencode')).not.toHaveTextContent('use Retry above')
    expect(screen.queryByRole('button', { name: /Remove managed:1\.2\.3 of OpenCode/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Upgrade OpenCode/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /More for OpenCode/ })).toBeInTheDocument()
    // A registry agent an admin added to the server host stays theirs to manage.
    expect(screen.getByRole('button', { name: /Remove managed:2\.0\.0 of Cursor/ })).toBeInTheDocument()
  })

  it('points at the provisioner\u2019s Retry only when there is one to press', async () => {
    const SERVER_WITH_OPENCODE = {
      ...SERVER_HOST,
      capabilities_json: {
        runtimes: [], versions: {},
        installations: { opencode: [{ id: 'managed:1.2.3', version: '1.2.3', logged_in: true, options: null }] },
      },
    }
    const OPENCODE_ADAPTER = {
      runtime_key: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode',
      remote_eligible: true, supports_runtime_native: true, supports_model_provider: true,
    }
    vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [OPENCODE_ADAPTER] })
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER_WITH_OPENCODE] })
    vi.mocked(hostsApi.serverRuntimeProvisioning).mockResolvedValue({
      host_id: SERVER_HOST.id,
      runtime_key: 'opencode',
      installation: { state: 'failed', desired_version: '1.2.3', installed_version: null, active_version: null, error: 'install failed', attempts: 2 },
      native_account: { installation_id: null, logged_in: null, accounts: null },
    })

    // A member sees who owns the copy but no Retry, so no hint either.
    const member = renderPanel()
    await waitFor(() => expect(screen.getByTestId('host-agent-host-server-opencode')).toHaveTextContent('managed · 1.2.3'))
    expect(screen.getByTestId('host-agent-host-server-opencode')).not.toHaveTextContent('use Retry above')
    expect(screen.queryByRole('button', { name: 'Retry Server Runtime provisioning' })).toBeNull()
    member.unmount()

    authState.currentUser = { is_instance_admin: true }
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry Server Runtime provisioning' })).toBeInTheDocument())
    expect(screen.getByTestId('host-agent-host-server-opencode')).toHaveTextContent('managed · 1.2.3')
  })

  it('shows a member the built-in host\'s copies without the controls that would 403', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({
      items: [{
        ...SERVER_HOST,
        capabilities_json: { runtimes: [], versions: {}, installations: { claude_code: [{ id: 'own', version: '1.2.3', logged_in: true, options: null }] } },
      }],
    })
    renderPanel()
    // What is installed and whether it is logged in: that is what says whether
    // a member's Run can run here at all.
    expect(await screen.findByTestId('host-agent-host-server-claude_code')).toHaveTextContent('logged in')
    expect(screen.getByText(/Installing and logging in its agents is instance-admin work/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Log in/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add agent…' })).toBeNull()
    // Host account setup is not a second provider/backend authority.
    expect(screen.queryByLabelText(/^Model source for/)).toBeNull()
  })
})

/**
 * The host card is where a copy's subscription and its upgrade history are
 * acted on. The rollback control must send `rollback_version`. Dropping that
 * field makes the button do nothing.
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

  it('opens quota through the usage page even before the first cached measurement', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [CLAUDE_HOST] })
    renderPanel()
    const link = await screen.findByRole('link', { name: 'View quota' })
    expect(link).toHaveAttribute('href', '/spaces/space-1/usage?tab=quotas&host=host-1&runtime=claude_code&installation=managed%3A2.0.0')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(hostsApi.refreshUsage).not.toHaveBeenCalled()
  })

  it('keeps rollback in version management and asks for it by adapter', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ ...CLAUDE_HOST, capabilities_json: { ...CLAUDE_HOST.capabilities_json, managed_cli_updates: true } }] })
    vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
    vi.mocked(hostsApi.rollbackRuntime).mockResolvedValue({
      host_id: 'host-1', runtime_key: 'claude_code', ok: true, error: null, installation: 'managed:1.0.0',
    })
    renderPanel()

    await screen.findByRole('button', { name: 'More for Claude Code on Laptop' })
    expect(screen.queryByRole('button', { name: 'Roll back to 1.0.0' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'More for Claude Code on Laptop' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Version management' }))
    expect(await screen.findByRole('dialog', { name: 'Version management · Claude Code' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Roll back to 1.0.0' }))

    await waitFor(() => expect(hostsApi.rollbackRuntime).toHaveBeenCalledWith('host-1', 'claude_code'))
  })

  it('shows the vendor CLI version and upgrades its newer native release', async () => {
    vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({
      items: [{ ...CLAUDE_ADAPTER, latest_managed_version: null, latest_own_version: '2.1.5', reports_managed_cli_version: true }],
    })
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [{
      ...CLAUDE_HOST,
      capabilities_json: {
        ...CLAUDE_HOST.capabilities_json,
        managed_cli_updates: true,
        installations: { claude_code: [{
          ...CLAUDE_HOST.capabilities_json.installations.claude_code[0],
          runtime_version: 'claude 2.1.4 (Claude Code)',
        }] },
      },
    }] })
    vi.mocked(hostsApi.updateManagedRuntime).mockResolvedValue({
      host_id: 'host-1', runtime_key: 'claude_code', ok: true, error: null, installation: 'managed:3.0.0',
    })
    renderPanel()

    expect(await screen.findByText('managed · 2.1.4 · logged in')).toBeInTheDocument()
    expect(screen.queryByText(/ACP/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade Claude Code on Laptop' }))
    await waitFor(() => expect(hostsApi.updateManagedRuntime).toHaveBeenCalledWith('host-1', 'claude_code'))
  })

  it('hides the upgrade icon when the managed package is current', async () => {
    vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({
      items: [{ ...CLAUDE_ADAPTER, latest_managed_version: '2.0.0', reports_managed_cli_version: true }],
    })
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [CLAUDE_HOST] })
    renderPanel()

    await screen.findByText('managed · CLI version unavailable · logged in')
    expect(screen.queryByRole('button', { name: /upgrade claude code/i })).toBeNull()
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
    renderPanel()

    await screen.findByText('managed · CLI version unavailable · logged in')
    expect(screen.queryByRole('button', { name: /roll .* back to/i })).toBeNull()
  })
})
