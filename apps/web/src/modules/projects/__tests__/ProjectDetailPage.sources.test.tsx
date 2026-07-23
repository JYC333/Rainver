import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import ProjectDetailPage from '../ProjectDetailPage'
import {
  automationsApi, sourcesApi, readerApi, projectsApi, workspacesApi, projectPresetsApi, projectResearchApi,
  activityApi, artifactsApi, proposalsApi,
} from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
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

vi.mock('../../capabilities/ResearchWorkflowPanel', () => ({
  ResearchWorkflowPanel: () => <div>Research workflow panel</div>,
}))

vi.mock('../../../api/client', () => ({
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
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
      archived_at: null,
    }),
    getSummary: vi.fn().mockResolvedValue({
      project_id: 'project-1',
      activity_count: 0,
      artifact_count: 0,
      pending_proposal_count: 0,
      workspace_count: 0,
      active_run_count: 0,
      memory_entry_count: 0,
    }),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    archive: vi.fn(),
    linkWorkspace: vi.fn(),
    unlinkWorkspace: vi.fn(),
    deleteSourceBinding: vi.fn().mockResolvedValue({ id: 'binding-1', status: 'archived' }),
    createSourceBinding: vi.fn().mockResolvedValue({
      id: 'binding-new',
      project_id: 'project-1',
      source_channel_id: 'channel-1',
      binding_key: 'default',
      status: 'active',
    }),
  },
  projectPresetsApi: {
    getProjectPreset: vi.fn().mockResolvedValue({ preset_key: null }),
  },
  projectResearchApi: {
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
      methods: [],
      date_range_start: null,
      date_range_end: null,
      venues: [],
      required_evidence_fields: [],
      created_at: null,
      updated_at: null,
    }),
    upsertScreeningCriteria: vi.fn(),
    literatureMatrix: vi.fn().mockResolvedValue([]),
    rebuildLiteratureMatrix: vi.fn(),
    reports: vi.fn().mockResolvedValue([]),
    runReportIntegrity: vi.fn(),
    questionChangeImpact: vi.fn().mockResolvedValue({
      workflow_id: 'workflow-1', previous_question: 'Old question', current_question: 'New question',
      previous_version: 1, screened_papers: 0, reports: 0,
    }),
    resolveQuestionChange: vi.fn().mockResolvedValue({}),
  },
  providersApi: {
    list: vi.fn().mockResolvedValue([]),
  },
  credentialsApi: {
    profiles: vi.fn().mockResolvedValue([]),
  },
  workspacesApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 }),
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

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/spaces/space-1/projects/project-1']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProjectDetailPage Source consumption', () => {
  it('shows Source summaries and links management back to Source', async () => {
    renderPage()

    expect(await screen.findByText('Project One')).toBeInTheDocument()
    expect(await screen.findByText('Engineering feed')).toBeInTheDocument()
    expect(await screen.findByText('Release item')).toBeInTheDocument()
    expect(await screen.findByText('Useful evidence')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^link source$/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /manage sources/i })).toHaveAttribute('href', '/projects/project-1/sources')
    expect(screen.queryByText(/create connection/i)).toBeNull()

    await waitFor(() => {
      expect(sourcesApi.projectSourceBindings).toHaveBeenCalledWith({ project_id: 'project-1' })
      expect(sourcesApi.projectItems).toHaveBeenCalledWith({ project_id: 'project-1', limit: 5 })
      expect(sourcesApi.evidence).toHaveBeenCalledWith({ project_id: 'project-1', status: 'active', limit: 5 })
      expect(automationsApi.list).toHaveBeenCalledWith({ project_id: 'project-1' })
      expect(projectPresetsApi.getProjectPreset).toHaveBeenCalledWith('project-1')
      expect(sourcesApi.createSourceRecipe).not.toHaveBeenCalled()
      expect(sourcesApi.createCustomSourceDraft).not.toHaveBeenCalled()
    })
  })

  it('renders the Academic Research workbench from the creation-time project preset', async () => {
    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    renderPage()

    expect(await screen.findByText('Research status')).toBeInTheDocument()
    expect(screen.getByText('Set the research question that screening and synthesis should answer.')).toBeInTheDocument()
    expect(screen.queryByText('Research corpus')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open reading list, notebook, checklist, and reports/ })).toHaveAttribute('href', '/projects/project-1/research')
    expect(screen.getByRole('button', { name: /^start initial research$/i })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /set up intake/i }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: /citation graph/i })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(projectResearchApi.workflows).toHaveBeenCalledWith('project-1')
      expect(projectResearchApi.literatureMatrix).toHaveBeenCalledWith('project-1')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText('Saved intake configuration')).toBeInTheDocument()
    expect(screen.getByLabelText('Research question')).toBeInTheDocument()
    expect(screen.getByText(/Engineering feed/)).toBeInTheDocument()
  })

  it('skips fetching data that only the non-academic sections render', async () => {
    // This suite has no global mock-clearing between tests (other cases rely
    // on accumulated call history), so the calls asserted "not called" below
    // must be cleared of whatever earlier non-academic tests already left on
    // these same shared spies.
    vi.mocked(workspacesApi.list).mockClear()
    vi.mocked(activityApi.list).mockClear()
    vi.mocked(artifactsApi.list).mockClear()
    vi.mocked(proposalsApi.list).mockClear()
    vi.mocked(sourcesApi.evidence).mockClear()
    vi.mocked(sourcesApi.postProcessingDecisions).mockClear()
    vi.mocked(readerApi.listByProject).mockClear()
    vi.mocked(projectResearchApi.screeningCriteria).mockClear()

    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    renderPage()

    expect(await screen.findByText('Research status')).toBeInTheDocument()
    await waitFor(() => {
      expect(projectResearchApi.workflows).toHaveBeenCalledWith('project-1')
    })

    // These four only feed the plain-project "Sources consumption"/"Project
    // activity" sections and the non-academic ResearchWorkflowPanel, none of
    // which render for an academic project — fetching them would be pure
    // waste on this page.
    expect(workspacesApi.list).not.toHaveBeenCalled()
    expect(activityApi.list).not.toHaveBeenCalled()
    expect(artifactsApi.list).not.toHaveBeenCalled()
    expect(proposalsApi.list).not.toHaveBeenCalled()
    expect(sourcesApi.evidence).not.toHaveBeenCalled()
    expect(sourcesApi.postProcessingDecisions).not.toHaveBeenCalled()
    expect(readerApi.listByProject).not.toHaveBeenCalled()
    // Screening criteria was fetched into a prop no component ever read.
    expect(projectResearchApi.screeningCriteria).not.toHaveBeenCalled()

    // Still-needed data — consumed by AcademicResearchWorkbench itself or by
    // sections shown regardless of project type — must still be fetched.
    expect(sourcesApi.channels).toHaveBeenCalled()
    expect(sourcesApi.projectSourceBindings).toHaveBeenCalledWith({ project_id: 'project-1' })
    expect(automationsApi.list).toHaveBeenCalledWith({ project_id: 'project-1' })
  })

  it('does not flash the initial intake setup while research data is loading', async () => {
    let resolveWorkflows!: (value: Awaited<ReturnType<typeof projectResearchApi.workflows>>) => void
    const workflows = new Promise<Awaited<ReturnType<typeof projectResearchApi.workflows>>>(resolve => {
      resolveWorkflows = resolve
    })
    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    vi.mocked(projectResearchApi.workflows).mockReturnValueOnce(workflows)

    renderPage()

    expect(await screen.findByText('Project One')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading academic research')).toBeInTheDocument()
    expect(screen.queryByText('Set up initial literature intake')).toBeNull()

    resolveWorkflows([])
    await waitFor(() => expect(screen.getByText('Set up initial literature intake')).toBeInTheDocument())
  })

  it('announces a pending research review instead of silently pausing', async () => {
    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1',
      project_id: 'project-1',
      workflow_type: 'literature_review',
      current_stage: 'screening',
      status: 'active',
      mode: 'autonomous',
      state_json: {},
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

    renderPage()

    expect((await screen.findAllByText('Review required')).length).toBeGreaterThan(0)
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Research review required',
      expect.objectContaining({
        id: 'research-review:project-1:checkpoint-1',
        duration: Infinity,
      }),
    ))
  })

  it('offers project-level source removal and keeps the source available', async () => {
    vi.mocked(projectsApi.deleteSourceBinding).mockResolvedValueOnce({ id: 'binding-1', status: 'archived' } as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))
    expect(screen.getByRole('heading', { name: /remove source from project/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /remove source/i }))

    await waitFor(() => expect(projectsApi.deleteSourceBinding).toHaveBeenCalledWith('project-1', 'binding-1'))
  })

  it('keeps the research question editable after it has been set', async () => {
    vi.mocked(projectsApi.get).mockResolvedValueOnce({
      id: 'project-1',
      space_id: 'space-1',
      owner_user_id: 'user-1',
      name: 'Project One',
      description: null,
      status: 'active',
      current_focus: 'How should agents use source evidence?',
      settings_json: null,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
      archived_at: null,
    })
    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    renderPage()

    expect(await screen.findByRole('button', { name: /edit question/i })).toBeInTheDocument()
  })

  it('warns that saving a changed question does not rewrite started research', async () => {
    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1', project_id: 'project-1', workflow_type: 'literature_review', current_stage: 'complete',
      status: 'active', mode: 'autonomous', state_json: { research_question: 'Old question', research_question_version: 1 },
      started_by_user_id: 'user-1', started_run_id: null, created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }])
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(screen.getByText(/saving a new question does not rewrite existing screening decisions or reports/i)).toBeInTheDocument()
  })

  it('resolves question drift through the impact-aware decision dialog', async () => {
    vi.mocked(projectsApi.get).mockResolvedValueOnce({
      id: 'project-1', space_id: 'space-1', owner_user_id: 'user-1', name: 'Project One', description: null,
      status: 'active', current_focus: 'New question', settings_json: null,
      created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z', archived_at: null,
    })
    vi.mocked(projectPresetsApi.getProjectPreset).mockResolvedValueOnce({ preset_key: 'academic_research' })
    vi.mocked(projectResearchApi.workflows).mockResolvedValueOnce([{
      id: 'workflow-1', project_id: 'project-1', workflow_type: 'literature_review', current_stage: 'complete',
      status: 'active', mode: 'autonomous', state_json: { research_question: 'Old question', research_question_version: 3, monitoring: { active: true } },
      started_by_user_id: 'user-1', started_run_id: null, created_at: '2026-06-30T00:00:00.000Z', updated_at: '2026-06-30T00:00:00.000Z',
    }])
    vi.mocked(projectResearchApi.questionChangeImpact).mockResolvedValueOnce({
      workflow_id: 'workflow-1', previous_question: 'Old question', current_question: 'New question',
      previous_version: 3, screened_papers: 27, reports: 2,
    })
    vi.mocked(projectResearchApi.resolveQuestionChange).mockResolvedValueOnce({} as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve question change' }))
    expect(await screen.findByText('27 papers screened against the previous question · 2 reports')).toBeInTheDocument()
    expect(screen.getByText('Question version 3 → 4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /re-screen against the new question/i }))

    await waitFor(() => expect(projectResearchApi.resolveQuestionChange).toHaveBeenCalledWith('project-1', 'rescreen'))
  })

  it('uses the unified confirmation dialog before archiving a project', async () => {
    vi.mocked(projectsApi.archive).mockResolvedValueOnce({} as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^archive$/i }))
    expect(screen.getByRole('heading', { name: /archive “project one”/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /archive project/i }))

    await waitFor(() => expect(projectsApi.archive).toHaveBeenCalledWith('project-1'))
  })

  it('backfills historical evidence for an existing linked source', async () => {
    renderPage()

    const button = await screen.findByRole('button', { name: /backfill history/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(sourcesApi.backfillProjectSourceBinding).toHaveBeenCalledWith('project-1', 'binding-1')
    })
  })

  it('links a Source directly from the Project page', async () => {
    vi.mocked(projectsApi.listWorkspaces).mockResolvedValue([
      {
        id: 'project-workspace-1',
        project_id: 'project-1',
        workspace_id: 'workspace-1',
        role: 'reference',
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
      },
    ])
    vi.mocked(workspacesApi.list).mockResolvedValue({
      items: [{
        id: 'workspace-1',
        owner_space_id: 'space-1',
        created_by_user_id: 'user-1',
        name: 'Project workspace',
        slug: 'project-workspace',
        description: null,
        workspace_type: 'project',
        kind: 'standard',
        repo_url: null,
        root_path: null,
        default_branch: null,
        visibility: 'space_shared',
        status: 'active',
        protected: false,
        system_managed: false,
        registered_from: null,
        metadata_json: null,
        snapshot_retention_days: null,
        snapshot_max_count: null,
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
      }],
      total: 1,
      limit: 200,
      offset: 0,
    })
    vi.mocked(sourcesApi.projectSourceBindings).mockResolvedValue([])

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^link source$/i }))
    expect(await screen.findByRole('dialog', { name: /^use an existing source$/i })).toBeInTheDocument()
    expect(screen.getByText(/Engineering feed · RSS/)).toBeInTheDocument()

    const buttons = screen.getAllByRole('button', { name: /^link source$/i })
    fireEvent.click(buttons[buttons.length - 1]!)

    await waitFor(() => {
      expect(projectsApi.createSourceBinding).toHaveBeenCalledWith('project-1', {
        source_channel_id: 'channel-1',
        backfill_history: true,
      })
    })
  })

  it('saves a URL directly to a project-linked Source', async () => {
    vi.mocked(sourcesApi.projectSourceBindings).mockResolvedValue([{
      id: 'binding-1',
      space_id: 'space-1',
      project_id: 'project-1',
      source_channel_id: 'channel-1',
      binding_key: 'default',
      status: 'active',
      priority: 0,
      delivery_scope: 'project_members',
      collection_notifications_enabled: true,
      filters_json: {},
      routing_policy_json: {},
      extraction_policy_json: {},
      created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }])

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^save url$/i }))
    expect(await screen.findByRole('dialog', { name: /^save url$/i })).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('https://example.com/post'), { target: { value: 'https://example.test/saved' } })
    fireEvent.change(screen.getByPlaceholderText('Optional'), { target: { value: 'Saved article' } })

    const buttons = screen.getAllByRole('button', { name: /^save url$/i })
    fireEvent.click(buttons[buttons.length - 1]!)

    await waitFor(() => {
      expect(sourcesApi.createManualUrl).toHaveBeenCalledWith({
        url: 'https://example.test/saved',
        title: 'Saved article',
        connection_id: 'conn-1',
        queue_content: false,
      })
    })
  })

  it('attaches an already saved URL to the selected project source', async () => {
    vi.mocked(sourcesApi.projectSourceBindings).mockResolvedValue([{
      id: 'binding-1',
      space_id: 'space-1',
      project_id: 'project-1',
      source_channel_id: 'channel-1',
      binding_key: 'default',
      status: 'active',
      priority: 0,
      delivery_scope: 'project_members',
      collection_notifications_enabled: true,
      filters_json: {},
      routing_policy_json: {},
      extraction_policy_json: {},
      created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }])
    vi.mocked(sourcesApi.createManualUrl).mockResolvedValueOnce({
      id: 'item-existing',
      space_id: 'space-1',
      connection_id: null,
      item_type: 'external_url',
      source_object_type: null,
      source_object_id: null,
      created_by_user_id: 'user-1',
      title: 'Existing URL',
      source_uri: 'https://example.test/existing',
      canonical_uri: 'https://example.test/existing',
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
    })
    vi.mocked(sourcesApi.updateItem).mockClear()

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^save url$/i }))
    fireEvent.change(await screen.findByPlaceholderText('https://example.com/post'), { target: { value: 'https://example.test/existing' } })

    const buttons = screen.getAllByRole('button', { name: /^save url$/i })
    fireEvent.click(buttons[buttons.length - 1]!)

    await waitFor(() => {
      expect(sourcesApi.updateItem).toHaveBeenCalledWith('item-existing', { connection_id: 'conn-1' })
    })
  })

  it('changes the source for a manually saved URL item from the Project page', async () => {
    vi.mocked(sourcesApi.channels).mockResolvedValue([
      {
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
      },
      {
        id: 'channel-2',
        space_id: 'space-1',
        source_connection_id: 'conn-2',
        source_name: 'Research feeds',
        name: 'Research feed',
        channel_type: 'feed',
        endpoint_url: 'https://example.test/research.xml',
        query: {},
        provider_query: {},
        query_fingerprint: 'fingerprint-2',
        status: 'active',
        fetch_frequency: 'daily',
        schedule_rule: null,
        provider: { key: 'generic_rss', display_name: 'RSS' },
        connection_status: 'active',
        capture_policy: 'reference_only',
        scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
      },
    ])
    vi.mocked(sourcesApi.projectSourceBindings).mockResolvedValue([
      {
        id: 'binding-1',
        space_id: 'space-1',
        project_id: 'project-1',
        source_channel_id: 'channel-1',
        binding_key: 'default',
        status: 'active',
        priority: 0,
        delivery_scope: 'project_members',
        collection_notifications_enabled: true,
        filters_json: {},
        routing_policy_json: {},
        extraction_policy_json: {},
        created_by_user_id: 'user-1',
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'binding-2',
        space_id: 'space-1',
        project_id: 'project-1',
        source_channel_id: 'channel-2',
        binding_key: 'default',
        status: 'active',
        priority: 0,
        delivery_scope: 'project_members',
        collection_notifications_enabled: true,
        filters_json: {},
        routing_policy_json: {},
        extraction_policy_json: {},
        created_by_user_id: 'user-1',
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
      },
    ])
    vi.mocked(sourcesApi.projectItems).mockResolvedValue({
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
          item_type: 'external_url',
          source_object_type: null,
          source_object_id: null,
          created_by_user_id: 'user-1',
          title: 'Saved URL',
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
        },
      }],
      total: 1,
      limit: 5,
      offset: 0,
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^engineering feed .*rss$/i }))
    fireEvent.click(screen.getByRole('option', { name: /^research feed .*rss$/i }))

    await waitFor(() => {
      expect(sourcesApi.updateItem).toHaveBeenCalledWith('item-1', { connection_id: 'conn-2' })
    })
  })

  it('shows reader annotation quote linked to the Library reader, with no annotation controls', async () => {
    vi.mocked(readerApi.listByProject).mockResolvedValueOnce({
      items: [{
        id: 'ann-1',
        space_id: 'space-1',
        document_type: 'source_item',
        document_id: 'item-1',
        annotation_type: 'excerpt',
        quote_text: 'Highlighted content from the article.',
        anchor_json: { schema_version: 1, normalizer: 'plain_text_v1', quote_text: 'Highlighted content from the article.', text_range: { start: 0, end: 38, unit: 'utf16' as const }, before_context: '', after_context: '' },
        color: null,
        label: null,
        visibility: 'space_shared',
        status: 'active',
        anchor_state: 'unverified' as const,
        created_by_user_id: 'user-1',
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
      }],
    })

    renderPage()

    // Quote text renders in the reader annotations card
    expect(await screen.findByText('Highlighted content from the article.')).toBeInTheDocument()

    // The card links back to the Library reader — never owns the reader itself
    const link = screen.getByRole('link', { name: /highlighted content from the article/i })
    expect(link).toHaveAttribute('href', '/library/items/item-1')

    // Project page has no annotation creation or deletion controls
    expect(screen.queryByRole('button', { name: /save annotation/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete annotation/i })).toBeNull()

    await waitFor(() => {
      expect(readerApi.listByProject).toHaveBeenCalledWith('project-1', 5)
    })
  })
})
