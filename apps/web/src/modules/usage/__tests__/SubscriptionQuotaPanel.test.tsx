import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { SubscriptionQuotaPool } from '@rainver/protocol'
import SubscriptionQuotaPanel from '../SubscriptionQuotaPanel'
import { hostsApi } from '../../../api/client'

const scope = vi.hoisted(() => ({ activeSpaceId: 'space-1' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => scope }))
vi.mock('../../../api/client', () => ({ hostsApi: { subscriptionUsage: vi.fn(), refreshUsage: vi.fn() } }))
const pool: SubscriptionQuotaPool = { id: 'pool-a', label: 'Claude · person@example.test · Personal', account_display: { email: 'person@example.test', workspace_name: 'Personal' }, account: { provider: 'anthropic', product: 'claude', account_id: 'a'.repeat(64), organization_id: null },
  windows: [{ id: 'session', label: 'Session', used_pct: 42, resets: null, checked_at: '2026-11-06T12:00:00Z' }],
  connections: [
    { host_id: 'offline-host', host_name: 'Offline desk', runtime_key: 'claude_code', runtime_name: 'Claude Code', installation: 'own', online: false, can_refresh: true, checked_at: null, error: null },
    { host_id: 'online-host', host_name: 'Online desk', runtime_key: 'claude_code', runtime_name: 'Claude Code', installation: 'managed:1', online: true, can_refresh: true, checked_at: null, error: null },
  ] }
beforeEach(() => { scope.activeSpaceId = 'space-1'; vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items: [structuredClone(pool)] }); vi.mocked(hostsApi.refreshUsage).mockReset() })
const view = () => render(<MemoryRouter initialEntries={['/usage?tab=quotas&pool=pool-a']}><SubscriptionQuotaPanel /></MemoryRouter>)

it('shows one account quota with both connections and refreshes one accessible online connection', async () => {
  vi.mocked(hostsApi.refreshUsage).mockResolvedValue({} as never)
  view()
  expect(await screen.findByRole('heading', { name: pool.label })).toBeInTheDocument()
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  expect(screen.getByText('2 connections')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Refresh quota' }))
  await waitFor(() => expect(hostsApi.refreshUsage).toHaveBeenCalledWith('online-host', 'claude_code', 'managed:1'))
})
it('clears measurements after a denied refresh and offers a retry', async () => {
  vi.mocked(hostsApi.refreshUsage).mockRejectedValue(new Error('Access denied'))
  view()
  await screen.findByRole('progressbar')
  await userEvent.click(screen.getByRole('button', { name: 'Refresh quota' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied')
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByText(/person@example.test/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
})
it('does not turn an unknown quota into zero or an available connection', async () => {
  vi.mocked(hostsApi.subscriptionUsage).mockResolvedValue({ items: [{ ...pool, account: null, windows: [], connections: [pool.connections[0]] }] })
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
