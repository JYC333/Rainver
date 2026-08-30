import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentGroupsPage from '../AgentGroupsPage'
import {
  ApiRequestError,
  agentsApi,
  projectFoldersApi,
  projectsApi,
  proposalsApi,
  roomsApi,
  runsApi,
  spacesApi,
} from '../../../api/client'
import type { AgentOut, Project, Room, RoomConversation, RoomDetail, Run } from '../../../types/api'

const mockedSpaceContext = vi.hoisted(() => ({ activeSpaceId: 'space-1', userId: 'user-1' }))

vi.mock('../../../api/client', async () => {
  const { ApiRequestError } = await import('../../../test/apiClientMock')
  return {
  ApiRequestError,
  agentsApi: { list: vi.fn(), conversationBackends: vi.fn() },
  projectsApi: { list: vi.fn(), getOverview: vi.fn(), readers: vi.fn() },
  projectFoldersApi: { list: vi.fn(), listExecutionReady: vi.fn() },
  roomsApi: {
    list: vi.fn(),
    get: vi.fn(),
    attachReferences: vi.fn(),
    conversations: vi.fn(),
    summary: vi.fn(),
    messages: vi.fn(),
    create: vi.fn(),
    sendMessage: vi.fn(),
    continueAfterProposal: vi.fn(),
    agentCandidates: vi.fn(),
    addAgent: vi.fn(),
    addAgentPreset: vi.fn(),
    removeAgent: vi.fn(),
    invitations: vi.fn(),
    inviteUser: vi.fn(),
    decideInvitation: vi.fn(),
    removeUser: vi.fn(),
    transferOwner: vi.fn(),
    claimOwner: vi.fn(),
  },
  runsApi: { get: vi.fn(), streamEvents: vi.fn() },
  spacesApi: { members: vi.fn() },
  proposalsApi: { get: vi.fn(), accept: vi.fn(), reject: vi.fn() },
  }
})

// The editor itself is covered by `RoomMessageComposer.test.tsx`; jsdom cannot
// type into TipTap, and without this nothing here could exercise a send.
vi.mock('../RoomMessageComposer', () => ({
  emptyRoomMessageComposerValue: () => ({ text: '', mentionIds: [], routingSegments: [] }),
  // Reflects `value` as well as reporting changes: a seeded draft arrives
  // through that prop, so a write-only stand-in could not see one.
  RoomMessageComposer: ({ value, onChange }: {
    value: { text: string }
    onChange: (value: { text: string; mentionIds: string[]; routingSegments: unknown[] }) => void
  }) => (
    <textarea
      aria-label="Room message"
      value={value.text}
      onChange={event => onChange({ text: event.target.value, mentionIds: [], routingSegments: [] })}
    />
  ),
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: mockedSpaceContext.activeSpaceId, userId: mockedSpaceContext.userId }),
}))

const room: Room = {
  id: 'room-1',
  space_id: 'space-1',
  project_id: 'project-1',
  project_folder_id: null,
  created_by_user_id: 'user-1',
  title: 'Research Room',
  status: 'active',
  created_at: '2026-07-26T00:00:00.000Z',
  updated_at: '2026-07-26T00:00:00.000Z',
  archived_at: null,
      is_mainline: false,
}

const initialConversation = {
  id: 'session-1',
  space_id: 'space-1',
  room_id: room.id,
  project_id: room.project_id,
  project_folder_id: null,
  title: 'Conversation',
  status: 'active',
  created_at: room.created_at,
  updated_at: room.updated_at,
} as RoomConversation

const detail: RoomDetail = {
  room,
  viewer_can_write: true,
  other_member_names: ['Member'],
  agent_count: 1,
  user_members: [
    {
      id: 'member-1',
      space_id: 'space-1',
      room_id: room.id,
      user_id: 'user-1',
      role: 'owner',
      status: 'active',
      created_at: room.created_at,
      updated_at: room.updated_at,
    },
    {
      id: 'member-2',
      space_id: 'space-1',
      room_id: room.id,
      user_id: 'user-2',
      role: 'member',
      status: 'active',
      created_at: room.created_at,
      updated_at: room.updated_at,
    },
  ],
  agent_members: [{
    id: 'agent-member-1',
    space_id: 'space-1',
    room_id: room.id,
    agent_id: 'agent-1',
    agent_name: 'Space Assistant',
    agent_kind: 'system_assistant',
    role: 'manager',
    status: 'active',
    created_at: room.created_at,
    updated_at: room.updated_at,
  }],
}


/** The page at `path`, inside the Project shell's route when the path names one. */
function roomsAt(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      {path.startsWith('/spaces/') ? (
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      ) : <AgentGroupsPage />}
    </MemoryRouter>
  )
}
function renderRooms(path: string) {
  return render(roomsAt(path))
}

