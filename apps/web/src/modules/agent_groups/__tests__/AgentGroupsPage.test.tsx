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
import type { AgentOut, Project, Room, RoomDetail, Run } from '../../../types/api'

const mockedSpaceContext = vi.hoisted(() => ({ activeSpaceId: 'space-1', userId: 'user-1' }))

vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status: number
    code?: string
    payload?: Record<string, unknown>
    constructor(message: string, status: number, code?: string, payload?: Record<string, unknown>) {
      super(message)
      this.status = status
      this.code = code
      this.payload = payload
    }
  },
  agentsApi: { list: vi.fn(), conversationBackends: vi.fn() },
  projectsApi: { list: vi.fn(), getOverview: vi.fn() },
  projectFoldersApi: { list: vi.fn(), listExecutionReady: vi.fn() },
  roomsApi: {
    list: vi.fn(),
    get: vi.fn(),
    conversations: vi.fn(),
    summary: vi.fn(),
    messages: vi.fn(),
    create: vi.fn(),
    createConversation: vi.fn(),
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
} as Awaited<ReturnType<typeof roomsApi.create>>['conversation']

const detail: RoomDetail = {
  room,
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
  conversation: null,
}

describe('Rooms page', () => {
  beforeEach(() => {
    // Reset queued one-shot implementations as well as call history. Several
    // catalog race tests intentionally install response sequences, and a
    // leftover sequence must not change the next test's page state.
    vi.resetAllMocks()
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
      mode_projection: {
        mode: 'research',
        current_state_summary: 'Gathering evidence.',
        progress_indicators: [],
        focus_set: [],
        next_actions: [],
      },
      available_modes: ['research'],
      attention: [],
      entity_summaries: [],
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
    ] as Awaited<ReturnType<typeof spacesApi.members>>)
    vi.mocked(runsApi.streamEvents).mockResolvedValue(undefined)
  })

  it('shows a project-bound Room with persistent conversations and human/agent rosters', async () => {
    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

    expect((await screen.findAllByText('Research Room')).length).toBeGreaterThan(0)
    expect(screen.getByText('2 people · 1 agents')).toBeInTheDocument()
    expect(screen.getAllByText('Evidence review').length).toBeGreaterThan(0)
    expect(screen.getByRole('main', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Room and conversation navigation' })).toBeInTheDocument()
    expect(screen.getByText('Rooms', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText('New Room', { selector: 'summary' })).toBeInTheDocument()
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
    render(
      <MemoryRouter initialEntries={['/rooms']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-old']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Personal Agent Memory' })).toBeInTheDocument()
    expect(roomsApi.get).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('New conversation')).not.toBeInTheDocument()
  })

  it('follows new replies at the bottom without pulling back a user reading history', async () => {
    let resolveMessages!: (value: Awaited<ReturnType<typeof roomsApi.messages>>) => void
    vi.mocked(roomsApi.messages).mockImplementationOnce(() =>
      new Promise(resolve => { resolveMessages = resolve }))

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

    const conversation = await screen.findByRole('log', { name: 'Conversation messages' })
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
          id: 'message-latest',
          session_id: 'session-1',
          space_id: 'space-1',
          user_id: null,
          sender_agent_id: 'agent-1',
          role: 'assistant',
          content: 'Latest reply',
          metadata_json: null,
          created_at: '2026-07-26T00:00:03.000Z',
        }],
        task_group_ids: [],
        limit: 200,
        offset: 0,
      })
    })
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'auto' }))

    scrollTo.mockClear()
    conversation.scrollTop = 100
    fireEvent.scroll(conversation)
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'message-newer',
        session_id: 'session-1',
        space_id: 'space-1',
        user_id: null,
        sender_agent_id: 'agent-1',
        role: 'assistant',
        content: 'A newer reply',
        metadata_json: null,
        created_at: '2026-07-26T00:00:04.000Z',
      }],
      task_group_ids: [],
      limit: 200,
      offset: 0,
    })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByText('A newer reply')).toBeInTheDocument()
    expect(scrollTo).not.toHaveBeenCalled()
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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('approval needed')).toBeInTheDocument()
    expect(screen.getByText('Review request')).toBeInTheDocument()
    expect(screen.queryByText('waiting_for_review')).not.toBeInTheDocument()
    expect(runsApi.streamEvents).not.toHaveBeenCalled()
  })

  it('loads older Room history and does not refetch terminal Runs', async () => {
    const recent = Array.from({ length: 50 }, (_, index) => ({
      id: `message-${index}`,
      session_id: 'session-1',
      space_id: 'space-1',
      user_id: 'user-1',
      sender_agent_id: null,
      role: 'user' as const,
      content: `Recent ${index}`,
      metadata_json: index === 0 ? { run_ids: ['run-terminal'] } : null,
      created_at: `2026-07-26T00:00:${String(index).padStart(2, '0')}.000Z`,
    }))
    vi.mocked(roomsApi.messages)
      .mockResolvedValueOnce({
        items: recent,
        task_group_ids: ['group-1'],
        limit: 50,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [{
          ...recent[0],
          id: 'message-older',
          content: 'Oldest message',
        }],
        task_group_ids: ['group-1'],
        limit: 50,
        offset: 50,
      })
      .mockResolvedValue({
        items: recent,
        task_group_ids: ['group-1'],
        limit: 50,
        offset: 0,
      })
    vi.mocked(runsApi.get).mockResolvedValue({
      id: 'run-terminal',
      status: 'succeeded',
    } as Run)

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }))
    expect(await screen.findByText('Oldest message')).toBeInTheDocument()
    expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'session-1', {
      limit: 50,
      offset: 50,
    })

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledTimes(3))
    expect(runsApi.get).toHaveBeenCalledTimes(1)
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
            action_id: 'inquiry.record_conclusion',
            status: 'proposed',
            proposal_id: 'proposal-1',
            proposal_type: 'inquiry_conclusion',
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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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
    expect(await screen.findByText('研究结论已记录。助手正在下方继续。')).toBeInTheDocument()
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
            action_id: 'inquiry.record_conclusion',
            status: 'proposed',
            proposal_id: 'proposal-2',
            proposal_type: 'inquiry_conclusion',
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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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
            action_id: 'inquiry.propose_thread',
            status: 'proposed',
            proposal_id: 'proposal-duplicate',
            proposal_type: 'inquiry_thread_create',
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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

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

  it('opens a Project conversation in one click when the Project has no Room yet, without asking for a roster', async () => {
    vi.mocked(roomsApi.list).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 })
    vi.mocked(roomsApi.create).mockResolvedValue({ room, user_members: [], agent_members: [], conversation: initialConversation } as Awaited<ReturnType<typeof roomsApi.create>>)

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/rooms']}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const startButton = await screen.findByRole('button', { name: /start a conversation/i })
    expect(screen.queryByText('Manager agent')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Room' })).not.toBeInTheDocument()
    fireEvent.click(startButton)

    // One click has to produce a Room *and* its first conversation — a Room
    // with no conversation cannot be spoken to.
    await waitFor(() => expect(roomsApi.create).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      title: 'Project One Room',
    }), expect.any(String)))
    expect(roomsApi.createConversation).not.toHaveBeenCalled()
  })

  it('turns a missing backend response into actionable setup links', async () => {
    vi.mocked(roomsApi.list).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 })
    vi.mocked(roomsApi.create).mockRejectedValue(new ApiRequestError(
      'Configure a conversation backend',
      409,
      'conversation_backend_required',
      { code: 'conversation_backend_required', setup_targets: ['model_providers', 'cli_credentials'] },
    ))

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/rooms']}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /start a conversation/i }))
    expect(await screen.findByText(/set up a conversation backend/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /configure an api provider/i })).toHaveAttribute('href', '/spaces/space-1/providers')
    expect(screen.getByRole('link', { name: /grant a cli credential/i })).toHaveAttribute('href', '/cli-profiles')
  })

  it('retains a successfully created Room when the catalog is stale and the detail read fails', async () => {
    vi.mocked(roomsApi.list)
      .mockResolvedValueOnce({ items: [], total: 0, limit: 50, offset: 0 })
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 })
    vi.mocked(roomsApi.get).mockRejectedValue(new Error('Detail lagged'))
    vi.mocked(roomsApi.create).mockResolvedValue({ room, user_members: [], agent_members: [], conversation: initialConversation } as Awaited<ReturnType<typeof roomsApi.create>>)

    const view = render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/rooms']}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /start a conversation/i }))

    expect(roomsApi.createConversation).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getAllByText('Research Room').length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: /start a conversation/i })).not.toBeInTheDocument()
    expect(roomsApi.create).toHaveBeenCalledTimes(1)

    mockedSpaceContext.activeSpaceId = 'space-2'
    view.rerender(
      <MemoryRouter initialEntries={['/spaces/space-2/projects/project-2/rooms']}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.queryByText('Research Room')).not.toBeInTheDocument())
  })

  it('keeps the locally committed Room when a delayed catalog response is still empty', async () => {
    type RoomPage = Awaited<ReturnType<typeof roomsApi.list>>
    const emptyPage: RoomPage = { items: [], total: 0, limit: 50, offset: 0 }
    let resolveRefresh!: (page: RoomPage) => void
    vi.mocked(roomsApi.list)
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve }))
      .mockResolvedValue(emptyPage)
    vi.mocked(roomsApi.get).mockRejectedValue(new Error('Detail lagged'))
    vi.mocked(roomsApi.create).mockResolvedValue({ room, user_members: [], agent_members: [], conversation: initialConversation } as Awaited<ReturnType<typeof roomsApi.create>>)

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/rooms']}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /start a conversation/i }))
    await waitFor(() => expect(roomsApi.list).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveRefresh(emptyPage)
      await Promise.resolve()
    })

    expect(await screen.findByText('Research Room')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start a conversation/i })).not.toBeInTheDocument()
    expect(roomsApi.create).toHaveBeenCalledTimes(1)
  })

  it('keeps a created Room reachable when catalog refresh fails', async () => {
    let refreshShouldFail = false
    vi.mocked(roomsApi.list).mockImplementation(() => refreshShouldFail
      ? Promise.reject(new Error('Refresh failed'))
      : Promise.resolve({ items: [], total: 0, limit: 50, offset: 0 }))
    vi.mocked(roomsApi.create).mockResolvedValue({ room, user_members: [], agent_members: [], conversation: initialConversation } as Awaited<ReturnType<typeof roomsApi.create>>)

    render(
      <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/rooms']}>
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/rooms" element={<AgentGroupsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const startButton = await screen.findByRole('button', { name: /start a conversation/i })
    refreshShouldFail = true
    fireEvent.click(startButton)

    await waitFor(() => expect(screen.getAllByText('Research Room').length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: /start a conversation/i })).not.toBeInTheDocument()
    expect(roomsApi.create).toHaveBeenCalledTimes(1)
  })

  it('renders the Project state panel beside the conversation, deep-linking into the owning Area (Phase B)', async () => {
    vi.mocked(projectsApi.getOverview).mockResolvedValue({
      project: { id: 'project-1', name: 'Project One', primary_mode: 'research', status: 'active' },
      brief: null,
      definition_status: { status: 'initialized', basis: 'published_brief_goal', goal_or_problem: 'Understand memory quality' },
      mode_projection: {
        mode: 'research',
        current_state_summary: 'Two Threads are open; one search is running.',
        progress_indicators: [],
        focus_set: [],
        next_actions: [{ id: 'action-1', label: 'Review new evidence', href: '/projects/project-1/inquiry', kind: 'read_evidence' }],
      },
      available_modes: ['research'],
      attention: [{ id: 'attention-1', title: 'Candidate awaiting review', summary: null, href: '/projects/project-1/inquiry?candidate=candidate-1' }],
      entity_summaries: [],
    } as unknown as Awaited<ReturnType<typeof projectsApi.getOverview>>)

    render(
      <MemoryRouter initialEntries={['/rooms?room=room-1&conversation=session-1']}>
        <AgentGroupsPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Two Threads are open; one search is running.')).toBeInTheDocument()
    expect(screen.getByText('Project initialized')).toBeInTheDocument()
    // Distinct hrefs per fixture item so this proves each row links to its
    // own href, not just that some Inquiry-shaped link exists somewhere.
    const nextAction = await screen.findByRole('link', { name: 'Review new evidence' })
    expect(nextAction).toHaveAttribute('href', expect.stringContaining('/projects/project-1/inquiry'))
    expect(nextAction).not.toHaveAttribute('href', expect.stringContaining('candidate=candidate-1'))
    const attentionItem = await screen.findByRole('link', { name: 'Candidate awaiting review' })
    expect(attentionItem).toHaveAttribute('href', expect.stringContaining('candidate=candidate-1'))
  })
})
