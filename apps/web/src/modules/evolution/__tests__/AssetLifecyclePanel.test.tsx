import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { evolutionApiMock, runsApiMock } = vi.hoisted(() => ({
  evolutionApiMock: {
    evaluationCases: vi.fn(),
    createAssetVersion: vi.fn(),
    updateAssetVersion: vi.fn(),
    transitionAssetVersion: vi.fn(),
    createEvaluationCase: vi.fn(),
    createEvaluationCaseFromRun: vi.fn(),
    executeEvaluation: vi.fn(),
    createAssetPromotionProposal: vi.fn(),
  },
  runsApiMock: { list: vi.fn() },
}))
vi.mock('../../../api/client', () => ({ evolutionApi: evolutionApiMock, runsApi: runsApiMock }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))
vi.mock('../../../core/spaceNav', () => ({ useSpaceNavigate: () => vi.fn() }))

import AssetLifecyclePanel from '../AssetLifecyclePanel'

const asset = {
  id: 'asset-1', space_id: 'space-1', asset_type: 'workflow_template', asset_key: 'workflow.alpha',
  display_name: 'Workflow Alpha', description: null, owner_scope_type: 'space', owner_scope_id: 'space-1',
  status: 'active', current_system_version_id: null, default_eval_suite_ref: null, metadata_json: {},
  created_at: '2026-07-12T00:00:00Z', updated_at: '2026-07-12T00:00:00Z',
}

describe('AssetLifecyclePanel', () => {
  it('creates a draft candidate from the version lifecycle UI', async () => {
    const user = userEvent.setup({ delay: null })
    const onReload = vi.fn().mockResolvedValue(undefined)
    evolutionApiMock.evaluationCases.mockResolvedValue([])
    evolutionApiMock.createAssetVersion.mockResolvedValue({})
    render(<AssetLifecyclePanel asset={asset} versions={[]} evaluations={[]} onReload={onReload} />)

    await user.click(screen.getByRole('button', { name: /Create candidate version/ }))
    await user.click(screen.getByRole('button', { name: 'Create draft' }))
    expect(evolutionApiMock.createAssetVersion).toHaveBeenCalledWith('asset-1', {
      parent_version_id: null,
      source: 'user_authored',
      content_json: {},
    })
  })
})
