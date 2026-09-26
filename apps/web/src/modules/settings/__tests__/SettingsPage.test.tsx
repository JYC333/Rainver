import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../SettingsPage'
import { spacesApi } from '../../../api/client'
import { setLocale } from '../../../i18n'

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
  setLocale('en')
  vi.clearAllMocks()
  vi.mocked(spacesApi.create).mockResolvedValue({
    id: 'space-new',
    name: 'My Team',
    type: 'team',
    role: 'owner',
    member_count: 1,
    oversight_mode: 'none',
    egress_notifications_enabled: true,
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  })
})

describe('SettingsPage — create space', () => {
  it('switches the interface to Chinese and remembers the browser language', async () => {
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: '简体中文' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '简体中文' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem('rainver:locale')).toBe('zh-CN')
  })

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
