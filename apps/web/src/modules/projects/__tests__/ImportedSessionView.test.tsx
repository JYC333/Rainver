import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ImportedSessionView from '../ImportedSessionView'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ambientSessionsApi, projectsApi, roomsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', activeSpaceId: 'space-1', userId: 'user-1' }),
}))
const navigated: string[] = []
vi.mock('../../../core/spaceNav', async () => {
  const actual = await vi.importActual<typeof import('../../../core/spaceNav')>('../../../core/spaceNav')
  return { ...actual, useSpaceNavigate: () => (to: string) => { navigated.push(to) } }
})
vi.mock('../../../api/client', () => ({
  ambientSessionsApi: { records: vi.fn() },
  projectsApi: { mainlineRoom: vi.fn() },
  roomsApi: { create: vi.fn() },
}))

const PROJECT = 'project-1'
const SESSION = 'imported-1'

function session(
  visibility: 'space_shared' | 'private' | 'selected_users',
  access_level: 'full' | 'summary' = 'full',
) {
  return {
    id: SESSION, project_id: PROJECT, adapter_type: 'claude_code', title: 'Branch review',
    cwd: '/home/me/project', visibility, access_level, source_state: 'present',
    load_state: 'complete', record_count: 2, last_record_at: '2026-08-29T10:00:00.000Z',
  }
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={[`/spaces/space-1/projects/${PROJECT}/imported-sessions/${SESSION}`]}>
      <Routes>
        <Route
          path="/spaces/:spaceId/projects/:projectId/imported-sessions/:sessionId"
          element={<ImportedSessionView />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  navigated.length = 0
  sessionStorage.clear()
  vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
    room: { id: 'room-main', is_mainline: true }, joined: false, viewer_can_write: true,
  } as never)
  vi.mocked(roomsApi.create).mockResolvedValue({ room: { id: 'room-personal' } } as never)
})

describe('Continuing from an imported session', () => {
  it('continues a shared session in the Project mainline', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session('space_shared'),
      records: [{ id: 'r1', kind: 'user_message', sequence: 0, text: 'Fix the parser', tool_name: null, tool_status: null, tool_input: null, tool_output: null, created_at: '' }],
      truncated: false,
    } as never)
    renderView()

    await user.click(await screen.findByRole('button', { name: /Continue in Rainver/ }))
    await waitFor(() => expect(navigated).toContain(`/projects/${PROJECT}/rooms?room=room-main&new=1&reference=1`))
    // No personal Room, and nothing created before the message: the seed is a
    // draft keyed by Room, and sending is what makes the conversation.
    expect(roomsApi.create).not.toHaveBeenCalled()
    // A reference, not a paragraph of seed text: what travels is a pick the
    // composer sends with the first message.
    expect(JSON.parse(sessionStorage.getItem('rainver.reference.room.room-main')!))
      .toEqual([{ kind: 'imported_session', id: SESSION }])
  })

  it('tells a reader why they cannot continue privately, instead of failing on the press', async () => {
    // Opening a personal Room needs write authority on the Project; reading
    // the mainline does not. Without this the owner of a private session who
    // can only read the Project would press the button and get a bare 403.
    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
      room: { id: 'room-main', is_mainline: true }, joined: false, viewer_can_write: false,
    } as never)
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session('private'), records: [], truncated: false,
    } as never)
    renderView()
    expect(await screen.findByText(/needs write access to the Project/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument()
  })

  it('still offers a shared session to a reader, which only reads the mainline', async () => {
    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
      room: { id: 'room-main', is_mainline: true }, joined: false, viewer_can_write: false,
    } as never)
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session('space_shared'), records: [], truncated: false,
    } as never)
    renderView()
    expect(await screen.findByRole('button', { name: /Continue in Rainver/ })).toBeInTheDocument()
  })

  it('continues a private session in the person\'s own Room, and is offered at all', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session('private'),
      records: [{ id: 'r1', kind: 'user_message', sequence: 0, text: 'My own notes', tool_name: null, tool_status: null, tool_input: null, tool_output: null, created_at: '' }],
      truncated: false,
    } as never)
    renderView()

    // The button used to be withheld for a private session, because the only
    // destination was the Project's channel. The destination now keeps the
    // boundary by construction, so nothing has to be refused.
    await user.click(await screen.findByRole('button', { name: /Continue privately/ }))
    await waitFor(() => expect(roomsApi.create).toHaveBeenCalledWith({
      project_id: PROJECT, title: 'Just me', personal: true,
    }))
    await waitFor(() => expect(navigated).toContain(`/projects/${PROJECT}/rooms?room=room-personal&new=1&reference=1`))
    expect(JSON.parse(sessionStorage.getItem('rainver.reference.room.room-personal')!))
      .toEqual([{ kind: 'imported_session', id: SESSION }])
    // The mainline was read for write authority, never used as a destination.
    expect(navigated.some(to => to.includes('room-main'))).toBe(false)
  })
  // Visibility has three values and two access levels, and only one
  // combination means "everyone in the mainline can already read all of it".
  // The other two used to route to the mainline, where the server refuses the
  // attach as an unconfirmed disclosure — and the dialog for that is Phase 3,
  // so the refusal would have surfaced as a toast that discards the message.
  it.each([
    ['selected_users', 'full'],
    ['space_shared', 'summary'],
  ] as const)('continues a %s/%s session privately, not in the mainline', async (visibility, level) => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session(visibility, level), records: [], truncated: false,
    } as never)
    renderView()

    await user.click(await screen.findByRole('button', { name: /Continue privately/ }))
    await waitFor(() => expect(roomsApi.create).toHaveBeenCalledWith({
      project_id: PROJECT, title: 'Just me', personal: true,
    }))
    expect(navigated.some(to => to.includes('room-main'))).toBe(false)
  })

  it('carries the records somebody picked, instead of the whole session', async () => {
    // Two grains, and the person chooses. A whole session can only travel as
    // a summary; a few records travel as themselves, which is what you want
    // when the transcript is long and three lines of it are the point.
    const user = userEvent.setup({ delay: null })
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session('space_shared'),
      records: [
        { id: 'r1', kind: 'user_message', sequence: 0, text: 'Fix the parser', tool_name: null, tool_status: null, tool_input: null, tool_output: null, created_at: '' },
        { id: 'r2', kind: 'agent_message', sequence: 1, text: 'Done', tool_name: null, tool_status: null, tool_input: null, tool_output: null, created_at: '' },
      ],
      truncated: false,
    } as never)
    renderView()

    const checkboxes = await screen.findAllByLabelText('Pick this record')
    await user.click(checkboxes[1]!)
    expect(screen.getByText('1 record picked')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Use in Rainver/ }))

    await waitFor(() => expect(sessionStorage.getItem('rainver.reference.room.room-main')).not.toBeNull())
    expect(JSON.parse(sessionStorage.getItem('rainver.reference.room.room-main')!))
      .toEqual([{ kind: 'imported_records', id: SESSION, item_ids: ['r2'] }])
  })

  it('tells a reader with a narrowly-shared session why they cannot continue', async () => {
    // The destination is a personal Room, which needs write authority — so
    // the same explanation a private session gets. Keying this on `private`
    // alone offered a button that 403s on the press.
    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
      room: { id: 'room-main', is_mainline: true }, joined: false, viewer_can_write: false,
    } as never)
    vi.mocked(ambientSessionsApi.records).mockResolvedValue({
      session: session('space_shared', 'summary'), records: [], truncated: false,
    } as never)
    renderView()
    expect(await screen.findByText(/needs write access to the Project/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument()
  })
})
