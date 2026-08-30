import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectChatSidecar, { focusRefsFor } from '../sidecar/ProjectChatSidecar'
import { projectsApi, proposalsApi, roomsApi } from '../../../api/client'
import { projectTaskHref } from '../taskHref'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
// The rich composer is TipTap, which jsdom cannot type into; the send path
// is what is under test here, not the editor.
vi.mock('../../agent_groups/RoomMessageComposer', () => ({
  emptyRoomMessageComposerValue: () => ({ text: '', mentionIds: [], routingSegments: [] }),
  RoomMessageComposer: ({ onChange }: { onChange: (value: { text: string; mentionIds: string[]; routingSegments: unknown[] }) => void }) => (
    <textarea aria-label="Room message" onChange={event => onChange({ text: event.target.value, mentionIds: [], routingSegments: [] })} />
  ),
}))
vi.mock('../../../api/client', async () => {
  const { ApiRequestError } = await import('../../../test/apiClientMock')
  return {
  ApiRequestError,
  projectsApi: { mainlineRoom: vi.fn() },
  proposalsApi: { get: vi.fn(), accept: vi.fn(), reject: vi.fn() },
  runsApi: { get: vi.fn(), streamEvents: vi.fn() },
  roomsApi: {
    get: vi.fn(),
    summary: vi.fn(),
    create: vi.fn(),
    continueAfterProposal: vi.fn(),
    list: vi.fn(),
    conversations: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
  },
  }
})

const PROJECT = 'project-1'
const TASK = '11111111-1111-4111-8111-111111111111'

