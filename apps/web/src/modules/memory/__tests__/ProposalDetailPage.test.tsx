import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal } from '../../../types/api'

const mocked = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', userId: 'user-owner' }),
}))
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => null }))
vi.mock('../../../api/client', () => ({
  proposalsApi: { get: mocked.get, accept: vi.fn(), reject: vi.fn(), approveEgressGrantingUserProposal: vi.fn() },
}))

import ProposalDetailPage from '../ProposalDetailPage'

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: 'proposal-1', space_id: 'space-1', user_id: 'user-author', proposal_type: 'memory_create',
    proposed_title: 'A proposal', proposed_content: '', rationale: '', status: 'pending',
    risk_level: 'low', urgency: 'normal', visibility: 'space', preview: false,
    review_deadline: null, expires_at: null, expired: false, created_at: '', decided_at: null,
    grant_id: null, required_approver_user_id: null, required_approver_user_ids: null,
    requires_approval_type: null, egress_approval_status: null, egress_approval_id: null,
    created_by_run_id: null,
    ...overrides,
  } as unknown as Proposal
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/proposals/proposal-1']}>
      <Routes><Route path="/proposals/:proposalId" element={<ProposalDetailPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('ProposalDetailPage', () => {
  it('offers Accept and Reject on any pending proposal, as the list does', async () => {
    mocked.get.mockResolvedValue(proposal({ proposal_type: 'plan_review' }))
    renderPage()
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })

  it('lets a required content owner approve an egress review', async () => {
    mocked.get.mockResolvedValue(proposal({
      proposal_type: 'egress_review',
      requires_approval_type: 'egress_content_owner',
      required_approver_user_ids: ['user-other', 'user-owner'],
    }))
    renderPage()
    expect(await screen.findByRole('button', { name: 'Approve egress review' })).toBeInTheDocument()
  })
})
