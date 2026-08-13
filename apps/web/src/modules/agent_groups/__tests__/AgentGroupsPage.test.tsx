import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentGroupsPage from '../AgentGroupsPage'
import {
  agentsApi,
  projectFoldersApi,
  projectsApi,
  roomsApi,
  runsApi,
  spacesApi,
} from '../../../api/client'
import type { AgentOut, Project, Room, RoomDetail, Run } from '../../../types/api'

vi.mock('../../../api/client', () => ({
  agentsApi: { list: vi.fn(), conversationBackends: vi.fn() },
  projectsApi: { list: vi.fn() },
  projectFoldersApi: { list: vi.fn() },
  roomsApi: {
    list: vi.fn(),
    get: vi.fn(),
    conversations: vi.fn(),
    messages: vi.fn(),
    create: vi.fn(),
    createConversation: vi.fn(),
    sendMessage: vi.fn(),
  },
  runsApi: { get: vi.fn(), streamEvents: vi.fn() },
  spacesApi: { members: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1' }),
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
    role: 'manager',
    status: 'active',
    created_at: room.created_at,
    updated_at: room.updated_at,
  }],
}

describe('Rooms page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    vi.mocked(projectsApi.list).mockResolvedValue({
      items: [{ id: 'project-1', name: 'Project One' } as Project],
      total: 1,
      limit: 100,
      offset: 0,
    })
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    })
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
    expect(await screen.findByText('Codex subscription · My Codex login')).toBeInTheDocument()
    expect(screen.getByText(/every human speaks under their own identity and subscription/i)).toBeInTheDocument()
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
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(1)
    expect(screen.getAllByText('Member').length).toBeGreaterThan(1)
    expect(await screen.findByText('Agent started')).toBeInTheDocument()
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
})