/** Open a limited Room by choosing `name` in the shared dialog. */
async function openLimitedRoomWith(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New Room' }))
  fireEvent.click(await screen.findByLabelText('People who can see this'))
  fireEvent.click(await screen.findByRole('option', { name }))
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

/** One user message in `session-1`, to be picked. */
const polarsMessages = {
  items: [{
    id: 'm-1', space_id: 'space-1', session_id: 'session-1', role: 'user',
    user_id: 'user-1', content: 'We ruled out polars', metadata_json: {},
    created_at: '2026-08-29T09:00:00.000Z',
  }],
  total: 1, limit: 50, offset: 0,
}

describe('Rooms page', () => {
  beforeEach(() => {
    // Reset queued one-shot implementations as well as call history. Several
    // catalog race tests intentionally install response sequences, and a
    // leftover sequence must not change the next test's page state.
    vi.resetAllMocks()
    sessionStorage.clear()
    mockedSpaceContext.activeSpaceId = 'space-1'
    mockedSpaceContext.userId = 'user-1'
    vi.mocked(roomsApi.list).mockResolvedValue({ items: [room], total: 1, limit: 50, offset: 0 })
    vi.mocked(roomsApi.get).mockResolvedValue(detail)
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [{
        id: 'session-1',
        space_id: 'space-1',
        room_id: room.id,
        project_id: room.project_id,
        project_folder_id: null,
        title: 'Evidence review',
        status: 'active',
        created_at: room.created_at,
        updated_at: room.updated_at,
      }],
      total: 1,
      limit: 50,
      offset: 0,
    })
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [],
      task_group_ids: [],
      limit: 200,
      offset: 0,
    })
    vi.mocked(roomsApi.summary).mockResolvedValue({ state: null, summary: null })
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue({ agents: [], presets: [], total: 0, limit: 100, offset: 0 })
    vi.mocked(roomsApi.invitations).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
    vi.mocked(projectsApi.readers).mockResolvedValue({
      readers: [{ user_id: 'user-3', display_name: 'Reader', email: null, avatar_url: null }],
    })
    vi.mocked(projectsApi.list).mockResolvedValue({
      items: [{ id: 'project-1', name: 'Project One' } as Project],
      total: 1,
      limit: 100,
      offset: 0,
    })
    vi.mocked(projectsApi.getOverview).mockResolvedValue({
      project: { id: 'project-1', name: 'Project One', primary_mode: 'research', status: 'active' },
      brief: null,
      definition_status: { status: 'initialized', basis: 'published_brief_goal', goal_or_problem: 'Understand memory quality' },
      available_modes: ['research'],
      attention: [],
    } as unknown as Awaited<ReturnType<typeof projectsApi.getOverview>>)
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    })
    vi.mocked(projectFoldersApi.listExecutionReady).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    } as never)
    vi.mocked(agentsApi.list).mockResolvedValue([{
      id: 'agent-1',
      name: 'Researcher',
      status: 'active',
      agent_kind: 'standard',
    } as AgentOut])
    vi.mocked(agentsApi.conversationBackends).mockResolvedValue({
      options: [{
        runtime_profile_id: 'runtime-cli',
        name: 'Codex subscription',
        adapter_type: 'codex_cli',
        model_name: null,
        requires_cli_credential: true,
        credential_profiles: [{
          id: 'credential-user-1',
          name: 'My Codex login',
          is_default: true,
        }],
      }],
      binding: null,
    })
    vi.mocked(spacesApi.members).mockResolvedValue([
      { user_id: 'user-1', display_name: 'Owner', email: 'owner@example.test' },
      { user_id: 'user-2', display_name: 'Member', email: 'member@example.test' },
      // In the Space, not on this Project — what the old candidate source
      // would have offered and the server would have refused.
      { user_id: 'user-9', display_name: 'Outsider', email: 'outsider@example.test' },
    ] as Awaited<ReturnType<typeof spacesApi.members>>)
    vi.mocked(runsApi.streamEvents).mockResolvedValue(undefined)
  })

  it('opens a limited Room by choosing who is in it, and invites them', async () => {
    // The audience is what a Room *is* (ADR 0018), so it is what opening one
    // asks for; the name is optional and comes after. Same dialog as the
    // conversation list uses — one act, one implementation.
    vi.mocked(projectsApi.readers).mockResolvedValue({
      readers: [{ user_id: 'user-2', display_name: 'Dana', email: null, avatar_url: null }],
    })
    vi.mocked(roomsApi.create).mockResolvedValue({
      room: { ...room, id: 'room-2', title: 'Dana' }, user_members: [], agent_members: [],
    } as never)
    vi.mocked(roomsApi.inviteUser).mockResolvedValue({} as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1')
    await openLimitedRoomWith('Dana')

    await waitFor(() => expect(roomsApi.create).toHaveBeenCalledWith(
      { project_id: 'project-1', title: 'Limited group' },
      expect.any(String),
    ))
    await waitFor(() => expect(roomsApi.inviteUser).toHaveBeenCalledWith('room-2', {
      user_id: 'user-2',
      confirm_owned_private_agent_shares: false,
    }))
  })

  it('offers Project readers as invite candidates, not every Space member', async () => {
    // A Space member who cannot read the Project is somebody the server
    // refuses to invite, so offering them is offering a control that only
    // ever fails. `spacesApi.members` returns two people here; only the one
    // who reads the Project may be offered.
    vi.mocked(projectsApi.readers).mockResolvedValue({
      readers: [{ user_id: 'user-3', display_name: 'Reader', email: null, avatar_url: null }],
    })
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1')
    fireEvent.click(await screen.findByLabelText('Invite a person'))
    const offered = (await screen.findAllByRole('option')).map(option => option.textContent)
    expect(offered).toContain('Reader')
    // Not merely absent because they are already in the Room — `Outsider` is
    // in the Space and not in this Room, so only the candidate *source*
    // decides. Under `spacesApi.members` they would be offered and the server
    // would then refuse them.
    expect(offered).not.toContain('Outsider')
  })

  it('shows a reader the roster and none of the controls that would 403', async () => {
    // Every roster mutation goes through the server's `withRoomWriter`, which
    // requires Project write authority. Reading the roster does not — so the
    // panel stays, and only the controls go.
    // A member, not the Room's owner: `claimOwner` is for exactly this person
    // when the owner has been suspended.
    vi.mocked(roomsApi.get).mockResolvedValue({
      ...detail,
      viewer_can_write: false,
      user_members: detail.user_members.map(member => member.user_id === 'user-1'
        ? { ...member, role: 'member' }
        : member),
    } as never)
    vi.mocked(projectsApi.readers).mockResolvedValue({
      readers: [{ user_id: 'user-3', display_name: 'Reader', email: null, avatar_url: null }],
    })
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1')
    expect(await screen.findByText('Room roster')).toBeInTheDocument()
    expect(screen.queryByLabelText('Invite a person')).not.toBeInTheDocument()
    expect(screen.queryByText('Transfer Room ownership')).not.toBeInTheDocument()
    // But not everything on this panel answers to Project write. Claiming a
    // suspended Room needs the Project owner or a Space owner/admin, and
    // deciding a private-Agent share needs the Agent's owner — who may be a
    // reader, and is exactly who a blocked invitation is waiting on. Folding
    // these under the same flag is what left an invitation stuck.
    expect(screen.getByRole('button', { name: /Claim ownership if suspended/ })).toBeInTheDocument()
  })

  it('shows a project-bound Room with persistent conversations and human/agent rosters', async () => {
    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect((await screen.findAllByText('Research Room')).length).toBeGreaterThan(0)
    expect(screen.getByText('2 people · 1 agents')).toBeInTheDocument()
    expect(screen.getAllByText('Evidence review').length).toBeGreaterThan(0)
    expect(screen.getByRole('main', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Room and conversation navigation' })).toBeInTheDocument()
    expect(screen.getByText('Rooms', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New Room' })).toBeInTheDocument()
    expect(await screen.findByText('Room roster')).toBeInTheDocument()
    expect(screen.getByText('Manager · locked')).toBeInTheDocument()
    expect(roomsApi.agentCandidates).toHaveBeenCalledWith('room-1', { limit: 100 })
    expect(roomsApi.invitations).toHaveBeenCalledWith('room-1', { limit: 100 })
    expect(screen.queryByText('Codex subscription · My Codex login')).not.toBeInTheDocument()
    expect(screen.getByText(/every human speaks under their own identity and subscription/i)).toBeInTheDocument()
  })

  it('opens the newest Room and its newest conversation when the Rooms page has no selection', async () => {
    let resolveRoom!: (value: RoomDetail) => void
    let resolveProjects!: (value: Awaited<ReturnType<typeof projectsApi.list>>) => void
    vi.mocked(roomsApi.get).mockImplementationOnce(() => new Promise(resolve => {
      resolveRoom = resolve
    }))
    vi.mocked(projectsApi.list).mockImplementationOnce(() => new Promise(resolve => {
      resolveProjects = resolve
    }))
    renderRooms('/rooms')

    await waitFor(() => expect(roomsApi.get).toHaveBeenCalledWith('room-1'))
    // Secondary setup catalogs must not delay the Room's critical path.
    expect(resolveProjects).toBeTypeOf('function')
    expect(screen.getByText('Loading Room…')).toBeInTheDocument()
    expect(screen.queryByText('Choose or create a Room.')).not.toBeInTheDocument()
    await act(async () => resolveRoom(detail))
    expect((await screen.findAllByText('Research Room')).length).toBeGreaterThan(0)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith(
      'room-1',
      'session-1',
      expect.any(Object),
    ))
    expect(screen.getByRole('main', { name: 'Conversation' })).toBeInTheDocument()
    await act(async () => resolveProjects({
      items: [{ id: 'project-1', name: 'Project One' } as Project],
      total: 1,
      limit: 100,
      offset: 0,
    }))
  })

  it('composes into a Room with no conversation, creating nothing to get there', async () => {
    // Where "with a limited group…" lands: the Room exists, nothing has been
    // said in it, and creating a conversation up front is exactly what ADR
    // 0018 decision 5 removes.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    renderRooms('/rooms?room=room-1')
    expect(await screen.findByLabelText('Room message')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'New conversation' })).toBeInTheDocument()
    // Nothing to read, so nothing was asked for.
    expect(roomsApi.messages).not.toHaveBeenCalled()
  })

  it('starts a separate thread by deselecting, and does not snap back to the newest', async () => {
    // "Nothing selected" is also what a fresh arrival looks like, so the
    // auto-select would otherwise reopen the newest conversation the moment
    // this button cleared it.
    renderRooms('/rooms?room=room-1&conversation=session-1')
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'session-1', expect.anything()))

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    // The transcript header names the unwritten conversation, not the one
    // that was open a moment ago.
    await waitFor(() => expect(screen.getByRole('heading', { level: 3, name: 'New conversation' })).toBeInTheDocument())
    expect(await screen.findByLabelText('Room message')).toBeInTheDocument()
  })

  it('keeps conversations in creation-time descending order', async () => {
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [
        { ...initialConversation, id: 'session-old', title: 'Old conversation', created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-29T00:00:00.000Z' },
        { ...initialConversation, id: 'session-new', title: 'New conversation', created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z' },
        { ...initialConversation, id: 'session-middle', title: 'Middle conversation', created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-28T00:00:00.000Z' },
      ],
      total: 3,
      limit: 50,
      offset: 0,
    })

    renderRooms('/rooms?room=room-1&conversation=session-old')

    const navigation = await screen.findByRole('navigation', { name: 'Conversations' })
    await waitFor(() => expect(within(navigation).getAllByRole('button').map(button => button.textContent)).toEqual([
      'New conversation',
      'Middle conversation',
      'Old conversation',
    ]))
  })

  it('presents the legacy generic Room title as a real project Room name', async () => {
    const legacyRoom = { ...room, title: 'Project conversation' }
    vi.mocked(roomsApi.list).mockResolvedValue({ items: [legacyRoom], total: 1, limit: 50, offset: 0 })
    vi.mocked(roomsApi.get).mockResolvedValue({ ...detail, room: legacyRoom })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect((await screen.findAllByText('Project One Room')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Project conversation')).not.toBeInTheDocument()
  })

  it('switches conversations with a local message loader instead of reloading the Rooms page', async () => {
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [
        { ...initialConversation, title: 'First conversation' },
        { ...initialConversation, id: 'session-2', title: 'Second conversation' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    })
    let resolveSecondMessages!: (value: Awaited<ReturnType<typeof roomsApi.messages>>) => void
    const secondMessages = new Promise<Awaited<ReturnType<typeof roomsApi.messages>>>(resolve => {
      resolveSecondMessages = resolve
    })
    vi.mocked(roomsApi.messages)
      .mockResolvedValueOnce({
        items: [{
          id: 'message-first',
          session_id: 'session-1',
          space_id: 'space-1',
          user_id: 'user-1',
          sender_agent_id: null,
          role: 'user',
          content: 'First conversation message',
          metadata_json: null,
          created_at: '2026-07-26T00:00:01.000Z',
        }],
        task_group_ids: [],
        limit: 50,
        offset: 0,
      })
      .mockImplementationOnce(() => secondMessages)

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('First conversation message')).toBeInTheDocument()
    expect(roomsApi.get).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }))

    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument()
    expect(screen.queryByText('Loading Rooms…')).not.toBeInTheDocument()
    expect(await screen.findByText('Loading conversation…')).toBeInTheDocument()
    expect(roomsApi.get).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSecondMessages({
        items: [{
          id: 'message-second',
          session_id: 'session-2',
          space_id: 'space-1',
          user_id: 'user-1',
          sender_agent_id: null,
          role: 'user',
          content: 'Second conversation message',
          metadata_json: null,
          created_at: '2026-07-26T00:00:02.000Z',
        }],
        task_group_ids: [],
        limit: 50,
        offset: 0,
      })
    })
    expect(await screen.findByText('Second conversation message')).toBeInTheDocument()
  })

  it('updates a generated conversation title without reloading the Room', async () => {
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [{ ...initialConversation, title: 'New conversation' }],
      total: 1,
      limit: 50,
      offset: 0,
    })
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [],
      conversation: {
        ...initialConversation,
        title: 'Personal Agent Memory',
        updated_at: '2026-07-26T00:00:01.000Z',
      },
      task_group_ids: [],
      limit: 200,
      offset: 0,
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByRole('button', { name: 'Personal Agent Memory' })).toBeInTheDocument()
    expect(roomsApi.get).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('New conversation')).not.toBeInTheDocument()
  })

  it('a poll delivers a newer reply without pulling back a reader scrolled up', async () => {
    // What used to be waited for here was the conversation's five-second poll
    // firing on real time — five seconds of sleep the hygiene test cannot see,
    // dressed as a click on the page's Refresh button, which reloads the
    // catalog and the Room and never the messages. The poll is the subject,
    // so the clock is faked and advanced past it.
    let resolveMessages!: (value: Awaited<ReturnType<typeof roomsApi.messages>>) => void
    vi.mocked(roomsApi.messages).mockImplementationOnce(() =>
      new Promise(resolve => { resolveMessages = resolve }))
    vi.useFakeTimers()
    try {
      renderRooms('/rooms?room=room-1&conversation=session-1')
      await act(async () => { await Promise.resolve() })
      const conversation = screen.getByRole('log', { name: 'Conversation messages' })
      const scrollTo = vi.fn()
      Object.defineProperties(conversation, {
        scrollHeight: { configurable: true, value: 1_000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 600 },
        scrollTo: { configurable: true, value: scrollTo },
      })
      await act(async () => {
        resolveMessages({
          items: [{
            id: 'message-latest', session_id: 'session-1', space_id: 'space-1', user_id: null,
            sender_agent_id: 'agent-1', role: 'assistant', content: 'Latest reply', metadata_json: null,
            created_at: '2026-07-26T00:00:03.000Z',
          }],
          task_group_ids: [], limit: 200, offset: 0,
        })
      })
      // The follow-the-tail scroll is scheduled on an animation frame, which
      // the faked clock holds until advanced.
      await act(async () => { await vi.advanceTimersByTimeAsync(16) })
      expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'auto' })

      // The reader scrolls up to read history; the next poll brings a reply.
      scrollTo.mockClear()
      conversation.scrollTop = 100
      fireEvent.scroll(conversation)
      vi.mocked(roomsApi.messages).mockResolvedValue({
        items: [{
          id: 'message-newer', session_id: 'session-1', space_id: 'space-1', user_id: null,
          sender_agent_id: 'agent-1', role: 'assistant', content: 'A newer reply', metadata_json: null,
          created_at: '2026-07-26T00:00:04.000Z',
        }],
        task_group_ids: [], limit: 200, offset: 0,
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(screen.getByText('A newer reply')).toBeInTheDocument()
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the Project route as the Room scope without rendering a Project picker', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1',
        ]}
      >
        <Routes>
          <Route
            path="/spaces/:spaceId/projects/:projectId/rooms"
            element={<AgentGroupsPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    expect((await screen.findAllByText('Research Room')).length).toBeGreaterThan(0)
    expect(roomsApi.list).toHaveBeenCalledWith({
      project_id: 'project-1',
      limit: 100,
      offset: 0,
    })
    expect(screen.queryByText('Choose Project')).not.toBeInTheDocument()
  })

  it('attributes human messages by name and shows streamed Run lifecycle progress', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [
        {
          id: 'message-owner',
          session_id: 'session-1',
          space_id: 'space-1',
          user_id: 'user-1',
          sender_agent_id: null,
          role: 'user',
          content: 'Owner contribution',
          metadata_json: null,
          created_at: '2026-07-26T00:00:01.000Z',
        },
        {
          id: 'message-member',
          session_id: 'session-1',
          space_id: 'space-1',
          user_id: 'user-2',
          sender_agent_id: null,
          role: 'user',
          content: 'Member contribution',
          metadata_json: { run_ids: ['run-1'] },
          created_at: '2026-07-26T00:00:02.000Z',
        },
  ],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({
      id: 'run-1',
      status: 'running',
    } as Run)
    vi.mocked(runsApi.streamEvents).mockImplementation(async (_runId, options) => {
      options.onLifecycle({
        event_type: 'adapter_invoked',
        status: 'running',
        summary: 'Agent started',
      })
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Owner contribution')).toBeInTheDocument()
    expect(screen.getByText('Member contribution')).toBeInTheDocument()
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Member').length).toBeGreaterThan(0)
    expect(await screen.findByText('Agent started')).toBeInTheDocument()
  })

  it('shows a human action label instead of the internal review status', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-member',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: 'user-1',
        sender_agent_id: null,
        role: 'user',
        content: 'Continue with the protected action.',
        metadata_json: { run_ids: ['run-review'] },
        created_at: '2026-07-26T00:00:02.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({
      id: 'run-review',
      status: 'waiting_for_review',
      error_json: {
        authorization_request_id: 'authorization-1',
        error_text: 'Project file access requires approval.',
      },
    } as unknown as Run)

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('approval needed')).toBeInTheDocument()
    expect(screen.getByText('Review request')).toBeInTheDocument()
    expect(screen.queryByText('waiting_for_review')).not.toBeInTheDocument()
    expect(runsApi.streamEvents).not.toHaveBeenCalled()
  })

  it('loads older Room history, and a later poll does not refetch terminal Runs', async () => {
    // Same repair as above: the third `messages` call this test counts is the
    // poll, not the Refresh button it used to click.
    const recent = Array.from({ length: 50 }, (_, index) => ({
      id: `message-${index}`, session_id: 'session-1', space_id: 'space-1', user_id: 'user-1',
      sender_agent_id: null, role: 'user' as const, content: `Recent ${index}`,
      metadata_json: index === 0 ? { run_ids: ['run-terminal'] } : null,
      created_at: `2026-07-26T00:00:${String(index).padStart(2, '0')}.000Z`,
    }))
    vi.mocked(roomsApi.messages)
      .mockResolvedValueOnce({ items: recent, task_group_ids: ['group-1'], limit: 50, offset: 0 })
      .mockResolvedValueOnce({
        items: [{ ...recent[0], id: 'message-older', content: 'Oldest message' }],
        task_group_ids: ['group-1'], limit: 50, offset: 50,
      })
      .mockResolvedValue({ items: recent, task_group_ids: ['group-1'], limit: 50, offset: 0 })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-terminal', status: 'succeeded' } as Run)

    vi.useFakeTimers()
    try {
      renderRooms('/rooms?room=room-1&conversation=session-1')
      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('button', { name: 'Load older' }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText('Oldest message')).toBeInTheDocument()
      expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'session-1', { limit: 50, offset: 50 })

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(roomsApi.messages).toHaveBeenCalledTimes(3)
      // A terminal Run was fetched once and is not asked about again.
      expect(runsApi.get).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders an inline Proposal card on an agent-drafted conclusion and accepts it without leaving the Room', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-conclusion',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: 'agent-1',
        role: 'assistant',
        content: 'I drafted a conclusion for this Thread.',
        metadata_json: {
          action_previews: [{
            action_id: 'inquiry.promote_knowledge',
            status: 'proposed',
            proposal_id: 'proposal-1',
            proposal_type: 'knowledge_create',
            title: 'Record conclusion: Does caching help?',
            summary: null,
            risk_level: 'medium',
          }],
        },
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(proposalsApi.get).mockResolvedValue({ status: 'pending' } as Awaited<ReturnType<typeof proposalsApi.get>>)
    vi.mocked(proposalsApi.accept).mockResolvedValue({} as Awaited<ReturnType<typeof proposalsApi.accept>>)
    vi.mocked(roomsApi.continueAfterProposal).mockResolvedValue({
      message: {
        id: 'message-continue',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: null,
        role: 'system',
        content: 'I accepted “Record conclusion: Does caching help?”. Continue now: confirm what was completed in one sentence, then begin the next step.',
        metadata_json: { run_ids: ['run-continue'] },
        created_at: '2026-07-26T00:00:04.000Z',
      },
      conversation: initialConversation,
      task_group_ids: ['group-continue'],
      run_ids: ['run-continue'],
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Record conclusion: Does caching help?')).toBeInTheDocument()
    expect(await screen.findByText('Needs confirmation')).toBeInTheDocument()
    expect(proposalsApi.get).toHaveBeenCalledWith('proposal-1')

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(proposalsApi.accept).toHaveBeenCalledWith('proposal-1'))
    await waitFor(() => expect(roomsApi.continueAfterProposal).toHaveBeenCalledWith(
      'room-1',
      'session-1',
      expect.objectContaining({
        proposal_id: 'proposal-1',
      }),
    ))
    expect(screen.queryByText('I accepted “Record conclusion: Does caching help?”. Continue now: confirm what was completed in one sentence, then begin the next step.')).not.toBeInTheDocument()
    expect(await screen.findByText('Accepted')).toBeInTheDocument()
    expect(await screen.findByText('已提升为空间级知识。助手正在下方继续。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('refreshes a stale action-preview snapshot against the live Proposal on mount (already decided elsewhere)', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-conclusion',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: 'agent-1',
        role: 'assistant',
        content: 'I drafted a conclusion for this Thread.',
        // The stored snapshot is stale — the finalizer wrote 'proposed' once
        // and it is never updated after the Proposal is later decided.
        metadata_json: {
          action_previews: [{
            action_id: 'inquiry.promote_knowledge',
            status: 'proposed',
            proposal_id: 'proposal-2',
            proposal_type: 'knowledge_create',
            title: 'Record conclusion: Does caching help?',
            summary: null,
            risk_level: 'medium',
          }],
        },
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(proposalsApi.get).mockResolvedValue({ status: 'rejected' } as Awaited<ReturnType<typeof proposalsApi.get>>)

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Record conclusion: Does caching help?')).toBeInTheDocument()
    expect(await screen.findByText('Rejected')).toBeInTheDocument()
    expect(screen.queryByText('Needs confirmation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('keeps superseded duplicate Proposal cards visible and non-interactive', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-duplicate-question',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: 'agent-1',
        role: 'assistant',
        content: 'A recovery attempted the same question again.',
        metadata_json: {
          action_previews: [{
            action_id: 'inquiry.promote_knowledge',
            status: 'proposed',
            proposal_id: 'proposal-duplicate',
            proposal_type: 'knowledge_create',
            title: 'Duplicate research question',
            summary: null,
            risk_level: 'medium',
          }],
        },
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(proposalsApi.get).mockResolvedValue({ status: 'superseded' } as Awaited<ReturnType<typeof proposalsApi.get>>)

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('A recovery attempted the same question again.')).toBeInTheDocument()
    expect(await screen.findByText('Duplicate research question')).toBeInTheDocument()
    expect(await screen.findByText('重复 · 已合并')).toBeInTheDocument()
    expect(screen.getByText('这是重复提案，已与已有研究问题合并，无需再次确认。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('lets an already accepted proposal resume the conversation visibly', async () => {
    const continuationResult = {
      message: {
        id: 'message-resume',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: null,
        role: 'system' as const,
        content: 'I accepted the definition. Continue.',
        metadata_json: { run_ids: ['run-resume'] },
        created_at: '2026-07-26T00:00:04.000Z',
      },
      conversation: initialConversation,
      task_group_ids: ['group-resume'],
      run_ids: ['run-resume'],
    }
    let resolveContinuation!: (value: typeof continuationResult) => void
    const continuationRequest = new Promise<typeof continuationResult>(resolve => {
      resolveContinuation = resolve
    })
    let finalizeRun: (() => void) | null = null
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-definition',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: 'agent-1',
        role: 'assistant',
        content: 'I drafted the Project definition.',
        metadata_json: {
          action_previews: [{
            action_id: 'project.propose_definition',
            status: 'proposed',
            proposal_id: 'proposal-definition',
            proposal_type: 'project_brief_publish',
            title: 'Define Project: Agent memory research',
            summary: null,
            risk_level: 'medium',
          }],
        },
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(proposalsApi.get).mockResolvedValue({ status: 'accepted' } as Awaited<ReturnType<typeof proposalsApi.get>>)
    vi.mocked(roomsApi.continueAfterProposal).mockReturnValue(continuationRequest)
    vi.mocked(runsApi.streamEvents).mockImplementation(async (_runId, options) => {
      finalizeRun = () => options.onLifecycle({
        event_type: 'run_finalized',
        status: 'succeeded',
        summary: 'Finished',
      })
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Accepted')).toBeInTheDocument()
    expect(screen.getByText('项目目标、范围和成功标准已保存。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续下一步' }))
    expect(await screen.findByText('已接受，正在启动下一步…')).toBeInTheDocument()
    await waitFor(() => expect(roomsApi.continueAfterProposal).toHaveBeenCalledWith(
      'room-1',
      'session-1',
      expect.objectContaining({
        proposal_id: 'proposal-definition',
      }),
    ))
    await act(async () => resolveContinuation(continuationResult))
    expect(screen.queryByText('I accepted the definition. Continue.')).not.toBeInTheDocument()
    expect(await screen.findByText('已接受，助手正在处理…')).toBeInTheDocument()
    expect(await screen.findByText('项目目标、范围和成功标准已保存。助手正在下方继续。')).toBeInTheDocument()

    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-finished',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: 'agent-1',
        role: 'assistant',
        content: '下一步已经准备好了。',
        metadata_json: { run_id: 'run-resume' },
        created_at: '2026-07-26T00:00:05.000Z',
      }],
      task_group_ids: ['group-resume'],
      limit: 200,
      offset: 0,
    })
    await waitFor(() => expect(finalizeRun).not.toBeNull())
    act(() => finalizeRun?.())
    expect(await screen.findByText('下一步已经准备好了。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('已接受，助手正在处理…')).not.toBeInTheDocument())
  })

  it('surfaces backend setup links when the first message finds no usable Agent', async () => {
    // Provisioning moved to the first message (ADR 0018 decision 4), so this
    // error arrives from a send, not from creating the Room. It used to be
    // caught on the create path, which can no longer raise it — leaving a
    // Space with no configured provider an error and no next step.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(roomsApi.sendMessage).mockRejectedValue(new ApiRequestError(
      'Configure a conversation backend',
      409,
      'conversation_backend_required',
      { code: 'conversation_backend_required', setup_targets: ['model_providers', 'cli_credentials'] },
    ))
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Anyone there?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(/set up a conversation backend/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /configure an api provider/i })).toHaveAttribute('href', '/spaces/space-1/providers')
    expect(screen.getByRole('link', { name: /grant a cli credential/i })).toHaveAttribute('href', '/cli-profiles')
  })

  it('keeps a Room it just created when the catalog refresh fails', async () => {
    // `openRoom` commits the Room locally before any follow-up read, so a
    // failing catalog cannot restore an empty state and invite a duplicate.
    let refreshShouldFail = false
    vi.mocked(roomsApi.list).mockImplementation(() => refreshShouldFail
      ? Promise.reject(new Error('Refresh failed'))
      : Promise.resolve({ items: [room], total: 1, limit: 50, offset: 0 }))
    vi.mocked(roomsApi.create).mockResolvedValue({
      room: { ...room, id: 'room-2', title: 'Second Room' }, user_members: [], agent_members: [],
    } as never)

    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')

    fireEvent.click(await screen.findByRole('button', { name: 'New Room' }))
    fireEvent.click(await screen.findByLabelText('People who can see this'))
    fireEvent.click(await screen.findByRole('option', { name: 'Reader' }))
    refreshShouldFail = true
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getAllByText('Second Room').length).toBeGreaterThan(0))
    expect(roomsApi.create).toHaveBeenCalledTimes(1)
  })

  it('sends a Room-keyed reference with the message that creates the conversation', async () => {
    // The consuming half of the import continuation handoff. The pick is
    // stored under the Room because the conversation it is for is created by
    // the message that carries it (ADR 0018 decision 5), and the two are
    // written in one transaction.
    sessionStorage.setItem(
      'rainver.reference.room.room-1',
      JSON.stringify([{ kind: 'imported_session', id: 'imported-1' }]),
    )
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-1', session_id: 'session-new', role: 'user', content: 'Picking this up', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' },
      task_group_ids: [], run_ids: [],
    } as never)
    renderRooms('/rooms?room=room-1&new=1&reference=1')
    const composer = await screen.findByLabelText('Room message')
    // Read once: a reload must not resurrect a pick the person abandoned.
    expect(sessionStorage.getItem('rainver.reference.room.room-1')).toBeNull()

    fireEvent.change(composer, { target: { value: 'Picking this up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', null, expect.objectContaining({
      references: [{ kind: 'imported_session', id: 'imported-1' }],
    }), expect.any(String)))
  })

  it('picks messages at the source and attaches them to another thread', async () => {
    // Picking happens where the content can be read, not in a browser opened
    // from the destination. What travels is a `messages` pick naming the
    // conversation it came from.
    vi.mocked(roomsApi.messages).mockResolvedValue(polarsMessages as never)
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [initialConversation, { ...initialConversation, id: 'session-2', title: 'Other thread' }],
      total: 2, limit: 50, offset: 0,
    } as never)
    vi.mocked(roomsApi.attachReferences).mockResolvedValue({ messages: [] } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    const checkboxes = await screen.findAllByLabelText('Pick this message')
    fireEvent.click(checkboxes[0]!)
    expect(await screen.findByText('1 message picked')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Attach to a thread'))
    fireEvent.click(await screen.findByRole('option', { name: 'Other thread' }))

    await waitFor(() => expect(roomsApi.attachReferences).toHaveBeenCalledWith('room-1', 'session-2', {
      references: [{ kind: 'messages', id: 'session-1', item_ids: [expect.any(String)] }],
    }))
  })

  it('holds a pick for a new thread, creating nothing until the first message', async () => {
    // The phase's headline deliverable. Nothing exists until the message: a
    // thread comes into being when somebody speaks in it (ADR 0018 decision
    // 5), so an abandoned draft leaves nothing behind.
    vi.mocked(roomsApi.messages).mockResolvedValue(polarsMessages as never)
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-2', session_id: 'session-new', role: 'user', content: 'Following up', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' },
      task_group_ids: [], run_ids: [],
    } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    fireEvent.click((await screen.findAllByLabelText('Pick this message'))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: /Use in a new thread/ }))

    // Held, not sent: no conversation was created to hold it.
    expect(roomsApi.attachReferences).not.toHaveBeenCalled()
    expect(roomsApi.sendMessage).not.toHaveBeenCalled()

    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Following up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // Written with the message that creates the conversation, in one call.
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', null, expect.objectContaining({
      references: [{ kind: 'messages', id: 'session-1', item_ids: ['m-1'] }],
    }), expect.any(String)))
  })

  it('drops a pick the server will never accept, instead of wedging the composer', async () => {
    // A whole-thread pick needs the source thread's summary, and a young
    // thread has none. The pick is invisible in the composer, so leaving it
    // in place would make every further attempt fail identically and the only
    // escape would be a reload — which discards it anyway.
    sessionStorage.setItem(
      'rainver.reference.room.room-1',
      JSON.stringify([{ kind: 'thread', id: 'session-9' }]),
    )
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(roomsApi.sendMessage).mockRejectedValueOnce(
      new ApiRequestError('no summary', 409, 'reference_summary_unavailable', {
        detail: 'That thread has no summary yet.',
      }),
    )
    renderRooms('/rooms?room=room-1&new=1&reference=1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Following up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledTimes(1))

    // The second attempt carries no reference, so it can actually be sent.
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-1', session_id: 'session-new', role: 'user', content: 'Following up', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' },
      task_group_ids: [], run_ids: [],
    } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(roomsApi.sendMessage).mock.calls[1]![2]).not.toHaveProperty('references')
  })

  it('names who would gain access before copying across an audience boundary', async () => {
    // A confirmation that cannot say who is being let in is not informed
    // consent. Declining attaches nothing; confirming sends back the ids the
    // refusal named, never a bare `true`.
    vi.mocked(roomsApi.messages).mockResolvedValue(polarsMessages as never)
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [initialConversation, { ...initialConversation, id: 'session-2', title: 'Other thread' }],
      total: 2, limit: 50, offset: 0,
    } as never)
    vi.mocked(roomsApi.attachReferences).mockRejectedValueOnce(
      new ApiRequestError('refused', 409, 'reference_disclosure_confirmation_required', {
        detail: 'Dana could not read this before.',
        gains_access_user_ids: ['user-2'],
      }),
    )
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    fireEvent.click((await screen.findAllByLabelText('Pick this message'))[0]!)
    fireEvent.click(await screen.findByLabelText('Attach to a thread'))
    fireEvent.click(await screen.findByRole('option', { name: 'Other thread' }))

    // Named, not counted.
    expect(await screen.findByText('Member')).toBeInTheDocument()
    vi.mocked(roomsApi.attachReferences).mockResolvedValue({ messages: [] } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Share it with them' }))

    await waitFor(() => expect(roomsApi.attachReferences).toHaveBeenLastCalledWith('room-1', 'session-2', {
      references: [{ kind: 'messages', id: 'session-1', item_ids: [expect.any(String)] }],
      confirm_disclosure: ['user-2'],
    }))
  })

  it('links a conversation reference back to the thread it came from', async () => {
    // The branch `source_room_id` exists for, and the one that was broken:
    // hand-building the path missed the Space prefix every route lives under,
    // so "open the source" navigated to Home.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm-ref', space_id: 'space-1', session_id: 'session-1', role: 'system',
        content: 'We ruled out polars.', created_at: '2026-08-29T10:00:00.000Z',
        metadata_json: {
          room_display: 'reference',
          reference: {
            kind: 'messages', source_id: 'session-7', source_room_id: 'room-7',
            source_title: 'Storage options', item_ids: ['m-9'], trust: 'domain_approved',
            clipped: false, attached_by_user_id: 'user-1',
            attached_at: '2026-08-29T10:00:00.000Z',
          },
        },
      }],
      total: 1, limit: 50, offset: 0,
    } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    expect(await screen.findByRole('link', { name: 'Storage options' }))
      .toHaveAttribute('href', '/spaces/space-1/projects/project-1/rooms?room=room-7&conversation=session-7')
    // Rainver's own record of what a colleague said, so it is not fenced off.
    expect(screen.queryByText('outside Rainver')).not.toBeInTheDocument()
  })

  it('carries a whole thread into a new one, shows the draft, and lets it be dropped', async () => {
    // The header action holds a `thread` pick for the next thread. A draft
    // has to be visible to be a draft, and droppable: an invisible pick with
    // no way out is the failure this exists to close.
    vi.mocked(roomsApi.messages).mockResolvedValue(polarsMessages as never)
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-2', session_id: 'session-new', role: 'user', content: 'Next', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' },
      task_group_ids: [], run_ids: [],
    } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')

    fireEvent.click(await screen.findByRole('button', { name: /Carry into a new thread/ }))
    expect(await screen.findByText(/A conversation will be copied in with this message/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Do not carry this in' }))
    await waitFor(() => expect(screen.queryByText(/will be copied in with this message/)).not.toBeInTheDocument())
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Next' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledTimes(1))
    expect(vi.mocked(roomsApi.sendMessage).mock.calls[0]![2]).not.toHaveProperty('references')
  })

  it('attaches nothing when the disclosure is declined', async () => {
    // Declining is a real answer, not a dismissal: no partial attach, because
    // the picks are resolved and written in one transaction on the server.
    vi.mocked(roomsApi.messages).mockResolvedValue(polarsMessages as never)
    vi.mocked(roomsApi.conversations).mockResolvedValue({
      items: [initialConversation, { ...initialConversation, id: 'session-2', title: 'Other thread' }],
      total: 2, limit: 50, offset: 0,
    } as never)
    vi.mocked(roomsApi.attachReferences).mockRejectedValue(
      new ApiRequestError('refused', 409, 'reference_disclosure_confirmation_required', {
        detail: 'Member could not read this before.',
        gains_access_user_ids: ['user-2'],
      }),
    )
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    fireEvent.click((await screen.findAllByLabelText('Pick this message'))[0]!)
    fireEvent.click(await screen.findByLabelText('Attach to a thread'))
    fireEvent.click(await screen.findByRole('option', { name: 'Other thread' }))

    fireEvent.click(await screen.findByRole('button', { name: /Don't attach/ }))
    await waitFor(() => expect(screen.queryByText(/could not read this before/)).not.toBeInTheDocument())
    // One call — the refused one. Declining sent nothing further.
    expect(roomsApi.attachReferences).toHaveBeenCalledTimes(1)
  })

  it('renders a reference as its origin, not as somebody speaking', async () => {
    // A reference is `role: 'system'` and has no speaker. Rendered as a
    // bubble it would read as the Agent having said a colleague's words, or a
    // vendor transcript's — which is exactly what the trust label exists to
    // prevent anyone concluding.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm-ref', space_id: 'space-1', session_id: 'session-1', role: 'system',
        content: 'Quoted transcript.', created_at: '2026-08-29T10:00:00.000Z',
        metadata_json: {
          room_display: 'reference',
          reference: {
            kind: 'imported_session', source_id: 'imported-1', source_room_id: null,
            source_title: 'Branch review', item_ids: [], trust: 'external_untrusted',
            clipped: false, attached_by_user_id: 'user-1',
            attached_at: '2026-08-29T10:00:00.000Z',
          },
        },
      }],
      total: 1, limit: 50, offset: 0,
    } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    expect(await screen.findByTestId('reference-m-ref')).toBeInTheDocument()
    expect(screen.getByText(/brought in an imported session/)).toBeInTheDocument()
    expect(screen.getByText('outside Rainver')).toBeInTheDocument()
    // Its origin is reachable, and it is the session's own page.
    expect(screen.getByRole('link', { name: 'Branch review' }))
      .toHaveAttribute('href', '/spaces/space-1/projects/project-1/imported-sessions/imported-1')
  })

  it('does not carry a used reference into the next thread', async () => {
    // The pick outlives every conversation switch on the page, so consuming it
    // has to be explicit. Pressing "New" after sending puts the page back into
    // the same state the pick was read in — without clearing it, the same
    // content silently attaches to a second thread nobody picked it for.
    sessionStorage.setItem(
      'rainver.reference.room.room-1',
      JSON.stringify([{ kind: 'imported_session', id: 'imported-1' }]),
    )
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-1', session_id: 'session-new', role: 'user', content: 'First', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' },
      task_group_ids: [], run_ids: [],
    } as never)
    renderRooms('/rooms?room=room-1&new=1&reference=1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'First' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', null, expect.objectContaining({
      references: [{ kind: 'imported_session', id: 'imported-1' }],
    }), expect.any(String)))

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(roomsApi.sendMessage).mock.calls[1]![2]).not.toHaveProperty('references')
  })

  it('does not attach a reference onto a conversation that already exists', async () => {
    sessionStorage.setItem(
      'rainver.reference.room.room-1',
      JSON.stringify([{ kind: 'imported_session', id: 'imported-1' }]),
    )
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-1', session_id: 'session-1', role: 'user', content: 'Hello', metadata_json: {} },
      conversation: initialConversation, task_group_ids: [], run_ids: [],
    } as never)
    renderRooms('/rooms?room=room-1&conversation=session-1&reference=1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // The server refuses references on an addressed send, so the client must
    // not offer them there either.
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith(
      'room-1', 'session-1', expect.not.objectContaining({ references: expect.anything() }),
    ))
  })

  it('keeps a locally committed Room when a slower catalog response still lacks it', async () => {
    // The stale-response guard: a refresh issued before the create can resolve
    // after it, and its older list would drop the Room that is already
    // committed. Distinct from a *failing* refresh, which the test above
    // covers.
    type RoomPage = Awaited<ReturnType<typeof roomsApi.list>>
    const onlyExisting: RoomPage = { items: [room], total: 1, limit: 50, offset: 0 }
    let resolveRefresh!: (page: RoomPage) => void
    vi.mocked(roomsApi.list)
      .mockResolvedValueOnce(onlyExisting)
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve }))
      .mockResolvedValue(onlyExisting)
    vi.mocked(roomsApi.create).mockResolvedValue({
      room: { ...room, id: 'room-2', title: 'Second Room' }, user_members: [], agent_members: [],
    } as never)

    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    await openLimitedRoomWith('Reader')
    await waitFor(() => expect(resolveRefresh).toBeTypeOf('function'))

    await act(async () => { resolveRefresh(onlyExisting); await Promise.resolve() })
    expect(await screen.findByText('Second Room')).toBeInTheDocument()
    expect(roomsApi.create).toHaveBeenCalledTimes(1)
  })

  it('drops a locally committed Room when the active Space changes', async () => {
    // The pending entry is Space-scoped: carrying it across a Space switch
    // would show a Room from somewhere else.
    vi.mocked(roomsApi.list).mockResolvedValue({ items: [room], total: 1, limit: 50, offset: 0 })
    vi.mocked(roomsApi.create).mockResolvedValue({
      room: { ...room, id: 'room-2', title: 'Second Room' }, user_members: [], agent_members: [],
    } as never)

    const view = renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    await openLimitedRoomWith('Reader')
    await waitFor(() => expect(screen.getAllByText('Second Room').length).toBeGreaterThan(0))

    mockedSpaceContext.activeSpaceId = 'space-2'
    view.rerender(roomsAt('/spaces/space-2/projects/project-2/rooms?room=room-1&conversation=session-1'))
    await waitFor(() => expect(screen.queryByText('Second Room')).not.toBeInTheDocument())
  })

  it('renders the Project state panel beside the conversation, deep-linking into the owning Area (Phase B)', async () => {
    vi.mocked(projectsApi.getOverview).mockResolvedValue({
      project: { id: 'project-1', name: 'Project One', primary_mode: 'research', status: 'active' },
      brief: null,
      definition_status: { status: 'initialized', basis: 'published_brief_goal', goal_or_problem: 'Understand memory quality' },
      available_modes: ['research'],
      attention: [{ id: 'attention-1', title: 'Candidate awaiting review', summary: null, href: '/projects/project-1/inquiry?candidate=candidate-1' }],
    } as unknown as Awaited<ReturnType<typeof projectsApi.getOverview>>)

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Project initialized')).toBeInTheDocument()
    // The panel shows the same attention list Pulse and the shell show, and
    // nothing invented for it: the per-Mode "next actions" it used to carry
    // all pointed at Areas the sidebar lists.
    expect(screen.queryByText('Next')).toBeNull()
    const attentionItem = await screen.findByRole('link', { name: 'Candidate awaiting review' })
    expect(attentionItem).toHaveAttribute('href', expect.stringContaining('candidate=candidate-1'))
  })
})
