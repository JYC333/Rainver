import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from './LoginPage'
import { setLocale } from '../i18n'

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: null, isLoading: false, reloadUser: vi.fn() }),
}))

vi.mock('../hooks/useAuthConfiguration', () => ({
  useAuthConfiguration: () => ({
    google_auth_available: false,
    bootstrap_registration_available: false,
  }),
}))

describe('LoginPage language choice', () => {
  beforeEach(() => setLocale('en'))

  it('starts in English and switches the public login page to Chinese', async () => {
    render(<MemoryRouter initialEntries={['/login']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}><LoginPage /></MemoryRouter>)

    expect(screen.getByText('Sign in to continue')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '简体中文' }))

    await waitFor(() => expect(screen.getByText('登录以继续')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('邮箱')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '简体中文' })).toHaveAttribute('aria-pressed', 'true')
  })
})
