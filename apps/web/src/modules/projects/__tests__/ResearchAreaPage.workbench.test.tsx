import { act, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { useProjectResearch } from '../useProjectResearch'
import { projectsApi, projectResearchApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'user-1' } }),
}))

vi.mock('../../../core/spaceNav', () => ({
  useSpaceNavigate: () => vi.fn(),
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../researchArea/ReadingListView', () => ({ ReadingListView: () => <div>Reading list</div> }))

vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  },
  notesApi: {
    list: vi.fn().mockResolvedValue([]), get: vi.fn(), create: vi.fn(),
    update: vi.fn(), jot: vi.fn(), linkingTo: vi.fn().mockResolvedValue([]),
  },
  projectsApi: {
    get: vi.fn().mockResolvedValue({
      id: 'project-1',
      space_id: 'space-1',
      owner_user_id: 'user-1',
      name: 'Project One',
      description: null,
      status: 'active',
      current_focus: null,
      settings_json: null,
      active_brief_version_id: null,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
      archived_at: null,
    }),
    getSummary: vi.fn().mockResolvedValue({
      project_id: 'project-1',
      activity_count: 0,
      artifact_count: 0,
      pending_proposal_count: 0,
      project_folder_count: 0,
      active_run_count: 0,
      memory_entry_count: 0,
    }),
    getOverview: vi.fn().mockResolvedValue({
      project: { id: 'project-1', name: 'Project One', status: 'active' },
      brief: null,
      attention: [],
    }),
    update: vi.fn(),
    archive: vi.fn(),
    operations: vi.fn().mockResolvedValue([]),
    sourceExtractionProfiles: vi.fn().mockResolvedValue([{
      key: 'generic_document_v1', display_name: 'Generic document', entity_type: 'document',
      domain_criteria_keys: [], graph_lens_id: null, is_default: true,
    }]),
    deleteSourceBinding: vi.fn().mockResolvedValue({ id: 'binding-1', status: 'archived' }),
    createSourceBinding: vi.fn().mockResolvedValue({
      id: 'binding-new',
      project_id: 'project-1',
      source_channel_id: 'channel-1',
      binding_key: 'default',
      status: 'active',
    }),
  },
  projectResearchApi: {
    initializeArea: vi.fn().mockResolvedValue({
      notes_collection_id: 'col-1', notes: [], checklist: [], reports: [],
    }),
    area: vi.fn().mockResolvedValue({
      notes_collection_id: 'col-1', notes: [], checklist: [], reports: [],
    }),
    readingList: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    generateReportSnapshot: vi.fn(),
    updateEvidenceCard: vi.fn(),
    createChecklistItem: vi.fn(), updateChecklistItem: vi.fn(), deleteChecklistItem: vi.fn(),
    askAi: vi.fn(),
    standing: vi.fn().mockResolvedValue({
      enabled: false, enabled_binding_count: 0, budget: { daily_used: 0, daily_limit: 20 },
      batches: [], advice: [], recent_inflow: [],
    }),
    actionStandingAdvice: vi.fn(),
    dismissStandingAdvice: vi.fn(),
    profile: vi.fn().mockRejectedValue(new Error('404 Research profile not found')),
    upsertProfile: vi.fn(),
    approveProfile: vi.fn(),
    workflows: vi.fn().mockResolvedValue([]),
    scanSummaries: vi.fn().mockResolvedValue([]),
    startWorkflow: vi.fn(),
    runStage: vi.fn(),
    checkpoints: vi.fn().mockResolvedValue([]),
    decideCheckpoint: vi.fn(),
    updateItemLimit: vi.fn(),
    rescanBackfill: vi.fn().mockResolvedValue({}),
    updateInitialItemLimit: vi.fn(),
    screeningCriteria: vi.fn().mockResolvedValue({
      id: null,
      project_id: 'project-1',
      include_keywords: [],
      exclude_keywords: [],
      domain_criteria: {},
      date_range_start: null,
      date_range_end: null,
      source_restrictions: [],
      required_evidence_fields: [],
      created_at: null,
      updated_at: null,
    }),
    upsertScreeningCriteria: vi.fn(),
    evidenceMatrix: vi.fn().mockResolvedValue([]),
    rebuildEvidenceMatrix: vi.fn(),
    reports: vi.fn().mockResolvedValue([]),
    runReportIntegrity: vi.fn(),
    questionChangeImpact: vi.fn().mockResolvedValue({
      workflow_id: 'workflow-1', previous_question: 'Old question', current_question: 'New question',
      previous_version: 1, screened_items: 0, reports: 0,
    }),
    resolveQuestionChange: vi.fn().mockResolvedValue({}),
  },
  providersApi: {
    usable: vi.fn().mockResolvedValue([]),
    vendors: vi.fn().mockResolvedValue([]),
  },
  inquiryApi: {
    listOpenSteps: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
  },
  activityApi: {
    list: vi.fn().mockResolvedValue([]),
  },
  artifactsApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 }),
  },
  proposalsApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 }),
  },
  runsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
  memoryApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 }),
  },
  sourcesApi: {
    customSourceCredentials: vi.fn().mockResolvedValue([]),
    channels: vi.fn().mockResolvedValue([{
      id: 'channel-1',
      space_id: 'space-1',
      source_connection_id: 'conn-1',
      source_name: 'Engineering feeds',
      name: 'Engineering feed',
      channel_type: 'feed',
      endpoint_url: 'https://example.test/feed.xml',
      query: {},
      provider_query: {},
      query_fingerprint: 'fingerprint-1',
      status: 'active',
      fetch_frequency: 'daily',
      schedule_rule: null,
      provider: { key: 'generic_rss', display_name: 'RSS' },
      connection_status: 'active',
      capture_policy: 'reference_only',
      scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
    }]),
    createSourceRecipe: vi.fn(),
    createCustomSourceDraft: vi.fn(),
    projectSourceBindings: vi.fn().mockResolvedValue([{
      id: 'binding-1',
      space_id: 'space-1',
      project_id: 'project-1',
      source_channel_id: 'channel-1',
      binding_key: 'engineering',
      status: 'active',
      priority: 0,
      delivery_scope: 'project_members',
      collection_notifications_enabled: true,
      standing_comparison_enabled: false,
      filters_json: {},
      routing_policy_json: {},
      extraction_policy_json: {},
      created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }]),
    createProjectSourceBinding: vi.fn().mockResolvedValue({
      id: 'binding-new',
      space_id: 'space-1',
      project_id: 'project-1',
      source_channel_id: 'channel-1',
      binding_key: 'default',
      status: 'active',
      priority: 0,
      delivery_scope: 'project_members',
      collection_notifications_enabled: true,
      standing_comparison_enabled: false,
      filters_json: {},
      routing_policy_json: {},
      extraction_policy_json: {},
      created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }),
    backfillProjectSourceBinding: vi.fn().mockResolvedValue({
      binding_id: 'binding-1',
      project_id: 'project-1',
      source_connection_id: 'conn-1',
      created_links: 2,
      reactivated_links: 0,
      archived_links: 0,
      evidence_links: 2,
    }),
    createManualUrl: vi.fn().mockResolvedValue({
      id: 'item-new',
      space_id: 'space-1',
      connection_id: 'conn-1',
      item_type: 'external_url',
      source_object_type: null,
      source_object_id: null,
      created_by_user_id: 'user-1',
      title: 'Saved URL',
      source_uri: 'https://example.test/saved',
      canonical_uri: 'https://example.test/saved',
      source_domain: 'example.test',
      source_external_id: null,
      author: null,
      occurred_at: null,
      first_seen_at: '2026-06-30T00:00:00.000Z',
      last_seen_at: '2026-06-30T00:00:00.000Z',
      content_hash: null,
      excerpt: null,
      library_status: 'new',
      read_status: 'unread',
      content_state: 'metadata_only',
      retention_policy: 'metadata_only',
      relevance_score: null,
      novelty_score: null,
      raw_artifact_id: null,
      extracted_artifact_id: null,
      summary_artifact_id: null,
      search_index_ref: null,
      embedding_index_ref: null,
      metadata_json: { created_by: 'manual_url' },
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }),
    updateItem: vi.fn().mockResolvedValue({
      id: 'item-1',
      space_id: 'space-1',
      connection_id: 'conn-1',
      item_type: 'external_url',
      source_object_type: null,
      source_object_id: null,
      created_by_user_id: 'user-1',
      title: 'Release item',
      source_uri: 'https://example.test/item',
      canonical_uri: 'https://example.test/item',
      source_domain: 'example.test',
      source_external_id: null,
      author: null,
      occurred_at: null,
      first_seen_at: '2026-06-30T00:00:00.000Z',
      last_seen_at: '2026-06-30T00:00:00.000Z',
      content_hash: null,
      excerpt: null,
      library_status: 'new',
      read_status: 'unread',
      content_state: 'metadata_only',
      retention_policy: 'metadata_only',
      relevance_score: null,
      novelty_score: null,
      raw_artifact_id: null,
      extracted_artifact_id: null,
      summary_artifact_id: null,
      search_index_ref: null,
      embedding_index_ref: null,
      metadata_json: { created_by: 'manual_url' },
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }),
    projectItems: vi.fn().mockResolvedValue({
      items: [{
        id: 'project-item-1',
        space_id: 'space-1',
        project_id: 'project-1',
      project_source_binding_id: 'binding-1',
        source_channel_id: 'channel-1',
        source_connection_id: 'conn-1',
        source_item_id: 'item-1',
        status: 'active',
        matched_at: '2026-06-30T00:00:00.000Z',
        match_reason: 'project_source_binding:binding-1',
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
        item: {
          id: 'item-1',
          space_id: 'space-1',
          connection_id: 'conn-1',
          item_type: 'feed_entry',
          source_object_type: null,
          source_object_id: null,
          created_by_user_id: 'user-1',
          title: 'Release item',
          source_uri: 'https://example.test/item',
          canonical_uri: 'https://example.test/item',
          source_domain: 'example.test',
          source_external_id: 'guid-1',
          author: null,
          occurred_at: null,
          first_seen_at: '2026-06-30T00:00:00.000Z',
          last_seen_at: '2026-06-30T00:00:00.000Z',
          content_hash: null,
          excerpt: null,
          library_status: 'new',
          read_status: 'unread',
          content_state: 'metadata_only',
          retention_policy: 'metadata_only',
          relevance_score: null,
          novelty_score: null,
          raw_artifact_id: null,
          extracted_artifact_id: null,
          summary_artifact_id: null,
          search_index_ref: null,
          embedding_index_ref: null,
          metadata_json: null,
          created_at: '2026-06-30T00:00:00.000Z',
          updated_at: '2026-06-30T00:00:00.000Z',
        },
      }],
      total: 1,
      limit: 5,
      offset: 0,
    }),
    evidence: vi.fn().mockResolvedValue({
      items: [{
        id: 'evidence-1',
        space_id: 'space-1',
        source_item_id: 'item-1',
        extraction_job_id: null,
        source_snapshot_id: null,
        source_object_type: null,
        source_object_id: null,
        evidence_type: 'excerpt',
        title: 'Useful evidence',
        content_excerpt: 'Project-relevant excerpt.',
        content_hash: null,
        artifact_id: null,
        source_uri: 'https://example.test/item',
        source_title: 'Release item',
        source_author: null,
        occurred_at: null,
        trust_level: 'normal',
        extraction_method: 'connection_scan',
        confidence: 0.7,
        status: 'active',
        metadata_json: null,
        created_by_user_id: null,
        created_by_agent_id: null,
        created_by_run_id: null,
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
      }],
      total: 1,
      limit: 5,
      offset: 0,
    }),
    postProcessingDecisions: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 5,
      offset: 0,
    }),
  },
  readerApi: {
    listByProject: vi.fn().mockResolvedValue({ items: [] }),
  },
  automationsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}))

