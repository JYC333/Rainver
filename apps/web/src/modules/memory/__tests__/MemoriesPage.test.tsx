import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import MemoriesPage from '../MemoriesPage'
import type { Memory } from '../../../types/api'
import { knowledgeApi, memoryApi, spacesApi } from '../../../api/client'

const toastCalls: string[] = []
vi.mock('sonner', () => {
  const toast = Object.assign(
    (message: string) => { toastCalls.push(message) },
    { success: vi.fn(), error: vi.fn(), message: vi.fn() },
  )
  return { toast }
})

// ADR 0003 §2/§3: the Agent writes without asking, so the page is where that
// is read afterwards — and archiving your own entry is one request, not a
// proposal you file with yourself.
describe('MemoriesPage, memory an Agent wrote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastCalls.length = 0
    vi.mocked(memoryApi.list).mockResolvedValue({ items: [memoryRow()], limit: 50, offset: 0, total: 1 })
    vi.mocked(spacesApi.getRetrievalSettings).mockResolvedValue(baseSettings)
  })

  it('asks for what the Agents wrote, and marks those rows', async () => {
    renderPage()

    expect(await screen.findByText('Meeting times')).toBeInTheDocument()
    expect(screen.getByText('Agent')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Written by an Agent' }))
    await waitFor(() => {
      expect(memoryApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ created_by: 'agent' }))
    })
  })

  it('carries a paused session straight into the list', async () => {
    renderPage('/memory?session=session-1')

    await waitFor(() => {
      expect(memoryApi.list).toHaveBeenCalledWith(expect.objectContaining({ session: 'session-1' }))
    })
    expect(await screen.findByText(/Session session-/)).toBeInTheDocument()
  })

  it('carries a paused turn into the list by Run', async () => {
    renderPage('/memory?run=run-1')

    await waitFor(() => {
      expect(memoryApi.list).toHaveBeenCalledWith(expect.objectContaining({ run: 'run-1' }))
    })
    expect(await screen.findByText(/Turn run-1/)).toBeInTheDocument()
  })

  it('archives the caller\'s own entry outright and restores an archived one', async () => {
    vi.mocked(memoryApi.delete).mockResolvedValue(memoryRow({ status: 'archived' }) as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '×' }))
    await waitFor(() => { expect(memoryApi.delete).toHaveBeenCalledWith('memory-1') })
    // Not "proposal submitted": the server archived it.
    expect(toastCalls).toContain('Archived')

    vi.mocked(memoryApi.list).mockResolvedValue({
      items: [memoryRow({ status: 'archived' })], limit: 50, offset: 0, total: 1,
    })
    renderPage('/memory?status=archived')
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(() => { expect(memoryApi.restore).toHaveBeenCalledWith('memory-1') })
  })

  it('still says a proposal was submitted for someone else\'s entry', async () => {
    vi.mocked(memoryApi.delete).mockResolvedValue({ id: 'proposal-1', proposal_type: 'memory_archive' } as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '×' }))
    await waitFor(() => { expect(toastCalls).toContain('Archive proposal submitted') })
  })
})

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'user-1' } }),
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
  }),
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  memoryApi: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    restore: vi.fn(),
    versions: vi.fn(),
    retrievalSearch: vi.fn(),
    feedback: vi.fn(),
    maintenanceScan: vi.fn(),
    accessLogs: vi.fn(),
  },
  spacesApi: {
    getRetrievalSettings: vi.fn(),
  },
  knowledgeApi: {
    claimCandidatePacket: vi.fn(),
  },
}))

const disabledRankingMechanic = {
  state: 'disabled',
  calibration_artifact_id: null,
  shipped_at: null,
  eval_gate: {
    status: 'not_run',
    metric: null,
    value: null,
    threshold: 0,
    checked_at: null,
  },
} as const

const baseSettings = {
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
    eval_gate: {
      min_primary_metric_delta: 0,
      required_evidence_artifacts: 1,
    },
    mechanics: {
      visible_edge_backlink: disabledRankingMechanic,
      candidate_owned_salience: disabledRankingMechanic,
      richer_dedup: disabledRankingMechanic,
      autocut: disabledRankingMechanic,
      semantic_results_cache: disabledRankingMechanic,
    },
  },
  created_at: '2026-06-26T00:00:00.000Z',
  updated_at: '2026-06-26T00:00:00.000Z',
} as const

function renderPage(entry = '/memory?project_id=project-1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <MemoriesPage />
    </MemoryRouter>,
  )
}

function memoryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'memory-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    title: 'Meeting times',
    content: 'Prefers morning meetings',
    type: 'semantic',
    scope: 'user',
    namespace: 'user.default',
    status: 'active',
    visibility: 'private',
    access_level: 'full',
    confidence: 1,
    importance: 0.5,
    created_by: 'agent:agent-1',
    version: 1,
    tags: null,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    deleted_at: null,
    ...over,
  } as Memory
}

describe('MemoriesPage maintenance UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(memoryApi.list).mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 })
    vi.mocked(memoryApi.create).mockResolvedValue({ id: 'proposal-1' } as never)
    vi.mocked(memoryApi.maintenanceScan).mockResolvedValue({
      findings: [],
      counts: { duplicate: 0, stale: 0, thin: 0, lifecycle_drift: 0 },
      candidate_limit: 500,
      candidates_examined: 0,
      scanned: 0,
      truncated: false,
      artifact_id: 'report-artifact-1',
      proposal_id: 'maintenance-proposal-1',
      access_safety: {},
    })
    vi.mocked(knowledgeApi.claimCandidatePacket).mockResolvedValue({
      artifact_id: 'claim-packet-artifact-1',
      proposal_id: 'claim-packet-proposal-1',
      candidate_count: 1,
      source_artifact_count: 1,
      generated_child_proposal_count: 0,
    })
    vi.mocked(spacesApi.getRetrievalSettings).mockResolvedValue(baseSettings)
  })

  it('keeps space_ops unavailable when shared review is private_only', async () => {
    vi.mocked(spacesApi.getRetrievalSettings).mockResolvedValue({
      ...baseSettings,
      context_ops_review_mode: 'private_only',
    })

    renderPage()

    expect(await screen.findByText(/space_ops review is disabled/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'private' }))

    expect(screen.queryByRole('button', { name: 'space_ops' })).not.toBeInTheDocument()
  })

  it('derives Memory scope from the project context instead of exposing a scope picker', async () => {
    renderPage()

    expect(screen.queryByText('Scope')).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Short title…'), { target: { value: 'Project convention' } })
    fireEvent.change(screen.getByPlaceholderText('Memory content…'), { target: { value: 'Use the shared review checklist.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit proposal' }))

    await waitFor(() => {
      expect(memoryApi.create).toHaveBeenCalledWith({
        title: 'Project convention',
        content: 'Use the shared review checklist.',
        type: 'semantic',
        namespace: 'user.default',
        project_id: 'project-1',
      })
    })
  })

  it('runs a project-filtered maintenance scan and creates a claim candidate packet from the report', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /scan/i }))

    await waitFor(() => {
      expect(memoryApi.maintenanceScan).toHaveBeenCalledWith(expect.objectContaining({
        project_id: 'project-1',
        review_scope: 'private',
      }))
    })
    fireEvent.click(await screen.findByRole('button', { name: /claim packet/i }))

    await waitFor(() => {
      expect(knowledgeApi.claimCandidatePacket).toHaveBeenCalledWith({
        source_artifact_ids: ['report-artifact-1'],
        review_scope: 'private',
      })
    })
    expect(await screen.findByText('Open claim packet proposal')).toBeInTheDocument()
  })

})
