import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ContextOpsArtifactSummary, ContextOpsDrilldown, ContextOpsSummary } from '@rainver/protocol'
import ContextOpsPage from '../ContextOpsPage'
import { contextOpsApi, knowledgeApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
    spaces: [{ id: 'space-1', name: 'Space One', role: 'owner' }],
  }),
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  contextOpsApi: { summary: vi.fn(), drilldown: vi.fn(), reviewCycleRun: vi.fn() },
  knowledgeApi: {
    maintenanceScan: vi.fn(),
    diagnosticsReport: vi.fn(),
    contradictionScan: vi.fn(),
    relationDiscoveryScan: vi.fn(),
    claimCandidatePacket: vi.fn(),
    explain: vi.fn(),
  },
  objectSchemaApi: { suggestionScan: vi.fn() },
}))

const summary: ContextOpsSummary = {
  generated_at: '2026-09-01T00:00:00.000Z',
  space_id: 'space-1',
  owner_user_id: 'user-1',
  window_days: 14,
  index_freshness: {
    object_counts: { note: 2 },
    stale_projection_count: 0,
    source_connected_object_count: 0,
    oldest_indexed_at: null,
    newest_indexed_at: null,
    newest_source_updated_at: null,
  },
  embedding_backlog: {
    total_chunks: 4,
    embedded_chunks: 4,
    missing_embedding_chunks: 0,
    claimed_chunks: 0,
    attempted_chunks: 0,
    missing_by_object_type: {},
  },
  source_policy_warnings: {
    active_source_connections: 0,
    missing_consent_version_count: 0,
    reader_restricted_source_count: 0,
    external_egress_disabled_source_count: 0,
    derived_writes_disabled_source_count: 0,
    warning_counts: {},
  },
  maintenance: { recent_report_count: 1, finding_counts: {}, pending_packet_count: 0, recent_packets: [] },
  diagnostics: {
    recent_report_count: 0,
    diagnostic_code_counts: {},
    latest_report_artifact_id: null,
    latest_generated_at: null,
    trend_metric_deltas: {},
    insufficient_trend_sample: true,
  },
  recent_context_briefs: [],
  retrieval_feedback: { recent_event_count: 0, signal_counts: {}, surface_counts: {}, window_days: 14 },
  memory_provenance: { recent_access_count: 0, context_injection_count: 0, maintenance_scan_count: 0, inspector_available: false },
}

function report(id: string, title: string): ContextOpsArtifactSummary {
  return {
    artifact_id: id,
    artifact_type: 'memory_maintenance_report',
    title,
    created_at: '2026-09-01T00:00:00.000Z',
    surface: null,
    diagnostic_codes: [],
    finding_count: 0,
  }
}

function drilldown(artifacts: ContextOpsArtifactSummary[]): ContextOpsDrilldown {
  return {
    generated_at: '2026-09-01T00:00:00.000Z',
    space_id: 'space-1',
    section: 'maintenance_reports',
    limit: 25,
    truncated: false,
    objects: [],
    sources: [],
    artifacts,
    packets: [],
  }
}

describe('ContextOpsPage drill-down', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(contextOpsApi.summary).mockResolvedValue(summary)
  })

  it('lists the report a scan just created in an already expanded drill-down', async () => {
    const reports = [report('artifact-1', 'Older maintenance report')]
    vi.mocked(contextOpsApi.drilldown).mockImplementation(async () => drilldown([...reports]))
    vi.mocked(knowledgeApi.maintenanceScan).mockImplementation(async () => {
      reports.push(report('artifact-2', 'Fresh maintenance report'))
      return { artifact_id: 'artifact-2', proposal_id: null } as never
    })
    render(<ContextOpsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Triage maintenance reports & packets' }))
    expect(await screen.findByText('Older maintenance report')).toBeInTheDocument()
    expect(contextOpsApi.drilldown).toHaveBeenCalledWith('maintenance_reports', { limit: 25 })

    fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))

    await waitFor(() => expect(knowledgeApi.maintenanceScan).toHaveBeenCalled())
    expect(await screen.findByText('Fresh maintenance report')).toBeInTheDocument()
    expect(screen.getByText('Older maintenance report')).toBeInTheDocument()
  })
})
