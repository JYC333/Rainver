import { beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), agentAttentionApi: { stream: vi.fn(), snapshot: vi.fn(), list: vi.fn() } }))
import { agentAttentionApi } from '../api/client'
import type { AgentAttentionStreamFrame } from '@rainver/protocol'
import Shell from '../core/Shell'

beforeEach(() => {
  vi.mocked(agentAttentionApi.stream).mockClear().mockImplementation(async (_sink, options) => {
    await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
  })
})

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

describe('Shell scene sidebar collapse', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // Uses the Agents scene: Knowledge intentionally has no scene sidebar (it switches
  // sections via an in-header breadcrumb), so this generic collapse behaviour is
  // exercised against a module that still owns a scene.
  it('shows a visible expand handle in the header when the scene sidebar is collapsed', () => {
    localStorage.setItem('rainver:scene-collapsed', JSON.stringify({ agents: true }))
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

describe('Shell mobile tab bar', () => {
  it('lists Home, Agent Work, Projects and More with secondary destinations in More', () => {
    render(<MemoryRouter initialEntries={['/home']} future={routerFuture}><Shell /></MemoryRouter>)

    const tabs = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(tabs).getByRole('link', { name: 'Home' })).toBeInTheDocument()
    expect(within(tabs).getByRole('link', { name: /Agent Work/ })).toBeInTheDocument()
    expect(within(tabs).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/spaces/personal-1/projects')
    fireEvent.click(within(tabs).getByRole('button', { name: 'More' }))
    const more = screen.getByRole('dialog')
    for (const name of ['Inbox', 'Library', 'Review', 'Tasks', 'Command Center']) {
      expect(within(more).getByRole('link', { name })).toBeInTheDocument()
    }
    expect(within(tabs).queryByRole('link', { name: 'Command Center' })).toBeNull()
  })
})


it('keeps one account aggregate stream across navigation and updates the Agent Work rail badge', () => {
  render(<MemoryRouter initialEntries={['/home']} future={routerFuture}><Shell /></MemoryRouter>)
  const callback = vi.mocked(agentAttentionApi.stream).mock.calls[0]![0]
  const frame: AgentAttentionStreamFrame = { type: 'attention.snapshot', seq: 1, version: 'source-revision', unread_count: 42, notices: [], page: {
    items: [], next_cursor: null, counts: { needs_you: 3, recently_finished: 0, working: 0, waiting: 0, idle: 0 }, as_of: '2026-10-21T00:00:00Z',
  } }
  act(() => callback(frame))
  const link = within(screen.getByRole('navigation', { name: 'Global navigation' })).getByRole('link', { name: /Agent Work/ })
  const mobileLink = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: /Agent Work/ })
  expect(within(mobileLink).getByRole('status', { name: /3 need you.*42 unread/ })).toBeEmptyDOMElement()
  expect(within(link).getByRole('status', { name: /3 need you.*42 unread/ })).toBeVisible()
  fireEvent.click(link)
  expect(agentAttentionApi.stream).toHaveBeenCalledTimes(1)
})