// Research is available from every Project, however it was created. Do not
// require a Template. There is no Template runtime.
function mockResearchProject(overrides: Partial<Awaited<ReturnType<typeof projectsApi.get>>> = {}) {
  vi.mocked(projectsApi.get).mockResolvedValue({
    id: 'project-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    name: 'Project One',
    description: null,
    status: 'active',
    current_focus: null,
    settings_json: null,
    active_brief_version_id: null,
    created_at: '2026-06-30T00:00:00.000Z',
    updated_at: '2026-06-30T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  })
}

describe('useProjectResearch authorized Operation compatibility', () => {
  it.each([false, true])('retains Workflow, stage, partial and live limit control (partial=%s)', async (partial) => {
    mockResearchProject()
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening', status: 'active',
      state_json: { research_question: 'Authorized question' }, primary_thread_id: 'thread-1',
      created_at: '', updated_at: '',
    }] as never)
    const operation = { id: 'bound-op', project_id: 'project-1', kind: 'research', status: 'active',
      title: 'Authorized research', progress_json: { workflow_id: 'workflow-1', run_kind: 'baseline',
        current_stage: 'historical_backfill', partial, history: { max_items: 50 } },
      steps: [], links: [], created_at: '', updated_at: '' }
    vi.mocked(projectsApi.operations).mockResolvedValue([operation] as never)
    let controller: ReturnType<typeof useProjectResearch> | undefined
    function Probe() { controller = useProjectResearch('project-1'); return null }
    window.localStorage.setItem('rainver:research-workflow:user-1:project-1', 'workflow-1')
    try {
      render(<MemoryRouter><Probe /></MemoryRouter>)
      await waitFor(() => expect(controller?.settings?.hasLiveOperation).toBe(true))
      expect(controller!.settings!.currentItemLimit).toBe(50)
      expect(controller!.focusProps!.selectedWorkflowId).toBe('workflow-1')
      expect(controller!.focusProps!.researchOperations[0]!.progress_json).toEqual(operation.progress_json)
      await act(async () => { await controller!.settings!.onUpdateItemLimit(80) })
      expect(projectResearchApi.updateItemLimit).toHaveBeenCalledWith('project-1', 'bound-op', 80)
      vi.mocked(projectResearchApi.rescanBackfill).mockClear()
      await act(async () => { await controller!.focusProps!.onRescanBackfill() })
      if (partial) expect(projectResearchApi.rescanBackfill).not.toHaveBeenCalled()
      else expect(projectResearchApi.rescanBackfill).toHaveBeenCalledWith('project-1', 'bound-op')
    } finally { window.localStorage.removeItem('rainver:research-workflow:user-1:project-1') }
  })
})
