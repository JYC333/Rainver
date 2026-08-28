import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectConversationsPage from '../ProjectConversationsPage'
import { projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }) }))
vi.mock('../../../api/client', () => ({ projectsApi: { conversations: vi.fn() } }))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/conversations']}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/conversations" element={<ProjectConversationsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.conversations).mockResolvedValue({
    items: [
      { id: 'conv-main', room_id: 'room-main', room_title: 'Daily', room_is_mainline: true, title: 'Main thread',
        created_at: '2026-08-27T08:00:00.000Z', last_message_at: '2026-08-27T09:00:00.000Z',
        last_message_role: 'assistant', last_message_preview: 'The summary is drafted.', message_count: 4 },
      { id: 'conv-tax', room_id: 'room-tax', room_title: 'Tax season', room_is_mainline: false, title: null,
        created_at: '2026-08-26T08:00:00.000Z', last_message_at: null,
        last_message_role: null, last_message_preview: null, message_count: 0 },
    ],
    total: 2, limit: 100, offset: 0, viewer_can_write: true,
  } as never)
})

describe('Project conversations', () => {
  it('lists every conversation across Rooms, mainline first, each opening in its Room', async () => {
    renderPage()
    expect(await screen.findByText('Main thread')).toBeInTheDocument()
    expect(screen.getByText(/The summary is drafted/)).toBeInTheDocument()
    // A topic Room's conversation says which Room it is in; the mainline does
    // not need to.
    expect(screen.getByText('Tax season')).toBeInTheDocument()
    expect(screen.getByText('Untitled conversation')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-conv-main'))
      .toHaveAttribute('href', '/projects/project-1/rooms?room=room-main&conversation=conv-main')
    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headings).toEqual(['Mainline', 'Topic Rooms'])
  })

  it('offers a new topic Room only to a writer', async () => {
    vi.mocked(projectsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0, viewer_can_write: false } as never)
    renderPage()
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /New topic Room/ })).not.toBeInTheDocument()
  })
})
