import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginAgentSetup } from './PluginAgentSetup'
import { agentRolesApi, agentsApi, ApiRequestError, projectsApi, roomsApi } from '../../api/client'
import { PROJECT_CHAT_OPEN_EVENT } from '../projects/sidecar/projectChatOpen'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../api/client', async () => {
  const { ApiRequestError } = await import('../../test/apiClientMock')
  return {
    ApiRequestError,
    agentRolesApi: { list: vi.fn(), createAgent: vi.fn() },
    agentsApi: { list: vi.fn() },
    projectsApi: { rooms: vi.fn() },
    roomsApi: { get: vi.fn(), addAgent: vi.fn(), agentCandidates: vi.fn() },
  }
})

const ROLE = { id: 'phd_application.assistant', key: 'phd_application.assistant', name: 'PhD Application Assistant', source_plugin_id: 'phd_application' }
/** The 409 the Room add answers with when its owner must confirm a Room-only share. */
const NAMES: Record<string, string> = { 'user-b': 'Ana Li', 'user-c': 'Chen Wu' }
const shareRequired = (memberIds: string[]) => new ApiRequestError('Confirm Room-only sharing', 409, 'operation_conflict', {
  error: { code: 'operation_conflict', metadata: {
    code: 'private_agent_share_confirmation_required', agent_id: 'agent-old', member_ids: memberIds,
    members: memberIds.map(id => ({ user_id: id, display_name: NAMES[id] ?? id })),
  } },
})
const page = (agents: Array<{ agent_id: string; name: string }>, total = agents.length, offset = 0) => ({ agents, presets: [], total, limit: 100, offset })
const OLD_CANDIDATE = { agent_id: 'agent-old', name: 'My PhD helper' }
const OLD = { id: 'agent-old', name: 'My PhD helper', source_role_id: 'phd_application.assistant', status: 'active', visibility: 'space_shared' }
/** Set up, once the chosen Room's candidates have loaded: a click before that is ignored. */
const enabledSetUp = async () => {
  const button = await screen.findByRole('button', { name: 'Set up' })
  await waitFor(() => expect(button).toBeEnabled())
  return button
}
const room = (id: string, title: string, mainline = false) => ({ room: { id, title, is_mainline: mainline }, other_member_names: [], person_count: 1, agent_count: 1, conversation_count: 0, last_activity_at: null })

