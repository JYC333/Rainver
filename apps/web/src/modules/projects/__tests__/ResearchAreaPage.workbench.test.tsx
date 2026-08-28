import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import ResearchAreaPage from '../ResearchAreaPage'
import { projectsApi, projectResearchApi, inquiryApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
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
      primary_mode: 'research',
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
      project: { id: 'project-1', name: 'Project One', primary_mode: 'research', status: 'active' },
      brief: null,
      available_modes: ['research'],
      attention: [],
    }),
    transitionMode: vi.fn(),
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
    list: vi.fn().mockResolvedValue([]),
    vendors: vi.fn().mockResolvedValue([]),
  },
  inquiryApi: {
    listOpenSteps: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
  },
  credentialsApi: {
    profiles: vi.fn().mockResolvedValue([]),
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

function renderArea(search = '') {
  return render(
    <MemoryRouter
      initialEntries={[`/spaces/space-1/projects/project-1/research${search}`]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/research" element={<ResearchAreaPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Open the Thread-scoped workbench. Standing discovery is the default view. */
async function openFocus() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Focus workbench' }))
}

// Research is available from every Project independently of how it was
// created; the retired Template concept has no runtime representation.
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
    primary_mode: 'research',
    active_brief_version_id: null,
    created_at: '2026-06-30T00:00:00.000Z',
    updated_at: '2026-06-30T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  })
}

/**
 * Project Research is an Area, not an Overview section.
 *
 * Every case here used to render the Project Overview, which owned the
 * workbench, its state, its polling, and its setup dialog while `/research`
 * existed as a separate route for the same domain.
 */
describe('Research Area workbench', () => {
  it('renders the workbench independently of creation-time Template provenance', async () => {
    renderArea()

    expect(await screen.findByText('Research status')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Standing overview' })).toHaveAttribute('data-state', 'active')
    await openFocus()
    expect(screen.getByText('Set the research question that screening and synthesis should answer.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^start initial research$/i })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /set up intake/i }).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(projectResearchApi.workflows).toHaveBeenCalledWith('project-1')
      expect(projectResearchApi.evidenceMatrix).toHaveBeenCalledWith('project-1')
    })
  })

  it('keeps the research item limit in the Area instead of Project settings', async () => {
    renderArea()

    await openFocus()
    expect(await screen.findByText('Saved intake configuration')).toBeInTheDocument()
    expect(screen.getByLabelText('New item limit')).toBeInTheDocument()
  })

  it('restores the selected Research Workflow and scopes its checkpoint reads explicitly', async () => {
    mockResearchProject()
    const workflow = (id: string, question: string) => ({
      id,
      project_id: 'project-1',
      current_stage: 'monitoring',
      status: 'active',
      state_json: {
        research_question: question,
        research_question_version: 1,
        thread_scope: [{ thread_id: `thread-${id}`, version: 1, kind: 'question', statement: question }],
        monitoring: { active: true },
      },
      started_by_user_id: 'user-1',
      started_run_id: null,
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
    })
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([
      workflow('workflow-1', 'Does caching improve latency?'),
      workflow('workflow-2', 'Does batching improve throughput?'),
    ] as never)
    window.localStorage.setItem('project:project-1:research-workflow', 'workflow-2')

    renderArea()

    await openFocus()
    const selector = await screen.findByLabelText('Selected research question workflow')
    expect(selector).toHaveTextContent('Does batching improve throughput?')
    await waitFor(() => {
      expect(projectResearchApi.checkpoints).toHaveBeenCalledWith('project-1', 'workflow-2')
    })
    expect(projectResearchApi.checkpoints).not.toHaveBeenCalledWith('project-1', 'workflow-1')
    window.localStorage.removeItem('project:project-1:research-workflow')
  })

  it('does not flash the initial intake setup while research data is loading', async () => {
    let resolveWorkflows!: (value: Awaited<ReturnType<typeof projectResearchApi.workflows>>) => void
    const workflows = new Promise<Awaited<ReturnType<typeof projectResearchApi.workflows>>>(resolve => {
      resolveWorkflows = resolve
    })
    mockResearchProject()
    vi.mocked(projectResearchApi.workflows).mockReturnValueOnce(workflows)

    renderArea()

    await openFocus()
    expect(screen.getByLabelText('Loading Project Research')).toBeInTheDocument()
    expect(screen.queryByText('Set up initial material intake')).toBeNull()

    resolveWorkflows([])
    await waitFor(() => expect(screen.getByText('Set up initial material intake')).toBeInTheDocument())
  })

  it('announces a pending research review instead of silently pausing', async () => {
    mockResearchProject()
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1',
      project_id: 'project-1',
      current_stage: 'screening',
      status: 'active',
      state_json: {},
      primary_thread_id: null,
      started_by_user_id: 'user-1',
      started_run_id: null,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }])
    vi.mocked(projectResearchApi.checkpoints).mockResolvedValueOnce([{
      id: 'checkpoint-1',
      project_id: 'project-1',
      workflow_id: 'workflow-1',
      stage_key: 'screening',
      checkpoint_type: 'screening_gate',
      status: 'pending',
      machine_result_json: { relevant: 4, maybe: 1 },
      review: null,
      user_decision: null,
      decision_reason: null,
      decided_by_user_id: null,
      decided_at: null,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }])

    renderArea()

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Research review required',
      expect.objectContaining({
        id: 'research-review:project-1:checkpoint-1',
        duration: Infinity,
      }),
    ))
  })

  it('resolves question drift through the impact-aware decision dialog', async () => {
    mockResearchProject({ current_focus: 'New question' })
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'complete',
      status: 'active', state_json: {
        research_question: 'Old question', research_question_version: 3, monitoring: { active: true },
        thread_scope: [{ thread_id: 'thread-1', version: 3, kind: 'question', statement: 'Old question' }],
      },
      primary_thread_id: 'thread-1',
      started_by_user_id: 'user-1', started_run_id: null, created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }])
    vi.mocked(inquiryApi.listThreads).mockResolvedValueOnce([{
      id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'question', statement: 'New question',
      lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
      owner_user_id: 'user-1', next_focus_kind: null, next_focus_note: null, blocked_reason: null,
      version: 4, created_from: 'user', created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }])
    vi.mocked(projectResearchApi.questionChangeImpact).mockResolvedValueOnce({
      workflow_id: 'workflow-1', previous_question: 'Old question', current_question: 'New question',
      previous_version: 3, screened_items: 27, reports: 2,
    })
    vi.mocked(projectResearchApi.resolveQuestionChange).mockResolvedValueOnce({} as never)
    renderArea()

    await openFocus()
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve question change' }))
    expect(await screen.findByText('27 materials screened against the previous question · 2 reports')).toBeInTheDocument()
    expect(screen.getByText('Question version 3 → 4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /re-screen against the new question/i }))

    await waitFor(() => expect(projectResearchApi.questionChangeImpact).toHaveBeenCalledWith('project-1', 'workflow-1'))
    await waitFor(() => expect(projectResearchApi.resolveQuestionChange).toHaveBeenCalledWith('project-1', 'workflow-1', 'rescreen'))
  })

  it('opens Research Setup and preselects the ?thread= Hypothesis', async () => {
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: { research_question: 'Does caching improve latency?' },
      primary_thread_id: 'thread-1',
      started_by_user_id: 'user-1', started_run_id: null,
      created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z',
    }] as never)
    vi.mocked(inquiryApi.listThreads).mockResolvedValueOnce([{
      id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'question', statement: 'Does caching improve latency?',
      lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
      owner_user_id: 'user-1', next_focus_kind: null, next_focus_note: null, blocked_reason: null,
      version: 1, created_from: 'user', created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }, {
      id: 'thread-2', space_id: 'space-1', project_id: 'project-1', kind: 'hypothesis', statement: 'Batching improves throughput',
      lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
      owner_user_id: 'user-1', next_focus_kind: 'search_acquisition', next_focus_note: null, blocked_reason: null,
      version: 1, created_from: 'user', created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }])

    renderArea('?research=new&thread=thread-2')

    // The independent dialog opens preselecting thread-2's own wording — proof
    // the ?research=new wiring reached the right dialog with the right thread,
    // not the "edit the currently selected Workflow" dialog (workflow-1 /
    // thread-1, a Question). Definition itself happens on Inquiry, so with no
    // draft Workflow yet linked to thread-2 this dialog hands back there.
    expect(await screen.findByText(/Researching: Batching improves throughput/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Refine in Inquiry' })).toHaveAttribute('href', '/projects/project-1/inquiry?thread=thread-2')
  })

  it('reuses the confirmed Thread draft instead of reopening setup as unrefined', async () => {
    mockResearchProject()
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-confirmed', project_id: 'project-1', current_stage: 'initial_intake_setup',
      status: 'not_started', primary_thread_id: 'thread-1',
      state_json: {
        thread_id: 'thread-1',
        research_question: 'Does caching improve latency?',
        research_context_version_id: '11111111-1111-4111-8111-111111111111',
        question_refine_skipped: false,
        initial_intake: { history_mode: 'bounded_range', max_items: 1000, monitoring_field: 'submittedDate', report_depth: 'quick' },
        execution: {},
      },
      started_by_user_id: 'user-1', started_run_id: null,
      created_at: '2026-08-03T20:09:57.000Z', updated_at: '2026-08-03T20:09:57.000Z',
    }] as never)
    vi.mocked(inquiryApi.listThreads).mockResolvedValueOnce([{
      id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'question', statement: 'Does caching improve latency?',
      lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
      owner_user_id: 'user-1', next_focus_kind: null, next_focus_note: null, blocked_reason: null,
      version: 1, created_from: 'user', created_by_user_id: 'user-1',
      created_at: '2026-08-03T20:00:00.000Z', updated_at: '2026-08-03T20:00:00.000Z',
    }])

    renderArea('?research=new&thread=thread-1')

    expect(await screen.findByText(/Researching: Does caching improve latency/)).toBeInTheDocument()
    expect(screen.queryByText(/question has not passed refinement/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Refine in Inquiry' })).not.toBeInTheDocument()
  })

  it('opens the existing operation instead of a duplicate setup after that Inquiry intake completed', async () => {
    mockResearchProject()
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'completed',
      status: 'completed', mode: 'autonomous', state_json: { research_question: 'Does caching improve latency?' },
      primary_thread_id: 'thread-1', started_by_user_id: 'user-1', started_run_id: null,
      created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z',
    }] as never)
    vi.mocked(inquiryApi.listThreads).mockResolvedValueOnce([{
      id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'question', statement: 'Does caching improve latency?',
      lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
      owner_user_id: 'user-1', next_focus_kind: null, next_focus_note: null, blocked_reason: null,
      version: 1, created_from: 'user', created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }])

    renderArea('?research=new&thread=thread-1')

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      'Research has already started for this Inquiry. Opening its operation instead.',
    ))
    expect(screen.queryByText(/Researching: Does caching improve latency/)).not.toBeInTheDocument()
  })
})
