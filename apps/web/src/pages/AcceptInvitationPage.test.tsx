import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AcceptInvitationPage from './AcceptInvitationPage'
import { setLocale } from '../i18n'

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: null, isLoading: false, reloadUser: vi.fn() }),
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ reloadSpaces: vi.fn() }),
}))

vi.mock('../hooks/useAuthConfiguration', async importOriginal => ({
  ...(await importOriginal<typeof import('../hooks/useAuthConfiguration')>()),
  useAuthConfiguration: () => ({
    google_auth_available: false,
    password_min_length: 12,
    password_max_length: 128,
  }),
}))

describe('AcceptInvitationPage', () => {
  beforeEach(() => {
    setLocale('en')
    window.history.replaceState(null, '', '/')
  })

  it('erases the claim token from the URL and translates without changing that boundary', async () => {
    window.history.replaceState(null, '', '/invitations/claim#token=invite-secret')
    render(
      <MemoryRouter initialEntries={['/invitations/claim']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AcceptInvitationPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(screen.getByText('Join Rainver')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '简体中文' }))
    await waitFor(() => expect(screen.getByText('加入 Rainver')).toBeInTheDocument())
    expect(window.location.hash).toBe('')
  })
})
