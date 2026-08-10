import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'u1', display_name: 'Ada', email: 'a@x', avatar_url: null, default_space_id: 'personal-1', created_at: '', last_login_at: null }, logout: vi.fn() }),
}))
vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [{ id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', created_at: '', updated_at: '' }],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'personal-1',
    activeSpaceName: 'My Personal',
    preferredSpaceId: 'personal-1',
  }),
}))

import Shell from '../core/Shell'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

describe('Shell scene sidebar collapse', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // Uses the Agents scene: Knowledge intentionally has no scene sidebar (it switches
  // sections via an in-header breadcrumb), so this generic collapse behaviour is
  // exercised against a module that still owns a scene.
  it('shows a visible expand handle in the header when the scene sidebar is collapsed', () => {
    localStorage.setItem('agent-space:scene-collapsed', JSON.stringify({ agents: true }))
    render(<MemoryRouter initialEntries={['/spaces/personal-1/agents']} future={routerFuture}><Shell /></MemoryRouter>)

    // Expand handle visible in the header, labelled with the scene title (e.g. "☰ Agents").
    const handle = screen.getByRole('button', { name: 'Show sidebar' })
    expect(handle).toBeInTheDocument()
    expect(handle).toHaveTextContent('Agents')

    // The full sidebar is collapsed (not rendered).
    expect(screen.queryByLabelText('Agents navigation')).toBeNull()
  })

  it('renders the scene sidebar when not collapsed', () => {
    render(<MemoryRouter initialEntries={['/spaces/personal-1/agents']} future={routerFuture}><Shell /></MemoryRouter>)
    expect(screen.getByLabelText('Agents navigation')).toBeInTheDocument()
  })

  it('renders Library item type routes and digests in the scene sidebar', () => {
    render(<MemoryRouter initialEntries={['/spaces/personal-1/library/items/pdfs']} future={routerFuture}><Shell /></MemoryRouter>)

    const sidebar = screen.getByLabelText('Library navigation')
    expect(within(sidebar).getByRole('link', { name: 'All Items' })).toHaveAttribute('href', '/spaces/personal-1/library/items')
    expect(within(sidebar).getByRole('link', { name: 'Articles' })).toHaveAttribute('href', '/spaces/personal-1/library/items/articles')
    expect(within(sidebar).getByRole('link', { name: 'Podcasts' })).toHaveAttribute('href', '/spaces/personal-1/library/items/podcasts')
    const pdfsLink = within(sidebar).getByRole('link', { name: 'PDFs' })
    expect(pdfsLink).toHaveAttribute('href', '/spaces/personal-1/library/items/pdfs')
    expect(pdfsLink).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).getByRole('link', { name: 'Digests' })).toHaveAttribute('href', '/spaces/personal-1/library/digests')
  })
})
