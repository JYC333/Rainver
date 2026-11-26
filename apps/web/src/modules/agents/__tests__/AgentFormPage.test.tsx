import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentFormPage from '../AgentFormPage'
import { agentRolesApi } from '../../../api/client'

const mockedApi = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createAgentFromRole: vi.fn(),
  listProjects: vi.fn(),
  getRole: vi.fn(),
  getRoleVersion: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  agentRolesApi: {
    list: vi.fn(async () => []),
    get: mockedApi.getRole,
    getVersion: mockedApi.getRoleVersion,
    createAgent: mockedApi.createAgentFromRole,
  },
  agentsApi: { create: mockedApi.createAgent },
  projectsApi: { list: mockedApi.listProjects },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1' }),
}))

describe('AgentFormPage default runtime provisioning', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedApi.listProjects.mockResolvedValue({ items: [{ id: 'project-1', name: 'Financial System' }], total: 1, limit: 100, offset: 0 })
    mockedApi.createAgent.mockResolvedValue({ id: 'agent-1' })
    mockedApi.createAgentFromRole.mockResolvedValue({ id: 'agent-2' })
  })

  it('creates with the provisioned Server Runtime and exposes no deployment selector', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new']}>
        <AgentFormPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/release-pinned OpenCode installation/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Execution host')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Maximum run time (seconds)')).not.toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Prefilled reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      execution_constraints: { risk_level: 'medium' },
    })))
    expect(mockedApi.createAgent.mock.calls[0]?.[0]).not.toHaveProperty('execution_host_id')
    expect(mockedApi.createAgent.mock.calls[0]?.[0]).not.toHaveProperty('runtime_key')
  })

  it('offers catalog Roles only: a plugin assistant is set up from its plugin page in a Project', async () => {
    vi.mocked(agentRolesApi.list).mockResolvedValue([
      { id: 'research_reader', key: 'research_reader', name: 'Research Reader', description: null, source_plugin_id: null },
      { id: 'phd_application.assistant', key: 'phd_application.assistant', name: 'PhD Application Assistant', description: null, source_plugin_id: 'phd_application' },
    ] as never)
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new?project=project-1']}>
        <AgentFormPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: /Research Reader/ })).toBeInTheDocument()
    expect(screen.queryByText('PhD Application Assistant')).not.toBeInTheDocument()
    // Asked without a Project, so the server offers none either.
    expect(agentRolesApi.list).toHaveBeenCalledWith({ status: 'published' })
  })

  it('cancels back to the Project or Room it was opened from, and ignores any other return path', async () => {
    const back = '/projects/project-1/rooms?room=room-1'
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/spaces/space-1/agents/new?${new URLSearchParams({ project: 'project-1', return_to: back })}`]}>
        <AgentFormPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: 'Cancel' })).toHaveAttribute('href', `/spaces/space-1${back}`)
    unmount()
    render(
      <MemoryRouter initialEntries={[`/spaces/space-1/agents/new?${new URLSearchParams({ return_to: 'https://elsewhere.example/' })}`]}>
        <AgentFormPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/my-agents')
  })

  it('offers no risk level that has no eligible execution target', async () => {
    // Risk requires trust and nothing reaches `high` (ROUTING.md,
    // "Effective trust"). High and critical are shown with the reason.
    // Do not offer them as a choice that strands every Run of the Agent.
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new']}>
        <AgentFormPage />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByLabelText('Run risk'))
    expect(screen.getByRole('option', { name: 'Low' })).toBeEnabled()
    expect(screen.getByRole('option', { name: 'Medium' })).toBeEnabled()
    expect(screen.getByRole('option', { name: /^High · no execution target reaches high trust yet/ })).toBeDisabled()
    expect(screen.getByRole('option', { name: /^Critical · no execution target reaches high trust yet/ })).toBeDisabled()
  })

  it('ignores legacy host query parameters instead of restoring creation-time deployment selection', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new?project=project-1&host=host-1&location=location-1&runtime=claude_code&installation=own']}>
        <AgentFormPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/release-pinned OpenCode installation/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Execution host')).not.toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Default agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.not.objectContaining({
      execution_host_id: expect.anything(),
      runtime_key: expect.anything(),
    })))
    expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      execution_constraints: { risk_level: 'medium' },
    }))
  })

  it('preserves an interval schedule when creating from a role', async () => {
    mockedApi.getRole.mockResolvedValue({
      id: 'role-1',
      name: 'Interval Agent',
      description: null,
      current_version_id: 'role-version-1',
    })
    mockedApi.getRoleVersion.mockResolvedValue({
      id: 'role-version-1',
      execution_constraints: { risk_level: 'low', max_run_time_seconds: 120 },
      schedule_defaults_json: {
        enabled: true,
        every_hours: 6,
        timezone: 'UTC',
        manual_run_allowed: false,
      },
      context_policy_json: {},
      output_policy_json: {},
      tool_policy_json: {},
    })

    render(
      <MemoryRouter initialEntries={['/roles/role-1/create']}>
        <Routes>
          <Route path="/roles/:roleId/create" element={<AgentFormPage />} />
          <Route path="/spaces/:spaceId/agents/:agentId" element={<div>Created agent</div>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByLabelText('Interval (hours)')).toHaveValue(6)
    expect(screen.getByRole('button', { name: 'Cadence' })).toHaveTextContent('Every N hours')
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Preserved interval' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))

    await waitFor(() => expect(mockedApi.createAgentFromRole).toHaveBeenCalledWith(
      'role-1',
      expect.objectContaining({
        schedule_config_json: {
          enabled: true,
          every_hours: 6,
          timezone: 'UTC',
          manual_run_allowed: false,
        },
      }),
    ))
  })
  it('reads the Projects on the Role path and leaves nothing of the Role on the blank path', async () => {
    mockedApi.getRole.mockResolvedValue({ id: 'role-1', name: 'Interval Agent', description: 'From the Role', current_version_id: 'role-version-1' })
    mockedApi.getRoleVersion.mockResolvedValue({
      id: 'role-version-1',
      execution_constraints: { risk_level: 'low' },
      schedule_defaults_json: null,
      context_policy_json: { role_marker: true },
      output_policy_json: { role_marker: true },
      tool_policy_json: { role_marker: true },
    })
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/roles/role-1/use?project=project-1']}>
        <Routes>
          <Route path="/spaces/:spaceId/agents/roles/:roleId/use" element={<AgentFormPage />} />
          <Route path="/spaces/:spaceId/agents/new" element={<AgentFormPage />} />
          <Route path="/spaces/:spaceId/agents/:agentId" element={<div>Created agent</div>} />
        </Routes>
      </MemoryRouter>,
    )
    // Opened directly (a deep link or a reload): the carried Project is named, not lost.
    expect(await screen.findByRole('heading', { name: 'New agent: Interval Agent' })).toBeInTheDocument()
    expect(await screen.findByText('Financial System')).toBeInTheDocument()
    expect(mockedApi.listProjects).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('link', { name: 'start blank instead' }))
    expect(await screen.findByRole('heading', { name: 'New agent' })).toBeInTheDocument()
    expect(screen.getByText('Financial System')).toBeInTheDocument()
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('')
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/my-agents')
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Blank one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Blank one', project_id: 'project-1' })))
    const body = mockedApi.createAgent.mock.calls[0]![0] as Record<string, Record<string, unknown>>
    for (const key of ['context_policy_json', 'output_policy_json', 'tool_policy_json']) expect(body[key]).not.toHaveProperty('role_marker')
    expect(body.execution_constraints).toEqual({ risk_level: 'medium' })
    expect(mockedApi.createAgentFromRole).not.toHaveBeenCalled()
  })

  it('says a Role that cannot be read is unavailable and offers the blank form, never a form that submits to it', async () => {
    mockedApi.getRole.mockRejectedValue(new Error('Agent role not found'))
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/roles/phd_application.assistant/use?project=project-1']}>
        <Routes>
          <Route path="/spaces/:spaceId/agents/roles/:roleId/use" element={<AgentFormPage />} />
          <Route path="/spaces/:spaceId/agents/new" element={<AgentFormPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('agent-role-unavailable')).toHaveTextContent('This Role is not available to you here')
    expect(screen.queryByRole('button', { name: 'Create agent' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Start blank instead' }))
    expect(await screen.findByTestId('agent-start-from')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-role-unavailable')).not.toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Blank one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Blank one', project_id: 'project-1' })))
    expect(mockedApi.createAgentFromRole).not.toHaveBeenCalled()
  })
})
