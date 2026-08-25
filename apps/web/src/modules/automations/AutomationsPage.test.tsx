import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { automationsApiMock, agentsApiMock, evolutionApiMock, projectsApiMock } = vi.hoisted(() => ({
  automationsApiMock: { list: vi.fn(), create: vi.fn(), update: vi.fn(), fire: vi.fn(), get: vi.fn(), workflowExecutions: vi.fn() },
  agentsApiMock: { list: vi.fn() },
  evolutionApiMock: { assets: vi.fn(), assetVersions: vi.fn() },
  projectsApiMock: { list: vi.fn() },
}))

vi.mock('../../api/client', () => ({ automationsApi: automationsApiMock, agentsApi: agentsApiMock, evolutionApi: evolutionApiMock, projectsApi: projectsApiMock }))
vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Test Space' }) }))

import AutomationsPage from './AutomationsPage'

describe('AutomationsPage', () => {
  it('creates a pinned workflow automation with structured input', async () => {
    const user = userEvent.setup({ delay: null })
    automationsApiMock.list.mockResolvedValue([])
    automationsApiMock.create.mockResolvedValue({
      id: 'automation-1',
      agent_id: 'agent-1',
      project_id: null,
      name: 'Workflow automation',
      trigger_type: 'manual',
      status: 'active',
      config_json: { target_type: 'workflow', workflow_asset_key: 'workflow.alpha', workflow_resolution: 'pin', workflow_version_id: 'version-1', input_json: {} },
    })
    automationsApiMock.workflowExecutions.mockResolvedValue([])
    agentsApiMock.list.mockResolvedValue([{ id: 'agent-1', name: 'Agent One' }])
    projectsApiMock.list.mockResolvedValue({ items: [] })
    evolutionApiMock.assets.mockResolvedValue([{
      id: 'asset-1', asset_key: 'workflow.alpha', display_name: 'Workflow Alpha', asset_type: 'workflow_template',
    }])
    evolutionApiMock.assetVersions.mockResolvedValue([{ id: 'version-1', version: 1, status: 'approved' }])
    render(<AutomationsPage />)

    await user.click(await screen.findByRole('button', { name: /New automation/ }))
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'agent-1')
    await user.selectOptions(selects[1], 'workflow')
    await user.selectOptions(screen.getAllByRole('combobox')[3], 'workflow.alpha')
    await waitFor(() => expect(evolutionApiMock.assetVersions).toHaveBeenCalledWith('asset-1'))
    await user.selectOptions(screen.getAllByRole('combobox')[5], 'version-1')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(automationsApiMock.create).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'agent-1',
      config_json: expect.objectContaining({
        target_type: 'workflow',
        workflow_asset_key: 'workflow.alpha',
        workflow_resolution: 'pin',
        workflow_version_id: 'version-1',
        input_json: {},
      }),
    })))
    expect(automationsApiMock.list).toHaveBeenCalledTimes(1)
  })
})
