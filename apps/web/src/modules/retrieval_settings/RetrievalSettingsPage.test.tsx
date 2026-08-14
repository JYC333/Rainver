import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RetrievalSettingsPage from './RetrievalSettingsPage'
import { artifactsApi, providersApi, spacesApi } from '../../api/client'

const { providerSelectorValues } = vi.hoisted(() => ({
  providerSelectorValues: [] as unknown[],
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
    spaces: [{ id: 'space-1', name: 'Space One', role: 'owner' }],
  }),
}))

vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

vi.mock('../providers/ProviderSelector', () => ({
  default: ({ value }: { value: unknown }) => {
    providerSelectorValues.push(value)
    return <div data-testid="provider-selection">{JSON.stringify(value)}</div>
  },
}))

vi.mock('../../api/client', () => ({
  spacesApi: {
    getRetrievalSettings: vi.fn(),
    updateRetrievalSettings: vi.fn(),
  },
  providersApi: {
    vendors: vi.fn(),
    taskPolicies: vi.fn(),
    putTaskPolicy: vi.fn(),
    deleteTaskPolicy: vi.fn(),
  },
  artifactsApi: { list: vi.fn() },
}))

const disabledMechanic = {
  state: 'disabled',
  calibration_artifact_id: null,
  shipped_at: null,
  eval_gate: { status: 'not_run', metric: null, value: null, threshold: 0, checked_at: null },
} as const

const settings = {
  space_id: 'space-1',
  default_search_mode: 'hybrid',
  rerank_enabled: false,
  query_rewrite_enabled: false,
  query_rewrite_default: false,
  use_query_cache: true,
  include_trace: false,
  external_egress_enabled: true,
  retrieval_tool_mode: 'off',
  context_ops_review_mode: 'admins',
  context_ops_scan_mode: 'admins',
  embedding_dimensions: 2560,
  max_results_default: 50,
  ranking_config: {
    version: 1,
    eval_gate: { min_primary_metric_delta: 0, required_evidence_artifacts: 1 },
    mechanics: {
      visible_edge_backlink: disabledMechanic,
      candidate_owned_salience: disabledMechanic,
      richer_dedup: disabledMechanic,
      autocut: disabledMechanic,
      semantic_results_cache: disabledMechanic,
    },
  },
  created_at: '2026-08-14T00:00:00.000Z',
  updated_at: '2026-08-14T00:00:00.000Z',
} as const

describe('RetrievalSettingsPage vendor registry failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerSelectorValues.length = 0
    vi.mocked(spacesApi.getRetrievalSettings).mockResolvedValue(settings)
    vi.mocked(providersApi.vendors).mockRejectedValue(new Error('registry unavailable'))
    vi.mocked(providersApi.taskPolicies).mockResolvedValue([{
      task: 'retrieval_query_rewrite',
      chain: [{ provider_id: 'provider-1', model: 'model-1' }],
      enabled: true,
      updated_at: '2026-08-14T00:00:00.000Z',
    }])
    vi.mocked(artifactsApi.list).mockResolvedValue({ items: [] } as never)
  })

  it('keeps settings and saved task selections when only vendor metadata fails', async () => {
    render(<RetrievalSettingsPage />)

    expect(await screen.findByText('Search defaults')).toBeInTheDocument()
    expect(screen.queryByText('Retrieval settings unavailable')).not.toBeInTheDocument()
    expect(await screen.findByText('{"provider_id":"provider-1","model":"model-1"}')).toBeInTheDocument()
    expect(providersApi.deleteTaskPolicy).not.toHaveBeenCalled()
  })
})
