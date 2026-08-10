import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../SettingsPage'
import { spacesApi } from '../../../api/client'

const navigateMock = vi.fn()
const reloadSpacesMock = vi.fn()

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../core/spaceNav', () => ({
  useSpaceNavigate: () => navigateMock,
  SpaceLink: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { id: 'user-1', display_name: 'User One', email: 'u@example.test', avatar_url: null, default_space_id: 'space-1', created_at: '', last_login_at: null },
  }),
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ reloadSpaces: reloadSpacesMock }),
}))

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}))

vi.mock('../../../api/client', () => ({
  spacesApi: { create: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(spacesApi.create).mockResolvedValue({
    id: 'space-new',
    name: 'My Team',
    type: 'team',
    role: 'owner',
    oversight_mode: 'none',
    egress_notifications_enabled: true,
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  })
})

describe('SettingsPage — create space', () => {
  it('defaults to oversight_mode=none and creates a space without selecting an option', async () => {
    render(<SettingsPage />)

    fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'My Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create space' }))

    await waitFor(() => expect(spacesApi.create).toHaveBeenCalledWith({
      name: 'My Team',
      type: 'team',
      oversight_mode: 'none',
    }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/spaces/space-new/today'))
  })

  it('sends the selected oversight mode when creating a space', async () => {
    render(<SettingsPage />)

    fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'Watched Team' } })
    const oversightGroup = screen.getByRole('group', { name: 'Oversight mode' })
    fireEvent.click(within(oversightGroup).getByRole('button', { name: /^Content/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create space' }))

    await waitFor(() => expect(spacesApi.create).toHaveBeenCalledWith({
      name: 'Watched Team',
      type: 'team',
      oversight_mode: 'content',
    }))
  })
})
