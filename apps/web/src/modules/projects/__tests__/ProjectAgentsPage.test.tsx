import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectAgentsPage from '../agents/ProjectAgentsPage'
import { agentsApi, projectsApi, roomsApi } from '../../../api/client'
import { agentCreationReturnPath, withCreatedAgent } from '../agentCreationReturn'
import type { ProjectAgent, ProjectRoomSummary, Room } from '../../../types/api'

vi.mock('../../../api/client', () => ({
  projectsApi: { rooms: vi.fn(), get: vi.fn(), agents: vi.fn(), agentCandidates: vi.fn(), addAgent: vi.fn(), removeAgent: vi.fn() },
  agentsApi: { get: vi.fn() },
  roomsApi: { get: vi.fn(), addAgent: vi.fn() },
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', userId: 'user-1' }),
}))

const room = (id: string, title: string, mainline: boolean): Room => ({
  id, space_id: 'space-1', project_id: 'project-1', project_folder_id: null, created_by_user_id: 'user-1', title,
  status: 'active', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', archived_at: null, is_mainline: mainline,
})
const mainline = room('room-main', 'Project conversation', true)
const limited = room('room-limited', 'Reviewers', false)
const summaries: ProjectRoomSummary[] = [
  { room: mainline, other_member_names: ['Dana'], person_count: 2, agent_count: 1, conversation_count: 2, last_activity_at: null },
  { room: limited, other_member_names: ['Dana'], person_count: 2, agent_count: 0, conversation_count: 0, last_activity_at: null },
]
const agent = (overrides: Partial<ProjectAgent>): ProjectAgent => ({
  agent_id: 'agent-1', name: 'Reviewer', description: 'Reads diffs', agent_kind: 'standard', visibility: 'space_shared', status: 'active',
  private: false, viewer_is_owner: false, added_at: '2026-11-01T00:00:00.000Z', rooms: [], ...overrides,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
type AgentsPage = Awaited<ReturnType<typeof projectsApi.agents>>
const agentsPage = (items: ProjectAgent[], total: number): AgentsPage => ({ items, total, limit: 50, offset: 0, viewer_can_write: true })
function SwitchProject() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate('/spaces/space-1/projects/project-2/agents')}>Go to project 2</button>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SwitchProject />
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/agents" element={<ProjectAgentsPage />} />
        <Route path="/spaces/:spaceId/projects/:projectId/agents/:agentId/chat" element={<p>Independent chat</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Project Agents page', () => {
  it('opens the Rooms index when a Room-only Agent has no visible Room', async () => {
    vi.mocked(projectsApi.agents).mockResolvedValue(agentsPage([agent({ room_only: true, rooms: [] })], 1))
    renderAt('/spaces/space-1/projects/project-1/agents')
    expect(await screen.findByRole('link', { name: 'Open Room' })).toHaveAttribute('href', '/spaces/space-1/projects/project-1/rooms')
  })

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(projectsApi.rooms).mockResolvedValue({ items: summaries, total: 2, limit: 200, offset: 0, viewer_can_write: true })
    vi.mocked(projectsApi.get).mockResolvedValue({ id: 'project-1', name: 'Atlas' } as never)
    vi.mocked(projectsApi.agents).mockResolvedValue({
      items: [
        agent({ rooms: [{ room_id: 'room-main', title: 'Project conversation', is_mainline: true }] }),
        agent({ agent_id: 'agent-2', name: 'Scout', private: true, viewer_is_owner: false }),
      ],
      total: 2, limit: 50, offset: 0, viewer_can_write: true,
    })
  })

  it('lists Project Agents with the Rooms they are in, separately from Room membership', async () => {
    renderAt('/spaces/space-1/projects/project-1/agents')
    const reviewer = await screen.findByTestId('project-agent-agent-1')
    expect(within(reviewer).getByText('In Atlas Room')).toBeInTheDocument()
    const scout = screen.getByTestId('project-agent-agent-2')
    expect(within(scout).getByText('Not in a Room you can see')).toBeInTheDocument()
    expect(within(scout).getByText('Private')).toBeInTheDocument()
    // Only a private Agent's owner may share it into a Room.
    expect(within(scout).queryByRole('button', { name: 'Add to Room' })).not.toBeInTheDocument()
    expect(within(reviewer).getByRole('button', { name: 'Add to Room' })).toBeInTheDocument()
    // Existing Agents first; creating one is the secondary action and comes back here.
    expect(screen.getByRole('button', { name: 'Add existing Agent' })).toBeInTheDocument()
    const create = screen.getAllByRole('link', { name: 'Create new Agent' })[0]!
    expect(decodeURIComponent(create.getAttribute('href') ?? '')).toContain('return_to=/projects/project-1/agents')
  })

  it('opens independent use in the Project, not a Room', async () => {
    renderAt('/spaces/space-1/projects/project-1/agents')
    fireEvent.click(within(await screen.findByTestId('project-agent-agent-1')).getByRole('button', { name: 'Use in this Project' }))
    expect(await screen.findByText('Independent chat')).toBeInTheDocument()
  })

  it('adds an existing Agent from a server search without touching any Room', async () => {
    vi.mocked(projectsApi.agentCandidates).mockImplementation(async (_id, params = {}) => ({
      items: params.q === 'ana'
        ? [{ agent_id: 'agent-3', name: 'Analyst', description: null, visibility: 'space_shared', private: false, linked: false }]
        : [{ agent_id: 'agent-1', name: 'Reviewer', description: null, visibility: 'space_shared', private: false, linked: true }],
      total: 1, limit: 50, offset: 0,
    }))
    vi.mocked(projectsApi.addAgent).mockResolvedValue({} as never)
    renderAt('/spaces/space-1/projects/project-1/agents')
    fireEvent.click(await screen.findByRole('button', { name: 'Add existing Agent' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('In this Project')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Search your Agents'), { target: { value: 'ana' } })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add' }))
    await waitFor(() => expect(projectsApi.addAgent).toHaveBeenCalledWith('project-1', 'agent-3'))
    expect(projectsApi.agentCandidates).toHaveBeenLastCalledWith('project-1', expect.objectContaining({ q: 'ana' }))
    expect(roomsApi.addAgent).not.toHaveBeenCalled()
  })

  it('adds a Project Agent to one chosen Room, offering only Rooms it is not in', async () => {
    vi.mocked(roomsApi.addAgent).mockResolvedValue({} as never)
    renderAt('/spaces/space-1/projects/project-1/agents')
    fireEvent.click(within(await screen.findByTestId('project-agent-agent-1')).getByRole('button', { name: 'Add to Room' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Reviewers/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/Atlas Room/)).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to Room' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-limited', expect.objectContaining({
      agent_id: 'agent-1', share_private_with_member_ids: [], confirm_room_share: false,
    })))
  })

  it('shares a private Agent only with the chosen Room\'s current members, after confirming', async () => {
    vi.mocked(projectsApi.agents).mockResolvedValue({
      items: [agent({ agent_id: 'agent-mine', name: 'Mine', private: true, viewer_is_owner: true })],
      total: 1, limit: 50, offset: 0, viewer_can_write: true,
    })
    vi.mocked(roomsApi.get).mockResolvedValue({
      user_members: [
        { user_id: 'user-1', status: 'active' },
        { user_id: 'user-2', status: 'active' },
        { user_id: 'user-3', status: 'removed' },
      ],
    } as never)
    vi.mocked(roomsApi.addAgent).mockResolvedValue({} as never)
    renderAt('/spaces/space-1/projects/project-1/agents')
    fireEvent.click(within(await screen.findByTestId('project-agent-agent-mine')).getByRole('button', { name: 'Add to Room' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Add to Room' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Share and add' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-main', expect.objectContaining({
      agent_id: 'agent-mine', share_private_with_member_ids: ['user-2'], confirm_room_share: true,
    })))
  })

  it('offers the add for an Agent just created from this page, once, with one confirmation', async () => {
    vi.mocked(agentsApi.get).mockResolvedValue({ id: 'agent-new', name: 'Fresh' } as never)
    vi.mocked(projectsApi.addAgent).mockResolvedValue({} as never)
    renderAt('/spaces/space-1/projects/project-1/agents?created_agent=agent-new')
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Project' }))
    await waitFor(() => expect(projectsApi.addAgent).toHaveBeenCalledWith('project-1', 'agent-new'))
  })

  it('says a failed load out loud and retries it', async () => {
    vi.mocked(projectsApi.agents).mockRejectedValueOnce(new Error('offline'))
    renderAt('/spaces/space-1/projects/project-1/agents')
    expect(await screen.findByText('Could not load this Project’s Agents.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('project-agent-agent-1')).toBeInTheDocument()
  })

  it('never appends a load-more page of an earlier search to the new search', async () => {
    const stale = deferred<AgentsPage>()
    vi.mocked(projectsApi.agents).mockImplementation(async (_id, params = {}) => {
      if (params.q === 'sco') return agentsPage([agent({ agent_id: 'agent-2', name: 'Scout' })], 1)
      if (params.offset) return stale.promise
      // More than one page, so the search box is offered.
      return agentsPage([agent({})], 60)
    })
    renderAt('/spaces/space-1/projects/project-1/agents')
    await screen.findByTestId('project-agent-agent-1')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.change(screen.getByLabelText('Search this Project’s Agents'), { target: { value: 'sco' } })
    expect(await screen.findByTestId('project-agent-agent-2')).toBeInTheDocument()
    stale.resolve(agentsPage([agent({ agent_id: 'agent-stale', name: 'Stale' })], 60))
    await waitFor(() => expect(projectsApi.agents).toHaveBeenCalledTimes(3))
    await new Promise(done => setTimeout(done, 0))
    expect(screen.queryByTestId('project-agent-agent-stale')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-agent-1')).not.toBeInTheDocument()
    // The load more continues only the search on screen, at that search's offset.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('clears the previous Project at once and drops its late pages', async () => {
    const lateMore = deferred<AgentsPage>()
    const second = deferred<AgentsPage>()
    vi.mocked(projectsApi.agents).mockImplementation(async (id, params = {}) => {
      if (id === 'project-2') return second.promise
      if (params.offset) return lateMore.promise
      return agentsPage([agent({})], 2)
    })
    renderAt('/spaces/space-1/projects/project-1/agents')
    await screen.findByTestId('project-agent-agent-1')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to project 2' }))
    // Nothing of project 1 stays on screen while project 2 loads.
    await waitFor(() => expect(screen.queryByTestId('project-agent-agent-1')).not.toBeInTheDocument())
    lateMore.resolve(agentsPage([agent({ agent_id: 'agent-late', name: 'Late' })], 2))
    second.resolve(agentsPage([agent({ agent_id: 'agent-p2', name: 'Other' })], 1))
    expect(await screen.findByTestId('project-agent-agent-p2')).toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-agent-late')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-agent-1')).not.toBeInTheDocument()
  })

  it('in the add dialog, a load more for an earlier search never mixes into the new one', async () => {
    const stale = deferred<Awaited<ReturnType<typeof projectsApi.agentCandidates>>>()
    const candidate = (id: string, name: string) => ({ agent_id: id, name, description: null, visibility: 'space_shared' as const, private: false, linked: false })
    vi.mocked(projectsApi.agentCandidates).mockImplementation(async (_id, params = {}) => {
      if (params.q === 'ana') return { items: [candidate('agent-3', 'Analyst')], total: 1, limit: 50, offset: 0 }
      if (params.offset) return stale.promise
      return { items: [candidate('agent-4', 'Writer')], total: 2, limit: 50, offset: 0 }
    })
    renderAt('/spaces/space-1/projects/project-1/agents')
    fireEvent.click(await screen.findByRole('button', { name: 'Add existing Agent' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Writer')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }))
    fireEvent.change(within(dialog).getByLabelText('Search your Agents'), { target: { value: 'ana' } })
    expect(await within(dialog).findByText('Analyst')).toBeInTheDocument()
    stale.resolve({ items: [candidate('agent-stale', 'Stale candidate')], total: 2, limit: 50, offset: 0 })
    await new Promise(done => setTimeout(done, 0))
    expect(within(dialog).queryByText('Stale candidate')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Writer')).not.toBeInTheDocument()
  })

  it('drops an earlier search answering while the new text is still debouncing', async () => {
    const sc = deferred<AgentsPage>()
    vi.mocked(projectsApi.agents).mockImplementation(async (_id, params = {}) => {
      if (params.q === 'sc') return sc.promise
      if (params.q === 'sco') return agentsPage([agent({ agent_id: 'agent-2', name: 'Scout' })], 1)
      return agentsPage([agent({})], 60)
    })
    renderAt('/spaces/space-1/projects/project-1/agents')
    await screen.findByTestId('project-agent-agent-1')
    const box = screen.getByLabelText('Search this Project’s Agents')
    fireEvent.change(box, { target: { value: 'sc' } })
    await waitFor(() => expect(projectsApi.agents).toHaveBeenCalledWith('project-1', expect.objectContaining({ q: 'sc' })))
    // New text; its own request is still 250 ms away when the old one answers.
    fireEvent.change(box, { target: { value: 'sco' } })
    await act(async () => { sc.resolve(agentsPage([agent({ agent_id: 'agent-stale', name: 'Stale' })], 1)); await sc.promise })
    expect(projectsApi.agents).not.toHaveBeenCalledWith('project-1', expect.objectContaining({ q: 'sco' }))
    expect(screen.queryByTestId('project-agent-agent-stale')).not.toBeInTheDocument()
    expect(await screen.findByTestId('project-agent-agent-2')).toBeInTheDocument()
    expect(screen.queryByTestId('project-agent-agent-stale')).not.toBeInTheDocument()
  })

  it('in the add dialog, drops an earlier search answering while the new text is still debouncing', async () => {
    const an = deferred<Awaited<ReturnType<typeof projectsApi.agentCandidates>>>()
    const candidate = (id: string, name: string) => ({ agent_id: id, name, description: null, visibility: 'space_shared' as const, private: false, linked: false })
    vi.mocked(projectsApi.agentCandidates).mockImplementation(async (_id, params = {}) => {
      if (params.q === 'an') return an.promise
      if (params.q === 'ana') return { items: [candidate('agent-3', 'Analyst')], total: 1, limit: 50, offset: 0 }
      return { items: [candidate('agent-4', 'Writer')], total: 1, limit: 50, offset: 0 }
    })
    renderAt('/spaces/space-1/projects/project-1/agents')
    fireEvent.click(await screen.findByRole('button', { name: 'Add existing Agent' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Writer')).toBeInTheDocument()
    const box = within(dialog).getByLabelText('Search your Agents')
    fireEvent.change(box, { target: { value: 'an' } })
    await waitFor(() => expect(projectsApi.agentCandidates).toHaveBeenCalledWith('project-1', expect.objectContaining({ q: 'an' })))
    fireEvent.change(box, { target: { value: 'ana' } })
    await act(async () => { an.resolve({ items: [candidate('agent-stale', 'Stale candidate')], total: 1, limit: 50, offset: 0 }); await an.promise })
    expect(projectsApi.agentCandidates).not.toHaveBeenCalledWith('project-1', expect.objectContaining({ q: 'ana' }))
    expect(within(dialog).queryByText('Stale candidate')).not.toBeInTheDocument()
    expect(await within(dialog).findByText('Analyst')).toBeInTheDocument()
    expect(within(dialog).queryByText('Stale candidate')).not.toBeInTheDocument()
  })

  it('shows an empty Project with both add paths and no Room choice', async () => {
    vi.mocked(projectsApi.agents).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, viewer_can_write: true })
    renderAt('/spaces/space-1/projects/project-1/agents')
    expect(await screen.findByText('No Agents in this Project yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add existing Agent' }).length).toBeGreaterThan(0)
  })
})

describe('Agent creation return path', () => {
  it('accepts only a Project Agents or Rooms path and adds the created Agent', () => {
    expect(agentCreationReturnPath('/projects/p-1/agents')).toBe('/projects/p-1/agents')
    expect(agentCreationReturnPath('/projects/p-1/rooms?room=r-1&view=members')).toBe('/projects/p-1/rooms?room=r-1&view=members')
    for (const bad of ['https://evil.test/projects/p/agents', '//evil.test', '/settings', '/projects/p-1/files', '/projects/../agents', null]) {
      expect(agentCreationReturnPath(bad)).toBeNull()
    }
    expect(withCreatedAgent('/projects/p-1/rooms?room=r-1&view=members', 'a-9')).toBe('/projects/p-1/rooms?room=r-1&view=members&created_agent=a-9')
  })
})
