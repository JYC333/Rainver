import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentFormPage from '../AgentFormPage'

const mockedApi = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createAgentFromTemplate: vi.fn(),
  listProjects: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateVersion: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  agentTemplatesApi: {
    get: mockedApi.getTemplate,
    getVersion: mockedApi.getTemplateVersion,
    createAgent: mockedApi.createAgentFromTemplate,
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
    mockedApi.createAgentFromTemplate.mockResolvedValue({ id: 'agent-2' })
  })

  it('creates with the provisioned Server Runtime and exposes no deployment selector', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new']}>
        <AgentFormPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/release-pinned OpenCode installation/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Execution host')).not.toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Prefilled reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      execution_constraints: { risk_level: 'medium', max_run_time_seconds: 300 },
    })))
    expect(mockedApi.createAgent.mock.calls[0]?.[0]).not.toHaveProperty('execution_host_id')
    expect(mockedApi.createAgent.mock.calls[0]?.[0]).not.toHaveProperty('runtime_key')
  })

  it('offers no risk level that has no eligible execution target', async () => {
    // Risk requires trust and nothing reaches `high` today (ROUTING.md,
    // "Effective trust"), so high/critical are shown with the reason rather
    // than offered as a choice that strands every Run of the Agent.
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
      execution_constraints: { risk_level: 'medium', max_run_time_seconds: 300 },
    }))
  })

  it('preserves an interval schedule when creating from a template', async () => {
    mockedApi.getTemplate.mockResolvedValue({
      id: 'template-1',
      name: 'Interval Agent',
      description: null,
      current_version_id: 'template-version-1',
    })
    mockedApi.getTemplateVersion.mockResolvedValue({
      id: 'template-version-1',
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
      <MemoryRouter initialEntries={['/templates/template-1/create']}>
        <Routes>
          <Route path="/templates/:templateId/create" element={<AgentFormPage />} />
          <Route path="/spaces/:spaceId/agents/:agentId" element={<div>Created agent</div>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByLabelText('Interval (hours)')).toHaveValue(6)
    expect(screen.getByRole('button', { name: 'Cadence' })).toHaveTextContent('Every N hours')
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Preserved interval' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))

    await waitFor(() => expect(mockedApi.createAgentFromTemplate).toHaveBeenCalledWith(
      'template-1',
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
})
