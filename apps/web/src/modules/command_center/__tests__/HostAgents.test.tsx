import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { act, render as testingRender, screen, waitFor, within } from '@testing-library/react'
import { acpAgentsApi, hostsApi } from '../../../api/client'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import HostAgents from '../HostAgents'
import type { Host, HostRuntimeDefinitionOption } from '../../../types/api'

vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { enable, disable, installRuntime, uninstallRuntime, loginInput, loginCallback, loginStream, goose, enabledGoose, flags } = vi.hoisted(() => {
  const goose = {
    id: 'goose', name: 'goose', version: '1.2.3', description: 'An agent', repository: null, license: null, icon: null,
    distribution: { kind: 'npx' as const, package: 'goose-acp@1.2.3', args: [], env: {} },
  }
  return {
    enable: vi.fn(), disable: vi.fn(), installRuntime: vi.fn(), uninstallRuntime: vi.fn(), loginInput: vi.fn(), loginCallback: vi.fn(), loginStream: vi.fn(), goose,
    /** Per-test switches for the fake daemon. */
    flags: { loopbackCallback: false, namedQuota: false },
    enabledGoose: { ...goose, enabled_at: '', enabled_by_user_id: null, runtime_key: 'acp_goose', installed_on: [{ host_id: 'h1', name: 'Laptop' }] },
  }
})

vi.mock('../LoginTerminalView', () => import('../../../test/loginTerminalStandIn'))

vi.mock('../../../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return {
    ...original,
    acpAgentsApi: {
      registry: vi.fn(async () => ({ items: [goose, { ...goose, id: 'kilo', name: 'Kilo' }, { ...goose, id: 'opencode', name: 'OpenCode' }, { ...goose, id: 'claude-acp', name: 'Claude Code' }] })),
      list: vi.fn(async () => ({ items: [enabledGoose, { ...enabledGoose, id: 'crow', name: 'crow', runtime_key: 'acp_crow', installed_on: [] }] })),
      enable: enable.mockImplementation(async (id: string) => ({ ...enabledGoose, id, name: 'Kilo', runtime_key: `acp_${id}`, installed_on: [] })),
      disable: disable.mockResolvedValue(null),
    },
    hostsApi: {
      ...original.hostsApi,
      toolOperations: vi.fn(async () => ({ items: [] })),
      usage: vi.fn(async () => ({ items: flags.namedQuota ? [{
        host_id: 'h1', runtime_key: 'acp_goose', installation: 'managed:1.2.3', checked_at: '2026-10-26T12:00:00Z',
        quota: { available: true, session_pct: 20, session_resets: null, week_pct: 10, week_resets: null, error: null,
          windows: [{ id: 'seven_day_fable', label: 'Fable weekly', used_pct: 95, resets: null }] },
      }] : [] })),

      installRuntime: installRuntime.mockImplementation(async (hostId: string, runtimeKey: string) => ({ host_id: hostId, runtime_key: runtimeKey, ok: true, error: null, installation: 'managed:1.2.3' })),
      uninstallRuntime: uninstallRuntime.mockImplementation(async (hostId: string, runtimeKey: string, installation: string) => ({ host_id: hostId, runtime_key: runtimeKey, ok: true, error: null, installation })),
      // The fake daemon: prompts, waits for what is typed, then exits logged in.
      loginStream: loginStream.mockImplementation(async function* (_hostId: string, _runtimeKey: string, _installation: string, target?: { kind: string } | null) {
        yield { type: 'hint', text: 'Follow the prompts.' }
        yield { type: 'output', data: '\u001b[32mcode? \u001b[0mhttps://login.example.test/device?id=abc\n' }
        if (flags.loopbackCallback && target?.kind === 'acp') {
          // A loopback OAuth login: the browser on this device cannot deliver
          // the redirect, so the panel takes the address it landed on.
          yield { type: 'callback_wanted', port: 51601, authorize_url: 'https://accounts.example/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A51601%2F' }
          const pasted = await new Promise<string>(resolve => { loginCallback.mockImplementation(async (...args: unknown[]) => { resolve(String(args[3])); return null }) })
          yield { type: 'output', data: `callback:${pasted}` }
          yield { type: 'exit', exit_code: 0, logged_in: true }
          return
        }
        if (target) {
          yield { type: 'exit', exit_code: 0, logged_in: true }
          return
        }
        const typed = await new Promise<string>(resolve => { loginInput.mockImplementation(async (...args: unknown[]) => { resolve(String(args[3])); return null }) })
        yield { type: 'output', data: `got:${typed}` }
        yield { type: 'exit', exit_code: 0, logged_in: true }
      }),
      loginInput,
      loginCallback,
    },
  }
})

