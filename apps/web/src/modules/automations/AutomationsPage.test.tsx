import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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

  it('keeps a workflow root-run link inside the current Space', async () => {
    automationsApiMock.list.mockResolvedValue([{
      id: 'automation-1',
      space_id: 'space-1',
      owner_user_id: 'user-1',
      agent_id: 'agent-1',
      project_folder_id: null,
      project_id: null,
      name: 'Workflow automation',
      description: null,
      trigger_type: 'manual',
      status: 'active',
      preflight_snapshot_json: null,
      config_json: { target_type: 'workflow', workflow_asset_key: 'workflow.alpha' },
      next_run_at: null,
      last_fired_at: null,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    }])
    automationsApiMock.workflowExecutions.mockResolvedValue([{
      workflow_execution_id: 'exec-1',
      automation_id: 'automation-1',
      workflow_version_id: 'version-1',
      status: 'completed',
      trigger_type: 'manual',
      root_run_id: 'run-99',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      node_count: 2,
      completed_node_count: 2,
      waiting_node_count: 0,
    }])
    agentsApiMock.list.mockResolvedValue([{ id: 'agent-1', name: 'Agent One' }])
    projectsApiMock.list.mockResolvedValue({ items: [] })
    evolutionApiMock.assets.mockResolvedValue([])

    render(
      <MemoryRouter>
        <AutomationsPage />
      </MemoryRouter>,
    )

    const link = await screen.findByRole('link', { name: 'root run' })
    expect(link).toHaveAttribute('href', '/spaces/space-1/runs/run-99')
  })

  it('runs an automation on its own configured prompt, not one this person supplied', async () => {
    // ADR 0003 §5 / D1: the server reads the configured prompt itself, and a
    // fire that carries a prompt is stamped as the firing person asking.
    // Echoing the owner's configured text back would make every "Run now"
    // read as this person's request and take the persona write with it.
    const user = userEvent.setup({ delay: null })
    const automation = {
      id: 'automation-1',
      space_id: 'space-1',
      owner_user_id: 'user-2',
      agent_id: 'agent-1',
      project_folder_id: null,
      project_id: null,
      name: 'Standing digest',
      description: null,
      trigger_type: 'manual',
      status: 'active',
      preflight_snapshot_json: null,
      config_json: { target_type: 'agent_run', prompt: 'Summarize what arrived' },
      next_run_at: null,
      last_fired_at: null,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    }
    automationsApiMock.list.mockResolvedValue([automation])
    automationsApiMock.get.mockResolvedValue(automation)
    automationsApiMock.fire.mockResolvedValue({ run_id: 'run-1', automation_run_id: 'fire-1' })
    agentsApiMock.list.mockResolvedValue([{ id: 'agent-1', name: 'Agent One' }])
    projectsApiMock.list.mockResolvedValue({ items: [] })
    evolutionApiMock.assets.mockResolvedValue([])

    render(
      <MemoryRouter>
        <AutomationsPage />
      </MemoryRouter>,
    )

    await user.click(await screen.findByRole('button', { name: /Run now/ }))
    await waitFor(() => expect(automationsApiMock.fire).toHaveBeenCalledWith('automation-1'))
  })
})
