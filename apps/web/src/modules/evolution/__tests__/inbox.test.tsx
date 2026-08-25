import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { evolutionApiMock } = vi.hoisted(() => ({
  evolutionApiMock: {
    signals: vi.fn(), bundles: vi.fn(), bundle: vi.fn(), proposals: vi.fn(), assets: vi.fn(), assetEvaluationRuns: vi.fn(),
  },
}))

const { proposalsApiMock } = vi.hoisted(() => ({ proposalsApiMock: { accept: vi.fn(), reject: vi.fn(), approveEgressGrantingUserProposal: vi.fn() } }))
vi.mock('../../../api/client', () => ({ evolutionApi: evolutionApiMock, proposalsApi: proposalsApiMock }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1', userId: 'user-1' }),
}))

import EvolutionInboxPage from '../EvolutionInboxPage'

describe('EvolutionInboxPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    evolutionApiMock.signals.mockResolvedValue([])
    evolutionApiMock.bundles.mockResolvedValue([])
    evolutionApiMock.bundle.mockResolvedValue(null)
    evolutionApiMock.proposals.mockResolvedValue([{
      id: 'proposal-memory-1', proposal_type: 'memory_create', target_id: null, target_name: null,
      target_type: null, capability_key: null, status: 'pending', summary: 'Ordinary proposal evidence',
      created_at: '2026-07-12T00:00:00Z', created_by_run_id: null,
    }])
    evolutionApiMock.assets.mockResolvedValue([])
    evolutionApiMock.assetEvaluationRuns.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('surfaces ordinary pending proposals as bundle evidence', async () => {
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter><EvolutionInboxPage /></MemoryRouter>)

    await user.click(await screen.findByRole('tab', { name: /Evidence/ }))
    expect(await screen.findByText('Ordinary proposal evidence')).toBeInTheDocument()
    expect(screen.getByText('memory_create')).toBeInTheDocument()
    expect(evolutionApiMock.proposals).toHaveBeenCalledWith({ limit: 100 })
  })

  it('keeps released bundle members out of new bundle selection', async () => {
    evolutionApiMock.proposals.mockResolvedValue([{
      id: 'proposal-released-1', proposal_type: 'memory_create', target_id: null, target_name: null,
      target_type: null, capability_key: null, status: 'pending', summary: 'Released bundle member',
      created_at: '2026-07-12T00:00:00Z', created_by_run_id: null,
      bundle_id: 'bundle-1', bundle_member_status: 'released',
    }])
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter><EvolutionInboxPage /></MemoryRouter>)

    await user.click(await screen.findByRole('tab', { name: /Evidence/ }))
    expect(await screen.findByText('previously bundled')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('approves an ordinary proposal through the canonical proposal boundary', async () => {
    proposalsApiMock.accept.mockResolvedValue({})
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter><EvolutionInboxPage /></MemoryRouter>)

    await user.click(await screen.findByRole('tab', { name: /Evidence/ }))
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(proposalsApiMock.accept).toHaveBeenCalledWith('proposal-memory-1')
  })

  it('uses confirmation before approving an incomplete code patch', async () => {
    evolutionApiMock.proposals.mockResolvedValue([{
      id: 'proposal-patch-1', proposal_type: 'code_patch', target_id: null, target_name: null,
      target_type: null, capability_key: null, status: 'pending', summary: 'Partial patch',
      created_at: '2026-07-12T00:00:00Z', created_by_run_id: null, incomplete_patch: true, skipped_count: 2,
    }])
    proposalsApiMock.accept.mockResolvedValue({})
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter><EvolutionInboxPage /></MemoryRouter>)

    await user.click(await screen.findByRole('tab', { name: /Evidence/ }))
    await user.click(await screen.findByRole('button', { name: 'Confirm partial patch' }))
    expect(proposalsApiMock.accept).toHaveBeenCalledWith('proposal-patch-1', { confirmIncompletePatch: true })
  })

  it('uses the granting-user endpoint for egress proposals', async () => {
    evolutionApiMock.proposals.mockResolvedValue([{
      id: 'proposal-egress-1', proposal_type: 'egress_review', target_id: null, target_name: null,
      target_type: null, capability_key: null, status: 'pending', summary: 'Egress review',
      created_at: '2026-07-12T00:00:00Z', created_by_run_id: null,
      grant_id: 'grant-1', required_approver_user_id: 'user-1', egress_approval_status: null,
    }])
    proposalsApiMock.approveEgressGrantingUserProposal.mockResolvedValue({})
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter><EvolutionInboxPage /></MemoryRouter>)

    await user.click(await screen.findByRole('tab', { name: /Evidence/ }))
    await user.click(await screen.findByRole('button', { name: 'Approve egress' }))
    expect(proposalsApiMock.approveEgressGrantingUserProposal).toHaveBeenCalledWith('proposal-egress-1', { grant_id: 'grant-1' })
    expect(proposalsApiMock.accept).not.toHaveBeenCalled()
  })

  it('disables rollback when the server reports unsupported members', async () => {
    evolutionApiMock.bundles.mockResolvedValue([{
      id: 'bundle-1', space_id: 'space-1', title: 'Unsupported bundle', description: null,
      status: 'applied', risk_level: 'medium', created_by_user_id: 'user-1',
      created_at: '2026-07-12T00:00:00Z', updated_at: '2026-07-12T00:00:00Z',
      decided_at: '2026-07-12T00:00:00Z', rolled_back_at: null, rollback_error: null,
      member_count: 1, pending_count: 0, approved_count: 1,
      rollbackable: false, rollback_blockers: ['Member proposal-1 has no supported promotion rollback adapter'],
    }])
    evolutionApiMock.bundle.mockResolvedValue({
      id: 'bundle-1', space_id: 'space-1', title: 'Unsupported bundle', description: null,
      status: 'applied', risk_level: 'medium', created_by_user_id: 'user-1',
      created_at: '2026-07-12T00:00:00Z', updated_at: '2026-07-12T00:00:00Z',
      decided_at: '2026-07-12T00:00:00Z', rolled_back_at: null, rollback_error: null,
      member_count: 1, pending_count: 0, approved_count: 1,
      rollbackable: false, rollback_blockers: ['Member proposal-1 has no supported promotion rollback adapter'],
      members: [{ id: 'member-1', bundle_id: 'bundle-1', proposal_id: 'proposal-1', position: 1,
        status: 'approved', decision_note: null, decided_by_user_id: 'user-1', decided_at: '2026-07-12T00:00:00Z',
        created_at: '2026-07-12T00:00:00Z', before_snapshot_available: true, after_snapshot_available: true,
        rollback_supported: false, rollback_blocker: 'Member proposal-1 has no supported promotion rollback adapter',
        proposal: { id: 'proposal-1', proposal_type: 'memory_create', status: 'accepted', risk_level: 'low', title: 'Unsupported', summary: null, created_at: '2026-07-12T00:00:00Z' } }],
    })
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter><EvolutionInboxPage /></MemoryRouter>)

    await user.click(await screen.findByRole('tab', { name: /Bundles/ }))
    await user.click(await screen.findByRole('button', { name: /Unsupported bundle/ }))
    expect(await screen.findByText(/Rollback unavailable:/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Roll back approved members/ })).not.toBeInTheDocument()
  })
})
