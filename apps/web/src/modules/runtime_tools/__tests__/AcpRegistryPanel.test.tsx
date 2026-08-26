import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import AcpRegistryPanel from '../AcpRegistryPanel'

const { enable, disable, goose, enabledGoose } = vi.hoisted(() => {
  const goose = {
    id: 'goose', name: 'goose', version: '1.2.3', description: 'An agent', repository: null, license: null, icon: null,
    distribution: { kind: 'npx' as const, package: 'goose-acp@1.2.3', args: [], env: {} },
  }
  return {
    enable: vi.fn(), disable: vi.fn(), goose,
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
      listRuntimeAdapters: vi.fn(async () => ({ items: [
        { adapter_type: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true, registry_id: 'opencode' },
      ] })),
    },
  }
})

describe('AcpRegistryPanel', () => {
  it('lists enabled agents, refuses to disable one still installed somewhere, and enables from the registry without a host', async () => {
    render(<AcpRegistryPanel />)
    const gooseRow = await screen.findByTestId('registry-agent-goose')
    expect(gooseRow.textContent).toContain('on Laptop')
    const buttons = screen.getAllByRole('button', { name: 'Disable' })
    expect(buttons[0]).toBeDisabled()
    await userEvent.click(buttons[1])
    await waitFor(() => expect(disable).toHaveBeenCalledWith('crow'))

    // `opencode` is a builtin's registry entry and `goose` is already enabled: neither is offered.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable Kilo' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Enable OpenCode' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Enable goose' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Enable Kilo' }))
    await waitFor(() => expect(enable).toHaveBeenCalledWith('kilo'))
    expect(await screen.findByTestId('registry-agent-kilo')).toBeInTheDocument()
  })
})
