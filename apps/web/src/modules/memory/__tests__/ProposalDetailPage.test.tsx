import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal } from '../../../types/api'

const mocked = vi.hoisted(() => ({ get: vi.fn(), memoryGet: vi.fn(), reviseProposal: vi.fn() }))

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
  memoryApi: { get: mocked.memoryGet, reviseProposal: mocked.reviseProposal },
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

  it('holds a maintenance update until its revision is written, starting from the current text', async () => {
    const pendingRevision = proposal({
      proposal_type: 'memory_update',
      target_memory_id: 'memory-1',
      operator_revision: { edited_by_user_id: null, edited_at: null },
    })
    mocked.get.mockResolvedValue(pendingRevision)
    mocked.memoryGet.mockResolvedValue({ id: 'memory-1', content: 'The office opens at 9.' })
    mocked.reviseProposal.mockResolvedValue({
      ...pendingRevision,
      proposed_content: 'The office opens at 8.',
      operator_revision: { edited_by_user_id: 'user-owner', edited_at: '2026-10-14T10:00:00Z' },
    })
    renderPage()

    expect(await screen.findByRole('button', { name: 'Accept' })).toBeDisabled()
    const editor = screen.getByLabelText('Revised memory content')
    await waitFor(() => expect(editor).toHaveValue('The office opens at 9.'))
    fireEvent.change(editor, { target: { value: 'The office opens at 8.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled())
    expect(mocked.reviseProposal).toHaveBeenCalledWith('proposal-1', { content: 'The office opens at 8.' })
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
