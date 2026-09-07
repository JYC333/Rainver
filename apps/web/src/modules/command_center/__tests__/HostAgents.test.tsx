import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import HostAgents from '../HostAgents'
import type { Host, HostRuntimeAdapterOption } from '../../../types/api'

const { enable, disable, installRuntime, uninstallRuntime, loginInput, loginStream, goose, enabledGoose } = vi.hoisted(() => {
  const goose = {
    id: 'goose', name: 'goose', version: '1.2.3', description: 'An agent', repository: null, license: null, icon: null,
    distribution: { kind: 'npx' as const, package: 'goose-acp@1.2.3', args: [], env: {} },
  }
  return {
    enable: vi.fn(), disable: vi.fn(), installRuntime: vi.fn(), uninstallRuntime: vi.fn(), loginInput: vi.fn(), loginStream: vi.fn(), goose,
    enabledGoose: { ...goose, enabled_at: '', enabled_by_user_id: null, adapter_type: 'acp_goose', installed_on: [{ host_id: 'h1', name: 'Laptop' }] },
  }
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return {
    ...original,
    acpAgentsApi: {
      registry: vi.fn(async () => ({ items: [goose, { ...goose, id: 'kilo', name: 'Kilo' }, { ...goose, id: 'opencode', name: 'OpenCode' }, { ...goose, id: 'claude-acp', name: 'Claude Code' }] })),
      list: vi.fn(async () => ({ items: [enabledGoose, { ...enabledGoose, id: 'crow', name: 'crow', adapter_type: 'acp_crow', installed_on: [] }] })),
      enable: enable.mockImplementation(async (id: string) => ({ ...enabledGoose, id, name: 'Kilo', adapter_type: `acp_${id}`, installed_on: [] })),
      disable: disable.mockResolvedValue(null),
    },
    hostsApi: {
      ...original.hostsApi,
      installRuntime: installRuntime.mockImplementation(async (hostId: string, adapterType: string) => ({ host_id: hostId, adapter_type: adapterType, ok: true, error: null, installation: 'managed:1.2.3' })),
      uninstallRuntime: uninstallRuntime.mockImplementation(async (hostId: string, adapterType: string, installation: string) => ({ host_id: hostId, adapter_type: adapterType, ok: true, error: null, installation })),
      // The fake daemon: prompts, waits for what is typed, then exits logged in.
      loginStream: loginStream.mockImplementation(async function* (_hostId: string, _adapterType: string, _installation: string, target?: { kind: string } | null) {
        yield { type: 'hint', text: 'Follow the prompts.' }
        yield { type: 'output', data: '\u001b[32mcode? \u001b[0mhttps://login.example.test/device?id=abc\n' }
        if (target) {
          yield { type: 'exit', exit_code: 0, logged_in: true }
          return
        }
        const typed = await new Promise<string>(resolve => { loginInput.mockImplementation(async (...args: unknown[]) => { resolve(String(args[3])); return null }) })
        yield { type: 'output', data: `got:${typed}` }
        yield { type: 'exit', exit_code: 0, logged_in: true }
      }),
      loginInput,
    },
  }
})

