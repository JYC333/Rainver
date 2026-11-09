import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import QuotaOverview from '../QuotaOverview'
import { hostsApi, providersApi } from '../../../api/client'

vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))
vi.mock('../../../api/client', async importOriginal => ({
  ApiRequestError: (await importOriginal<typeof import('../../../api/client')>()).ApiRequestError,
  hostsApi: { subscriptionUsage: vi.fn(), refreshUsage: vi.fn() },
  providersApi: { planUsageProviders: vi.fn(), refreshPlanUsage: vi.fn() },
}))
beforeEach(() => {
  vi.mocked(hostsApi.subscriptionUsage).mockReset().mockResolvedValue({ items: [{ id: 'cli', account: null, label: 'CLI account', windows: [], connections: [{ host_id: 'desk', runtime_key: 'claude_code', installation: 'own', online: true, can_refresh: true }] }] } as never)
  vi.mocked(hostsApi.refreshUsage).mockReset().mockResolvedValue({ quota: { available: true, error: null } } as never)
  vi.mocked(providersApi.planUsageProviders).mockReset().mockResolvedValue({ items: [{ provider_id: 'mini', name: 'MiniMax', vendor: 'minimax' }] })
  vi.mocked(providersApi.refreshPlanUsage).mockReset().mockResolvedValue({ provider_id: 'mini', checked_at: '2026-11-08T12:00:00Z', windows: [] })
})
it('automatically refreshes CLI and API on entry and refreshes both with one action', async () => {
  render(<MemoryRouter><QuotaOverview /></MemoryRouter>)
  const all = await screen.findByRole('button', { name: 'Refresh all quotas' })
  await waitFor(() => expect(all).toBeEnabled())
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(1)
  expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(1)
  await userEvent.click(all)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh all quotas' })).toBeEnabled())
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(2)
  expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(2)
})
it('does not duplicate quota probes during StrictMode effect replay', async () => {
  render(<StrictMode><MemoryRouter><QuotaOverview /></MemoryRouter></StrictMode>)
  await screen.findByRole('button', { name: 'Refresh all quotas' })
  expect(hostsApi.refreshUsage).toHaveBeenCalledTimes(1)
  expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(1)
})
