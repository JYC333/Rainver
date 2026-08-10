import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SpaceSettingsPage from '../SpaceSettingsPage'
import { spaceEgressApi } from '../../../api/client'

const reloadSpaces = vi.fn()
const space = {
  id: 'space-1',
  name: 'Team Space',
  type: 'team' as const,
  role: 'owner' as const,
  oversight_mode: 'none' as const,
  egress_notifications_enabled: true,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../../core/spaceNav', () => ({ SpaceLink: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { id: 'user-1' } }) }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Team Space',
    spaces: [space],
    reloadSpaces,
  }),
}))
vi.mock('../../../api/client', () => ({
  spacesApi: {
    members: vi.fn().mockResolvedValue([]),
    getSnapshotDefaults: vi.fn().mockResolvedValue({
      snapshot_retention_days_default: null,
      snapshot_max_count_default: null,
    }),
    updateSnapshotDefaults: vi.fn(),
    invite: vi.fn(),
  },
  spaceEgressApi: { updateNotifications: vi.fn() },
}))
vi.mock('../../runtime_tools/SpaceRuntimePolicyPanel', () => ({ SpaceRuntimePolicyPanel: () => null }))
vi.mock('../CustomSourceSpacePolicyPanel', () => ({ CustomSourceSpacePolicyPanel: () => null }))
vi.mock('../ObjectSchemaPanel', () => ({ ObjectSchemaPanel: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(spaceEgressApi.updateNotifications).mockResolvedValue({
    space_id: 'space-1',
    egress_notifications_enabled: false,
    updated_at: '2026-08-07T01:00:00.000Z',
  })
  reloadSpaces.mockResolvedValue(undefined)
})

describe('SpaceSettingsPage egress notification setting', () => {
  it('discloses pointer-only semantics and lets an admin change future notifications', async () => {
    render(<SpaceSettingsPage />)

    expect(screen.getByText(/conclusion text is never included/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disable notifications' }))

    await waitFor(() => expect(spaceEgressApi.updateNotifications).toHaveBeenCalledWith('space-1', false))
    await waitFor(() => expect(reloadSpaces).toHaveBeenCalled())
  })
})
