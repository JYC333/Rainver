import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HostsPanel from '../HostsPanel'
import { hostsApi } from '../../../api/client'

// The Host list and the one selected Host's detail: which Host is shown, how
// the URL names it, and what happens when the named Host is not there.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const authState = vi.hoisted(() => ({ currentUser: null as null | { is_instance_admin: boolean } }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => authState }))
vi.mock('../../../api/client', () => ({
  acpAgentsApi: { list: vi.fn().mockResolvedValue({ items: [] }), registry: vi.fn().mockResolvedValue({ items: [] }) },
  hostsApi: {
    list: vi.fn(), pairingCode: vi.fn(), revoke: vi.fn(), listRuntimeDefinitions: vi.fn(), toolOperations: vi.fn(),
    usage: vi.fn(), refreshUsage: vi.fn(), installRuntime: vi.fn(), rollbackRuntime: vi.fn(),
    serverRuntimeProvisioning: vi.fn(), retryServerRuntimeProvisioning: vi.fn(),
  },
  ordinaryToolsApi: { list: vi.fn().mockResolvedValue({ host_id: 'x', host_state: 'online', can_manage: false, operations: [], tools: [] }) },
}))

const BASE = { last_heartbeat_at: null, platform: 'linux', arch: 'x64', daemon_version: '0.4.7', created_at: '', updated_at: '' }
const SERVER = { ...BASE, id: 'host-server', owner_user_id: null, machine_id: 'm-server', machine_name: 'Instance', name: 'server', kind: 'server' as const, status: 'online' as const, capabilities_json: null, max_concurrent_runs: 3 }
const LAPTOP = { ...BASE, id: 'host-1', owner_user_id: 'user-1', machine_id: 'm-1', machine_name: 'Laptop', name: 'Laptop', kind: 'remote' as const, status: 'online' as const,
  capabilities_json: { runtimes: ['claude'], versions: {}, installations: { claude_code: [{ id: 'own', version: '2.1.0', logged_in: false, options: null }] } } }
const DESK = { ...BASE, id: 'host-2', owner_user_id: 'user-1', machine_id: 'm-2', machine_name: 'Desk', name: 'Desk', kind: 'remote' as const, status: 'offline' as const, last_heartbeat_at: '2026-11-01T10:00:00.000Z', capabilities_json: null }
const CLAUDE = { runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude', capability_probe: 'claude', remote_eligible: true, reports_managed_cli_version: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'claude_compatible' as const }

function Location() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><span hidden data-testid="location">{location.search}</span><button type="button" onClick={() => navigate(-1)}>history back</button></>
}
function renderPanel(search = '') {
  return render(<MemoryRouter initialEntries={[`/command-center${search}`]}><HostsPanel /><Location /></MemoryRouter>)
}
const params = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '')
const detailOf = (name: string) => screen.findByRole('article', { name })

beforeEach(() => {
  authState.currentUser = null
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER, LAPTOP, DESK] } as never)
  vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [CLAUDE] } as never)
  vi.mocked(hostsApi.usage).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.toolOperations).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.serverRuntimeProvisioning).mockResolvedValue({
    host_id: SERVER.id, runtime_key: 'opencode',
    installation: { state: 'failed', desired_version: '1.2.3', installed_version: null, active_version: null, error: 'download failed', attempts: 1 },
    native_account: { installation_id: null, logged_in: null, accounts: null },
  } as never)
})
afterEach(() => { vi.useRealTimers() })

describe('Command Center Host list and detail', () => {
  it('opens on the instance Host, says what is wrong with each Host, and names the chosen one in the URL', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [LAPTOP, SERVER, DESK] } as never)
    renderPanel()
    const list = await screen.findByRole('navigation', { name: 'Execution environments' })
    expect(await detailOf('Built-in sandbox')).toBeInTheDocument()
    expect(within(list).getAllByRole('button')[0]).toHaveTextContent('Built-in sandbox')
    expect(within(list).queryByRole('heading')).toBeNull()
    expect(within(list).getByRole('button', { name: /Laptop/ })).toHaveTextContent('Paired environment')
    // Only what is already known: Server provisioning, a Runtime not logged in, an offline Host.
    expect(within(list).getByRole('button', { name: /Built-in sandbox/ })).toHaveTextContent('Runtime setup failed')
    expect(within(list).getByRole('button', { name: /Laptop/ })).toHaveTextContent('1 Runtime not logged in')
    expect(within(list).getByRole('button', { name: /Desk/ })).toHaveTextContent(/Offline · last seen/)
    expect(params().get('host')).toBeNull()

    fireEvent.click(within(list).getByRole('button', { name: /Laptop/ }))
    expect(await detailOf('Laptop')).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Built-in sandbox' })).toBeNull()
    expect(within(list).getByRole('button', { name: /Laptop/ })).toHaveAttribute('aria-current', 'true')
    expect(params().get('host')).toBe('host-1')
    expect(screen.getByText('Your paired environment. You manage its installed tools and logins.')).toBeInTheDocument()

    // History goes back to where it was.
    fireEvent.click(screen.getByRole('button', { name: 'history back' }))
    expect(await detailOf('Built-in sandbox')).toBeInTheDocument()
    expect(params().get('host')).toBeNull()
  })

  it('opens a linked Host directly, and its Back returns to the list', async () => {
    renderPanel('?host=host-2&section=connection')
    expect(await detailOf('Desk')).toBeInTheDocument()
    expect(params().get('section')).toBe('connection')
    fireEvent.click(screen.getByRole('button', { name: 'All environments' }))
    expect(params().get('host')).toBeNull()
    expect(params().get('section')).toBeNull()
  })

  it('does not stand another Host in for one that is not there', async () => {
    renderPanel('?host=someone-elses')
    expect(await screen.findByRole('alert')).toHaveTextContent('This Host is not available')
    expect(screen.queryByRole('article')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show all environments' }))
    expect(await detailOf('Built-in sandbox')).toBeInTheDocument()
  })

  it('shows a lone Host’s detail without a list to choose from', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER] } as never)
    renderPanel()
    expect(await detailOf('Built-in sandbox')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Execution environments' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'All environments' })).toBeNull()
    expect(screen.getByText(/Its Runtimes are managed by the instance admin/)).toBeInTheDocument()
  })

  it('with no Host, says so and offers pairing at once', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [] } as never)
    renderPanel()
    expect(await screen.findByText('No hosts registered yet')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. laptop')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pair an environment' })).toBeNull()
  })

  it('keeps the selected Host through a refresh, and takes its actions away once it is revoked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPanel('?host=host-1')
    expect(await detailOf('Laptop')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show CLI tools for Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [SERVER, { ...LAPTOP, status: 'revoked' }, DESK] } as never)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(await screen.findByText('This Host was revoked. Nothing can run or be managed on it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show CLI tools for Laptop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(params().get('host')).toBe('host-1')
  })

  it('a link to a Host’s CLI tools opens them', async () => {
    renderPanel('?host=host-1&section=cli')
    expect(await screen.findByRole('button', { name: 'Hide CLI tools for Laptop' })).toHaveAttribute('aria-expanded', 'true')
  })
})
