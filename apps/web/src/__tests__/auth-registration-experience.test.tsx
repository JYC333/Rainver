import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  authApi: {
    configuration: vi.fn().mockResolvedValue({
      google_auth_available: false,
      bootstrap_registration_available: true,
      password_min_length: 8,
      password_max_length: 128,
    }),
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentUser: null,
    isLoading: false,
    reloadUser: vi.fn().mockResolvedValue(undefined),
  }),
}))

import RegistrationPage from '../pages/RegistrationPage'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

describe('registration experience', () => {
  it('disables password registration until the server-advertised length is satisfied', async () => {
    render(
      <MemoryRouter future={routerFuture}>
        <RegistrationPage />
      </MemoryRouter>,
    )

    const password = await screen.findByPlaceholderText('Password (8–128 characters)')
    const email = screen.getByPlaceholderText('Email')
    const submit = screen.getByRole('button', { name: 'Create with password' })
    expect(password).not.toHaveAttribute('minlength')
    expect(password).not.toHaveAttribute('maxlength')
    expect(submit).toBeDisabled()

    fireEvent.change(email, { target: { value: 'owner@example.test' } })
    fireEvent.change(password, { target: { value: '1234567' } })
    expect(submit).toBeDisabled()

    fireEvent.change(password, { target: { value: '12345678' } })
    expect(submit).toBeEnabled()
    expect(submit).toHaveClass('cursor-pointer')
  })
})
