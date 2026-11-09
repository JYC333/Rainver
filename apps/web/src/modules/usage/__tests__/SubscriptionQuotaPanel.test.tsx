import { act, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { HostRuntimeUsage, SubscriptionQuotaPool } from '@rainver/protocol'
import SubscriptionQuotaPanel from '../SubscriptionQuotaPanel'
import { ApiRequestError, hostsApi } from '../../../api/client'

const scope = vi.hoisted(() => ({ activeSpaceId: 'space-1' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => scope }))
vi.mock('../../../api/client', async importOriginal => ({
  ApiRequestError: (await importOriginal<typeof import('../../../api/client')>()).ApiRequestError,
  hostsApi: { subscriptionUsage: vi.fn(), refreshUsage: vi.fn() },
}))
const pool: SubscriptionQuotaPool = { id: 'pool-a', label: 'Claude · person@example.test · Personal', account_display: { email: 'person@example.test', workspace_name: 'Personal' }, account: { provider: 'anthropic', product: 'claude', account_id: 'a'.repeat(64), organization_id: null },
  windows: [{ id: 'session', label: 'Session', used_pct: 42, resets: null, checked_at: '2026-11-06T12:00:00Z' }],
  connections: [
    { host_id: 'offline-host', host_name: 'Offline desk', runtime_key: 'claude_code', runtime_name: 'Claude Code', installation: 'own', online: false, can_refresh: true, checked_at: null, error: null },
    { host_id: 'online-host', host_name: 'Online desk', runtime_key: 'claude_code', runtime_name: 'Claude Code', installation: 'managed:1', online: true, can_refresh: true, checked_at: null, error: null },
  ] }
const other: SubscriptionQuotaPool = { ...pool, id: 'other', account_display: undefined, label: 'Other', windows: [{ ...pool.windows[0]!, used_pct: 7 }], connections: [{ ...pool.connections[1]!, host_id: 'other-host' }] }
const row = (error: string | null = null) => ({ host_id: 'h', runtime_key: 'claude_code', installation: 'own', checked_at: '2026-11-06T12:00:00Z',
  quota: { available: true, session_pct: 42, session_resets: null, week_pct: null, week_resets: null, error } }) as HostRuntimeUsage
const card = (name: string) => screen.getByRole('heading', { name }).closest('[id^="quota-"]') as HTMLElement
beforeEach(() => { scope.activeSpaceId = 'space-1'; vi.mocked(hostsApi.subscriptionUsage).mockReset().mockResolvedValue({ items: [structuredClone(pool)] }); vi.mocked(hostsApi.refreshUsage).mockReset().mockResolvedValue(row()) })
const view = () => render(<MemoryRouter initialEntries={['/usage?tab=quotas&pool=pool-a']}><SubscriptionQuotaPanel /></MemoryRouter>)
const settled = () => waitFor(() => expect(screen.getByRole('button', { name: 'Refresh CLI quotas' })).toBeEnabled())

it('shows one account quota with both connections and refreshes one accessible online connection', async () => {
  view()
  expect(await screen.findByRole('heading', { name: pool.label })).toBeInTheDocument()
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  expect(screen.getByText('2 connections')).toBeInTheDocument()
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledWith('online-host', 'claude_code', 'managed:1'))
})
it('keeps every card and the last reading when one pool cannot be refreshed right now, with its own retry', async () => {
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items: [pool, other] })
  view()
  await settled()
  vi.mocked(hostsApi.refreshUsage).mockRejectedValueOnce(new ApiRequestError('Host is not answering', 502))
  await userEvent.click(within(card(pool.label)).getByRole('button', { name: 'Refresh quota' }))
  expect(await within(card(pool.label)).findByRole('alert')).toHaveTextContent('Could not refresh: Host is not answering Showing the last successful measurement')
  expect(within(card(pool.label)).getByRole('progressbar')).toBeInTheDocument()
  expect(within(card(pool.label)).getByText(/Checked/)).toBeInTheDocument()
  expect(within(card('Other')).queryByRole('alert')).toBeNull()
  expect(within(card(pool.label)).getByRole('button', { name: 'Refresh quota' })).toBeEnabled()
})
it('shows a kept reading as not refreshed when the host answered with a transient failure', async () => {
  vi.mocked(hostsApi.refreshUsage).mockResolvedValue(row('This host did not answer in time.'))
  view()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh: This host did not answer in time.')
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
})
it('removes only the pool whose access was lost', async () => {
  let refuse!: () => void
  vi.mocked(hostsApi.refreshUsage).mockImplementation(host => host === 'online-host'
    ? new Promise((_, reject) => { refuse = () => reject(new ApiRequestError('Host not found', 404)) })
    : Promise.resolve(row()))
  // Initial read, the read after "Other" succeeds, then a transient failure.
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items: [pool, other] }).mockResolvedValueOnce({ items: [pool, other] }).mockRejectedValue(new Error('Network down'))
  view()
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(2))
  // The 404 removes that pool's numbers even though the follow-up list read fails transiently.
  await act(async () => { refuse() })
  await settled()
  expect(screen.queryByText(/person@example.test/)).toBeNull()
  expect(screen.getByRole('heading', { name: 'Other' })).toBeInTheDocument()
})
it('keeps a pool whose batch refresh failed transiently, alongside the pools that succeeded', async () => {
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items: [pool, other] })
  vi.mocked(hostsApi.refreshUsage).mockImplementation(async host => { if (host === 'online-host') throw new Error('Failed to fetch'); return row() })
  view()
  await settled()
  expect(within(card(pool.label)).getByRole('alert')).toHaveTextContent('Failed to fetch')
  expect(within(card(pool.label)).getByRole('button', { name: 'Refresh quota' })).toBeEnabled()
  expect(within(card('Other')).queryByRole('alert')).toBeNull()
})
it('keeps the first list when re-reading it after refresh fails, and clears it when access is refused', async () => {
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items: [pool] }).mockRejectedValueOnce(new Error('Network down'))
  const rendered = view()
  await settled()
  expect(screen.getByRole('heading', { name: pool.label })).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Network down')
  rendered.unmount()
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items: [pool] }).mockRejectedValueOnce(new ApiRequestError('Not signed in', 401))
  view()
  await settled()
  expect(screen.queryByText(/person@example.test/)).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
})
it('does not turn an unknown quota into zero or an available connection', async () => {
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items: [{ ...pool, account: null, windows: [], connections: [pool.connections[0]!] }] })
  view()
  expect(await screen.findByText(/Account not identified/)).toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByRole('button', { name: 'Refresh quota' })).toBeDisabled()
})
it('does not restore a previous Space response after scope changes', async () => {
  let finish!: (value: { items: SubscriptionQuotaPool[] }) => void
  vi.mocked(hostsApi.subscriptionUsage).mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValue({ items: [] })
  const rendered = view()
  scope.activeSpaceId = 'space-2'
  rendered.rerender(<MemoryRouter><SubscriptionQuotaPanel /></MemoryRouter>)
  await screen.findByText('No CLI subscriptions are available to view.')
  await act(async () => { finish({ items: [pool] }) })
  expect(screen.queryByRole('heading', { name: pool.label })).toBeNull()
})
it('refreshes one authorized online connection per pool and skips offline, read-only and logged-out pools', async () => {
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items: [
    pool, other,
    { ...pool, id: 'offline', connections: [pool.connections[0]!] },
    { ...pool, id: 'read-only', connections: [{ ...pool.connections[1]!, can_refresh: false }] },
    { ...pool, id: 'logged-out', label: 'Logged out', account_display: undefined, connections: [{ ...pool.connections[1]!, host_id: 'logged-out-host', error: 'not_logged_in' }] },
  ] })
  view()
  await settled()
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(2)
  expect(hostsApi.refreshUsage).toHaveBeenCalledWith('online-host', 'claude_code', 'managed:1')
  expect(hostsApi.refreshUsage).toHaveBeenCalledWith('other-host', 'claude_code', 'managed:1')
  // Checking whether it has been logged back in stays one click away.
  await userEvent.click(within(card('Logged out')).getByRole('button', { name: 'Refresh quota' }))
  expect(hostsApi.refreshUsage).toHaveBeenCalledWith('logged-out-host', 'claude_code', 'managed:1')
})
it('runs at most three probes at once, finishes pools independently and ignores repeat clicks', async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ ...other, id: `p${index}`, label: `Pool ${index}`, connections: [{ ...other.connections[0]!, host_id: `host-${index}` }] }))
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items })
  const answers = new Map<string, () => void>()
  vi.mocked(hostsApi.refreshUsage).mockImplementation(host => new Promise(resolve => { answers.set(host, () => resolve(row())) }))
  view()
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(3))
  const busy = within(card('Pool 0')).getByRole('button', { name: 'Refresh quota' })
  expect(busy).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Refresh CLI quotas' })).toBeDisabled()
  await act(async () => { answers.get('host-1')!() })
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(4))
  expect(within(card('Pool 1')).getByRole('button', { name: 'Refresh quota' })).toBeEnabled()
  await act(async () => { for (const host of ['host-0', 'host-2', 'host-3']) answers.get(host)!() })
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(5))
  await act(async () => { answers.get('host-4')!() })
  await settled()
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(5)
})
it('keeps a probe failure on its copy when that copy moves to another card', async () => {
  // One copy whose probe reports the login ended: the re-read list has it under a new, unidentified pool.
  const single = { ...other, id: 'acct', label: 'Acct' }
  const moved = { ...single, id: 'unidentified', label: 'Unidentified copy', account: null, windows: [] }
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items: [single] }).mockResolvedValue({ items: [moved] })
  vi.mocked(hostsApi.refreshUsage).mockResolvedValue({ ...row("This copy's Claude login has expired; log in again."), quota: { ...row().quota, available: false, session_pct: null, error: "This copy's Claude login has expired; log in again." } })
  view()
  await settled()
  expect(screen.queryByRole('heading', { name: 'Acct' })).toBeNull()
  const alert = within(card('Unidentified copy')).getByRole('alert')
  expect(alert).toHaveTextContent('login has expired')
  // The moved copy has no reading, so the card claims no previous measurement.
  expect(alert).not.toHaveTextContent('Showing the last successful measurement')
})
it('puts a split copy\'s failure on its new card, not on the healthy copies left behind', async () => {
  const both: SubscriptionQuotaPool = { ...pool, connections: [{ ...pool.connections[0]!, online: true }, pool.connections[1]!] }
  const healthy: SubscriptionQuotaPool = { ...pool, connections: [pool.connections[1]!] }
  const split: SubscriptionQuotaPool = { ...pool, id: 'split', label: 'Split copy', account: null, account_display: undefined, windows: [], connections: [{ ...pool.connections[0]!, online: true }] }
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items: [both] }).mockResolvedValue({ items: [healthy, split] })
  vi.mocked(hostsApi.refreshUsage).mockRejectedValue(new ApiRequestError('Host is not answering', 502))
  view()
  await settled()
  expect(hostsApi.refreshUsage).toHaveBeenCalledWith('offline-host', 'claude_code', 'own')
  expect(within(card('Split copy')).getByRole('alert')).toHaveTextContent('Host is not answering')
  expect(within(card(pool.label)).queryByRole('alert')).toBeNull()
})
it('keeps a manual refresh within the three probe slots and the card busy until its list is re-read', async () => {
  const items = Array.from({ length: 4 }, (_, index) => ({ ...other, id: `p${index}`, label: `Pool ${index}`, connections: [{ ...other.connections[0]!, host_id: `host-${index}` }] }))
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items })
  const answers = new Map<string, () => void>()
  vi.mocked(hostsApi.refreshUsage).mockImplementation(host => new Promise(resolve => { answers.set(host, () => resolve(row())) }))
  view()
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(3))
  // Pool 3 is queued behind the automatic three; a click on it must not open a fourth probe.
  await userEvent.click(within(card('Pool 3')).getByRole('button', { name: 'Refresh quota' }))
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(3)
  expect(within(card('Pool 3')).getByRole('button', { name: 'Refresh quota' })).toBeDisabled()
  let reread!: () => void
  vi.mocked(hostsApi.subscriptionUsage).mockImplementationOnce(() => new Promise(resolve => { reread = () => resolve({ items }) }))
  await act(async () => { answers.get('host-0')!() })
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(4))
  // Answered, but its list is not in yet.
  expect(within(card('Pool 0')).getByRole('button', { name: 'Refresh quota' })).toBeDisabled()
  await act(async () => { reread() })
  await waitFor(() => expect(within(card('Pool 0')).getByRole('button', { name: 'Refresh quota' })).toBeEnabled())
  await act(async () => { for (const host of ['host-1', 'host-2', 'host-3']) answers.get(host)!() })
  await settled()
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(4)
})
for (const order of ['older list first', 'newer list first'] as const) {
  it(`keeps a card busy until the list read that is actually adopted is in (${order})`, async () => {
    const items = Array.from({ length: 2 }, (_, index) => ({ ...other, id: `p${index}`, label: `Pool ${index}`, connections: [{ ...other.connections[0]!, host_id: `host-${index}` }] }))
    vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items })
    const answers = new Map<string, () => void>()
    vi.mocked(hostsApi.refreshUsage).mockImplementation(host => new Promise(resolve => { answers.set(host, () => resolve(row())) }))
    view()
    await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(2))
    const lists: Array<() => void> = []
    vi.mocked(hostsApi.subscriptionUsage).mockImplementation(() => new Promise(resolve => { lists.push(() => resolve({ items })) }))
    // Pool 0's list read starts, then Pool 1's overtakes it.
    await act(async () => { answers.get('host-0')!() })
    await waitFor(() => expect(lists).toHaveLength(1))
    await act(async () => { answers.get('host-1')!() })
    await waitFor(() => expect(lists).toHaveLength(2))
    const button = (name: string) => within(card(name)).getByRole('button', { name: 'Refresh quota' })
    if (order === 'older list first') {
      // Pool 0's own read is superseded: the card waits for Pool 1's read, which is still out.
      await act(async () => { lists[0]!() })
      expect(button('Pool 0')).toBeDisabled()
      expect(button('Pool 1')).toBeDisabled()
      await act(async () => { lists[1]!() })
    } else {
      await act(async () => { lists[1]!() })
      await waitFor(() => expect(button('Pool 1')).toBeEnabled())
      // Pool 0's own read is still out; when it lands it is superseded and adopts nothing.
      expect(button('Pool 0')).toBeDisabled()
      await act(async () => { lists[0]!() })
    }
    await settled()
    expect(button('Pool 0')).toBeEnabled()
    expect(button('Pool 1')).toBeEnabled()
    // Neither click can open a second probe for the same copy while it was busy.
    expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(2)
  })
}
for (const status of [401, 403]) {
  it(`stops the rest of the refresh queue when the list itself is refused with ${status}`, async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ ...other, id: `p${index}`, label: `Pool ${index}`, connections: [{ ...other.connections[0]!, host_id: `host-${index}` }] }))
    vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items }).mockRejectedValue(new ApiRequestError('Not signed in', status))
    const answers = new Map<string, () => void>()
    vi.mocked(hostsApi.refreshUsage).mockImplementation(host => new Promise(resolve => { answers.set(host, () => resolve(row())) }))
    view()
    await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(3))
    await act(async () => { answers.get('host-0')!() })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pool 0' })).toBeNull())
    await act(async () => { answers.get('host-1')!(); answers.get('host-2')!() })
    await settled()
    // The two queued pools are never asked, and nothing is left spinning.
    expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(3)
    expect(hostsApi.subscriptionUsage).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
}
it('keeps the queue going when only one copy is gone (404)', async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ ...other, id: `p${index}`, label: `Pool ${index}`, connections: [{ ...other.connections[0]!, host_id: `host-${index}` }] }))
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValueOnce({ items }).mockResolvedValue({ items: items.slice(1) })
  vi.mocked(hostsApi.refreshUsage).mockImplementation(async host => { if (host === 'host-0') throw new ApiRequestError('Host not found', 404); return row() })
  view()
  await settled()
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(5)
  expect(screen.queryByRole('heading', { name: 'Pool 0' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Pool 4' })).toBeInTheDocument()
})
