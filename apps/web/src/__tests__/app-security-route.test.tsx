import { render, screen } from '@testing-library/react'
import { Outlet } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ currentUser: { id: 'user-1' }, isLoading: false }),
}))
vi.mock('../contexts/SpaceContext', () => ({
  SpaceProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../core/Shell', () => ({
  default: () => <><nav aria-label="Global navigation" /><Outlet /></>,
}))
vi.mock('../pages/SecurityPage', () => ({
  default: () => <h1>Account security</h1>,
}))

import App from '../App'

describe('Security route', () => {
  beforeEach(() => window.history.replaceState(null, '', '/settings/security'))

  it('renders the authenticated Security page inside the app shell', () => {
    render(<App />)

    expect(screen.getByRole('navigation', { name: 'Global navigation' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Account security' })).toBeInTheDocument()
  })
})
