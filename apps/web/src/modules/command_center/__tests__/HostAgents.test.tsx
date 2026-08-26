import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import HostAgents from '../HostAgents'
import type { Host, HostRuntimeAdapterOption } from '../../../types/api'

const { enable, disable, installRuntime, uninstallRuntime, loginInput, goose, enabledGoose } = vi.hoisted(() => {
  const goose = {
    id: 'goose', name: 'goose', version: '1.2.3', description: 'An agent', repository: null, license: null, icon: null,
    distribution: { kind: 'npx' as const, package: 'goose-acp@1.2.3', args: [], env: {} },
  }
  return {
    enable: vi.fn(), disable: vi.fn(), installRuntime: vi.fn(), uninstallRuntime: vi.fn(), loginInput: vi.fn(), goose,
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
      loginStream: vi.fn(async function* () {
        yield { type: 'hint', text: 'Follow the prompts.' }
        yield { type: 'output', data: '\u001b[32mcode? \u001b[0m' }
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
]
const HOST = {
  id: 'h1', name: 'Laptop', kind: 'remote', status: 'online',
  capabilities_json: {
    runtimes: ['opencode'],
    installations: {
      opencode: [{ id: 'own', version: '1.18.11', logged_in: true }],
      acp_goose: [{ id: 'managed:1.2.3', version: '1.2.3', logged_in: false }],
    },
  },
} as unknown as Host

describe('HostAgents', () => {
  it("lists only the agents this host has a copy of, with log-in and remove, and adds a managed copy", async () => {
    const onChanged = vi.fn()
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false} onChanged={onChanged} />)
    expect(screen.getByTestId('host-agent-h1-opencode').textContent).toContain('own · logged in')
    expect(screen.getByTestId('host-agent-h1-acp_goose').textContent).toContain('managed:1.2.3 · not logged in')
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
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin={false} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Log in managed:1.2.3 of goose on Laptop' }))
    const terminal = await screen.findByTestId('runtime-login-terminal')
    await waitFor(() => expect(terminal.textContent).toContain('code? '))
    expect(terminal.textContent).not.toContain('[32m')
    await userEvent.type(screen.getByLabelText('Login input'), 'abc{enter}')
    await waitFor(() => expect(loginInput).toHaveBeenCalledWith('h1', 'acp_goose', 'managed:1.2.3', 'abc\n'))
    await waitFor(() => expect(terminal.textContent).toContain('Logged in.'))
  })

  it('offers the catalog only — enabling from the registry is the admin panel\'s job', async () => {
    render(<HostAgents host={HOST} adapters={ADAPTERS} isInstanceAdmin onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add agent…' }))
    expect(screen.getByRole('button', { name: 'Install Claude Code on Laptop' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Search ACP registry')).toBeNull()
  })
})
