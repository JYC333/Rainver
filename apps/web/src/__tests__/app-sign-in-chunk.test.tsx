import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The sign-in screen (and the worker's offline copy of it) must not need the
// signed-in app's chunk; the form starts loading it once someone signs in.
const signedInApp = vi.hoisted(() => ({ imports: 0 }))

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ currentUser: null, isLoading: false, reloadUser: async () => {}, logout: async () => {} }),
}))
vi.mock('../contexts/SpaceContext', () => ({
  SpaceProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../AuthenticatedApp', () => {
  signedInApp.imports += 1
  return { default: () => null }
})

import App from '../App'

describe('sign-in without the signed-in app', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    window.history.replaceState(null, '', '/')
  })

  it('redirects a signed-out visit to sign-in without importing the signed-in app, and starts it when the form is used', async () => {
    const { container } = render(<App />)

    await waitFor(() => expect(container.querySelector('input[type=password]')).not.toBeNull())
    expect(window.location.pathname).toBe('/login')
    expect(signedInApp.imports).toBe(0)

    fireEvent.focus(screen.getByPlaceholderText('Email'))
    await waitFor(() => expect(signedInApp.imports).toBe(1))
  })
})
