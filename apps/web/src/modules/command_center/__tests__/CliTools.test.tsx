import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostOrdinaryAccountResponse, HostOrdinaryTool, HostOrdinaryToolsResponse, OrdinaryToolReport } from '@rainver/protocol'
import HostsPanel from '../HostsPanel'
import CliToolsPanel from '../cliTools/CliToolsPanel'
import OrdinaryAccountCard from '../cliTools/OrdinaryAccountCard'

const api = vi.hoisted(() => ({
  list: vi.fn(), install: vi.fn(), register: vi.fn(), remove: vi.fn(),
  account: vi.fn(), verify: vi.fn(), logout: vi.fn(), cancelSession: vi.fn(), sessionStream: vi.fn(),
  hosts: vi.fn(), runtimeDefinitions: vi.fn(), provisioning: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly payload?: unknown) { super(message) }
  },
  ordinaryToolsApi: {
    list: api.list, install: api.install, register: api.register, remove: api.remove,
    account: api.account, verify: api.verify, logout: api.logout, cancelSession: api.cancelSession, sessionStream: api.sessionStream,
  },
  hostsApi: { list: api.hosts, listRuntimeDefinitions: api.runtimeDefinitions, serverRuntimeProvisioning: api.provisioning },
}))
// The Host card's other sections have their own tests; here they are inert.
vi.mock('../HostAgents', () => ({ default: () => null }))
vi.mock('../ServerRuntimeProvisioningPanel', () => ({ default: () => null }))
vi.mock('../HostProxyAddress', () => ({ default: () => null }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { is_instance_admin: false } }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const HOST_BASE = { owner_user_id: null, last_heartbeat_at: null, platform: 'linux', arch: 'x64', daemon_version: '0.4.7', capabilities_json: null, created_at: '', updated_at: '' }
const HOSTS = [
  { ...HOST_BASE, id: 'builtin', name: 'server', kind: 'server', status: 'online', max_concurrent_runs: 2 },
  { ...HOST_BASE, id: 'desk', name: 'Desk', kind: 'remote', status: 'online', owner_user_id: 'user-1' },
  { ...HOST_BASE, id: 'new', name: 'New laptop', kind: 'remote', status: 'pending_pairing', owner_user_id: 'user-1' },
  { ...HOST_BASE, id: 'old', name: 'Old laptop', kind: 'remote', status: 'revoked', owner_user_id: 'user-1' },
]

function tool(overrides: Partial<HostOrdinaryTool> = {}): HostOrdinaryTool {
  return {
    tool_id: 'lark_cli', label: 'Feishu / Lark CLI', executable: 'lark-cli', requires_account: true,
    host_status: 'missing', reported_live: true, source: null, version: null, version_text: null, registered: false,
    managed: { catalog_version: '1.0.99', installed_version: null, installable: true, update_available: false },
    sandbox_status: 'not_verified', account_status: 'not_verified', ...overrides,
  }
}
function tools(hostId: string, overrides: Partial<HostOrdinaryToolsResponse> = {}, items = [tool()]): HostOrdinaryToolsResponse {
  return { host_id: hostId, host_state: 'online', can_manage: true, operations: [], tools: items, ...overrides }
}
function account(hostId: string, overrides: Partial<HostOrdinaryAccountResponse> = {}): HostOrdinaryAccountResponse {
  return {
    host_id: hostId, tool_id: 'lark_cli', availability: 'live', reason: null, session_active: false, sandbox_status: 'not_verified',
    status: { state: 'not_logged_in', account: null, reason: null }, ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
function report(overrides: Partial<OrdinaryToolReport> = {}): OrdinaryToolReport {
  return {
    tool_id: 'lark_cli', status: 'available', source: 'managed', version: '1.0.99', version_text: 'lark-cli 1.0.99',
    managed_version: '1.0.99', registered: false, managed_installable: true, managed_catalog_version: '1.0.99', ...overrides,
  }
}
const SIGNED_IN = { state: 'signed_in', account: { user_name: 'Alice', app_id: 'cli_x', brand: 'feishu', refresh_pending: false, expires_at: null, refresh_expires_at: null, verified: null }, reason: null } as const
const INSTALLED = { host_status: 'available', source: 'managed', version: '1.0.99', managed: { catalog_version: '1.0.99', installed_version: '1.0.99', installable: true, update_available: false } } as const
/** Lets the card's and panel's follow-up reads (3 s) fire. */
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.resetAllMocks()
  // Every refresh answers with new objects, as the server does.
  api.hosts.mockImplementation(async () => ({ items: HOSTS.map((host) => ({ ...host })) }))
  api.runtimeDefinitions.mockResolvedValue({ items: [] })
  api.provisioning.mockResolvedValue(null)
  api.account.mockImplementation(async (hostId: string) => account(hostId))
})
afterEach(() => { vi.useRealTimers() })

/** Navigates inside the app, as a link or the browser's history would. */
function Nav() {
  const navigate = useNavigate()
  const location = useLocation()
  return <><span hidden data-testid="search">{location.search}</span>
    <button type="button" onClick={() => navigate('/command-center?host=builtin&section=cli')}>go to builtin CLI</button></>
}
const renderHosts = (search = '') => render(<MemoryRouter initialEntries={[`/command-center${search}`]}><HostsPanel /><Nav /></MemoryRouter>)
const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '')
const chooseHost = async (name: string) => fireEvent.click(within(await screen.findByRole('navigation', { name: 'Execution environments' })).getByRole('button', { name: new RegExp(name) }))