describe('PluginAgentSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(agentRolesApi.list).mockResolvedValue([ROLE, { id: 'research_reader', key: 'research_reader', name: 'Research Reader' }] as never)
    vi.mocked(projectsApi.rooms).mockResolvedValue({ items: [room('room-main', 'Project conversation', true), room('room-apps', 'Applications')], total: 2, limit: 100, offset: 0, viewer_can_write: true } as never)
    vi.mocked(roomsApi.get).mockResolvedValue({ agent_members: [], user_members: [] } as never)
    vi.mocked(agentsApi.list).mockResolvedValue([] as never)
    vi.mocked(agentRolesApi.createAgent).mockResolvedValue({ id: 'agent-new' } as never)
    vi.mocked(roomsApi.addAgent).mockResolvedValue({} as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([]) as never)
  })

  it('creates the assistant from the Role with the Project prefilled, adds it to the chosen Room and opens the chat there', async () => {
    const opened = vi.fn()
    window.addEventListener(PROJECT_CHAT_OPEN_EVENT, event => opened((event as CustomEvent).detail))
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    fireEvent.click(await enabledSetUp())
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-main', expect.objectContaining({ agent_id: 'agent-new' })))
    expect(agentRolesApi.createAgent).toHaveBeenCalledWith('phd_application.assistant', { project_id: 'project-1' })
    // Its Role exists only where the plugin is bound and enabled, so it is asked for with this Project.
    expect(agentRolesApi.list).toHaveBeenCalledWith({ status: 'published', project_id: 'project-1' })
    await waitFor(() => expect(opened).toHaveBeenCalledWith({ projectId: 'project-1', roomId: 'room-main' }))
  })

  it('finds the set-up assistant on a later page of this Role and shows no setup form while the Rooms are read', async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ ...OLD, id: `agent-${index}`, name: `Helper ${index}` }))
    vi.mocked(agentsApi.list).mockImplementation(async params => (params?.offset === '0' ? others : [OLD]) as never)
    let release: (value: unknown) => void = () => {}
    vi.mocked(roomsApi.get)
      .mockImplementationOnce(() => new Promise(done => { release = done }) as never)
      .mockResolvedValueOnce({ agent_members: [{ agent_id: 'agent-old' }], user_members: [] } as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await waitFor(() => expect(roomsApi.get).toHaveBeenCalledTimes(1))
    // Asked by Role, page by page, not the first page of every Agent.
    expect(agentsApi.list).toHaveBeenCalledWith({ source_role_id: ROLE.id, status: 'active', limit: '100', offset: '0' })
    expect(agentsApi.list).toHaveBeenCalledWith({ source_role_id: ROLE.id, status: 'active', limit: '100', offset: '100' })
    expect(screen.queryByTestId('plugin-agent-setup')).toBeNull()
    release({ agent_members: [], user_members: [] })
    expect(await screen.findByText('My PhD helper works in Applications.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull()
  })

  it('reads no Room when the viewer has no Agent from this Role', async () => {
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    expect(await screen.findByRole('button', { name: 'Set up' })).toBeInTheDocument()
    expect(roomsApi.get).not.toHaveBeenCalled()
  })

  it('offers a retry, not the setup form, when a Room cannot be read', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.get)
      .mockRejectedValueOnce(new ApiRequestError('Unavailable', 503))
      .mockResolvedValue({ agent_members: [{ agent_id: 'agent-old' }], user_members: [] } as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    expect(await screen.findByText('Could not check whether this assistant is already set up in your Rooms.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('My PhD helper works in Default Room.')).toBeInTheDocument()
    expect(agentRolesApi.createAgent).not.toHaveBeenCalled()
  })

  it('offers a retry, not nothing, when the Role list cannot be read, and keeps it after a setup', async () => {
    vi.mocked(agentRolesApi.list).mockRejectedValueOnce(new ApiRequestError('Unavailable', 503))
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    expect(await screen.findByText('Could not check whether this assistant is already set up in your Rooms.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(await enabledSetUp())
    // The check after the setup fails: the card says so instead of disappearing.
    vi.mocked(agentRolesApi.list).mockRejectedValueOnce(new ApiRequestError('Unavailable', 503))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-main', expect.objectContaining({ agent_id: 'agent-new' })))
    expect(await screen.findByText('Could not check whether this assistant is already set up in your Rooms.')).toBeInTheDocument()
  })

  it('offers the first remaining Room when the chosen one is gone after a reload', async () => {
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    fireEvent.click((await screen.findAllByLabelText('Room'))[0]!)
    fireEvent.click(await screen.findByRole('option', { name: 'Applications' }))
    await waitFor(() => expect(roomsApi.agentCandidates).toHaveBeenCalledWith('room-apps', expect.anything()))
    // Applications leaves the Project while the setup completes; its add then finds nothing set up.
    vi.mocked(projectsApi.rooms).mockResolvedValue({ items: [room('room-main', 'Project conversation', true)], total: 1, limit: 100, offset: 0, viewer_can_write: true } as never)
    vi.mocked(roomsApi.agentCandidates).mockClear()
    fireEvent.click(await enabledSetUp())
    await waitFor(() => expect(roomsApi.agentCandidates).toHaveBeenCalledWith('room-main', expect.anything()))
    expect(roomsApi.agentCandidates).not.toHaveBeenCalledWith('room-apps', expect.anything())
  })

  it('keeps the latest check when an earlier one finishes late', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    let release: (value: unknown) => void = () => {}
    vi.mocked(roomsApi.get)
      .mockImplementationOnce(() => new Promise(done => { release = done }) as never)
      .mockResolvedValue({ agent_members: [], user_members: [] } as never)
    const view = render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await waitFor(() => expect(roomsApi.get).toHaveBeenCalledTimes(1))
    // Another Project: its own check says not set up.
    view.rerender(<PluginAgentSetup pluginId="phd_application" projectId="project-2" canWrite />)
    expect(await screen.findByRole('button', { name: 'Set up' })).toBeInTheDocument()
    // The first Project's answer arrives afterwards and is not applied here.
    release({ agent_members: [{ agent_id: 'agent-old' }], user_members: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText(/My PhD helper works in/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument()
  })

  it('reuses an Agent from the Role the person can already use, and creates no Room', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([OLD_CANDIDATE]) as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    expect(await screen.findByText('Use My PhD helper')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-main', expect.objectContaining({ agent_id: 'agent-old' })))
    // The Room's own candidates, asked for this Role only.
    expect(roomsApi.agentCandidates).toHaveBeenCalledWith('room-main', { source_role_id: 'phd_application.assistant', limit: 100, offset: 0 })
    expect(agentRolesApi.createAgent).not.toHaveBeenCalled()
  })

  it('offers only the Role Agents the chosen Room would let this person add', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD, { ...OLD, id: 'agent-foreign', name: 'Someone else’s helper' }] as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([OLD_CANDIDATE]) as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    expect(await screen.findByText('Use My PhD helper')).toBeInTheDocument()
    fireEvent.click(screen.getAllByLabelText('Assistant')[0]!)
    const offered = (await screen.findAllByRole('option')).map(option => option.textContent)
    expect(offered).toEqual(['Use My PhD helper', 'Create a new PhD Application Assistant'])
  })

  it('confirms a Room-only share with exactly the people the server names, then opens the chat', async () => {
    const opened = vi.fn()
    window.addEventListener(PROJECT_CHAT_OPEN_EVENT, event => opened((event as CustomEvent).detail))
    // An Agent whose home is another Project: space_shared, yet the add needs its owner's share.
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([OLD_CANDIDATE]) as never)
    vi.mocked(roomsApi.addAgent).mockRejectedValueOnce(shareRequired(['user-b'])).mockResolvedValue({} as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await screen.findByText('Use My PhD helper')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    // The people by name, as the server listed them.
    expect(await screen.findByText(/shared with Ana Li in this Room, and nobody else/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share in this Room' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenLastCalledWith('room-main', {
      agent_id: 'agent-old', share_private_with_member_ids: ['user-b'], confirm_room_share: true, restore_workspace: false,
    }))
    await waitFor(() => expect(opened).toHaveBeenCalledWith({ projectId: 'project-1', roomId: 'room-main' }))
  })

  it('confirms a Room of one with an empty list, and reuses the Agent it created on retry', async () => {
    vi.mocked(roomsApi.addAgent)
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(shareRequired([]))
      .mockResolvedValue({} as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue({ agents: [], presets: [], total: 0, limit: 100, offset: 0 } as never)
    vi.mocked(agentRolesApi.createAgent).mockResolvedValue({ ...OLD, id: 'agent-new', name: 'PhD Application Assistant' } as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(await screen.findByText(/only you use it here/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share in this Room' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenLastCalledWith('room-main', expect.objectContaining({
      agent_id: 'agent-new', share_private_with_member_ids: [], confirm_room_share: true,
    })))
    expect(agentRolesApi.createAgent).toHaveBeenCalledTimes(1)
  })

  it('reports any other refusal instead of asking to share', async () => {
    const { toast } = await import('sonner')
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([OLD_CANDIDATE]) as never)
    vi.mocked(roomsApi.addAgent).mockRejectedValue(new ApiRequestError('Agent not found', 404))
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await screen.findByText('Use My PhD helper')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Share in this Room' })).not.toBeInTheDocument()
  })

  it('asks again, naming the new person, when the Room changed to the same number of people', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([OLD_CANDIDATE]) as never)
    vi.mocked(roomsApi.addAgent)
      .mockRejectedValueOnce(shareRequired(['user-b']))
      .mockRejectedValueOnce(shareRequired(['user-c']))
      .mockResolvedValue({} as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await screen.findByText('Use My PhD helper')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(await screen.findByText(/shared with Ana Li/)).toBeInTheDocument()
    expect(screen.queryByText(/changed since you last confirmed/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share in this Room' }))
    // One left and another joined: still one person, but not the one confirmed.
    expect(await screen.findByText(/changed since you last confirmed.*shared with Chen Wu/)).toBeInTheDocument()
    expect(screen.queryByText(/Ana Li/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share in this Room' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenLastCalledWith('room-main', expect.objectContaining({
      agent_id: 'agent-old', share_private_with_member_ids: ['user-c'], confirm_room_share: true,
    })))
  })

  it('offers nothing and creates nothing until the Room candidates have loaded; a failure asks to retry', async () => {
    let resolve: (value: unknown) => void = () => {}
    vi.mocked(roomsApi.agentCandidates)
      .mockImplementationOnce(() => new Promise(done => { resolve = done }) as never)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(page([OLD_CANDIDATE]) as never)
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    const setUpButton = await screen.findByRole('button', { name: 'Set up' })
    expect(setUpButton).toBeDisabled()
    expect(screen.getByText('Loading assistants…')).toBeInTheDocument()
    fireEvent.click(setUpButton)
    expect(agentRolesApi.createAgent).not.toHaveBeenCalled()
    // The first answer is stale by the time it arrives: the Room is switched, and that read fails.
    fireEvent.click(screen.getAllByLabelText('Room')[0]!)
    fireEvent.click(await screen.findByRole('option', { name: 'Applications' }))
    resolve(page([]))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the assistants you can use in this Room.')
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Use My PhD helper')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-apps', expect.objectContaining({ agent_id: 'agent-old' })))
    expect(agentRolesApi.createAgent).not.toHaveBeenCalled()
  })

  it('reads every page of the Role candidates, so a reusable Agent past the first page is offered', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ agent_id: `agent-${i}`, name: `Helper ${i}` }))
    vi.mocked(roomsApi.agentCandidates)
      .mockResolvedValueOnce(page(first, 101) as never)
      .mockResolvedValueOnce(page([OLD_CANDIDATE], 101, 100) as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await waitFor(() => expect(roomsApi.agentCandidates).toHaveBeenCalledWith('room-main', { source_role_id: 'phd_application.assistant', limit: 100, offset: 100 }))
    fireEvent.click(await screen.findByLabelText('Assistant'))
    expect(await screen.findByRole('option', { name: 'Use My PhD helper' })).toBeInTheDocument()
  })

  it('keeps an explicit choice to create a new assistant when the Room changes', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.agentCandidates).mockResolvedValue(page([OLD_CANDIDATE]) as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    await screen.findByText('Use My PhD helper')
    fireEvent.click(screen.getAllByLabelText('Assistant')[0]!)
    fireEvent.click(await screen.findByRole('option', { name: 'Create a new PhD Application Assistant' }))
    fireEvent.click(screen.getAllByLabelText('Room')[0]!)
    fireEvent.click(await screen.findByRole('option', { name: 'Applications' }))
    await waitFor(() => expect(roomsApi.agentCandidates).toHaveBeenCalledWith('room-apps', expect.anything()))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up' })).toBeEnabled())
    expect(screen.getByText('Create a new PhD Application Assistant')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    await waitFor(() => expect(roomsApi.addAgent).toHaveBeenCalledWith('room-apps', expect.objectContaining({ agent_id: 'agent-new' })))
    expect(agentRolesApi.createAgent).toHaveBeenCalledTimes(1)
  })

  it('shows the placement once set up, and nothing for a plugin without a Role', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([OLD] as never)
    vi.mocked(roomsApi.get).mockImplementation(async (id: string) => ({ agent_members: id === 'room-apps' ? [{ agent_id: 'agent-old' }] : [], user_members: [] }) as never)
    render(<PluginAgentSetup pluginId="phd_application" projectId="project-1" canWrite />)
    expect(await screen.findByText('My PhD helper works in Applications.')).toBeInTheDocument()
    // No resident chat entry: the conversation is the Room's, in the chat panel.
    expect(screen.queryByRole('button', { name: 'Open chat' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('My PhD helper works in Applications.')).toBeInTheDocument()

    const { container } = render(<PluginAgentSetup pluginId="other" projectId="project-1" canWrite />)
    await waitFor(() => expect(agentRolesApi.list).toHaveBeenCalledTimes(2))
    expect(container).toBeEmptyDOMElement()
  })
})
