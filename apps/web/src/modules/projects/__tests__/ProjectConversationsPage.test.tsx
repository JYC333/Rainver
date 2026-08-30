import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectConversationsPage from '../ProjectConversationsPage'
import { ambientSessionsApi, projectsApi, roomsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
const navigated: string[] = []
vi.mock('../../../core/spaceNav', async () => {
  const actual = await vi.importActual<typeof import('../../../core/spaceNav')>('../../../core/spaceNav')
  return { ...actual, useSpaceNavigate: () => (to: string) => { navigated.push(to) } }
})
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', activeSpaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../../../api/client', () => ({
  projectsApi: { conversations: vi.fn(), mainlineRoom: vi.fn(), readers: vi.fn() },
  roomsApi: { create: vi.fn(), inviteUser: vi.fn() },
  spacesApi: { members: vi.fn() },
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
  navigated.length = 0
  vi.mocked(ambientSessionsApi.listForProject).mockResolvedValue({ sessions: [] } as never)
  vi.mocked(ambientSessionsApi.pendingExtraction).mockResolvedValue({ records: 0, sessions: 0 } as never)
  vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
    room: { id: 'room-main', is_mainline: true }, joined: false, viewer_can_write: true,
  } as never)
  // The picker's candidates are the Project's readers, not the Space's
  // members: the server refuses to invite anyone who cannot read the Project.
  vi.mocked(projectsApi.readers).mockResolvedValue({
    readers: [{ user_id: 'user-2', display_name: 'Alice', email: 'a@x', avatar_url: null }],
  } as never)
  vi.mocked(projectsApi.conversations).mockResolvedValue({
    items: [
      { id: 'conv-main', room_id: 'room-main', room_title: 'Daily', room_is_mainline: true,
        room_other_member_names: ['Alice'], room_agent_count: 1, title: 'Main thread',
        created_at: '2026-08-27T08:00:00.000Z', last_message_at: '2026-08-27T09:00:00.000Z',
        last_message_role: 'assistant', last_message_preview: 'The summary is drafted.', message_count: 4 },
      { id: 'conv-tax', room_id: 'room-tax', room_title: 'Tax season', room_is_mainline: false,
        room_other_member_names: ['Bob', 'Carol'], room_agent_count: 2, title: null,
        created_at: '2026-08-26T08:00:00.000Z', last_message_at: null,
        last_message_role: null, last_message_preview: null, message_count: 0 },
    ],
    total: 2, limit: 100, offset: 0, viewer_can_write: true,
  } as never)
})

describe('Project conversations', () => {
  it('names a limited group by its audience, and the Project\'s own conversations not at all', async () => {
    renderPage()
    expect(await screen.findByText('Main thread')).toBeInTheDocument()
    expect(screen.getByText(/The summary is drafted/)).toBeInTheDocument()
    expect(screen.getByText('Untitled conversation')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-conv-main'))
      .toHaveAttribute('href', '/spaces/space-1/projects/project-1/rooms?room=room-main&conversation=conv-main')

    // The Project's own conversations lead with no heading; the limited group
    // is titled by who is in it, and the word "Room" never appears.
    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headings).toEqual(['With Bob and Carol · 2 agents'])
    expect(screen.queryByText(/\bRoom\b/)).not.toBeInTheDocument()
    // Its title is not what names it — the roster is.
    expect(screen.queryByText('Tax season')).not.toBeInTheDocument()
  })

  it('renders a Project with only its own conversations as a plain list', async () => {
    vi.mocked(projectsApi.conversations).mockResolvedValue({
      items: [
        { id: 'conv-main', room_id: 'room-main', room_title: 'Daily', room_is_mainline: true,
          room_other_member_names: [], room_agent_count: 1, title: 'Main thread',
          created_at: '2026-08-27T08:00:00.000Z', last_message_at: null,
          last_message_role: null, last_message_preview: null, message_count: 0 },
      ],
      total: 1, limit: 100, offset: 0, viewer_can_write: true,
    } as never)
    renderPage()
    expect(await screen.findByText('Main thread')).toBeInTheDocument()
    // No section heading at all: the layer is invisible until a visibility
    // decision has been made (ADR 0018 decision 2).
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0)
  })

  it('offers exactly the two answers to "who should see this"', async () => {
    const user = userEvent.setup({ delay: null })
    renderPage()
    await user.click(await screen.findByRole('button', { name: /New conversation/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'In this Project' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'With a limited group…' })).toBeInTheDocument()
  })

  it('lets a reader start a conversation but not open a limited group', async () => {
    // Speaking in the Project is Room membership, which every reader gets on
    // first open; opening a limited Room asserts writer authority, because
    // creating a Room does. Gating both on write locked viewers out of the
    // panel whose whole purpose is asking the Project's Assistant something.
    const user = userEvent.setup({ delay: null })
    vi.mocked(projectsApi.conversations).mockResolvedValue({
      items: [], empty_rooms: [], total: 0, limit: 100, offset: 0, viewer_can_write: false,
    } as never)
    renderPage()
    await user.click(await screen.findByRole('button', { name: /New conversation/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'In this Project' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'With a limited group…' })).not.toBeInTheDocument()
  })

  it('creates the Room when the audience is chosen, and lands in it with no conversation', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(roomsApi.create).mockResolvedValue({ room: { id: 'room-new' } } as never)
    vi.mocked(roomsApi.inviteUser).mockResolvedValue({} as never)
    renderPage()
    await user.click(await screen.findByRole('button', { name: /New conversation/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'With a limited group…' }))
    expect(await screen.findByText('Who can see this?')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('People who can see this'))
    fireEvent.click(await screen.findByText('Alice'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(roomsApi.create).toHaveBeenCalledWith(
      { project_id: 'project-1', title: 'Limited group' },
      expect.any(String),
    ))
    await waitFor(() => expect(roomsApi.inviteUser).toHaveBeenCalledWith('room-new', {
      user_id: 'user-2', confirm_owned_private_agent_shares: false,
    }))
    // The Room exists and no conversation was created with it, because sending
    // is what creates one (ADR 0018 decision 5) — and the reader lands in that
    // Room's composer, not in some other conversation.
    await waitFor(() => expect(navigated).toContain('/projects/project-1/rooms?room=room-new&new=1'))
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

it('lists a limited Room nobody has spoken in, with a way back to its roster', async () => {
  // A Room with no conversation is invisible to a list of conversations,
  // and it is only reachable through one — so the list carries such Rooms
  // separately, named by their audience, or opening one and leaving would
  // have left it with no way back.
  vi.mocked(projectsApi.conversations).mockResolvedValue({
    items: [],
    empty_rooms: [{ room_id: 'room-9', room_is_mainline: false, room_other_member_names: ['Bob'], room_agent_count: 1 }],
    total: 0, limit: 100, offset: 0, viewer_can_write: true,
  } as never)
  renderPage()
  expect(await screen.findByText('With Bob · 1 agent')).toBeInTheDocument()
  expect(screen.getByText('Nothing said yet — start the conversation.')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Manage who can see this group' }))
    .toHaveAttribute('href', expect.stringContaining('/projects/project-1/rooms?room=room-9'))
})
