import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalContextPanel } from '../PersonalContextPanel'
import { personalMemoryGrantsApi } from '../../../api/client'
import type { Run, SpaceWithMembership } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  personalMemoryGrantsApi: {
    listPersonalMemoryGrants: vi.fn(),
    previewPersonalMemoryGrant: vi.fn(),
    createPersonalMemoryGrant: vi.fn(),
    revokePersonalMemoryGrant: vi.fn(),
    getPersonalMemoryGrantAudit: vi.fn(),
  },
}))

const run = {
  id: 'run-1', space_id: 'team-1', status: 'running', instructed_by_user_id: 'user-1',
} as unknown as Run
const spaces = [{ id: 'team-1', name: 'Team', type: 'team', role: 'member' }] as unknown as SpaceWithMembership[]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(personalMemoryGrantsApi.listPersonalMemoryGrants).mockResolvedValue([])
  vi.mocked(personalMemoryGrantsApi.previewPersonalMemoryGrant).mockResolvedValue({
    eligible: true, access_mode: 'summary_only', target_run_id: 'run-1', target_space_id: 'team-1',
    proposed_read_expires_at: '2026-10-03T11:00:00.000Z', max_items: 20, excluded_sensitivity_levels: [], warnings: [],
  } as never)
})

// The preview is what the person reads before pressing Allow; a grant must
// not be created with parameters the preview never showed.
describe('PersonalContextPanel preview', () => {
  it('withdraws the preview, and Allow with it, when the parameters change afterwards', async () => {
    render(<PersonalContextPanel run={run} currentUserId="user-1" personalSpaceId="personal-1" spaces={spaces} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Preview personal context attachment' }))
    expect(await screen.findByRole('button', { name: 'Allow personal context for this run' })).toBeInTheDocument()

    // Max items is the first of the two number fields.
    fireEvent.change(screen.getAllByRole('spinbutton')[0]!, { target: { value: '5' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow personal context for this run' })).not.toBeInTheDocument())
    expect(personalMemoryGrantsApi.createPersonalMemoryGrant).not.toHaveBeenCalled()
  })
})
