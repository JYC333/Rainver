import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
vi.mock('../../../api/client', () => ({
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
    createConversation: vi.fn(),
  },
}))

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
  vi.mocked(roomsApi.messages).mockResolvedValue({
    items: [], task_group_ids: [], limit: 50, offset: 0,
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

  it('offers to start the conversation to someone who may, and only to them', async () => {
    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({ room: null, joined: false, viewer_can_write: false } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByText(/no conversation yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Start the Project/ })).not.toBeInTheDocument()

    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({ room: null, joined: false, viewer_can_write: true } as never)
    vi.mocked(roomsApi.create).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/tasks/${TASK}`)
    fireEvent.click(await screen.findByRole('button', { name: /Start the Project/ }))
    await waitFor(() => expect(roomsApi.create).toHaveBeenCalledWith({ project_id: PROJECT, title: 'Project conversation' }))
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

  it('starts a separate thread and switches to it', async () => {
    vi.mocked(roomsApi.createConversation).mockResolvedValue({ id: 'conv-3', title: null } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Start a separate thread' }))
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'conv-3', { limit: 50, offset: 0 }))
    // Remembered, so returning to the Project lands where the person left off.
    // Remembered per Room: the id names a conversation *in* a Room.
    expect(localStorage.getItem('project.sidecar.room.room-1.conversation')).toBe('conv-3')
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
})
