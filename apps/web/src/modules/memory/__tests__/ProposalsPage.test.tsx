import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Proposal } from '../../../types/api'

const mocked = vi.hoisted(() => ({ list: vi.fn(), accept: vi.fn() }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', userId: 'user-owner' }),
}))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('../../../api/client', () => ({
  proposalsApi: { list: mocked.list, get: vi.fn(), accept: mocked.accept, reject: vi.fn(), approveEgressGrantingUserProposal: vi.fn() },
}))

import ProposalsPage from '../ProposalsPage'
import { toast } from 'sonner'

function proposal(id: string, overrides: Partial<Proposal>): Proposal {
  return {
    id, space_id: 'space-1', user_id: 'user-author', proposal_type: 'memory_update',
    proposed_title: `Proposal ${id}`, proposed_content: '', rationale: '', status: 'pending',
    risk_level: 'low', urgency: 'normal', visibility: 'space', preview: false,
    review_deadline: null, expires_at: null, expired: false, created_at: '', decided_at: null,
    grant_id: null, required_approver_user_id: null, required_approver_user_ids: null,
    requires_approval_type: null, egress_approval_status: null, egress_approval_id: null,
    created_by_run_id: null,
    ...overrides,
  } as unknown as Proposal
}

describe('ProposalsPage', () => {
  it('sends a maintenance update that still needs its revision to be revised, not accepted', async () => {
    mocked.list.mockResolvedValue({
      items: [
        proposal('unrevised', { operator_revision: { edited_by_user_id: null, edited_at: null } }),
        proposal('revised', { operator_revision: { edited_by_user_id: 'user-owner', edited_at: '2026-10-14T00:00:00Z' } }),
      ],
      total: 2, limit: 80, offset: 0,
    })
    render(<MemoryRouter><ProposalsPage /></MemoryRouter>)

    expect(await screen.findByRole('link', { name: 'Revise' })).toHaveAttribute('href', '/proposals/unrevised')
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(1)
  })

  it('offers no decision on an expired proposal, which stays pending', async () => {
    mocked.list.mockResolvedValue({ items: [proposal('expired', { proposal_type: 'plugin_proposal', expired: true }), proposal('open', { proposal_type: 'plugin_proposal' })], next_cursor: null })
    render(<MemoryRouter><ProposalsPage /></MemoryRouter>)
    expect(await screen.findByText('EXPIRED')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(1)
  })

  it('reports a superseded accept (HTTP 200, operation_failure) as not applied, never accepted', async () => {
    mocked.list.mockResolvedValue({ items: [proposal('stale', { proposal_type: 'plugin_proposal' })], next_cursor: null })
    mocked.accept.mockResolvedValue({ proposal: proposal('stale', { status: 'superseded' }), result_type: 'operation_failure', result: { error: { code: 'operation_approval_superseded', request_id: 'r' } } })
    render(<MemoryRouter><ProposalsPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not applied: this request changed after the proposal was made, so the old approval no longer applies. Review the current proposal instead.'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
