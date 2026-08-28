import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectConversationsPage from '../ProjectConversationsPage'
import { ambientSessionsApi, projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }) }))
vi.mock('../../../api/client', () => ({
  projectsApi: { conversations: vi.fn() },
  ambientSessionsApi: { listForProject: vi.fn(), pendingExtraction: vi.fn(), extract: vi.fn() },
}))

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
  vi.mocked(ambientSessionsApi.listForProject).mockResolvedValue({ sessions: [] } as never)
  vi.mocked(ambientSessionsApi.pendingExtraction).mockResolvedValue({ records: 0, sessions: 0 } as never)
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

it('lists an imported CLI session beside the Project\'s own conversations, marked read-only', async () => {
  vi.mocked(ambientSessionsApi.listForProject).mockResolvedValue({
    sessions: [{
      id: 'imported-1', project_id: 'project-1', workspace_location_id: 'loc-1', execution_host_id: 'host-1',
      owner_user_id: 'user-1', adapter_type: 'claude_code', installation: 'own', vendor_session_id: 'sess-1',
      cwd: '/home/me/project', title: 'Branch review', visibility: 'space_shared', source_state: 'present',
      load_state: 'complete', last_error: null, record_count: 12, first_record_at: null,
      last_record_at: '2026-08-27T10:00:00.000Z', vendor_updated_at: null, last_synced_at: null,
      created_at: '2026-08-27T10:00:00.000Z', updated_at: '2026-08-27T10:00:00.000Z',
    }],
  } as never)
  renderPage()
  expect(await screen.findByText('Branch review')).toBeInTheDocument()
  // The marker is on the row, not only on the page it opens: the whole risk of
  // showing these beside real conversations is someone expecting to reply.
  expect(screen.getByText('Read-only')).toBeInTheDocument()
})

it('still shows the empty state when neither source has anything', async () => {
  vi.mocked(projectsApi.conversations).mockResolvedValue({
    items: [], total: 0, limit: 100, offset: 0, viewer_can_write: true,
  } as never)
  renderPage()
  expect(await screen.findByText('No conversations yet')).toBeInTheDocument()
})

it("offers extraction only when there is unread imported history to read", async () => {
  // The button spends model budget, so it says how much work it would do and
  // is absent when there is none.
  vi.mocked(ambientSessionsApi.pendingExtraction).mockResolvedValue({ records: 7, sessions: 2 } as never)
  renderPage()
  expect(await screen.findByRole('button', { name: /Extract to Brief \(7 new records\)/ })).toBeInTheDocument()
})
