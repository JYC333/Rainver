import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PromptLibraryPage from '../PromptLibraryPage'
import { promptsApi } from '../../../api/client'
import type { PromptAssetDetail, PromptAssetSummary, PromptVersion } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  promptsApi: {
    listAssets: vi.fn(),
    getAsset: vi.fn(),
    listVersions: vi.fn(),
    listDeployments: vi.fn(),
    setDeployment: vi.fn(),
    evaluate: vi.fn(),
    promote: vi.fn(),
    rollback: vi.fn(),
  },
}))

function asset(key: string, name: string): PromptAssetDetail {
  return {
    id: `asset-${key}`, space_id: 'space-1', asset_key: key, display_name: name, description: null,
    prompt_type: 'chat', status: 'active', owner_scope_type: 'space', owner_scope_id: 'space-1',
    current_system_version_id: `version-${key}`, metadata_json: {},
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
  }
}

function version(key: string): PromptVersion {
  return {
    id: `version-${key}`, asset_id: `asset-${key}`, space_id: 'space-1', scope_type: 'space', scope_id: 'space-1',
    parent_version_id: null, version: 1, status: 'candidate', source: 'user_authored',
    content: { messages: [{ role: 'system', content: `Prompt text for ${key}` }] }, content_hash: null,
    eval_summary_json: null, promotion_proposal_id: null, created_by_user_id: 'user-1', approved_by_user_id: null,
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z', stale_parent: false,
  }
}

const assets: PromptAssetSummary[] = [asset('prompt.a', 'Prompt A'), asset('prompt.b', 'Prompt B')]

describe('PromptLibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(promptsApi.listAssets).mockResolvedValue(assets)
    vi.mocked(promptsApi.getAsset).mockImplementation(async key => asset(key, key === 'prompt.a' ? 'Prompt A' : 'Prompt B'))
    vi.mocked(promptsApi.listVersions).mockImplementation(async key => [version(key)])
    vi.mocked(promptsApi.listDeployments).mockResolvedValue([])
  })

  it('does not put the previous asset back into the detail panel when its action finishes after a switch', async () => {
    const user = userEvent.setup({ delay: null })
    let finishDeployment: (value: unknown) => void = () => {}
    vi.mocked(promptsApi.setDeployment).mockReturnValue(new Promise(resolve => { finishDeployment = resolve }) as never)
    render(
      <MemoryRouter initialEntries={['/prompts?asset=prompt.a']}>
        <Routes><Route path="/prompts" element={<PromptLibraryPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: 'Prompt A' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Deployment' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy staging' }))
    await waitFor(() => expect(promptsApi.setDeployment).toHaveBeenCalledWith('prompt.a', 'staging', expect.anything()))

    fireEvent.click(screen.getByRole('button', { name: /Prompt B/ }))
    expect(await screen.findByRole('heading', { name: 'Prompt B' })).toBeInTheDocument()

    await act(async () => { finishDeployment({}) })
    await waitFor(() => expect(promptsApi.getAsset).toHaveBeenLastCalledWith('prompt.a'))
    await act(async () => {})

    expect(screen.getByRole('heading', { name: 'Prompt B' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Prompt A' })).not.toBeInTheDocument()
  })
})
