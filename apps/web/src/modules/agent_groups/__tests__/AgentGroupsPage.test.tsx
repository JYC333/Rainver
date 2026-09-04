import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentGroupsPage from '../AgentGroupsPage'
import {
  ApiRequestError,
  agentsApi,
  hostsApi,
  projectFoldersApi,
  projectsApi,
  proposalsApi,
  roomsApi,
  runsApi,
  sessionsApi,
  spacesApi,
} from '../../../api/client'
import type { AgentOut, Project, Room, RoomConversation, RoomDetail, Run, RunTurn, TurnPart } from '../../../types/api'

/** A turn in progress, for the stream mock. */
function workingTurn(runId: string, parts: TurnPart[]): RunTurn {
  return {
    schema_version: 'run_turn.v1',
    run_id: runId,
    state: 'working',
    source: 'run_events',
    parts,
    blocked_on: null,
    cursor: parts.length,
    updated_at: null,
  }
}

/** A turn as read back, for the read-once mock. */
function doneTurn(runId: string, parts: TurnPart[]): RunTurn {
  return { ...workingTurn(runId, parts), state: 'done' }
}

const mockedSpaceContext = vi.hoisted(() => ({ activeSpaceId: 'space-1', userId: 'user-1' }))

vi.mock('../../../api/client', async () => {
  const { ApiRequestError } = await import('../../../test/apiClientMock')
  return {
  ApiRequestError,
  agentsApi: { list: vi.fn(), conversationBackends: vi.fn(), listRuntimeProfiles: vi.fn() },
  projectsApi: { list: vi.fn(), getOverview: vi.fn(), readers: vi.fn(), hostExecutionTargets: vi.fn() },
  hostsApi: { listRuntimeAdapters: vi.fn() },
  projectFoldersApi: { list: vi.fn(), listExecutionReady: vi.fn() },
  roomsApi: {
    list: vi.fn(),
    get: vi.fn(),
    attachReferences: vi.fn(),
    conversations: vi.fn(),
    createConversation: vi.fn(),
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
    resetAgentContext: vi.fn(),
  },
  sessionsApi: {
    executionContext: vi.fn(),
    initializeExecution: vi.fn(),
    mutateExecutionAttachments: vi.fn(),
  },
  runsApi: { get: vi.fn(), streamTurn: vi.fn(), turn: vi.fn() },
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
    trigger_policy: 'owner_only',
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
    // A terminal Run with no reply has its turn read once; tests that do not
    // care still need the call to return something.
    vi.mocked(runsApi.turn).mockResolvedValue(workingTurn('run-default', []))
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
    vi.mocked(projectsApi.hostExecutionTargets).mockResolvedValue({ targets: [] })
    vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [] })
    vi.mocked(projectsApi.getOverview).mockResolvedValue({
      project: { id: 'project-1', name: 'Project One', status: 'active' },
      brief: null,
      definition_status: { status: 'initialized', basis: 'published_brief_goal', goal_or_problem: 'Understand memory quality' },
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
    vi.mocked(agentsApi.listRuntimeProfiles).mockResolvedValue([])
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      summary: {
        session_id: 'session-1', state: 'initialized',
        host: { host_id: 'host-1', host_name: 'Local Host', host_kind: 'server', online: true, managed_workspace_available: true, daemon_last_heartbeat_at: null },
        runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', credential_profile_id: null, adapter_type: 'codex_cli', runtime_installation: 'codex' },
        primary: { kind: 'managed', managed_workspace_id: 'session-1', display_path: null }, attachments: [],
        dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null,
      },
      available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
    } as never)
    vi.mocked(spacesApi.members).mockResolvedValue([
      { user_id: 'user-1', display_name: 'Owner', email: 'owner@example.test' },
      { user_id: 'user-2', display_name: 'Member', email: 'member@example.test' },
      // In the Space, not on this Project — what the old candidate source
      // would have offered and the server would have refused.
      { user_id: 'user-9', display_name: 'Outsider', email: 'outsider@example.test' },
    ] as Awaited<ReturnType<typeof spacesApi.members>>)
    vi.mocked(runsApi.streamTurn).mockResolvedValue(undefined)
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

  it('removes a specialist through the shared confirm dialog, not the browser prompt', async () => {
    vi.mocked(roomsApi.get).mockResolvedValue({
      ...detail,
      agent_members: [
        ...detail.agent_members,
        { ...detail.agent_members[0]!, id: 'agent-member-2', agent_id: 'agent-2', agent_name: 'Critical Reviewer', agent_kind: 'standard', role: 'member' },
      ],
    })
    const browserConfirm = vi.spyOn(window, 'confirm')
    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Room roster')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Configure Critical Reviewer' })).toHaveAttribute('href', expect.stringContaining('/agents/agent-2'))
    expect(screen.getByRole('link', { name: /Create a new Agent/ })).toHaveAttribute('href', expect.stringContaining('/agents/new'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove Critical Reviewer' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Remove Critical Reviewer from this Room?')
    expect(roomsApi.removeAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(roomsApi.removeAgent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Critical Reviewer' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(roomsApi.removeAgent).toHaveBeenCalledWith('room-1', 'agent-2'))
    expect(browserConfirm).not.toHaveBeenCalled()
  })

  it('shows host-bound specialist facts and lets the host owner reset context', async () => {
    vi.mocked(roomsApi.get).mockResolvedValue({
      ...detail,
      agent_members: [{
        ...detail.agent_members[0]!,
        agent_id: 'agent-host',
        agent_name: 'Remote Reviewer',
        agent_kind: 'standard',
        role: 'member',
        host_name: 'Workstation',
        host_online: false,
        host_owner_is_me: true,
      }],
    })
    vi.mocked(roomsApi.resetAgentContext).mockResolvedValue(detail as never)
    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText(/on Workstation · owner-only/)).toBeInTheDocument()
    expect(screen.getByText('offline')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset context for Remote Reviewer' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Reset Remote Reviewer\'s context?')
    fireEvent.click(screen.getByRole('button', { name: 'Reset context' }))
    await waitFor(() => expect(roomsApi.resetAgentContext).toHaveBeenCalledWith('room-1', 'agent-host'))
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
    vi.mocked(runsApi.streamTurn).mockImplementation(async (_runId, options) => {
      options.onTurn(workingTurn('run-1', [
        { type: 'tool_call', index: 0, call_id: 'c1', name: 'Agent started',
          kind: null, status: 'running', input: null, output: null },
      ]))
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Owner contribution')).toBeInTheDocument()
    expect(screen.getByText('Member contribution')).toBeInTheDocument()
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Member').length).toBeGreaterThan(0)
    expect(await screen.findByText('Agent started')).toBeInTheDocument()
  })

  it('keeps a failed turn on screen, because nothing else says what went wrong', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-failed',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: 'user-1',
        sender_agent_id: null,
        role: 'user',
        content: 'Do the thing.',
        metadata_json: { run_ids: ['run-failed'] },
        created_at: '2026-07-26T00:00:02.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    // A failed Run writes no assistant message, so its turn is the only
    // account of the failure. Dropping it when the Run goes terminal would
    // take that away and leave an empty conversation.
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-failed', status: 'failed' } as unknown as Run)
    // Already terminal when this surface first sees it, so there is nothing
    // to stream: the turn is read once.
    vi.mocked(runsApi.turn).mockResolvedValue({
      ...workingTurn('run-failed', [{
        type: 'diagnostic', index: 0, level: 'error',
        text: 'No credential profile is available for this runtime.',
        error_code: 'cli_credential_unavailable',
      }]),
      state: 'failed',
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('No credential profile is available for this runtime.')).toBeInTheDocument()
  })

  it('asks once for a terminal Run\'s turn, and tries again if that ask fails', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-retry',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: 'user-1',
        sender_agent_id: null,
        role: 'user',
        content: 'Do the thing.',
        metadata_json: { run_ids: ['run-retry'] },
        created_at: '2026-07-26T00:00:02.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-retry', status: 'failed' } as unknown as Run)
    // One blip, then it works. Holding the "already asked" mark through a
    // failure would make that blip permanent — and this Run's turn is the
    // only account of why it failed.
    vi.mocked(runsApi.turn)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({
        ...workingTurn('run-retry', [{
          type: 'diagnostic', index: 0, level: 'error',
          text: 'Upstream refused.', error_code: 'provider_unavailable',
        }]),
        state: 'failed',
      })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Upstream refused.')).toBeInTheDocument()
    // Twice: the blip, then the retry. The in-flight mark this asserts is
    // released on failure — held, it would make one blip permanent, and this
    // Run's turn is the only account of why it failed.
    expect(runsApi.turn).toHaveBeenCalledTimes(2)
  })

  it('asks for a terminal turn once, not once per poll', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-once',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: 'user-1',
        sender_agent_id: null,
        role: 'user',
        content: 'Do the thing.',
        metadata_json: { run_ids: ['run-once'] },
        created_at: '2026-07-26T00:00:02.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-once', status: 'failed' } as unknown as Run)
    // Never resolving: the window this guards is the one before the first
    // answer lands, when `liveTurns` cannot yet absorb a repeat. Only a
    // driven poll opens it — a `waitFor` does not.
    vi.mocked(runsApi.turn).mockReturnValue(new Promise(() => {}))

    vi.useFakeTimers()
    try {
      renderRooms('/rooms?room=room-1&conversation=session-1')
      await act(async () => { await vi.advanceTimersByTimeAsync(16) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(runsApi.turn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds a finished turn\'s work above the reply it produced', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [
        {
          id: 'message-ask', session_id: 'session-1', space_id: 'space-1',
          user_id: 'user-1', sender_agent_id: null, role: 'user',
          content: 'Find it.', metadata_json: { run_ids: ['run-fold'] },
          created_at: '2026-07-26T00:00:02.000Z',
        },
        {
          id: 'message-reply', session_id: 'session-1', space_id: 'space-1',
          user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
          content: 'Found three.', metadata_json: null, run_id: 'run-fold',
          created_at: '2026-07-26T00:00:03.000Z',
        },
      ],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-fold', status: 'running' } as unknown as Run)
    // As the server streams it: the steps, then the state it settled in
    // before the stream closes. The turn's own state is what the surface
    // renders — the server decides it with facts a client does not have.
    vi.mocked(runsApi.streamTurn).mockImplementation(async (_runId, options) => {
      const parts: TurnPart[] = [{
        type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
        kind: null, status: 'succeeded', input: null, output: null,
      }]
      options.onTurn(workingTurn('run-fold', parts))
      options.onTurn(doneTurn('run-fold', parts))
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    // D3's finished state, in the Room: the reply is the bubble and the work
    // that produced it folds above it — rather than vanishing the moment the
    // reply is written.
    expect(await screen.findByText('Found three.')).toBeInTheDocument()
    expect(await screen.findByText('show work (1 step)')).toBeInTheDocument()
  })

  it('keeps saying it is blocked once the pause notice arrives as a reply', async () => {
    // The server writes an assistant row at the pause, not only at the end
    // (`chatTurnFinalizer` posts the waiting-for-review notice under the
    // Agent's name). So a paused Run reaches a steady state where a reply and
    // a blocked turn coexist — and a surface that reads "there is a reply" as
    // "the turn is over" silently drops the approval link, which is the one
    // thing a paused turn exists to show.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [
        {
          id: 'message-ask', session_id: 'session-1', space_id: 'space-1',
          user_id: 'user-1', sender_agent_id: null, role: 'user',
          content: 'Do the protected thing.', metadata_json: { run_ids: ['run-paused'] },
          created_at: '2026-07-26T00:00:02.000Z',
        },
        {
          id: 'message-notice', session_id: 'session-1', space_id: 'space-1',
          user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
          content: 'Waiting for approval before continuing.', metadata_json: null,
          run_id: 'run-paused', created_at: '2026-07-26T00:00:03.000Z',
        },
      ],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({
      id: 'run-paused', status: 'waiting_for_review',
      error_json: { authorization_request_id: 'authorization-1' },
    } as unknown as Run)
    vi.mocked(runsApi.streamTurn).mockImplementation((_runId, options) => {
      options.onTurn({ ...workingTurn('run-paused', []), state: 'blocked', blocked_on: 'authorization' })
      return new Promise(() => {})
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Waiting for approval before continuing.')).toBeInTheDocument()
    expect(screen.getByText('approval needed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review request' })).toBeInTheDocument()
  })

  it('re-watches a paused Run whose stream went away, keeping the approval link', async () => {
    // The server keeps a blocked stream open on purpose — the turn resumes
    // when somebody decides — so it waits at human pace and a proxy idle
    // timeout on that connection is the ordinary ending. The Room's own
    // recovery is to watch it again: a paused Run stays in the watch set, so
    // the next poll re-opens the stream and the link comes back.
    //
    // What must NOT happen is the read-once path claiming it: a paused Run is
    // skipped there by design, so a turn released to it would be lost for
    // good. (That the client no longer reports a blocked ending as a fault at
    // all is covered directly in `chat-api.test.ts`.)
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-notice', session_id: 'session-1', space_id: 'space-1',
        user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
        content: 'Waiting for approval before continuing.', metadata_json: null,
        run_id: 'run-timeout', created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({
      id: 'run-timeout', status: 'waiting_for_review',
      error_json: { authorization_request_id: 'authorization-1' },
    } as unknown as Run)
    let endStream!: () => void
    vi.mocked(runsApi.streamTurn).mockImplementation((_runId, options) => {
      options.onTurn({ ...workingTurn('run-timeout', []), state: 'blocked', blocked_on: 'authorization' })
      return new Promise((_resolve, rejectStream) => {
        endStream = () => rejectStream(new ApiRequestError('Run turn stream ended before the turn settled', 502))
      })
    })

    vi.useFakeTimers()
    try {
      renderRooms('/rooms?room=room-1&conversation=session-1')
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(screen.getByText('approval needed')).toBeInTheDocument()

      await act(async () => { endStream() })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

      // Watched again rather than abandoned.
      expect(vi.mocked(runsApi.streamTurn).mock.calls.length).toBeGreaterThan(1)
      expect(screen.getByText('approval needed')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Review request' })).toBeInTheDocument()
      // Never handed to the read-once path, which skips a paused Run.
      expect(vi.mocked(runsApi.turn)).not.toHaveBeenCalledWith('run-timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leave a cold-loaded Room reply saying the Agent is still working', async () => {
    // Same race as the chat panel's: the reply is written before
    // `chat_completed`, so a turn read back can still say `working` on
    // finished work — and a read is not a stream, so nothing corrects it.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-lagging', session_id: 'session-1', space_id: 'space-1',
        user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
        content: 'The answer is 42.', metadata_json: null, run_id: 'run-lagging',
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-lagging', status: 'succeeded' } as unknown as Run)
    vi.mocked(runsApi.turn).mockResolvedValue(workingTurn('run-lagging', [{
      type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
      kind: null, status: 'succeeded', input: null, output: null,
    }]))

    renderRooms('/rooms?room=room-1&conversation=session-1')

    await waitFor(() => {
      expect(screen.getByText('The answer is 42.')).toBeInTheDocument()
      expect(screen.getByText('show work (1 step)')).toBeInTheDocument()
    }, { timeout: 3000 })
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()
  })

  it('recovers a turn stranded by a broken stream, rather than saying "working" forever', async () => {
    // A stream that dies before the turn settles — a database error on the
    // poll, a dropped connection, a proxy timeout — leaves a turn on screen
    // saying the Agent is still working. Nothing else corrects it: the stream
    // is gone and the read-once effect skips any run a turn is held for.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-stranded', session_id: 'session-1', space_id: 'space-1',
        user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
        content: 'Done here.', metadata_json: null, run_id: 'run-stranded',
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    // Running while the stream is alive — so the only turn on screen is the
    // streamed one, and the read-once effect cannot reach it. It goes
    // terminal once the stream has died, which is what makes recovery
    // possible and what the stale hold used to prevent.
    let streamDied = false
    vi.mocked(runsApi.get).mockImplementation(async () => ({
      id: 'run-stranded',
      status: streamDied ? 'succeeded' : 'running',
    } as unknown as Run))
    // The stranding, exactly as it happens: the working turn lands and is
    // held, and only then does the stream die. A mock that threw before
    // delivering anything would leave nothing held — and would pass whether
    // or not the surface recovers.
    let killStream!: () => void
    vi.mocked(runsApi.streamTurn).mockImplementation((_runId, options) => {
      options.onTurn(workingTurn('run-stranded', [{
        type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
        kind: null, status: 'succeeded', input: null, output: null,
      }]))
      return new Promise((_resolve, rejectStream) => {
        killStream = () => {
          streamDied = true
          rejectStream(new Error('Run turn stream ended before the turn settled'))
        }
      })
    })
    vi.mocked(runsApi.turn).mockResolvedValue(doneTurn('run-stranded', [{
      type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
      kind: null, status: 'succeeded', input: null, output: null,
    }]))

    // Recovery arrives on the next poll, and the poll slows to 5 s once no
    // Run is active — which is exactly the moment this test creates. The
    // clock is faked and advanced past it rather than waited out: a real 5 s
    // wait makes the test's runtime hostage to the surface's poll cadence.
    vi.useFakeTimers()
    try {
      renderRooms('/rooms?room=room-1&conversation=session-1')
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      // Stranded: the turn says the Agent is working, on a finished reply.
      expect(screen.getByText('Working…')).toBeInTheDocument()

      await act(async () => { killStream() })
      // Past the idle poll, so the released turn can be read back settled.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

      expect(screen.getByText('Done here.')).toBeInTheDocument()
      // Settled: the work folds, and nothing claims the Agent is still going.
      expect(screen.getByText('show work (1 step)')).toBeInTheDocument()
      expect(screen.queryByText('Working…')).not.toBeInTheDocument()
      expect(vi.mocked(runsApi.turn)).toHaveBeenCalledWith('run-stranded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call a degraded Run failed — the server already decided it did not', async () => {
    // `degraded` records a non-blocking warning; the reply is complete.
    // `turnReadModel.turnState` maps it to `done` for exactly that reason, so
    // a surface that re-derives the state from the Run status stamps "Could
    // not complete" on a correct answer.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-degraded', session_id: 'session-1', space_id: 'space-1',
        user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
        content: 'Here is the answer you asked for.', metadata_json: null,
        run_id: 'run-degraded', created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-degraded', status: 'degraded' } as unknown as Run)
    vi.mocked(runsApi.turn).mockResolvedValue(doneTurn('run-degraded', [{
      type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
      kind: null, status: 'succeeded', input: null, output: null,
    }]))

    renderRooms('/rooms?room=room-1&conversation=session-1')

    await waitFor(() => {
      expect(screen.getByText('Here is the answer you asked for.')).toBeInTheDocument()
      // Finished work folds; failed work does not.
      expect(screen.getByText('show work (1 step)')).toBeInTheDocument()
    })
    expect(screen.queryByText('Could not complete')).not.toBeInTheDocument()
  })

  it('reads a replied turn back on reload, so its work is still there', async () => {
    // Nothing streams here: the Run was terminal before this surface existed,
    // which is every reply on a reloaded page. An Agent reply renders *as* its
    // turn, so without reading the turn back the fold exists only in the page
    // session that happened to watch it live.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-reply', session_id: 'session-1', space_id: 'space-1',
        user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
        content: 'Found three.', metadata_json: null, run_id: 'run-old',
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-old', status: 'succeeded' } as unknown as Run)
    vi.mocked(runsApi.turn).mockResolvedValue(doneTurn('run-old', [{
      type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
      kind: null, status: 'succeeded', input: null, output: null,
    }]))

    renderRooms('/rooms?room=room-1&conversation=session-1')

    // The turn is read back after the Run refresh, so both the reply and its
    // fold have to be waited for together — the reply alone is on screen from
    // the first paint, and asserting it first proves nothing about the fold.
    await waitFor(() => {
      expect(screen.getByText('Found three.')).toBeInTheDocument()
      expect(screen.getByText('show work (1 step)')).toBeInTheDocument()
    })
    expect(vi.mocked(runsApi.turn)).toHaveBeenCalledWith('run-old')
  })

  it('a Run that failed after writing its reply still says so, with its steps', async () => {
    // A failed Room Run writes `Room task failed (...)` as an assistant row.
    // Reading that reply as a finished turn would show the failure text with
    // no failure marker and no account of what went wrong.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-fail', session_id: 'session-1', space_id: 'space-1',
        user_id: null, sender_agent_id: 'agent-1', role: 'assistant',
        content: 'Room task failed (provider_unavailable): upstream refused.',
        metadata_json: null, run_id: 'run-broken',
        created_at: '2026-07-26T00:00:03.000Z',
      }],
      task_group_ids: ['group-1'],
      limit: 200,
      offset: 0,
    })
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-broken', status: 'failed' } as unknown as Run)
    vi.mocked(runsApi.turn).mockResolvedValue({
      ...doneTurn('run-broken', [{
        type: 'tool_call', index: 0, call_id: 'c1', name: 'write',
        kind: null, status: 'failed', input: null, output: null,
      }]),
      state: 'failed',
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('Could not complete')).toBeInTheDocument()
    // Failed work does not fold: the steps are the explanation.
    expect(await screen.findByText('write')).toBeInTheDocument()
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
    // A paused turn keeps its stream: it is waiting on a person, not
    // finished, and the rest of it arrives once they decide. The stream is
    // left open here, as the server leaves it — a mock that resolves would
    // clear the controller for the surface and hide whether it handles a
    // still-open blocked stream at all.
    let opened = 0
    vi.mocked(runsApi.streamTurn).mockImplementation((_runId, options) => {
      opened += 1
      options.onTurn({ ...workingTurn('run-review', []), state: 'blocked', blocked_on: 'authorization' })
      return new Promise(() => {})
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')

    expect(await screen.findByText('approval needed')).toBeInTheDocument()
    expect(screen.getByText('Review request')).toBeInTheDocument()
    expect(screen.queryByText('waiting_for_review')).not.toBeInTheDocument()
    // One stream, not one per render. Treating a blocked turn as finished
    // drops its controller while the stream is still open, and the watch
    // effect opens another on the next pass — thousands within a second.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(opened).toBe(1)
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
    vi.mocked(runsApi.streamTurn).mockImplementation(async (_runId, options) => {
      finalizeRun = () => options.onTurn({ ...workingTurn('run-1', []), state: 'done' })
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
        run_id: 'run-resume',
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

  it('surfaces the canonical Host recovery link before the first message', async () => {
    // A missing Host/CLI is a preflight state now. The composer stays blocked
    // with its draft intact while the user gets the canonical Host recovery link.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Anyone there?' } })
    expect(screen.getByRole('button', { name: 'Configure conversation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('link', { name: /configure or reconnect host/i })).toHaveAttribute('href', '/spaces/space-1/command-center')
    expect(screen.queryByRole('link', { name: /configure cli/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Room message')).toHaveValue('Anyone there?')
  })

  it('renders ACP controls in the shared composer and sends them with the Room backend', async () => {
    vi.mocked(agentsApi.conversationBackends).mockResolvedValue({
      options: [{
        runtime_profile_id: 'runtime-cli', name: 'Codex', adapter_type: 'codex_cli', model_name: null,
        requires_cli_credential: false, credential_profiles: [],
        session_config_options: [{
          id: 'model', name: 'Model', description: null, category: 'model', type: 'select',
          current_value: 'gpt-5', options: [
            { value: 'gpt-5', name: 'GPT-5', description: null, group: null },
            { value: 'gpt-5.1', name: 'GPT-5.1', description: null, group: null },
          ],
        }, {
          id: 'fast', name: 'Fast mode', description: null, category: 'model_config',
          type: 'boolean', current_value: false,
        }],
      }],
      binding: { runtime_profile_id: 'runtime-cli', adapter_type: 'codex_cli', credential_profile_id: null },
      session_config: [],
    })
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-new', session_id: 'session-1', role: 'user', content: 'Use this model', metadata_json: {} },
      conversation: initialConversation, task_group_ids: ['group-1'], run_ids: [],
    } as never)

    renderRooms('/rooms?room=room-1&conversation=session-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.1' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: 'Use this model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'session-1', expect.objectContaining({
      backends: [{
        agent_id: 'agent-1', runtime_profile_id: 'runtime-cli', credential_profile_id: null,
        session_config: [
          { id: 'model', type: 'select', value: 'gpt-5.1', category: 'model' },
          { id: 'fast', type: 'boolean', value: true, category: 'model_config' },
        ],
      }],
    })))
  })

  it('refreshes composer options from the CLI pinned during execution setup', async () => {
    let initialized = false
    const openCodeCatalog = {
      options: [{
        runtime_profile_id: 'runtime-opencode', name: 'OpenCode', adapter_type: 'opencode', model_name: null,
        requires_cli_credential: false, credential_profiles: [],
        session_config_options: [{
          id: 'model', name: 'Model', description: null, category: 'model', type: 'select' as const,
          current_value: 'openai/gpt-5', options: [{ value: 'openai/gpt-5', name: 'OpenCode GPT-5', description: null, group: 'OpenCode' }],
        }],
      }],
      binding: null,
      session_config: [],
    }
    const codexCatalog = {
      options: [{
        runtime_profile_id: 'runtime-codex', name: 'Codex', adapter_type: 'codex_cli', model_name: null,
        requires_cli_credential: false, credential_profiles: [],
        session_config_options: [{
          id: 'model', name: 'Model', description: null, category: 'model', type: 'select' as const,
          current_value: 'gpt-5.2-codex', options: [{ value: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: null, group: 'Codex' }],
        }],
      }],
      binding: { runtime_profile_id: 'runtime-codex', adapter_type: 'codex_cli', credential_profile_id: null },
      session_config: [],
    }
    vi.mocked(agentsApi.conversationBackends).mockImplementation(async () => (
      initialized ? codexCatalog : openCodeCatalog
    ))
    vi.mocked(sessionsApi.executionContext).mockImplementation(async () => ({
      summary: initialized ? {
        session_id: 'session-1', state: 'initialized',
        host: { host_id: 'host-1', host_name: 'Laptop', host_kind: 'remote', online: true, managed_workspace_available: true, daemon_last_heartbeat_at: '2026-09-04T10:00:00.000Z' },
        runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-codex', credential_profile_id: null, adapter_type: 'codex_cli', runtime_installation: 'own' },
        primary: { kind: 'managed', managed_workspace_id: 'session-1', display_path: null },
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null,
      } : {
        session_id: 'session-1', state: 'draft', host: null, runtime: null, primary: null,
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: false,
        blocked_reason: 'Confirm the execution context',
      },
      available_hosts: [{
        host_id: 'host-1', host_name: 'Laptop', host_kind: 'remote', online: true,
        managed_workspace_available: true, daemon_last_heartbeat_at: '2026-09-04T10:00:00.000Z',
      }],
      available_runtime_profiles: [{
        agent_id: 'agent-1', agent_name: 'Space Assistant', runtime_profile_id: 'runtime-codex',
        adapter_type: 'codex_cli', runtime_installation: 'own', execution_host_id: 'host-1',
        workspace_mode: 'managed', workspace_location_id: null, preferred: true, usable: true, reason: null,
      }],
      available_primary_locations: [],
    } as never))
    vi.mocked(sessionsApi.initializeExecution).mockImplementation(async () => {
      initialized = true
      return {} as never
    })

    renderRooms('/rooms?room=room-1&conversation=session-1')
    expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('OpenCode GPT-5')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm execution context' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm execution context' }))

    await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.2 Codex'))
    expect(screen.getByRole('button', { name: 'Model' })).not.toHaveTextContent('OpenCode GPT-5')
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

  it('keeps a Room-keyed reference through explicit conversation setup', async () => {
    // The consuming half of the import continuation handoff. The pick is
    // stored under the Room until the user opens a draft, then attached to
    // that explicitly selected Conversation before its first message.
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
    vi.mocked(roomsApi.createConversation).mockResolvedValue({ ...initialConversation, id: 'session-new' } as never)
    renderRooms('/rooms?room=room-1&new=1&reference=1')
    const composer = await screen.findByLabelText('Room message')
    // Read once: a reload must not resurrect a pick the person abandoned.
    expect(sessionStorage.getItem('rainver.reference.room.room-1')).toBeNull()

    fireEvent.change(composer, { target: { value: 'Picking this up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledWith('room-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.attachReferences).toHaveBeenCalledWith('room-1', 'session-new', {
      references: [{ kind: 'imported_session', id: 'imported-1' }],
    }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'session-new', expect.not.objectContaining({ references: expect.anything() })))
  })

  it('forwards disclosure confirmation when attaching a picked reference to a new draft', async () => {
    sessionStorage.setItem(
      'rainver.reference.room.room-1',
      JSON.stringify([{ kind: 'imported_session', id: 'imported-1' }]),
    )
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(roomsApi.createConversation).mockResolvedValue({ ...initialConversation, id: 'session-new' } as never)
    vi.mocked(roomsApi.attachReferences).mockRejectedValueOnce(
      new ApiRequestError('refused', 409, 'reference_disclosure_confirmation_required', {
        detail: 'Dana could not read this before.',
        gains_access_user_ids: ['user-2'],
      }),
    )
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-disclosure', session_id: 'session-new', role: 'user', content: 'Share this', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' }, task_group_ids: [], run_ids: [],
    } as never)

    renderRooms('/rooms?room=room-1&new=1&reference=1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Share this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Member')).toBeInTheDocument()
    vi.mocked(roomsApi.attachReferences).mockResolvedValue({ messages: [] } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Share it with them' }))

    await waitFor(() => expect(roomsApi.attachReferences).toHaveBeenLastCalledWith('room-1', 'session-new', {
      references: [{ kind: 'imported_session', id: 'imported-1' }],
      confirm_disclosure: ['user-2'],
    }))
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

  it('holds a pick until explicit conversation setup', async () => {
    // Preflight opens a visible draft before any message can run. The pick is
    // still held in the composer and is attached only to that selected draft.
    vi.mocked(roomsApi.messages).mockResolvedValue(polarsMessages as never)
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-2', session_id: 'session-new', role: 'user', content: 'Following up', metadata_json: {} },
      conversation: { ...initialConversation, id: 'session-new' },
      task_group_ids: [], run_ids: [],
    } as never)
    vi.mocked(roomsApi.createConversation).mockResolvedValue({ ...initialConversation, id: 'session-new' } as never)
    renderRooms('/spaces/space-1/projects/project-1/rooms?room=room-1&conversation=session-1')
    fireEvent.click((await screen.findAllByLabelText('Pick this message'))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: /Use in a new thread/ }))

    // Held, not sent: no conversation was created to hold it.
    expect(roomsApi.attachReferences).not.toHaveBeenCalled()
    expect(roomsApi.sendMessage).not.toHaveBeenCalled()

    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Following up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledWith('room-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.attachReferences).toHaveBeenCalledWith('room-1', 'session-new', {
      references: [{ kind: 'messages', id: 'session-1', item_ids: ['m-1'] }],
    }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'session-new', expect.anything()))
  })

  it('does not send a picked draft until execution is configured', async () => {
    // The preflight gate owns the send boundary. A missing execution context
    // must not make the message or the picked content disappear.
    sessionStorage.setItem(
      'rainver.reference.room.room-1',
      JSON.stringify([{ kind: 'thread', id: 'session-9' }]),
    )
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    renderRooms('/rooms?room=room-1&new=1&reference=1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Following up' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(roomsApi.sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText(/will be attached to this conversation/i)).toBeInTheDocument()
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
    expect(await screen.findByText(/will be attached to this conversation before the message/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Do not carry this in' }))
    await waitFor(() => expect(screen.queryByText(/will be attached to this conversation before the message/)).not.toBeInTheDocument())
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Next' } })
    vi.mocked(roomsApi.createConversation).mockResolvedValue({ ...initialConversation, id: 'session-new' } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledWith('room-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
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

  it('renders execution system events as labeled timeline entries', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm-execution',
        space_id: 'space-1',
        session_id: 'session-1',
        user_id: null,
        sender_agent_id: null,
        role: 'system',
        content: 'Execution context initialized on Local Host.',
        metadata_json: { event_type: 'execution_context_initialized' },
        created_at: '2026-08-29T10:00:00.000Z',
      }],
      total: 1,
      limit: 50,
      offset: 0,
    } as never)
    renderRooms('/rooms?room=room-1&conversation=session-1')
    const entry = await screen.findByText('Execution context initialized on Local Host.')
    expect(entry.closest('[data-role="system"]')).toBeInTheDocument()
    expect(within(entry.closest('[data-role="system"]')!).getByText('Execution')).toBeInTheDocument()
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
    vi.mocked(roomsApi.createConversation)
      .mockResolvedValueOnce({ ...initialConversation, id: 'session-new' } as never)
      .mockResolvedValueOnce({ ...initialConversation, id: 'session-second' } as never)
    renderRooms('/rooms?room=room-1&new=1&reference=1')
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'First' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledWith('room-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.attachReferences).toHaveBeenCalledWith('room-1', 'session-new', {
      references: [{ kind: 'imported_session', id: 'imported-1' }],
    }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'session-new', expect.not.objectContaining({ references: expect.anything() })))

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
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
    // A terminal Run with no reply has its turn read once; tests that do not
    // care still need the call to return something.
    vi.mocked(runsApi.turn).mockResolvedValue(workingTurn('run-default', []))
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
      project: { id: 'project-1', name: 'Project One', status: 'active' },
      brief: null,
      definition_status: { status: 'initialized', basis: 'published_brief_goal', goal_or_problem: 'Understand memory quality' },
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
