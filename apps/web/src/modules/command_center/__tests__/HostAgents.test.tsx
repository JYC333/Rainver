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
      registry: vi.fn(async () => ({ items: [goose, { ...goose, id: 'kilo', name: 'Kilo' }, { ...goose, id: 'opencode', name: 'OpenCode' }] })),
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
  { adapter_type: 'acp_dynamic', display_name: 'Cursor', command: 'acp_dynamic', capability_probe: 'acp_dynamic', remote_eligible: true, provider_binding: false },
]
const HOST = {
  id: 'h1', name: 'Laptop', kind: 'remote', status: 'online',
  capabilities_json: {
    runtimes: ['opencode'],
    installations: {
      opencode: [{ id: 'own', version: 'opencode 1.18.11', logged_in: true }],
      acp_goose: [{ id: 'managed:1.2.3', version: '1.2.3', logged_in: false }],
      acp_dynamic: [{
        id: 'managed:2.0.0', version: '2.0.0', logged_in: false,
        options: { config_options: [], authenticated: false, auth_methods: [
          { id: 'browser', name: 'Browser login', description: 'Open a browser', type: 'agent', args: [], env: {} },
          { id: 'device', name: 'Device login', description: null, type: 'terminal', args: ['login'], env: {} },
        ], cli_login_available: true },
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
    await userEvent.click(screen.getByRole('button', { name: 'Install Claude Code on Laptop' }))
    await waitFor(() => expect(installRuntime).toHaveBeenCalledWith('h1', 'claude_code'))
    // Not an admin: no registry search.
    expect(screen.queryByLabelText('Search ACP registry')).toBeNull()
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
  })

  it('shows every authentication method advertised by an ACP agent', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={vi.fn()} />)
    expect(screen.getByTestId('host-agent-h1-acp_dynamic')).toHaveTextContent('Model source')
    expect(screen.getByTestId('host-agent-h1-acp_dynamic')).toHaveTextContent('Agent-managed · no Rainver override')
    expect(screen.getByRole('button', { name: 'Browser login for managed:2.0.0 of Cursor on Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Device login for managed:2.0.0 of Cursor on Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in managed:2.0.0 of Cursor on Laptop' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Browser login for managed:2.0.0 of Cursor on Laptop' }))
    await waitFor(() => expect(loginStream).toHaveBeenCalledWith('h1', 'acp_dynamic', 'managed:2.0.0', { kind: 'acp', methodId: 'browser' }))
    expect(screen.queryByLabelText('Login input')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('runtime-login-terminal')).toHaveTextContent('Logged in.'))
  })

  it('keeps the managed CLI fallback separate from ACP authentication methods', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin={false} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:2.0.0 of Cursor on Laptop' }))
    await waitFor(() => expect(loginStream).toHaveBeenLastCalledWith(
      'h1', 'acp_dynamic', 'managed:2.0.0', { kind: 'cli' },
    ))
  })

  it('lets an instance admin enable and install an agent directly from the ACP registry', async () => {
    let finishInstall!: (value: { host_id: string; adapter_type: string; ok: boolean; error: null; installation: string }) => void
    installRuntime.mockImplementationOnce((hostId: string, adapterType: string) => new Promise(resolve => {
      finishInstall = resolve
    }))
    const onChanged = vi.fn(async () => undefined)
    render(<HostAgents host={HOST} adapters={ADAPTERS} providers={[]} isInstanceAdmin onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    expect(screen.getByRole('button', { name: 'Install Claude Code on Laptop' })).toBeInTheDocument()
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
