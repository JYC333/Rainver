import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import SpaceSettingsPage from '../SpaceSettingsPage'
import { spaceEgressApi, spacesApi } from '../../../api/client'

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

describe('SpaceSettingsPage snapshot defaults', () => {
  it('saves both defaults once they have been read', async () => {
    vi.mocked(spacesApi.getSnapshotDefaults).mockResolvedValue({
      snapshot_retention_days_default: 14,
      snapshot_max_count_default: 50,
    })
    vi.mocked(spacesApi.updateSnapshotDefaults).mockResolvedValue({
      snapshot_retention_days_default: 30,
      snapshot_max_count_default: 50,
    })
    render(<SpaceSettingsPage />)

    const save = screen.getByRole('button', { name: 'Save defaults' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.change(screen.getByPlaceholderText('7'), { target: { value: '30' } })
    fireEvent.click(save)

    await waitFor(() => expect(spacesApi.updateSnapshotDefaults).toHaveBeenCalledWith('space-1', {
      snapshot_retention_days_default: 30,
      snapshot_max_count_default: 50,
    }))
  })

  it('reports a failed read and does not offer to save over unread defaults', async () => {
    vi.mocked(spacesApi.getSnapshotDefaults).mockRejectedValue(new Error('502 Bad Gateway'))
    render(<SpaceSettingsPage />)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('502 Bad Gateway'))
    const save = screen.getByRole('button', { name: 'Save defaults' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(spacesApi.updateSnapshotDefaults).not.toHaveBeenCalled()
  })
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