const ADAPTERS: HostRuntimeAdapterOption[] = [
  { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude-agent-acp', capability_probe: 'claude', remote_eligible: true, registry_id: 'claude-acp' },
  { adapter_type: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true, registry_id: 'opencode' },
  { adapter_type: 'acp_goose', display_name: 'goose', command: 'acp_goose', capability_probe: 'acp_goose', remote_eligible: true },
  // What the server really reports for a registry agent: installable and
  // managed on a host, but not dispatch-eligible until its entry can name a
  // login/state-root contract. It must still be listed here.
  { adapter_type: 'acp_dynamic', display_name: 'Cursor', command: 'acp_dynamic', capability_probe: 'acp_dynamic', remote_eligible: false, provider_binding: false },
  { adapter_type: 'acp_browser_only', display_name: 'Kite', command: 'acp_browser_only', capability_probe: 'acp_browser_only', remote_eligible: false, provider_binding: false },
]
const HOST = {
  id: 'h1', name: 'Laptop', kind: 'remote', status: 'online',
  capabilities_json: {
    runtimes: ['opencode'],
    installations: {
      opencode: [{ id: 'own', version: 'opencode 1.18.11', logged_in: true }],
      acp_goose: [{ id: 'managed:1.2.3', version: '1.2.3', logged_in: false }],
      // Cursor: advertises Agent Auth but needs its own CLI login first, so
      // Rainver reports the CLI login fallback — the one button the person sees.
      acp_dynamic: [{
        id: 'managed:2.0.0', version: '2.0.0', logged_in: false,
        options: { config_options: [], authenticated: false, auth_methods: [
          { id: 'cursor_login', name: 'Cursor Login', description: 'Uses existing Cursor credentials', type: 'agent', args: [], env: {} },
        ], cli_login_available: true },
      }],
      // An Agent whose advertised methods are the whole login story.
      acp_browser_only: [{
        id: 'managed:3.0.0', version: '3.0.0', logged_in: false,
        options: { config_options: [], authenticated: false, auth_methods: [
          { id: 'browser', name: 'Browser login', description: 'Open a browser', type: 'agent', args: [], env: {} },
          { id: 'device', name: 'Device login', description: null, type: 'terminal', args: ['login'], env: {} },
        ] },
      }],
    },
  },
} as unknown as Host

describe('HostAgents', () => {
  it("lists only the agents this host has a copy of, with log-in and remove, and adds a managed copy", async () => {
    const onChanged = vi.fn()
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={onChanged} />)
    expect(screen.getByTestId('host-agent-h1-opencode').textContent).toContain('own · 1.18.11 · logged in')
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
    // One list, the registry: the builtin CLI is installable from it like any
    // enabled agent, and nothing is listed above it as a default.
    await userEvent.click(await screen.findByRole('button', { name: 'Install Claude Code on Laptop' }))
    await waitFor(() => expect(installRuntime).toHaveBeenCalledWith('h1', 'claude_code'))
    // Not an admin: entries that would first need enabling are not offered.
    expect(screen.queryByText('Kilo')).toBeNull()
    expect(screen.queryByRole('button', { name: /Enable and install/ })).toBeNull()
  })

  it('logs a copy in through the terminal, stripping escape codes and relaying typed input', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:1.2.3 of goose on Laptop' }))
    const terminal = await screen.findByTestId('runtime-login-terminal')
    await waitFor(() => expect(terminal.textContent).toContain('code? '))
    expect(terminal.textContent).not.toContain('[32m')
    expect(screen.getByRole('link', { name: 'Open login link' })).toHaveAttribute('href', 'https://login.example.test/device?id=abc')
    expect(terminal.textContent).not.toContain('https://login.example.test')
    await userEvent.type(screen.getByLabelText('Login input'), 'abc{enter}')
    await waitFor(() => expect(loginInput).toHaveBeenCalledWith('h1', 'acp_goose', 'managed:1.2.3', 'abc\n'))
    await waitFor(() => expect(terminal.textContent).toContain('Logged in.'))
    // A successful login puts the panel away by itself after a moment.
    expect(screen.getByTestId('runtime-login-terminal')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('runtime-login-terminal')).toBeNull(), { timeout: 6_000 })
  })

  it('shows every authentication method advertised by an ACP agent that has no CLI login fallback', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={vi.fn()} />)
    expect(screen.getByTestId('host-agent-h1-acp_dynamic')).toHaveTextContent('Model source')
    expect(screen.getByTestId('host-agent-h1-acp_dynamic')).toHaveTextContent('Agent-managed · no Rainver override')
    expect(screen.getByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Device login for managed:3.0.0 of Kite on Laptop' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log in managed:3.0.0 of Kite on Laptop' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' }))
    await waitFor(() => expect(loginStream).toHaveBeenCalledWith('h1', 'acp_browser_only', 'managed:3.0.0', { kind: 'acp', methodId: 'browser' }))
    expect(screen.queryByLabelText('Login input')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged in.'))
  })

  it('starts a fresh session when the same copy is logged in again while its last panel is still open', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Browser login for managed:3.0.0 of Kite on Laptop' })
    const before = loginStream.mock.calls.length
    await userEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged in.'))
    // The host row is not refreshed by this fixture, so the label is unchanged.
    await userEvent.click(button)
    await waitFor(() => expect(loginStream.mock.calls.length).toBe(before + 2))
  })

  it('offers one Log in, the managed CLI login, when the Agent needs its own CLI login before its Agent Auth', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={vi.fn()} />)
    // The advertised Agent-Auth method is not a second button: the daemon and
    // every Run session authenticate with it unattended once the CLI is logged in.
    expect(screen.queryByRole('button', { name: /Cursor Login/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:2.0.0 of Cursor on Laptop' }))
    await waitFor(() => expect(loginStream).toHaveBeenLastCalledWith(
      'h1', 'acp_dynamic', 'managed:2.0.0', { kind: 'cli' },
    ))
  })

  it('keeps each install spinning until its own request settles when two start back to back', async () => {
    const pending = new Map<string, (value: { host_id: string; adapter_type: string; ok: boolean; error: null; installation: string }) => void>()
    installRuntime.mockImplementation((hostId: string, adapterType: string) => new Promise(resolve => {
      pending.set(adapterType, resolve)
    }))
    const onChanged = vi.fn(async () => undefined)
    const hostWithoutOpenCode = { ...HOST, capabilities_json: { runtimes: [], installations: { acp_goose: HOST.capabilities_json!.installations!.acp_goose } } } as unknown as Host
    render(<HostAgents host={hostWithoutOpenCode} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    const claude = await screen.findByRole('button', { name: 'Install Claude Code on Laptop' })
    const opencode = screen.getByRole('button', { name: 'Install OpenCode on Laptop' })
    await userEvent.click(claude)
    await userEvent.click(opencode)
    await waitFor(() => expect(pending.size).toBe(2))
    // Both in flight: both disabled, both spinning, neither has stolen the other's slot.
    expect(claude).toBeDisabled()
    expect(opencode).toBeDisabled()
    expect(claude.querySelector('.animate-spin')).not.toBeNull()
    expect(opencode.querySelector('.animate-spin')).not.toBeNull()
    pending.get('claude_code')!({ host_id: 'h1', adapter_type: 'claude_code', ok: true, error: null, installation: 'managed:1.2.3' })
    // A finished entry turns into its Installed badge; the button is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install Claude Code on Laptop' })).toBeNull())
    // goose was already on the host; Claude joins it.
    expect(screen.getAllByText('Installed')).toHaveLength(2)
    // The first finishing must not clear the second's spinner.
    expect(opencode).toBeDisabled()
    expect(opencode.querySelector('.animate-spin')).not.toBeNull()
    pending.get('opencode')!({ host_id: 'h1', adapter_type: 'opencode', ok: true, error: null, installation: 'managed:1.2.3' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install OpenCode on Laptop' })).toBeNull())
    expect(screen.getAllByText('Installed')).toHaveLength(3)
    installRuntime.mockImplementation(async (hostId: string, adapterType: string) => ({ host_id: hostId, adapter_type: adapterType, ok: true, error: null, installation: 'managed:1.2.3' }))
  })

  it('lets an instance admin enable and install an agent directly from the ACP registry', async () => {
    let finishInstall!: (value: { host_id: string; adapter_type: string; ok: boolean; error: null; installation: string }) => void
    installRuntime.mockImplementationOnce((hostId: string, adapterType: string) => new Promise(resolve => {
      finishInstall = resolve
    }))
    const onChanged = vi.fn(async () => undefined)
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    expect(await screen.findByRole('button', { name: 'Install Claude Code on Laptop' })).toBeInTheDocument()
    const search = await screen.findByLabelText('Search ACP registry')
    await userEvent.type(search, 'goose')
    // One occurrence is the installed host row; the second proves the
    // registry search did not hide the installed entry.
    expect(screen.getAllByText('goose')).toHaveLength(2)
    expect(screen.getByText('Installed')).toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.click(screen.getByRole('button', { name: 'Enable and install Kilo on Laptop' }))
    await waitFor(() => expect(enable).toHaveBeenCalledWith('kilo'))
    await waitFor(() => expect(installRuntime).toHaveBeenCalledWith('h1', 'acp_kilo'))
    expect(screen.getByRole('button', { name: 'Install Kilo on Laptop' })).toHaveTextContent('Installing…')
    expect(screen.getByText('Kilo')).toBeInTheDocument()
    finishInstall({ host_id: 'h1', adapter_type: 'acp_kilo', ok: true, error: null, installation: 'managed:1.2.3' })
    await waitFor(() => expect(screen.getAllByText('Installed')).toHaveLength(3))
    expect(onChanged).toHaveBeenCalled()
  })
})
