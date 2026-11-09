import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proposal } from '../../../types/api'

const mocked = vi.hoisted(() => ({ get: vi.fn(), accept: vi.fn(), memoryGet: vi.fn(), reviseProposal: vi.fn() }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', userId: 'user-owner' }),
}))
vi.mock('../../../core/spaceNav', async importOriginal => ({
  ...await importOriginal<typeof import('../../../core/spaceNav')>(),
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('../../../components/ContentAccessControl', () => ({ ContentAccessControl: () => null }))
vi.mock('../../../api/client', () => ({
  proposalsApi: { get: mocked.get, accept: mocked.accept, reject: vi.fn(), approveEgressGrantingUserProposal: vi.fn() },
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
      <Routes><Route path="/proposals/:proposalId" element={<ProposalDetailPage />} /><Route path="/spaces/:spaceId/proposals/:proposalId" element={<ProposalDetailPage />} /></Routes>
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

  it.each([false, true])('opens the saved maintenance revision, including a new frozen-review identity (%s)', async fresh => {
    const pendingRevision = proposal({
      proposal_type: 'memory_update',
      target_memory_id: 'memory-1',
      operator_revision: { edited_by_user_id: null, edited_at: null },
    })
    const revised = {...pendingRevision,id:fresh?"proposal-revised":pendingRevision.id,proposed_content:"The office opens at 8.",operator_revision:{edited_by_user_id:"user-owner",edited_at:"2026-10-14T10:00:00Z"}}
    mocked.get.mockImplementation(async id => id === "proposal-revised" ? revised : pendingRevision)
    mocked.memoryGet.mockResolvedValue({ id: 'memory-1', content: 'The office opens at 9.' })
    mocked.reviseProposal.mockResolvedValue(revised)
    renderPage()

    expect(await screen.findByRole('button', { name: 'Accept' })).toBeDisabled()
    const editor = screen.getByLabelText('Revised memory content')
    await waitFor(() => expect(editor).toHaveValue('The office opens at 9.'))
    fireEvent.change(editor, { target: { value: 'The office opens at 8.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled())
    expect(mocked.reviseProposal).toHaveBeenCalledWith('proposal-1', { content: 'The office opens at 8.' })
    if(fresh){
      await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('proposal-revised'))
      mocked.accept.mockResolvedValue({proposal:{...revised,status:'accepted'},result_type:'memory_entry',result:{}})
      fireEvent.click(screen.getByRole('button',{name:'Accept'}))
      await waitFor(()=>expect(mocked.accept).toHaveBeenCalledWith('proposal-revised',{}))
    }
  })

  it('links an accepted workflow save to the draft it created in Evolution', async () => {
    const pending = proposal({ proposal_type: 'workflow_save', risk_level: 'high', created_by_run_id: 'run-1' })
    mocked.get.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, status: 'accepted' })
    mocked.accept.mockResolvedValue({
      proposal: { ...pending, status: 'accepted' },
      result_type: 'evolvable_asset_version',
      result: { asset_id: 'asset-7', version_id: 'version-7', status: 'draft', asset_key: 'workflow.saved.x' },
    })
    renderPage()
    expect(screen.queryByRole('link', { name: 'Open in Evolution' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    const link = await screen.findByRole('link', { name: 'Open in Evolution' })
    expect(link).toHaveAttribute('href', '/evolution?asset=asset-7')
    expect(mocked.accept).toHaveBeenCalledWith('proposal-1', expect.anything())
  })

  it('keeps queued file decisions pending, reads the receipt and offers the existing Job destination', async () => {
    const pending = proposal({proposal_type:'code_patch'})
    const decision = {id:'decision-1',proposal_id:pending.id,phase:'apply' as const,status:'pending' as const,job_id:'job-1',error:null}
    mocked.get.mockResolvedValueOnce(pending).mockResolvedValue({...pending,code_patch_decision:decision})
    mocked.accept.mockResolvedValue({proposal:pending,result_type:'code_patch_pending',result:decision})
    renderPage()
    fireEvent.click(await screen.findByRole('button',{name:'Accept'}))
    expect(await screen.findByText('File execution is queued. The proposal remains pending.')).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:'Accept'})).not.toBeInTheDocument()
    expect(screen.getByRole('link',{name:'Open Job Queue'})).toHaveAttribute('href','/jobs')
    mocked.get.mockResolvedValue({...pending,status:'accepted',code_patch_decision:{...decision,status:'succeeded'}})
    fireEvent.click(screen.getByRole('button',{name:'Refresh decision'}))
    expect(await screen.findByText('File execution and the decision receipt are complete.')).toBeInTheDocument()
    expect(mocked.accept).toHaveBeenCalledTimes(1)
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