describe('CLI tools in a Command Center Host detail', () => {
  it('is in each usable Host’s detail, reads nothing until opened, and shows only that Host', async () => {
    api.list.mockImplementation(async (hostId: string) => tools(hostId, {}, [tool({ label: `Tool on ${hostId}`, requires_account: false })]))
    renderHosts()
    // The detail opens on the instance Host; a Host still pairing, or revoked, has no tools section.
    expect(await screen.findByRole('button', { name: 'Show CLI tools for Built-in sandbox' })).toHaveAttribute('aria-expanded', 'false')
    expect(api.list).not.toHaveBeenCalled()
    await chooseHost('New laptop')
    expect(await screen.findByRole('article', { name: 'New laptop' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /CLI tools for New laptop/ })).not.toBeInTheDocument()
    await chooseHost('Old laptop')
    expect(screen.queryByRole('button', { name: /CLI tools for Old laptop/ })).not.toBeInTheDocument()

    await chooseHost('Desk')
    fireEvent.click(await screen.findByRole('button', { name: 'Show CLI tools for Desk' }))
    expect(await screen.findByText('Tool on desk')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith('desk')
    fireEvent.click(screen.getByRole('button', { name: 'Hide CLI tools for Desk' }))
    expect(screen.queryByText('Tool on desk')).not.toBeInTheDocument()

    // Another Host's detail starts closed and reads its own tools only.
    await chooseHost('Built-in sandbox')
    fireEvent.click(await screen.findByRole('button', { name: 'Show CLI tools for Built-in sandbox' }))
    expect(await screen.findByText('Tool on builtin')).toBeInTheDocument()
    expect(screen.queryByText('Tool on desk')).not.toBeInTheDocument()
  })

  it('keeps an open login through the Host list refresh, and ends it when another Host is chosen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.list.mockImplementation(async (hostId: string) => tools(hostId, {}, [tool(INSTALLED)]))
    let signal: AbortSignal | undefined
    api.sessionStream.mockImplementation(async function* (_host: string, _tool: string, _flow: string, abort?: AbortSignal) {
      signal = abort
      yield { type: 'authorization', url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_in: 600 }
      await new Promise<void>((resolve) => abort?.addEventListener('abort', () => resolve()))
    })
    renderHosts('?host=desk&section=cli')
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Code: ABCD-EFGH')).toBeInTheDocument()
    const hostReads = api.hosts.mock.calls.length
    const toolReads = api.list.mock.calls.length
    await elapse(9_000)
    // The Host list refreshed; the detail was not remounted or reread.
    expect(api.hosts.mock.calls.length).toBeGreaterThan(hostReads)
    expect(api.list).toHaveBeenCalledTimes(toolReads)
    expect(signal?.aborted).toBe(false)
    expect(screen.getByText('Code: ABCD-EFGH')).toBeInTheDocument()

    // Choosing another Host leaves this one: its login ends with it.
    await chooseHost('Built-in sandbox')
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText('Code: ABCD-EFGH')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Show CLI tools for Built-in sandbox' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('Host detail lifecycle', () => {
  it('ends a login on the default Host when the person goes back to the list', async () => {
    api.list.mockImplementation(async (hostId: string) => tools(hostId, {}, [tool(INSTALLED)]))
    let signal: AbortSignal | undefined
    api.sessionStream.mockImplementation(async function* (_host: string, _tool: string, _flow: string, abort?: AbortSignal) {
      signal = abort
      yield { type: 'authorization', url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_in: 600 }
      await new Promise<void>((resolve) => abort?.addEventListener('abort', () => resolve()))
    })
    const user = userEvent.setup({ delay: null })
    renderHosts()
    // Nothing named: the instance Host is shown by default; using it names it.
    await user.click(await screen.findByRole('button', { name: 'Show CLI tools for Built-in sandbox' }))
    expect(search().get('host')).toBe('builtin')
    await user.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Code: ABCD-EFGH')).toBeInTheDocument()

    // Back to the list leaves that Host, though it stays the default.
    await user.click(screen.getByRole('button', { name: 'All environments' }))
    expect(search().get('host')).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText('Code: ABCD-EFGH')).not.toBeInTheDocument()
    await user.click(within(screen.getByRole('navigation', { name: 'Execution environments' })).getByRole('button', { name: /Built-in sandbox/ }))
    expect(await screen.findByRole('button', { name: 'Show CLI tools for Built-in sandbox' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Code: ABCD-EFGH')).not.toBeInTheDocument()
  })

  it('opens the CLI tools when a navigation names them on the Host already shown, but a refresh never reopens them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.list.mockImplementation(async (hostId: string) => tools(hostId, {}, [tool({ ...INSTALLED, requires_account: false })]))
    renderHosts('?host=builtin&section=runtime')
    expect(await screen.findByRole('button', { name: 'Show CLI tools for Built-in sandbox' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'go to builtin CLI' }))
    expect(await screen.findByRole('button', { name: 'Hide CLI tools for Built-in sandbox' })).toHaveAttribute('aria-expanded', 'true')
    // The person closes it; the Host list refresh leaves it closed.
    fireEvent.click(screen.getByRole('button', { name: 'Hide CLI tools for Built-in sandbox' }))
    await elapse(6_000)
    expect(screen.getByRole('button', { name: 'Show CLI tools for Built-in sandbox' })).toHaveAttribute('aria-expanded', 'false')
    // A new navigation to the same place opens it again.
    fireEvent.click(screen.getByRole('button', { name: 'go to builtin CLI' }))
    expect(await screen.findByRole('button', { name: 'Hide CLI tools for Built-in sandbox' })).toBeInTheDocument()
  })

  it('moves the keyboard into the default Host’s detail when that Host is chosen from the list', async () => {
    api.list.mockImplementation(async (hostId: string) => tools(hostId, {}, []))
    const user = userEvent.setup({ delay: null })
    renderHosts()
    const button = within(await screen.findByRole('navigation', { name: 'Execution environments' })).getByRole('button', { name: /Built-in sandbox/ })
    // That detail is already mounted (it is the default); choosing it still moves focus.
    await user.click(button)
    expect(document.activeElement).toBe(screen.getByRole('article', { name: 'Built-in sandbox' }))
    // Back returns to the Host it left.
    await user.click(screen.getByRole('button', { name: 'All environments' }))
    expect(document.activeElement).toBe(within(screen.getByRole('navigation', { name: 'Execution environments' })).getByRole('button', { name: /Built-in sandbox/ }))
  })
})

describe('CLI tools for one Host', () => {
  it('never draws a previous Host answer that arrives after a switch', async () => {
    const slow = deferred<HostOrdinaryToolsResponse>()
    api.list.mockImplementation((hostId: string) => hostId === 'desk'
      ? slow.promise
      : Promise.resolve(tools(hostId, {}, [tool({ label: 'Builtin tool', requires_account: false })])))
    // Same component instance, new Host: only the newest request may draw.
    const { rerender } = render(<CliToolsPanel hostId="desk" hostKind="remote" />)
    rerender(<CliToolsPanel hostId="builtin" hostKind="server" />)
    expect(await screen.findByText('Builtin tool')).toBeInTheDocument()
    await act(async () => { slow.resolve(tools('desk', {}, [tool({ label: 'Desk tool', requires_account: false })])) })
    expect(screen.queryByText('Desk tool')).not.toBeInTheDocument()
  })

  it('offers management only when the server allows it, and shows a refusal', async () => {
    api.list.mockResolvedValueOnce(tools('builtin', { can_manage: false }, [tool({ requires_account: false })]))
    const { unmount } = render(<CliToolsPanel key="builtin" hostId="builtin" hostKind="server" />)
    expect(await screen.findByText('Only an instance administrator can install or remove tools on the built-in Host.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Register/ })).not.toBeInTheDocument()
    unmount()

    api.list.mockResolvedValue(tools('desk', {}, [tool({ requires_account: false })]))
    api.install.mockRejectedValue(new Error('This Host\'s daemon carries 1.0.98; update the Host first.'))
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install 1.0.99' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('update the Host first')
    expect(api.install).toHaveBeenCalledWith('desk', 'lark_cli')
  })

  it('explains a Host that needs an update or is offline', async () => {
    api.list.mockResolvedValueOnce(tools('desk', { host_state: 'update_required' }, [tool({ host_status: 'unknown', requires_account: false })]))
    const { unmount } = render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText(/Update this Host's rainver-host/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument()
    unmount()
    api.list.mockResolvedValueOnce(tools('desk', { host_state: 'offline' }, [tool({ host_status: 'available', reported_live: false, requires_account: false })]))
    render(<CliToolsPanel key="desk2" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText(/offline; the list shows what it last reported/)).toBeInTheDocument()
    expect(screen.getByText('Last report')).toBeInTheDocument()
  })

  it('shows the official link only in this card and closes the session when the Host changes', async () => {
    api.list.mockImplementation(async (hostId: string) => tools(hostId, {}, [tool({ host_status: 'available', source: 'managed', version: '1.0.99' })]))
    let signal: AbortSignal | undefined
    api.sessionStream.mockImplementation(async function* (_host: string, _tool: string, _flow: string, abort?: AbortSignal) {
      signal = abort
      yield { type: 'authorization', url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_in: 600 }
      await new Promise<void>((resolve) => abort?.addEventListener('abort', () => resolve()))
    })
    const { rerender } = render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    const link = await screen.findByRole('link', { name: /official authorization page/ })
    expect(link).toHaveAttribute('href', 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH')
    expect(screen.getByText('Code: ABCD-EFGH')).toBeInTheDocument()
    expect(api.sessionStream).toHaveBeenCalledWith('desk', 'lark_cli', 'login', expect.any(AbortSignal))

    // Another Host in the same panel: the first Host's stream is closed and its link is gone.
    rerender(<CliToolsPanel key="desk" hostId="builtin" hostKind="server" />)
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(screen.queryByRole('link', { name: /official authorization page/ })).not.toBeInTheDocument())
  })

  it('reports the account as the server states it and keeps logout semantics honest', async () => {
    api.list.mockResolvedValue(tools('desk', {}, [tool({ host_status: 'available', source: 'managed' })]))
    api.account.mockResolvedValue(account('desk', { status: { state: 'signed_in', account: { user_name: 'Alice', app_id: 'cli_x', brand: 'feishu', refresh_pending: false, expires_at: null, refresh_expires_at: null, verified: null }, reason: null } }))
    api.logout.mockResolvedValue({ ...account('desk'), logout: { local_cleared: true, remote_revocation: 'attempted_unconfirmed' } })
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('Logged in as Alice')).toBeInTheDocument()
    expect(screen.getByText('Run sandbox: not verified')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await screen.findByText(/Remote revocation was attempted but could not be confirmed/)).toBeInTheDocument()
    expect(screen.getByText('Not logged in')).toBeInTheDocument()
  })
})

describe('CLI tools after an action or a wait', () => {
  it('after an install, waits for the server to record it before offering setup, without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // The Host's report says installed at once; the server's record (list and
    // the account endpoint's gate) catches up only after a few heartbeats.
    let recorded = false
    api.list.mockImplementation(async () => tools('desk', {}, [tool(recorded ? INSTALLED : {})]))
    api.account.mockImplementation(async () => recorded
      ? account('desk', { status: { state: 'not_configured', account: null, reason: null } })
      : account('desk', { availability: 'tool_unavailable', status: null }))
    api.install.mockResolvedValue({ host_id: 'desk', tool_id: 'lark_cli', ok: true, error: null, tool: report() })
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('Install or register the CLI first.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install 1.0.99' }))
    expect(await screen.findByRole('button', { name: 'Remove managed copy' })).toBeInTheDocument()
    expect(await screen.findByText('Waiting for the server to record the tool change…')).toBeInTheDocument()
    await elapse(3_000)
    await elapse(3_000)
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument()
    recorded = true
    await elapse(3_000)
    expect(await screen.findByRole('button', { name: 'Set up' })).toBeEnabled()
    expect(screen.queryByText('Waiting for the server to record the tool change…')).not.toBeInTheDocument()
    // Confirmed: no more reads of either.
    const reads = [api.list.mock.calls.length, api.account.mock.calls.length]
    await elapse(15_000)
    expect([api.list.mock.calls.length, api.account.mock.calls.length]).toEqual(reads)
  })

  it('after a remove, never shows the old login while the server still has the tool', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let recorded = false
    api.list.mockImplementation(async () => tools('desk', {}, [tool(recorded ? {} : INSTALLED)]))
    api.account.mockImplementation(async () => recorded
      ? account('desk', { availability: 'tool_unavailable', status: null })
      : account('desk', { status: SIGNED_IN }))
    api.remove.mockResolvedValue({ host_id: 'desk', tool_id: 'lark_cli', ok: true, error: null, tool: report({ status: 'missing', source: null, version: null, version_text: null, managed_version: null }) })
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('Logged in as Alice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove managed copy' }))
    expect(await screen.findByRole('button', { name: 'Install 1.0.99' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Logged in as Alice')).not.toBeInTheDocument())
    for (let i = 0; i < 3; i++) {
      await elapse(3_000)
      expect(screen.queryByText('Logged in as Alice')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument()
    }
    recorded = true
    await elapse(3_000)
    expect(await screen.findByText('Install or register the CLI first.')).toBeInTheDocument()
    expect(screen.queryByText('Logged in as Alice')).not.toBeInTheDocument()
  })

  it('a change the server never records ends with an explicit notice and retry, not a silent revert', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let recorded = false
    api.list.mockImplementation(async () => tools('desk', {}, [tool(recorded ? INSTALLED : {})]))
    api.account.mockImplementation(async () => recorded
      ? account('desk', { status: { state: 'not_configured', account: null, reason: null } })
      : account('desk', { availability: 'tool_unavailable', status: null }))
    api.install.mockResolvedValue({ host_id: 'desk', tool_id: 'lark_cli', ok: true, error: null, tool: report() })
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install 1.0.99' }))
    expect(await screen.findByRole('button', { name: 'Remove managed copy' })).toBeInTheDocument()
    for (let i = 0; i < 12; i++) await elapse(3_000)
    expect(screen.getByText('The Host reported this change, but the server has not recorded it yet.')).toBeInTheDocument()
    expect(screen.getByText('Your account state has not caught up with the tool yet.')).toBeInTheDocument()
    // Still the Host's report, not the old list.
    expect(screen.getByRole('button', { name: 'Remove managed copy' })).toBeInTheDocument()
    const reads = api.list.mock.calls.length
    await elapse(9_000)
    expect(api.list).toHaveBeenCalledTimes(reads)
    recorded = true
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByText(/has not recorded it yet/)).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: 'Set up' })).toBeEnabled()
  })

  it('follows an operation in progress until it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.list.mockResolvedValueOnce(tools('desk', { operations: [{ tool_id: 'lark_cli', action: 'install' }] }, [tool({ requires_account: false })]))
      .mockResolvedValue(tools('desk', {}, [tool({ ...INSTALLED, requires_account: false })]))
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('An operation on this tool is in progress.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install 1.0.99' })).toBeDisabled()
    await elapse(3_000)
    expect(await screen.findByRole('button', { name: 'Remove managed copy' })).toBeEnabled()
    expect(screen.queryByText('An operation on this tool is in progress.')).not.toBeInTheDocument()
    // Nothing runs any more: no further reads.
    const reads = api.list.mock.calls.length
    await elapse(10_000)
    expect(api.list).toHaveBeenCalledTimes(reads)
  })

  it('after a cancel a briefly busy account recovers by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.list.mockResolvedValue(tools('desk', {}, [tool(INSTALLED)]))
    api.account.mockResolvedValueOnce(account('desk'))
      .mockResolvedValueOnce(account('desk', { availability: 'busy', status: null, session_active: true }))
      .mockResolvedValue(account('desk'))
    let signal: AbortSignal | undefined
    api.sessionStream.mockImplementation(async function* (_host: string, _tool: string, _flow: string, abort?: AbortSignal) {
      signal = abort
      yield { type: 'authorization', url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_in: 600 }
      await new Promise<void>((resolve) => abort?.addEventListener('abort', () => resolve()))
    })
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(signal?.aborted).toBe(true)
    expect(await screen.findByText(/Another account operation or a Run is using your account/)).toBeInTheDocument()
    await elapse(3_000)
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeEnabled()
    expect(screen.queryByText(/Another account operation/)).not.toBeInTheDocument()
    expect(api.account).toHaveBeenCalledTimes(3)
  })

  it('an account read that failed, or an offline Host, is retried on request', async () => {
    api.list.mockResolvedValue(tools('desk', {}, [tool(INSTALLED)]))
    api.account.mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce(account('desk', { availability: 'offline', status: null }))
      .mockResolvedValue(account('desk'))
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('gateway timeout')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('The Host is offline.')).toBeInTheDocument()
    expect(screen.queryByText('gateway timeout')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeEnabled()
  })

  it('a read of the same Host that answers after a logout does not bring the account back', async () => {
    const stale = deferred<HostOrdinaryAccountResponse>()
    api.account.mockResolvedValueOnce(account('desk', { status: SIGNED_IN })).mockReturnValueOnce(stale.promise)
    api.logout.mockResolvedValue({ ...account('desk'), logout: { local_cleared: true, remote_revocation: 'attempted_unconfirmed' } })
    const { rerender } = render(<OrdinaryAccountCard hostId="desk" toolId="lark_cli" toolState="a" toolAvailable />)
    expect(await screen.findByText('Logged in as Alice')).toBeInTheDocument()
    // The tool changed: a quiet read starts and is slow; the person logs out meanwhile.
    rerender(<OrdinaryAccountCard hostId="desk" toolId="lark_cli" toolState="b" toolAvailable />)
    expect(api.account).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await screen.findByText('Not logged in')).toBeInTheDocument()
    await act(async () => { stale.resolve(account('desk', { status: SIGNED_IN })) })
    expect(screen.getByText('Not logged in')).toBeInTheDocument()
    expect(screen.queryByText('Logged in as Alice')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled()
  })

  it('a tool change during a login reads the account without closing the session', async () => {
    let signal: AbortSignal | undefined
    api.sessionStream.mockImplementation(async function* (_host: string, _tool: string, _flow: string, abort?: AbortSignal) {
      signal = abort
      yield { type: 'authorization', url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', user_code: 'ABCD-EFGH', expires_in: 600 }
      await new Promise<void>((resolve) => abort?.addEventListener('abort', () => resolve()))
    })
    const { rerender } = render(<OrdinaryAccountCard hostId="desk" toolId="lark_cli" toolState="a" toolAvailable />)
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Code: ABCD-EFGH')).toBeInTheDocument()
    rerender(<OrdinaryAccountCard hostId="desk" toolId="lark_cli" toolState="b" toolAvailable />)
    await waitFor(() => expect(api.account).toHaveBeenCalledTimes(2))
    expect(signal?.aborted).toBe(false)
    expect(screen.getByText('Code: ABCD-EFGH')).toBeInTheDocument()
  })

  it('an operation started elsewhere is followed after it ends, until its result is recorded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // Another page installs: first read shows the operation; then it is gone
    // from the server while the stored heartbeat still says missing.
    let stage: 'running' | 'ended' | 'recorded' = 'running'
    api.list.mockImplementation(async () => stage === 'running'
      ? tools('desk', { operations: [{ tool_id: 'lark_cli', action: 'install' }] })
      : tools('desk', {}, [tool(stage === 'recorded' ? INSTALLED : {})]))
    api.account.mockImplementation(async () => stage === 'recorded'
      ? account('desk', { status: { state: 'not_configured', account: null, reason: null } })
      : account('desk', { availability: 'tool_unavailable', status: null }))
    render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('An operation on this tool is in progress.')).toBeInTheDocument()
    stage = 'ended'
    await elapse(3_000)
    await waitFor(() => expect(screen.queryByText('An operation on this tool is in progress.')).not.toBeInTheDocument())
    await elapse(3_000)
    await elapse(3_000)
    expect(screen.getByText('Install or register the CLI first.')).toBeInTheDocument()
    stage = 'recorded'
    await elapse(3_000)
    expect(await screen.findByRole('button', { name: 'Set up' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove managed copy' })).toBeInTheDocument()
    // Seen: no more reads.
    const reads = api.list.mock.calls.length
    await elapse(15_000)
    expect(api.list).toHaveBeenCalledTimes(reads)
  })

  it('an ended operation whose result never shows says so, offers Check again, and stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let stage: 'running' | 'ended' | 'recorded' = 'running'
    api.list.mockImplementation(async () => stage === 'running'
      ? tools('desk', { operations: [{ tool_id: 'lark_cli', action: 'install' }] }, [tool({ requires_account: false })])
      : tools('desk', {}, [tool({ ...(stage === 'recorded' ? INSTALLED : {}), requires_account: false })]))
    const { unmount } = render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('An operation on this tool is in progress.')).toBeInTheDocument()
    stage = 'ended'
    for (let i = 0; i < 12; i++) await elapse(3_000)
    // Not claimed as done or failed: the result is unknown.
    expect(screen.getByText('An operation on this tool ended; its result has not shown up yet.')).toBeInTheDocument()
    expect(screen.queryByText('Done.')).not.toBeInTheDocument()
    const reads = api.list.mock.calls.length
    await elapse(9_000)
    expect(api.list).toHaveBeenCalledTimes(reads)
    stage = 'recorded'
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('button', { name: 'Remove managed copy' })).toBeInTheDocument()
    expect(screen.queryByText(/its result has not shown up yet/)).not.toBeInTheDocument()
    unmount()
  })

  it('leaving while an ended operation is still followed stops its reads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let running = true
    api.list.mockImplementation(async () => running
      ? tools('desk', { operations: [{ tool_id: 'lark_cli', action: 'install' }] }, [tool({ requires_account: false })])
      : tools('desk', {}, [tool({ requires_account: false })]))
    const { unmount } = render(<CliToolsPanel key="desk" hostId="desk" hostKind="remote" />)
    expect(await screen.findByText('An operation on this tool is in progress.')).toBeInTheDocument()
    running = false
    await elapse(3_000)
    await waitFor(() => expect(screen.queryByText('An operation on this tool is in progress.')).not.toBeInTheDocument())
    await elapse(3_000)
    const beforeLeaving = api.list.mock.calls.length
    unmount()
    await elapse(30_000)
    expect(api.list).toHaveBeenCalledTimes(beforeLeaving)
  })

  it('a live account whose status is an error offers Retry and recovers', async () => {
    api.account.mockResolvedValueOnce(account('desk', { status: { state: 'error', account: null, reason: 'lark-cli timed out' } }))
      .mockResolvedValue(account('desk'))
    render(<OrdinaryAccountCard hostId="desk" toolId="lark_cli" toolState="a" toolAvailable />)
    expect(await screen.findByText('Error')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeEnabled()
    expect(api.account).toHaveBeenCalledTimes(2)
  })
})
