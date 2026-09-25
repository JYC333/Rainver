import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { configuration, completeRegistration, completeGoogleReauth, acceptInvitation, reloadSpaces, accounts, sessions, reauthStatus, reauth, authState } = vi.hoisted(() => ({
  configuration: vi.fn(),
  completeRegistration: vi.fn(),
  completeGoogleReauth: vi.fn(),
  acceptInvitation: vi.fn(),
  reloadSpaces: vi.fn(),
  accounts: vi.fn(),
  sessions: vi.fn(),
  reauthStatus: vi.fn(),
  reauth: vi.fn(),
  authState: { currentUser: null as null | { id: string; email: string } },
}))

vi.mock('../api/client', () => ({
  authApi: {
    configuration,
    completeRegistration,
    completeGoogleReauth,
    accounts,
    sessions,
    reauthStatus,
    reauth,
  },
  spacesApi: { acceptInvitation },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentUser: authState.currentUser,
    isLoading: false,
    reloadUser: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ reloadSpaces }),
}))

import LoginPage from '../pages/LoginPage'
import SecurityPage from '../pages/SecurityPage'
import AcceptInvitationPage from '../pages/AcceptInvitationPage'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

describe('authentication callback pages', () => {
  beforeEach(() => {
    configuration.mockReset().mockResolvedValue({ google_auth_available: false, bootstrap_registration_available: false, password_min_length: 8, password_max_length: 128 })
    completeRegistration.mockReset()
    completeGoogleReauth.mockReset()
    acceptInvitation.mockReset()
    reloadSpaces.mockReset().mockResolvedValue(undefined)
    accounts.mockReset().mockResolvedValue([{ id: 'credential-1', provider: 'credential' }])
    sessions.mockReset().mockResolvedValue([])
    reauthStatus.mockReset().mockResolvedValue({ expires_at: null })
    reauth.mockReset().mockResolvedValue({ ok: true, expires_in: 600 })
    authState.currentUser = null
    window.history.replaceState(null, '', '/')
  })

  it('consumes a failed Google registration callback only once and removes it from the URL', async () => {
    completeRegistration.mockRejectedValue(new Error('completion failed'))
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/login?registration=intent-1']} future={routerFuture}>
          <LoginPage />
          <LocationProbe />
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText('Google registration could not be completed. Please retry from the invitation.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('registration='))
    expect(completeRegistration).toHaveBeenCalledTimes(1)
  })

  it('shows administrator setup only while bootstrap registration is available', async () => {
    configuration.mockResolvedValue({ google_auth_available: false, bootstrap_registration_available: true, password_min_length: 8, password_max_length: 128 })
    render(
      <MemoryRouter future={routerFuture}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Set up administrator account' })).toBeInTheDocument()
    expect(screen.queryByText(/HttpOnly cookie/i)).not.toBeInTheDocument()
  })

  it('hides administrator setup after bootstrap registration closes', async () => {
    render(
      <MemoryRouter future={routerFuture}>
        <LoginPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(configuration).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Set up administrator account' })).not.toBeInTheDocument()
    expect(screen.queryByText(/HttpOnly cookie/i)).not.toBeInTheDocument()
  })

  it('consumes a failed Google reauthentication callback only once and removes it from the URL', async () => {
    completeGoogleReauth.mockRejectedValue(new Error('reauth failed'))
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/settings/security?google_reauth=1']} future={routerFuture}>
          <SecurityPage />
          <LocationProbe />
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText('Google reauthentication failed.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('google_reauth='))
    expect(completeGoogleReauth).toHaveBeenCalledTimes(1)
  })

  it('reveals security settings after a successful Google reauthentication callback', async () => {
    completeGoogleReauth.mockResolvedValue({ ok: true, expires_in: 600 })
    reauthStatus.mockResolvedValue({ expires_at: new Date(Date.now() + 600_000).toISOString() })
    accounts.mockResolvedValue([{ id: 'google-1', provider: 'google' }])
    render(
      <MemoryRouter initialEntries={['/settings/security?google_reauth=1']} future={routerFuture}>
        <SecurityPage />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Login methods')).toBeInTheDocument()
    expect(completeGoogleReauth).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('location')).not.toHaveTextContent('google_reauth=')
  })

  it('hides security actions until password verification succeeds', async () => {
    reauthStatus.mockResolvedValueOnce({ expires_at: null }).mockResolvedValue({ expires_at: new Date(Date.now() + 600_000).toISOString() })
    render(<MemoryRouter future={routerFuture}><SecurityPage /></MemoryRouter>)

    expect(await screen.findByText(/First verify your identity to unlock/i)).toBeInTheDocument()
    expect(screen.queryByText('Login methods')).not.toBeInTheDocument()
    expect(screen.queryByText('Active sessions')).not.toBeInTheDocument()
    expect(sessions).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'current-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Login methods')).toBeInTheDocument()
    expect(screen.getByText('Active sessions')).toBeInTheDocument()
    expect(reauth).toHaveBeenCalledWith('current-password')
  })

  it('restores a still-valid reauthentication grant', async () => {
    reauthStatus.mockResolvedValue({ expires_at: new Date(Date.now() + 600_000).toISOString() })
    render(<MemoryRouter future={routerFuture}><SecurityPage /></MemoryRouter>)
    expect(await screen.findByText('Login methods')).toBeInTheDocument()
  })

  it('offers Google verification without requiring a password from Google-only accounts', async () => {
    accounts.mockResolvedValue([{ id: 'google-1', provider: 'google' }])
    configuration.mockResolvedValue({ google_auth_available: true, bootstrap_registration_available: false, password_min_length: 8, password_max_length: 128 })
    render(<MemoryRouter future={routerFuture}><SecurityPage /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Verify with Google' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('lets an existing signed-in account accept the fragment invitation and refresh its Spaces', async () => {
    authState.currentUser = { id: 'user-1', email: 'invitee@example.test' }
    acceptInvitation.mockResolvedValue({ space_id: 'team-1' })
    window.history.replaceState(null, '', '/invitations/claim#token=raw-invite')
    render(
      <MemoryRouter initialEntries={['/invitations/claim']} future={routerFuture}>
        <AcceptInvitationPage />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Join Space' })).toBeEnabled()
    expect(window.location.hash).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Join Space' }))
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('raw-invite'))
    await waitFor(() => expect(reloadSpaces).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/spaces/team-1/today'))
  })

  it('tells an existing signed-out account to sign in and reopen the link without storing the token', async () => {
    window.history.replaceState(null, '', '/invitations/claim#token=raw-invite')
    render(<MemoryRouter future={routerFuture}><AcceptInvitationPage /></MemoryRouter>)

    expect(await screen.findByText('Already have an account? Sign in first, then reopen this invitation link.')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(window.sessionStorage.length).toBe(0)
  })
})