const ADAPTERS: HostRuntimeDefinitionOption[] = [
  { runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude-agent-acp', capability_probe: 'claude', remote_eligible: true, registry_id: 'claude-acp', reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false },
  { runtime_key: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true, registry_id: 'opencode', supports_runtime_native: true, supports_model_provider: true, provider_api: 'vendor' },
  { runtime_key: 'acp_goose', display_name: 'goose', command: 'acp_goose', capability_probe: 'acp_goose', remote_eligible: true, supports_runtime_native: true, supports_model_provider: false },
  // What the server really reports for a registry agent: installable and
  // managed on a host, but not dispatch-eligible until its entry can name a
  // login/state-root contract. It must still be listed here.
  { runtime_key: 'acp_dynamic', display_name: 'Cursor', command: 'acp_dynamic', capability_probe: 'acp_dynamic', remote_eligible: false, supports_runtime_native: true, supports_model_provider: false },
  { runtime_key: 'acp_browser_only', display_name: 'Kite', command: 'acp_browser_only', capability_probe: 'acp_browser_only', remote_eligible: false, supports_runtime_native: true, supports_model_provider: false },
]
const HOST = {
  id: 'h1', name: 'Laptop', kind: 'remote', status: 'online',
  capabilities_json: {
    runtimes: ['opencode'],
    installations: {
      // OpenCode holds several accounts; the daemon reports ids and kinds only.
      opencode: [{ id: 'own', version: 'opencode 1.18.11', logged_in: true, accounts: [{ id: 'yitang', kind: 'api' }] }],
      acp_goose: [{ id: 'managed:1.2.3', version: '1.2.3', logged_in: false }],
      // Cursor: advertises Agent Auth but needs its own CLI login first, so
      // Rainver reports the CLI login fallback — the one button the person sees.
      acp_dynamic: [{
        id: 'managed:2.0.0', version: '2.0.0', logged_in: false,
        options: { config_options: [], session_available: false, auth_methods: [
          { id: 'cursor_login', name: 'Cursor Login', description: 'Uses existing Cursor credentials', type: 'agent', args: [], env: {} },
        ], cli_login_available: true },
      }],
      // An Agent whose advertised methods are the whole login story.
      acp_browser_only: [{
        id: 'managed:3.0.0', version: '3.0.0', logged_in: false,
        options: { config_options: [], session_available: false, auth_methods: [
          { id: 'browser', name: 'Browser login', description: 'Open a browser', type: 'agent', args: [], env: {} },
          { id: 'device', name: 'Device login', description: null, type: 'terminal', args: ['login'], env: {} },
        ] },
      }],
    },
  },
} as unknown as Host

describe('HostAgents', () => {
  it('removes cached account identity when a later quota read is refused', async () => {
    const host = { ...HOST, capabilities_json: { ...HOST.capabilities_json, installations: { claude_code: [{ id: 'own', version: '1.0.0', logged_in: true, options: null, reports_subscription_quota: true }] } } } as unknown as Host
    const adapters = [{ runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', remote_eligible: true, supports_runtime_native: true, supports_model_provider: false }] as HostRuntimeDefinitionOption[]
    vi.mocked(hostsApi.usage).mockResolvedValueOnce({ items: [{ host_id: HOST.id, runtime_key: 'claude_code', installation: 'own', checked_at: new Date().toISOString(), quota: {
      available: true, account: { provider: 'anthropic', product: 'claude', account_id: 'a'.repeat(64), organization_id: null },
      session_pct: 42, session_resets: null, week_pct: null, week_resets: null, error: null,
    } }] }).mockRejectedValueOnce(new Error('Access denied'))
    const view = render(<HostAgents host={host} adapters={adapters} isInstanceAdmin={false} manageable onChanged={vi.fn()} />)
    expect(await screen.findByText('Account: aaaaaaaa')).toBeInTheDocument()
    view.rerender(<HostAgents host={{ ...host, capabilities_json: { ...host.capabilities_json, runtimes: [], versions: {}, installations: { claude_code: [{ id: 'own', version: '1.0.1', logged_in: true, options: null, reports_subscription_quota: true }] } } }} adapters={adapters} isInstanceAdmin={false} manageable onChanged={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Account: aaaaaaaa')).toBeNull())
  })

  it('links to account quota without repeating named model readings in the installation list', async () => {
    flags.namedQuota = true
    try {
      render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false} manageable onChanged={vi.fn()} />)
      expect(await screen.findByRole('link', { name: 'View quota' })).toHaveAttribute('href', expect.stringContaining('/usage?tab=quotas&'))
      expect(screen.queryByText('Highest used 95%')).toBeNull()
      expect(screen.queryByRole('progressbar')).toBeNull()
    } finally { flags.namedQuota = false }
  })

  it('updates managed Codex when only its vendor CLI has a newer version', async () => {
    const { hostsApi } = await import('../../../api/client')
    const install = vi.spyOn(hostsApi, 'updateManagedRuntime').mockResolvedValue({ ok: true, installation: 'managed:2.5.0', error: null } as never)
    const host = { ...HOST, kind: 'server', capabilities_json: { managed_cli_updates: true, installations: { codex_cli: [{ id: 'managed:2.5.0', version: '2.5.0', runtime_version: 'codex-cli 0.165.0', logged_in: true }] } } } as unknown as Host
    const adapter = { runtime_key: 'codex_cli', display_name: 'Codex CLI', latest_managed_version: '2.5.0', latest_own_version: '0.166.0', reports_managed_cli_version: true } as HostRuntimeDefinitionOption
    const view = render(<HostAgents host={host} adapters={[adapter]} isInstanceAdmin manageable onChanged={vi.fn()} />)
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Upgrade Codex CLI on Laptop' }))
      await waitFor(() => expect(install).toHaveBeenCalledWith('h1', 'codex_cli'))
    } finally { view.unmount(); install.mockRestore() }
  })

  it('recovers a server-reported upgrade without a local request', async () => {
    const { hostsApi } = await import('../../../api/client')
    const status = vi.mocked(hostsApi.toolOperations)
    status.mockResolvedValue({ items: [{ runtime_key: 'claude_code', action: 'update_own_tool' }] })
    const host = { ...HOST, capabilities_json: { installations: { claude_code: [{ id: 'own', version: '1.0.0', logged_in: true }] } } } as unknown as Host
    const view = render(<HostAgents host={host} adapters={ADAPTERS.map(adapter => ({ ...adapter, latest_own_version: '2.0.0' }))} isInstanceAdmin={false} manageable onChanged={vi.fn()} />)
    try {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Update own Claude Code on Laptop' })).toHaveAttribute('aria-busy', 'true'))
    } finally {
      view.unmount()
      status.mockResolvedValue({ items: [] })
    }
  })

  it.each(['success', 'failure'] as const)('retains an upgrade across navigation, prevents duplicates and clears on %s', async outcome => {
    const { hostsApi } = await import('../../../api/client')
    const { toast } = await import('sonner')
    const notice = vi.spyOn(toast, 'info')
    let finish!: (value: never) => void
    let fail!: (error: Error) => void
    const update = vi.spyOn(hostsApi, 'updateOwnRuntime').mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }) as never)
    const host = { ...HOST, capabilities_json: { installations: { claude_code: [{ id: 'own', version: '1.0.0', logged_in: true }] } } } as unknown as Host
    const adapters = ADAPTERS.map(adapter => ({ ...adapter, latest_own_version: '2.0.0' }))
    const props = { host, adapters, isInstanceAdmin: false, manageable: true, onChanged: vi.fn() }
    const first = render(<HostAgents {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Update own Claude Code on Laptop' }))
    first.unmount()
    const refreshed = vi.fn()
    const second = render(<HostAgents {...props} onChanged={refreshed} />)
    try {
      const button = screen.getByRole('button', { name: 'Update own Claude Code on Laptop' })
      expect(button).toHaveAttribute('aria-busy', 'true')
      await userEvent.click(button)
      expect(update).toHaveBeenCalledTimes(1)
      expect(notice).toHaveBeenCalled()
      await act(async () => {
        if (outcome === 'success') finish({ ok: true, installation: 'own' } as never)
        else fail(new Error('Update failed'))
      })
      await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'false'))
      await waitFor(() => expect(refreshed).toHaveBeenCalled())
    } finally {
      second.unmount()
      update.mockRestore()
      notice.mockRestore()
    }
  })

  it('updates an own CLI through its separate endpoint and refreshes the Host', async () => {
    const update = vi.spyOn((await import('../../../api/client')).hostsApi, 'updateOwnRuntime').mockResolvedValue({ ok: true, error: null, installation: 'own' } as never)
    const changed = vi.fn()
    const host = { ...HOST, capabilities_json: { runtimes: ['claude'], installations: { claude_code: [{ id: 'own', version: '1.0.0', logged_in: true }] } } } as unknown as Host
    render(<HostAgents host={host} adapters={ADAPTERS.map(adapter => ({ ...adapter, latest_own_version: '2.0.0' }))} isInstanceAdmin={false} manageable onChanged={changed} />)
    await userEvent.click(screen.getByRole('button', { name: 'Update own Claude Code on Laptop' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('h1', 'claude_code'))
    await waitFor(() => expect(changed).toHaveBeenCalled())
    update.mockRestore()
  })
  it.each([
    ['1.0.0', '1.0.0', false], ['2.0.0', '1.0.0', false],
    ['1.9.0', '1.10.0', true], ['claude 1.0.0', '1.0.1', true],
    [null, '1.0.1', false], ['unknown', '1.0.1', false],
    ['1.0.0', null, false], ['1.0.0-beta.1', '1.0.0', false],
  ])('shows own update only for a confirmed newer vendor release: %s -> %s', (current, latest, visible) => {
    const host = { ...HOST, capabilities_json: { installations: { claude_code: [{ id: 'own', version: current, logged_in: true }] } } } as unknown as Host
    render(<HostAgents host={host} adapters={ADAPTERS.map(adapter => ({ ...adapter, latest_managed_version: '99.0.0', latest_own_version: latest }))} isInstanceAdmin={false} manageable onChanged={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Update own Claude Code on Laptop' }) !== null).toBe(visible)
  })

  it("lists only the agents this host has a copy of, with log-in and remove, and adds a managed copy", async () => {
    const onChanged = vi.fn()
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={onChanged} />)
    expect(screen.getByTestId('host-agent-h1-opencode').textContent).toContain('own · 1.18.11 · 1 account')
    expect(screen.getByTestId('host-agent-h1-opencode').textContent).not.toContain('opencode 1.18.11')
    expect(screen.getByTestId('host-agent-h1-acp_goose').textContent).toContain('managed · 1.2.3 · not logged in')
    // Claude is in the catalog but not on this host: not a row, only a choice under "Add agent…".
    expect(screen.queryByTestId('host-agent-h1-claude_code')).toBeNull()
    expect(screen.queryByText('built-in')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Add a managed copy of OpenCode on Laptop' }))
    await waitFor(() => expect(installRuntime).toHaveBeenCalledWith('h1', 'opencode'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove managed:1.2.3 of goose from Laptop' }))
    await waitFor(() => expect(uninstallRuntime).toHaveBeenCalledWith('h1', 'acp_goose', 'managed:1.2.3'))
    expect(onChanged).toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add a managed copy of Claude Code on Laptop' }))
    await waitFor(() => expect(installRuntime).toHaveBeenCalledWith('h1', 'claude_code'))
    // Not an admin: entries that would first need enabling are not offered.
    expect(screen.queryByText('Kilo')).toBeNull()
    expect(screen.queryByRole('button', { name: /Enable and install/ })).toBeNull()
  })

  it('logs a copy in through the terminal, relaying the PTY stream and typed input', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:1.2.3 of goose on Laptop' }))
    const terminal = await screen.findByTestId('runtime-login-terminal')
    // The stream reaches the terminal as sent — escape codes included, for
    // the emulator to render — and the auth URL stays visible.
    await waitFor(() => expect(terminal.textContent).toContain('code? '))
    expect(terminal.textContent).toContain('https://login.example.test/device?id=abc')
    await userEvent.type(screen.getByLabelText('Login input'), 'abc{enter}')
    await waitFor(() => expect(loginInput).toHaveBeenCalledWith('h1', 'acp_goose', 'managed:1.2.3', 'abc\n'))
    await waitFor(() => expect(terminal.textContent).toContain('Logged in.'))
    // A successful login puts the panel away by itself after a moment.
    expect(screen.getByTestId('runtime-login-terminal')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('runtime-login-terminal')).toBeNull(), { timeout: 6_000 })
  })

  it('shows every authentication method advertised by an ACP agent that has no CLI login fallback', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:3.0.0 of Kite on Laptop' }))
    expect(screen.getByRole('button', { name: 'Device login for managed:3.0.0 of Kite on Laptop' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' }))
    await waitFor(() => expect(loginStream).toHaveBeenCalledWith('h1', 'acp_browser_only', 'managed:3.0.0', { kind: 'acp', methodId: 'browser' }, expect.any(AbortSignal)))
    expect(screen.queryByLabelText('Login input')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged in.'))
  })

  it('takes the address a browser elsewhere landed on when the login returns to the host\'s loopback port', async () => {
    flags.loopbackCallback = true
    try {
      render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
            manageable onChanged={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Log in managed:3.0.0 of Kite on Laptop' }))
      await userEvent.click(screen.getByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' }))
      // The login returns to the host's loopback port: the panel offers the
      // authorization link and takes the address the browser lands on.
      const panel = await screen.findByTestId('login-callback-panel')
    expect(panel).toHaveTextContent('Paste the return address')
    expect(screen.getByRole('button', { name: 'Complete login' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Callback address'), 'https://example.com/wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Complete login' }))
    expect(screen.getByRole('alert')).toHaveTextContent('does not match the current login')
    await userEvent.clear(screen.getByLabelText('Callback address'))
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.type(screen.getByLabelText('Callback address'), 'http://127.0.0.1:51601/?state=s&code=c')
    loginCallback.mockRejectedValueOnce(new Error('Host is unavailable'))
    await userEvent.click(screen.getByRole('button', { name: 'Complete login' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Host is unavailable'))
    expect(screen.getByLabelText('Callback address')).toHaveValue('http://127.0.0.1:51601/?state=s&code=c')
    expect(screen.getByRole('button', { name: 'Complete login' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Complete login' }))
    await waitFor(() => expect(loginCallback).toHaveBeenCalledWith('h1', 'acp_browser_only', 'managed:3.0.0', 'http://127.0.0.1:51601/?state=s&code=c'))
    await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged in.'))
    expect(screen.queryByTestId('login-callback-panel')).toBeNull()
    } finally {
      flags.loopbackCallback = false
    }
  })

  it('shows a multi-account CLI by account count, adds one, and removes one through the vendor logout', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={vi.fn()} />)
    const row = screen.getByTestId('host-agent-h1-opencode')
    // The count in the row, the names on hover, never a secret.
    expect(row.textContent).toContain('1 account')
    expect(row.textContent).not.toContain('logged in')
    await userEvent.hover(screen.getByText('own · 1.18.11 · 1 account'))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('yitang · api')
    // Login adds an account here, so the button says so and stays prominent.
    expect(screen.getByRole('button', { name: 'Add account to own of OpenCode on Laptop' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Log in again/ })).toBeNull()
    const before = loginStream.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Remove account from own of OpenCode on Laptop' }))
    await waitFor(() => expect(loginStream.mock.calls.length).toBe(before + 1))
    expect(loginStream).toHaveBeenLastCalledWith('h1', 'opencode', 'own', { kind: 'logout' }, expect.any(AbortSignal))
    await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged out.'))
  })

  it('offers Log out on a single-account copy that is logged in', async () => {
    const host = { ...HOST, capabilities_json: { runtimes: ['claude'], installations: { claude_code: [{ id: 'own', version: '1.2.3', logged_in: true }] } } } as unknown as Host
    render(<HostAgents host={host} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Log in own of Claude Code on Laptop' })).toHaveTextContent('Log in again')
    const before = loginStream.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Log out own of Claude Code on Laptop' }))
    await waitFor(() => expect(loginStream.mock.calls.length).toBe(before + 1))
    expect(loginStream).toHaveBeenLastCalledWith('h1', 'claude_code', 'own', { kind: 'logout' }, expect.any(AbortSignal))
  })

  it('starts a fresh session when the same copy is logged in again while its last panel is still open', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={vi.fn()} />)
    const before = loginStream.mock.calls.length
    for (let attempt = 0; attempt < 2; attempt++) {
      await userEvent.click(screen.getByRole('button', { name: 'Log in managed:3.0.0 of Kite on Laptop' }))
      await userEvent.click(screen.getByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' }))
      await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged in.'))
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    }
    await waitFor(() => expect(loginStream.mock.calls.length).toBe(before + 2))
  })

  it('offers one Log in, the managed CLI login, when the Agent needs its own CLI login before its Agent Auth', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={vi.fn()} />)
    // The advertised Agent-Auth method is not a second button: the daemon and
    // every Run session authenticate with it unattended once the CLI is logged in.
    expect(screen.queryByRole('button', { name: /Cursor Login/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:2.0.0 of Cursor on Laptop' }))
    await waitFor(() => expect(loginStream).toHaveBeenLastCalledWith(
      'h1', 'acp_dynamic', 'managed:2.0.0', { kind: 'cli' }, expect.any(AbortSignal),
    ))
  })

  it('keeps each install spinning until its own request settles when two start back to back', async () => {
    const pending = new Map<string, (value: { host_id: string; runtime_key: string; ok: boolean; error: null; installation: string }) => void>()
    installRuntime.mockImplementation((hostId: string, runtimeKey: string) => new Promise(resolve => {
      pending.set(runtimeKey, resolve)
    }))
    const onChanged = vi.fn(async () => undefined)
    const hostWithoutOpenCode = { ...HOST, capabilities_json: { runtimes: [], installations: { acp_goose: HOST.capabilities_json!.installations!.acp_goose } } } as unknown as Host
    render(<HostAgents host={hostWithoutOpenCode} adapters={ADAPTERS} isInstanceAdmin={false}
          manageable onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    const claude = await screen.findByRole('button', { name: 'Add a managed copy of Claude Code on Laptop' })
    const opencode = screen.getByRole('button', { name: 'Install OpenCode on Laptop' })
    await userEvent.click(claude)
    await userEvent.click(opencode)
    await waitFor(() => expect(pending.size).toBe(2))
    // Both in flight: both disabled, both spinning, neither has stolen the other's slot.
    expect(claude).toBeDisabled()
    expect(opencode).toBeDisabled()
    expect(claude.querySelector('.animate-spin')).not.toBeNull()
    expect(opencode.querySelector('.animate-spin')).not.toBeNull()
    pending.get('claude_code')!({ host_id: 'h1', runtime_key: 'claude_code', ok: true, error: null, installation: 'managed:1.2.3' })
    // A finished entry turns into its Installed badge; the button is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add a managed copy of Claude Code on Laptop' })).toBeNull())
    // goose was already on the host; Claude joins it.
    expect(screen.getAllByText('Installed')).toHaveLength(2)
    // The first finishing must not clear the second's spinner.
    expect(opencode).toBeDisabled()
    expect(opencode.querySelector('.animate-spin')).not.toBeNull()
    pending.get('opencode')!({ host_id: 'h1', runtime_key: 'opencode', ok: true, error: null, installation: 'managed:1.2.3' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install OpenCode on Laptop' })).toBeNull())
    expect(screen.getAllByText('Installed')).toHaveLength(3)
    installRuntime.mockImplementation(async (hostId: string, runtimeKey: string) => ({ host_id: hostId, runtime_key: runtimeKey, ok: true, error: null, installation: 'managed:1.2.3' }))
  })

  it('lets an instance admin enable and install an agent directly from the ACP registry', async () => {
    let finishInstall!: (value: { host_id: string; runtime_key: string; ok: boolean; error: null; installation: string }) => void
    installRuntime.mockImplementationOnce((hostId: string, runtimeKey: string) => new Promise(resolve => {
      finishInstall = resolve
    }))
    const onChanged = vi.fn(async () => undefined)
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin manageable onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    expect(await screen.findByRole('button', { name: 'Add a managed copy of Claude Code on Laptop' })).toBeInTheDocument()
    const search = await screen.findByLabelText('Search agent registry')
    await userEvent.type(search, 'goose')
    // One occurrence is the installed host row; the second proves the
    // registry search did not hide the installed entry.
    expect(screen.getAllByText('goose')).toHaveLength(2)
    expect(screen.getByText('Installed')).toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.click(screen.getByRole('button', { name: 'Enable and install Kilo on Laptop' }))
    await waitFor(() => expect(enable).toHaveBeenCalledWith('kilo'))
    await waitFor(() => expect(installRuntime).toHaveBeenCalledWith('h1', 'acp_kilo', '1.2.3'))
    expect(screen.getByRole('button', { name: 'Install Kilo on Laptop' })).toHaveTextContent('Installing…')
    expect(screen.getByText('Kilo')).toBeInTheDocument()
    finishInstall({ host_id: 'h1', runtime_key: 'acp_kilo', ok: true, error: null, installation: 'managed:1.2.3' })
    await waitFor(() => expect(screen.getAllByText('Installed')).toHaveLength(3))
    expect(onChanged).toHaveBeenCalled()
  })

  it('keeps installed agents first and upgrades the selected ACP release without re-enabling it', async () => {
    vi.mocked(acpAgentsApi.registry).mockResolvedValueOnce({items:[{...goose,id:'aaa',name:'A new agent'},{...goose,version:'2.0.0'}]})
    installRuntime.mockResolvedValueOnce({ok:true,installation:'managed:2.0.0'})
    const changed=vi.fn()
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin manageable onChanged={changed}/> )
    await userEvent.click(screen.getByRole('button',{name:'Add agent…'}))
    const catalog=await screen.findByRole('list',{name:'Agent catalog'})
    expect(within(catalog).getAllByRole('listitem')[0]).toHaveTextContent('goose')
    expect(within(catalog).getByText('1.2.3 · Available 2.0.0')).toBeVisible()
    const before=enable.mock.calls.length
    await userEvent.click(within(catalog).getByRole('button',{name:'Upgrade goose on Laptop'}))
    await waitFor(()=>expect(installRuntime).toHaveBeenCalledWith('h1','acp_goose','2.0.0'))
    await waitFor(()=>expect(within(catalog).getByText('2.0.0 · Available 2.0.0')).toBeVisible())
    expect(within(catalog).queryByRole('button',{name:'Upgrade goose on Laptop'})).toBeNull()
    expect(enable.mock.calls.length).toBe(before)
    expect(changed).toHaveBeenCalled()
  })

  it('offers no Log out for a registry agent whose only sign-in is its advertised Agent Auth', () => {
    const host = {
      ...HOST,
      capabilities_json: {
        runtimes: [],
        installations: {
          acp_browser_only: [{
            id: 'managed:3.0.0', version: '3.0.0', logged_in: true,
            options: { config_options: [], session_available: true, auth_methods: [
              { id: 'device', name: 'Device login', description: null, type: 'terminal', args: ['login'], env: {} },
            ] },
          }],
        },
      },
    } as unknown as Host
    render(<HostAgents host={host} adapters={ADAPTERS} isInstanceAdmin={false} manageable onChanged={vi.fn()} />)
    expect(screen.getByTestId('host-agent-h1-acp_browser_only').textContent).toContain('logged in')
    // The server accepts a logout only through a CLI login or a logout
    // command; neither exists here, so the button would always answer 422.
    expect(screen.queryByRole('button', { name: /Log out managed:3\.0\.0 of Kite/ })).toBeNull()
  })
})

function render(ui: ReactNode) { return testingRender(ui, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> }) }
