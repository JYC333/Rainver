import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const navigateMock = vi.fn()
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [
      { id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', created_at: '', updated_at: '' },
      { id: 'team-1', name: 'Acme Team', type: 'team', role: 'member', created_at: '', updated_at: '' },
    ],
    activeSpaceId: 'personal-1',
    preferredSpaceId: 'personal-1',
  }),
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'u1', display_name: 'U', email: 'u@x', avatar_url: null, default_space_id: 'personal-1', created_at: '', last_login_at: null } }),
}))

import { SpaceSwitcher } from '../components/SpaceSwitcher'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function open() {
  render(<MemoryRouter future={routerFuture}><SpaceSwitcher /></MemoryRouter>)
  fireEvent.click(screen.getByLabelText('Switch space'))
}

describe('SpaceSwitcher', () => {
  beforeEach(() => { navigateMock.mockClear() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('lists only real spaces — never Home/PersonalView/aggregate', () => {
    open()
    // Both real spaces appear as menu entries (the active one also shows in the toggle).
    expect(screen.getAllByText('My Personal').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Acme Team/ })).toBeInTheDocument()
    expect(screen.queryByText(/aggregated/i)).toBeNull()
    expect(screen.queryByText(/my view/i)).toBeNull()
    expect(screen.queryByText(/personalview/i)).toBeNull()
    // No menu entry literally labelled "Home" (Home is not a Space).
    expect(screen.queryByText(/^Home$/)).toBeNull()
  })

  it('keeps the menu inside the viewport on narrow and resized screens', () => {
    let anchorLeft = 18
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      left: anchorLeft,
    }) as DOMRect)
    vi.stubGlobal('innerWidth', 289)
    open()

    const menu = screen.getByText('Spaces').parentElement!.parentElement!
    function expectMenuFits() {
      const left = anchorLeft + parseFloat(menu.style.left)
      const right = left + parseFloat(menu.style.width)
      expect(left).toBeGreaterThanOrEqual(16)
      expect(right).toBeLessThanOrEqual(window.innerWidth - 16)
    }
    expectMenuFits()

    anchorLeft = 140
    vi.stubGlobal('innerWidth', 400)
    fireEvent(window, new Event('resize'))
    expectMenuFits()
  })

  it('activates the chosen space by navigating to its URL-scoped Today page', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Acme Team/ }))
    expect(navigateMock).toHaveBeenCalledWith('/spaces/team-1/today')
  })
})