/**
 * The real route shape, not a convenient one. The sidecar's whole focus
 * feature depends on a Task page existing *inside* the Project shell — if it
 * does not, `focusRefsFor` never sees a Task path in production no matter what
 * a test renders it at.
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectChatSidecar />}>
          <Route path="board" element={null} />
          <Route path="tasks/:taskId" element={null} />
        </Route>
        <Route path="/spaces/:spaceId/projects/:projectId/*" element={<ProjectChatSidecar />} />
      </Routes>
    </MemoryRouter>,
  )
}

function viewport(wide: boolean) {
  // jsdom has no matchMedia; the panel asks it whether it sits beside the
  // page (≥ lg) or would overlay it.
  window.matchMedia = ((query: string) => ({
    matches: wide && query.includes('1024px'),
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  viewport(true)
  vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
    room: { id: 'room-1', title: 'Project Room', is_mainline: true }, joined: false, viewer_can_write: true,
  } as never)
  vi.mocked(roomsApi.conversations).mockResolvedValue({
    items: [
      { id: 'conv-2', title: 'Depth repair' },
      { id: 'conv-1', title: 'Main' },
    ], total: 2, limit: 50, offset: 0,
  } as never)
  vi.mocked(roomsApi.get).mockResolvedValue({
    room: { id: 'room-1', project_id: PROJECT, title: 'Project Room' }, user_members: [], agent_members: [],
  } as never)
  // The real endpoint always returns `conversation`; omitting it here hid a
  // render loop, because the panel's handler for it re-triggered the read.
  vi.mocked(roomsApi.messages).mockResolvedValue({
    items: [], task_group_ids: [], limit: 50, offset: 0,
    conversation: { id: 'conv-2', room_id: 'room-1', title: 'Depth repair' },
  } as never)
})

describe('focus refs', () => {
  it('names the Task when one is being looked at, and nothing otherwise', () => {
    // The whole point of the sidecar: "is this one done?" resolves without the
    // person restating which Task they mean.
    expect(focusRefsFor(`/spaces/s/projects/${PROJECT}/tasks/${TASK}`))
      .toEqual([{ type: 'task', id: TASK }])
    // The Room is already bound to the Project, so there is nothing to add.
    expect(focusRefsFor(`/spaces/s/projects/${PROJECT}/board`)).toEqual([])
  })

  it('reads back exactly the path the Board sends a card to', () => {
    // Guards the defect this replaced: the focus regex matched a shape no link
    // in the app produced, so the feature was inert while its test passed.
    // Tying the two helpers together means a change to either is caught here.
    expect(focusRefsFor(`/spaces/space-1${projectTaskHref(PROJECT, TASK)}`))
      .toEqual([{ type: 'task', id: TASK }])
  })
})

describe('Project chat sidecar', () => {
  it('binds to the mainline Room and its newest conversation', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    // The mainline is the server's answer, not "whichever Room I am in that
    // was most recently active".
    await waitFor(() => expect(projectsApi.mainlineRoom).toHaveBeenCalledWith(PROJECT))
    await waitFor(() => expect(roomsApi.conversations).toHaveBeenCalledWith('room-1', { limit: 50 }))
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'conv-2', { limit: 50, offset: 0 }))
  })

  it('opens the composer on a Project nobody has spoken in, creating nothing', async () => {
    // The Room is never what is missing — a Project is created with its
    // mainline (ADR 0018 decision 4) — and a conversation is not created
    // ahead of the message that fills it (decision 5). So a writer arriving
    // at a silent Project gets a composer, and no request is made at all.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/tasks/${TASK}`)
    expect(await screen.findByLabelText('Room message')).toBeInTheDocument()
    expect(roomsApi.create).not.toHaveBeenCalled()
    // Nothing to load, so nothing was asked for.
    expect(roomsApi.messages).not.toHaveBeenCalled()
  })

  it('gives a Project reader the composer, because asking the Agent is what the panel is for', async () => {
    // Speaking is Room membership, and opening the Project enrols any reader
    // in the mainline. Gating the composer on Project *write* authority made
    // the panel useless to exactly the person `modules/rooms.md` says it
    // exists for.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
      room: { id: 'room-1', title: 'Project Room', is_mainline: true }, joined: true, viewer_can_write: false,
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByLabelText('Room message')).toBeInTheDocument()
  })

  it('shows a failed mainline read as an error, not as an empty Project', async () => {
    // The mainline read can now fail outright — a Project without one is a
    // broken invariant the server reports as 500 — and the empty state's
    // button is disabled for a viewer, so rendering the failure that way
    // would show a dead end instead of what went wrong.
    vi.mocked(projectsApi.mainlineRoom).mockRejectedValue(new Error('Project has no mainline Room'))
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByText('Project has no mainline Room')).toBeInTheDocument()
  })

  it('reads the transcript a bounded number of times', async () => {
    // The panel binds to whatever conversation the reader reports, and the
    // reader reports on every load. Holding that callback in a dependency
    // list made each report re-run the read: the panel spun from first paint,
    // clearing and refetching the message list on every iteration.
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())
    // Each read resolves a promise, so draining the microtask queue a few
    // times is enough for a self-feeding one to run away — no real waiting,
    // and no dependence on the 5s poll.
    for (let turn = 0; turn < 20; turn += 1) {
      await act(async () => { await Promise.resolve() })
    }
    expect(vi.mocked(roomsApi.messages).mock.calls.length).toBeLessThan(4)
  })

  it('sends the focus alongside the message', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/tasks/${TASK}`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: 'is this done?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'conv-2', {
      content: 'is this done?',
      routing_mode: 'direct',
      backends: [],
      focus_refs: [{ type: 'task', id: TASK }],
    }))
  })

  it('opens the full Room on the conversation being read', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'conv-2', { limit: 50, offset: 0 }))
    // Landing on the Rooms list and having to find this conversation again
    // was the wrong side of the door.
    expect(screen.getByRole('link', { name: /Full Room/ }))
      .toHaveAttribute('href', `/projects/${PROJECT}/rooms?room=room-1&conversation=conv-2`)
  })

  it('is as wide as you last made it, within bounds, and never lengthens the page', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const aside = await screen.findByTestId('project-chat-sidecar')
    // Stuck to the top of the scroll container at a bounded height, so the
    // message list scrolls inside it instead of stretching the page.
    expect(aside.className).toContain('lg:sticky')
    expect(aside.className).toContain('lg:h-[var(--sidecar-h,100dvh)]')
    expect(aside.querySelector('.overflow-y-auto')).not.toBeNull()

    const handle = screen.getByRole('separator', { name: 'Resize Project chat' })
    expect(handle).toHaveAttribute('aria-valuenow', '352')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '384')
    expect(localStorage.getItem('project.sidecar.width')).toBe('384')
    // Bounded: it cannot be dragged into the page or out of usefulness.
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '640')
  })

  it('tells the two speakers apart by more than a label', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [
        { id: 'm1', role: 'user', content: 'Which shell do you use?', created_at: '2026-08-27T09:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'Direct API calls, no shell.', created_at: '2026-08-27T09:00:05.000Z' },
      ], task_group_ids: [], limit: 50, offset: 0,
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const mine = (await screen.findByText('Which shell do you use?')).closest('[data-role]')
    const theirs = screen.getByText('Direct API calls, no shell.').closest('[data-role]')
    expect(mine).toHaveAttribute('data-role', 'user')
    expect(theirs).toHaveAttribute('data-role', 'agent')
    // Opposite alignment, so a column of mixed-language text still reads.
    expect(mine?.className).toContain('justify-end')
    expect(theirs?.className).toContain('justify-start')
  })

  it('decides a proposal the turn produced, right here, and lets the Agent continue', async () => {
    // Before this the panel showed the Agent saying "I proposed a research
    // question" and the decision lived on the Space-level Review page: leave
    // the Project, find it, come back. The card is the decision.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm2', role: 'assistant', content: 'I proposed one question.', created_at: '2026-08-27T09:00:05.000Z',
        metadata_json: { action_previews: [{
          action_id: 'inquiry.promote_knowledge', status: 'proposed', proposal_id: 'proposal-1',
          proposal_type: 'knowledge_create', title: 'Research question: does batching help?',
        }] },
      }], task_group_ids: [], limit: 50, offset: 0,
    } as never)
    vi.mocked(proposalsApi.get).mockResolvedValue({ id: 'proposal-1', status: 'pending' } as never)
    vi.mocked(proposalsApi.accept).mockResolvedValue({} as never)
    vi.mocked(roomsApi.continueAfterProposal).mockResolvedValue({ run_ids: ['run-2'], conversation: null } as never)

    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const previews = await screen.findByTestId('previews-m2')
    expect(previews).toHaveTextContent('Research question: does batching help?')
    fireEvent.click(await within(previews).findByRole('button', { name: /accept|接受|确认/i }))
    await waitFor(() => expect(proposalsApi.accept).toHaveBeenCalledWith('proposal-1'))
    await waitFor(() => expect(roomsApi.continueAfterProposal)
      .toHaveBeenCalledWith('room-1', 'conv-2', { proposal_id: 'proposal-1', backends: [] }))
  })

  it('starts a separate thread by clearing the composer, not by creating one', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-1', session_id: 'conv-3', role: 'user', content: 'A new topic', metadata_json: {} },
      conversation: { id: 'conv-3', title: null },
      task_group_ids: [], run_ids: [],
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Start a separate thread' }))

    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'A new topic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // Addressed to the Room, with no conversation id.
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', null, expect.anything(), expect.any(String)))
    // The conversation the send created is what the panel binds to, and what
    // it remembers per Room.
    await waitFor(() => expect(localStorage.getItem('project.sidecar.room.room-1.conversation')).toBe('conv-3'))
  })

  it('stays a button on a narrow viewport, where open would mean covering the page', async () => {
    viewport(false)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByRole('button', { name: 'Open Project chat' })).toBeInTheDocument()
    expect(screen.queryByTestId('project-chat-sidecar')).not.toBeInTheDocument()
  })

  it('is open on first arrival beside the page, and stays closed once closed', async () => {
    // Conversation is the way in, so the panel is there before anyone asks.
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByTestId('project-chat-sidecar')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close Project chat' }))
    expect(screen.queryByTestId('project-chat-sidecar')).not.toBeInTheDocument()
    expect(localStorage.getItem(`project.sidecar.${PROJECT}.open`)).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Open Project chat' }))
    expect(await screen.findByTestId('project-chat-sidecar')).toBeInTheDocument()
    expect(localStorage.getItem(`project.sidecar.${PROJECT}.open`)).toBe('true')
  })

  it('stays out of the Rooms Area, which is already the Room', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/rooms`)
    expect(screen.queryByTestId('project-chat-sidecar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Project chat' })).not.toBeInTheDocument()
    expect(roomsApi.list).not.toHaveBeenCalled()
  })

  it('offers to attach a picked message to another thread, but not to start one', async () => {
    // The panel can reach the Room's other threads, so a pick has somewhere
    // to go; starting a thread is not one of this surface's affordances, so
    // that action is not offered rather than offered and dead.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm-1', space_id: 'space-1', session_id: 'conv-1', role: 'user',
        user_id: 'user-1', content: 'Pick me', metadata_json: {},
        created_at: '2026-08-29T09:00:00.000Z',
      }],
      total: 1, limit: 50, offset: 0,
    } as never)
    renderAt('/spaces/space-1/projects/project-1/board')

    fireEvent.click((await screen.findAllByLabelText('Pick this message'))[0]!)
    expect(await screen.findByLabelText('Attach to a thread')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use in a new thread/ })).not.toBeInTheDocument()
  })
})
