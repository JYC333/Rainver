import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentFormPage from '../AgentFormPage'

const mockedApi = vi.hoisted(() => ({
  createAgent: vi.fn(),
  listProjects: vi.fn(),
  hostExecutionTargets: vi.fn(),
  listRuntimeAdapters: vi.fn(),
  providerList: vi.fn(),
  spacePolicies: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  agentTemplatesApi: {},
  agentsApi: { create: mockedApi.createAgent },
  projectsApi: { list: mockedApi.listProjects, hostExecutionTargets: mockedApi.hostExecutionTargets },
  hostsApi: { executionTargets: mockedApi.hostExecutionTargets, listRuntimeAdapters: mockedApi.listRuntimeAdapters },
  providersApi: { list: mockedApi.providerList },
  runtimeToolsApi: { spacePolicies: mockedApi.spacePolicies },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1' }),
}))

vi.mock('../../providers/ProviderSelector', () => ({
  default: () => null,
}))

describe('AgentFormPage host binding', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedApi.listProjects.mockResolvedValue({ items: [{ id: 'project-1', name: 'Financial System' }], total: 1, limit: 100, offset: 0 })
    mockedApi.hostExecutionTargets.mockResolvedValue({
      targets: [{
        host_id: 'host-1',
        host_name: 'Workstation',
        host_online: true,
        locations: [{ id: 'location-1', project_folder_id: 'folder-1', folder_name: 'Financial System', display_path: '/workspace/financial', execution_ready: true }],
        adapters: [{
          adapter_type: 'claude_code',
          display_name: 'Claude Code',
          installations: [{ id: 'own', version: '1.0.0', logged_in: true }],
        }],
      }],
    })
    mockedApi.listRuntimeAdapters.mockResolvedValue({ items: [] })
    mockedApi.providerList.mockResolvedValue([])
    mockedApi.spacePolicies.mockResolvedValue([])
    mockedApi.createAgent.mockResolvedValue({ id: 'agent-1' })
  })

  it('opens with the host binding a Room roster handed over in the URL', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new?project=project-1&host=host-1&location=location-1&adapter=claude_code&installation=own']}>
        <AgentFormPage />
      </MemoryRouter>,
    )

    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('own')
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Prefilled reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      adapter_type: 'claude_code',
      execution_host_id: 'host-1',
      workspace_location_id: 'location-1',
      runtime_installation: 'own',
    })))
  })

  it('submits a host-bound Agent without a server provider', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/agents/new?project=project-1']}>
        <AgentFormPage />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))
    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('own')

    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Remote reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(mockedApi.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      adapter_type: 'claude_code',
      default_model_provider_id: null,
      execution_host_id: 'host-1',
      workspace_location_id: 'location-1',
      runtime_installation: 'own',
    })))
  })
})
