import { render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { SpaceProvider } from './SpaceContext'

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'user-1', default_space_id: 'personal-1' } }),
}))

vi.mock('../api/client', () => ({
  authApi: { mySpaces: vi.fn(async () => [{ id: 'personal-1', type: 'personal', role: 'owner' }]) },
  setSpaceContext: vi.fn(),
}))

function Location() {
  return <output>{useLocation().pathname}</output>
}

it('leaves an unavailable Space for a Space the person belongs to', async () => {
  render(
    <MemoryRouter initialEntries={['/spaces/removed/tasks']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <SpaceProvider><Location /></SpaceProvider>
    </MemoryRouter>,
  )

  expect(await screen.findByText('/spaces/personal-1/today')).toBeVisible()
})
