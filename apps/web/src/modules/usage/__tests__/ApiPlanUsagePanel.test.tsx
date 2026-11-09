import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import ApiPlanUsagePanel from '../ApiPlanUsagePanel'
import { providersApi } from '../../../api/client'

const scope = vi.hoisted(() => ({ activeSpaceId: 'space-1' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => scope }))
vi.mock('../../../api/client', () => ({ providersApi: { planUsageProviders: vi.fn(), refreshPlanUsage: vi.fn() } }))
const snapshot = { provider_id: 'mini', checked_at: '2026-11-07T12:00:00Z', windows: [{ id: 'session', label: '5h', used_pct: 25, resets_at: null }] }
beforeEach(() => {
  scope.activeSpaceId = 'space-1'
  vi.mocked(providersApi.planUsageProviders).mockReset().mockResolvedValue({ items: [{ provider_id: 'mini', name: 'My MiniMax', vendor: 'minimax' }] })
  vi.mocked(providersApi.refreshPlanUsage).mockReset().mockResolvedValue(snapshot)
})
const view = () => render(<MemoryRouter><ApiPlanUsagePanel /></MemoryRouter>)
it('automatically queries on entry and displays a measured zero', async () => {
  vi.mocked(providersApi.refreshPlanUsage).mockResolvedValue({ ...snapshot, windows: [{ ...snapshot.windows[0], used_pct: 0 }] })
  view()
  await screen.findByRole('heading', { name: 'My MiniMax' })
  await waitFor(() => expect(providersApi.refreshPlanUsage).toHaveBeenCalledWith('mini'))
  expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
})
it('clears the last reading on query failure', async () => {
  view()
  await screen.findByRole('heading', { name: 'My MiniMax' })
  await screen.findByRole('progressbar')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh quota' })).toBeEnabled())
  vi.mocked(providersApi.refreshPlanUsage).mockRejectedValue(new Error('denied'))
  await userEvent.click(screen.getByRole('button', { name: 'Refresh quota' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('progressbar')).toBeNull()
})
it('discards an in-flight result when the active Space changes', async () => {
  let finish!: (value: typeof snapshot) => void
  vi.mocked(providersApi.refreshPlanUsage).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const rendered = view()
  await screen.findByRole('heading', { name: 'My MiniMax' })
  await waitFor(() => expect(providersApi.refreshPlanUsage).toHaveBeenCalled())
  scope.activeSpaceId = 'space-2'
  vi.mocked(providersApi.planUsageProviders).mockResolvedValue({ items: [] })
  rendered.rerender(<MemoryRouter><ApiPlanUsagePanel /></MemoryRouter>)
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'My MiniMax' })).toBeNull())
  await act(async () => finish(snapshot))
  expect(screen.queryByRole('progressbar')).toBeNull()
})

it('refreshes every account on entry and isolates one failed account', async () => {
  vi.mocked(providersApi.planUsageProviders).mockResolvedValue({ items: [
    { provider_id: 'broken', name: 'Broken', vendor: 'minimax' },
    { provider_id: 'mini', name: 'My MiniMax', vendor: 'minimax' },
  ] })
  vi.mocked(providersApi.refreshPlanUsage).mockImplementation(async id => {
    if (id === 'broken') throw new Error('unavailable')
    return snapshot
  })
  view()
  expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(2)
})
it('refreshes all accounts again when requested by the parent', async () => {
  const rendered = view()
  await screen.findByRole('progressbar')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh quota' })).toBeEnabled())
  rendered.rerender(<MemoryRouter><ApiPlanUsagePanel refreshKey={1} /></MemoryRouter>)
  await waitFor(() => expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(2))
})
it('queries fresh readings again after leaving and re-entering the page', async () => {
  const first = view()
  await screen.findByRole('progressbar')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh quota' })).toBeEnabled())
  first.unmount()
  vi.mocked(providersApi.refreshPlanUsage).mockResolvedValue({ ...snapshot, windows: [{ ...snapshot.windows[0], used_pct: 30 }] })
  view()
  expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')
  expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(2)
})
it('queries at most three accounts at once and shows each as soon as it answers', async () => {
  vi.mocked(providersApi.planUsageProviders).mockResolvedValue({ items: ['a', 'b', 'c', 'd'].map(id => ({ provider_id: id, name: `Provider ${id}`, vendor: 'minimax' as const })) })
  const answers = new Map<string, () => void>()
  vi.mocked(providersApi.refreshPlanUsage).mockImplementation(id => new Promise(resolve => { answers.set(id, () => resolve({ ...snapshot, provider_id: id })) }))
  view()
  await waitFor(() => expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(3))
  await act(async () => { answers.get('b')!() })
  expect(await screen.findByRole('progressbar')).toBeInTheDocument()
  await waitFor(() => expect(providersApi.refreshPlanUsage).toHaveBeenCalledTimes(4))
})

it('stops a finished card spinning while the rest of a bulk refresh continues', async () => {
  vi.mocked(providersApi.planUsageProviders).mockResolvedValue({ items: [
    { provider_id: 'mini', name: 'My MiniMax', vendor: 'minimax' },
    { provider_id: 'slow', name: 'Slow', vendor: 'minimax' },
  ] })
  let finish!: () => void
  vi.mocked(providersApi.refreshPlanUsage).mockImplementation(id => id === 'slow' ? new Promise(resolve => { finish = () => resolve({ ...snapshot, provider_id: 'slow' }) }) : Promise.resolve(snapshot))
  view()
  await screen.findByRole('progressbar')
  const icon = (name: string) => screen.getByRole('heading', { name }).parentElement!.querySelector('svg')!
  await waitFor(() => expect(icon('My MiniMax')).not.toHaveClass('animate-spin'))
  expect(icon('Slow')).toHaveClass('animate-spin')
  await act(async () => finish())
  await waitFor(() => expect(icon('Slow')).not.toHaveClass('animate-spin'))
})
