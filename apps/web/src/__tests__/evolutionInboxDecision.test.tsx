import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import EvolutionInboxPage from '../modules/evolution/EvolutionInboxPage'

const api = vi.hoisted(() => ({ signals: vi.fn(), bundles: vi.fn(), proposals: vi.fn(), assets: vi.fn(), bundle: vi.fn(), decideBundle: vi.fn() }))
vi.mock('../api/client', () => ({ evolutionApi: api, proposalsApi: {} }))
vi.mock('../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space', preferredSpaceId: 'space', userId: 'owner' }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const base = { id: 'bundle', title: 'Mixed effects', status: 'pending_review', risk_level: 'high', member_count: 1,
  members: [{ id: 'member', proposal_id: 'patch', status: 'pending', proposal: { id: 'patch', title: 'Patch reviewed by owner', proposal_type: 'code_patch' } }] }
const receipt = (status: string) => ({ id: 'intent', status, job_id: 'job', error: null, member_ids: ['patch'] })
async function open() {
  render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><EvolutionInboxPage /></MemoryRouter>)
  const user = userEvent.setup({ delay: null })
  await user.click(await screen.findByRole('tab', { name: /Bundles/ }))
  await user.click(await screen.findByRole('button', { name: /Mixed effects/ }))
  return user
}
beforeEach(() => {
  vi.clearAllMocks()
  for (const key of ['signals', 'proposals', 'assets'] as const) api[key].mockResolvedValue([])
  api.bundles.mockResolvedValue([base]); api.bundle.mockResolvedValue(base)
})
describe('Evolution Inbox parent consumes durable decisions', () => {
  it('keeps member pending after the accepted request and refreshes the retained result in Bundles and Approval', async () => {
    api.decideBundle.mockResolvedValue({ ...base, decision: receipt('pending') })
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Decision queued; members remain pending.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(api.decideBundle).toHaveBeenCalledExactlyOnceWith('bundle', [{ proposal_id: 'patch', decision: 'approve' }])
    await user.click(screen.getByRole('tab', { name: /Approval/ }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    api.bundle.mockResolvedValue({ ...base, status: 'applied', decision: receipt('succeeded'), members: base.members.map(m => ({ ...m, status: 'approved' })) })
    await user.click(screen.getByRole('button', { name: 'Refresh decision' }))
    expect(await screen.findByText('Decision completed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
  it('shows compensation failure honestly and prevents another member decision', async () => {
    api.bundle.mockResolvedValue({ ...base, decision: receipt('compensation_failed') })
    await open()
    expect(await screen.findByText('Restoration needs attention. The bundle was not approved as a whole.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
    expect(api.decideBundle).not.toHaveBeenCalled()
  })
})
