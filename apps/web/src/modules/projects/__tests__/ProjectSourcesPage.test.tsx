import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ProjectSourcesPage from '../ProjectSourcesPage'
import { projectResearchApi, projectsApi, readerApi, sourcesApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    get: vi.fn(),
    corpus: vi.fn(),
    updateCorpusItem: vi.fn(),
    backfillCorpusFromSources: vi.fn(),
    sourceBindings: vi.fn(),
    sourceExtractionProfiles: vi.fn(),
    sourceHealth: vi.fn(),
    backfillSourceBinding: vi.fn(),
    updateSourceBinding: vi.fn(),
    deleteSourceBinding: vi.fn(),
    createSourceBinding: vi.fn(),
    proposeSourceBinding: vi.fn(),
    createOperation:vi.fn(),
    proposeBindingBackfill:vi.fn(),
  },
  projectResearchApi: {
    screeningCriteria: vi.fn(),
    upsertScreeningCriteria: vi.fn(),
  },
  readerApi: {
    listByProject: vi.fn(),
  },
  sourcesApi: {
    channels: vi.fn(),
    evidence: vi.fn(),
    postProcessingDecisions: vi.fn(),
    createManualUrl: vi.fn(),
    updateItem: vi.fn(),
    projectSourceBindings: vi.fn(),
    projectSourceHealth: vi.fn(),
    projectItems: vi.fn(),
    createProjectSourceBinding: vi.fn(),
    backfillProjectSourceBinding: vi.fn(),
    scanChannel: vi.fn(),
    updateProjectSourceBinding: vi.fn(),
    deleteProjectSourceBinding: vi.fn(),
    channelBackfillPlans: vi.fn(),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectResearchApi.screeningCriteria).mockResolvedValue({
    id: null,
    project_id: 'project-1',
    include_keywords: [],
    exclude_keywords: [],
    domain_criteria: {},
    available_domain_criteria: [],
    date_range_start: null,
    date_range_end: null,
    source_restrictions: [],
    required_evidence_fields: [],
    created_at: null,
    updated_at: null,
  })
  vi.mocked(projectResearchApi.upsertScreeningCriteria).mockImplementation(async (_projectId, body) => ({ ...{
    id: null,
    project_id: 'project-1',
    include_keywords: [],
    exclude_keywords: [],
    domain_criteria: {},
    available_domain_criteria: [],
    date_range_start: null,
    date_range_end: null,
    source_restrictions: [],
    required_evidence_fields: [],
    created_at: null,
    updated_at: null,
  }, ...body }))
  vi.mocked(projectsApi.get).mockResolvedValue({
    id: 'project-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    name: 'Research Project',
    description: null,
    status: 'active',
    current_focus: null,
    settings_json: {},
    active_brief_version_id: null,
    archived_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  })
  vi.mocked(projectsApi.sourceExtractionProfiles).mockResolvedValue([{
    key: 'generic_document_v1', display_name: 'Generic document', entity_type: 'document',
    domain_criteria_keys: [], graph_lens_id: null, is_default: true,
  }, {
    key: 'academic_paper_v1', display_name: 'Academic paper', entity_type: 'academic_paper',
    domain_criteria_keys: ['methods'], graph_lens_id: 'academic_citation_v1', is_default: false,
  }])
  vi.mocked(sourcesApi.channels).mockResolvedValue([{
    id: 'channel-1',
    space_id: 'space-1',
    source_connection_id: 'conn-1',
    source_name: 'RSS feeds',
    name: 'Research feed',
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
  }])
  vi.mocked(sourcesApi.channelBackfillPlans).mockResolvedValue([])
  vi.mocked(projectsApi.proposeBindingBackfill).mockResolvedValue({operation:{id:'operation-1'},plan:{id:'plan-1'},proposal:{id:'proposal-1'}} as never)
  vi.mocked(projectsApi.sourceBindings).mockResolvedValue([{
    id: 'binding-1',
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
    extraction_policy_json: { profile_key: 'generic_document_v1' },
    extraction_profile: { key: 'generic_document_v1', display_name: 'Generic document', entity_type: 'document', graph_lens_id: null },
    created_by_user_id: 'user-1',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  }])
  vi.mocked(projectsApi.sourceHealth).mockResolvedValue([{
    binding_id: 'binding-1',
    project_id: 'project-1',
    source_connection_id: 'conn-1',
    source_channel_id: 'channel-1',
    source_name: 'Research feed',
    status: 'healthy',
    last_success_at: '2026-07-01T00:00:00.000Z',
    last_failure_at: null,
    last_error: 'A previous scan failed',
    next_run_at: '2026-07-02T00:00:00.000Z',
    queued_jobs: 0,
    running_jobs: 0,
    recent_new_items: 1,
    consecutive_failures: 0,
  }])
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
      matched_at: '2026-07-01T00:00:00.000Z',
      match_reason: 'project_source_binding:binding-1',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      item: {
        id: 'item-1',
        space_id: 'space-1',
        connection_id: 'conn-1',
        item_type: 'external_url',
        source_object_type: null,
        source_object_id: null,
        created_by_user_id: null,
        title: 'Collected paper',
        source_uri: 'https://example.test/paper',
        canonical_uri: 'https://example.test/paper',
        source_domain: 'example.test',
        source_external_id: null,
        author: null,
        occurred_at: null,
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-01T00:00:00.000Z',
        content_hash: null,
        excerpt: 'A collected item',
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
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    }],
    total: 1,
    limit: 50,
    offset: 0,
  })
  vi.mocked(projectsApi.corpus).mockResolvedValue({
    items: [{
      id: 'corpus-1',
      space_id: 'space-1',
      project_id: 'project-1',
      object_id: null,
      source_item_id: 'item-1',
      evidence_id: null,
      source_connection_id: 'conn-1',
      source_decision_id: null,
      role: 'candidate',
      status: 'active',
      triage_status: 'new',
      read_status: 'unread',
      relevance: null,
      confidence: null,
      reason: 'project_source_binding:binding-1',
      added_by_user_id: null,
      metadata_json: {},
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      last_reviewed_at: null,
      last_read_at: null,
      object: null,
      source_item: {
        id: 'item-1',
        item_type: 'external_url',
        title: 'Collected paper',
        source_uri: 'https://example.test/paper',
        source_domain: 'example.test',
        excerpt: 'A collected item',
      },
      evidence: null,
    }],
    total: 1,
    limit: 50,
    offset: 0,
  })
  vi.mocked(projectsApi.updateCorpusItem).mockImplementation((_projectId, _corpusItemId, patch) => Promise.resolve({
    id: 'corpus-1',
    space_id: 'space-1',
    project_id: 'project-1',
    object_id: null,
    source_item_id: 'item-1',
    evidence_id: null,
    source_connection_id: 'conn-1',
    source_decision_id: null,
    role: 'candidate',
    status: 'active',
    triage_status: patch.triage_status ?? 'new',
    read_status: patch.read_status ?? 'unread',
    relevance: null,
    confidence: null,
    reason: 'project_source_binding:binding-1',
    added_by_user_id: null,
    metadata_json: {},
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    last_reviewed_at: patch.triage_status ? '2026-07-01T00:00:00.000Z' : null,
    last_read_at: patch.read_status ? '2026-07-01T00:00:00.000Z' : null,
    object: null,
    source_item: {
      id: 'item-1',
      item_type: 'external_url',
      title: 'Collected paper',
      source_uri: 'https://example.test/paper',
      source_domain: 'example.test',
      excerpt: 'A collected item',
    },
    evidence: null,
  }))
  vi.mocked(projectsApi.backfillCorpusFromSources).mockResolvedValue({
    project_id: 'project-1',
    source_items: 1,
    source_objects: 0,
    evidence_items: 0,
    evidence_objects: 0,
    source_decisions: 0,
    archived_source_items: 0,
  })
  vi.mocked(projectsApi.backfillSourceBinding).mockResolvedValue({
    binding_id: 'binding-1',
    project_id: 'project-1',
    source_connection_id: 'conn-1',
    created_links: 1,
    reactivated_links: 0,
    archived_links: 0,
    evidence_links: 1,
  })
  vi.mocked(sourcesApi.scanChannel).mockResolvedValue({ id: 'job-1' } as never)
  vi.mocked(sourcesApi.evidence).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 } as never)
  vi.mocked(sourcesApi.postProcessingDecisions).mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 } as never)
  vi.mocked(readerApi.listByProject).mockResolvedValue({ items: [] } as never)
  vi.mocked(sourcesApi.updateItem).mockImplementation(async (id, patch) => ({
    ...manualUrlItem, id, ...patch,
  }) as never)
  vi.mocked(sourcesApi.createManualUrl).mockResolvedValue({
    ...manualUrlItem, id: 'item-new', title: 'Saved URL', connection_id: 'conn-1',
  } as never)
})

/** A URL a person saved by hand: no monitor collected it, so its Project
 *  source is reassignable afterwards. */
const manualUrlItem = {
  id: 'item-manual',
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
  first_seen_at: '2026-07-01T00:00:00.000Z',
  last_seen_at: '2026-07-01T00:00:00.000Z',
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
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

function renderPage(initialEntry = '/spaces/space-1/projects/project-1/sources') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/sources" element={<ProjectSourcesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProjectSourcesPage', () => {
  it('renders project source bindings and project items from project APIs', async () => {
    renderPage()

    expect(await screen.findByText('Research Project')).toBeInTheDocument()
    expect(screen.getByText(/Monitor: Research feed/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'RSS feeds' })).toHaveAttribute('href', '/sources/conn-1')
    expect(screen.queryByText(/a previous scan failed/i)).not.toBeInTheDocument()
    expect(screen.getByText('Collected paper')).toBeInTheDocument()
    expect(screen.queryByText('Project corpus')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(projectsApi.sourceBindings).toHaveBeenCalledWith('project-1')
      expect(sourcesApi.projectItems).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'project-1', limit: 50 }))
      expect(projectsApi.corpus).not.toHaveBeenCalled()
    })
  })

  it('derives the graph lens from an active extraction profile, not Template provenance', async () => {
    vi.mocked(projectsApi.get).mockResolvedValueOnce({
      id: 'project-1',
      space_id: 'space-1',
      owner_user_id: 'user-1',
      name: 'Academic Project',
      description: null,
      status: 'active',
      current_focus: null,
      settings_json: null,
      active_brief_version_id: null,
      archived_at: null,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    vi.mocked(projectsApi.sourceBindings).mockResolvedValueOnce([{
      id: 'binding-academic', space_id: 'space-1', project_id: 'project-1', source_channel_id: 'channel-1',
      binding_key: 'default', status: 'active', priority: 0, delivery_scope: 'project_members',
      collection_notifications_enabled: true, standing_comparison_enabled: true,
      filters_json: {}, routing_policy_json: {}, extraction_policy_json: { profile_key: 'academic_paper_v1' },
      extraction_profile: { key: 'academic_paper_v1', display_name: 'Academic paper', entity_type: 'academic_paper', graph_lens_id: 'academic_citation_v1' },
      created_by_user_id: 'user-1', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
    }])
    renderPage()

    const graphLink = await screen.findByRole('link', { name: /open graph/i })
    expect(graphLink).toHaveAttribute('href', '/graph?project_id=project-1&lens_id=academic_citation_v1')
    expect(screen.getByRole('link', { name: /create reusable source/i })).toHaveAttribute(
      'href',
      '/sources',
    )
    expect(screen.getByText('Sources')).toBeInTheDocument()
    expect(screen.getByText('Advanced monitor state')).toBeInTheDocument()
    expect(screen.getByText(/Cursor empty · watermark/)).toBeInTheDocument()
    expect(projectsApi.get).toHaveBeenCalledWith('project-1')
  })

  it('uses the activity date query as a project item filter', async () => {
    renderPage('/spaces/space-1/projects/project-1/sources?date=2026-07-01')

    expect(await screen.findByLabelText('Collected date')).toHaveValue('2026-07-01')
    await waitFor(() => {
      expect(sourcesApi.projectItems).toHaveBeenCalledWith(expect.objectContaining({
        project_id: 'project-1',
        matched_date: '2026-07-01',
      }))
    })
  })

  it('runs scan and backfill from binding actions', async () => {
    vi.mocked(sourcesApi.channels).mockResolvedValue([{
      id: 'channel-1',
      space_id: 'space-1',
      source_connection_id: 'conn-1',
      source_name: 'arXiv',
      name: 'Research feed',
      channel_type: 'search',
      endpoint_url: 'https://export.arxiv.org/api/query',
      query: { search_query: 'all:research' },
      provider_query: { search_query: 'all:research' },
      query_fingerprint: 'fingerprint-1',
      status: 'active',
      fetch_frequency: 'daily',
      schedule_rule: null,
      provider: { key: 'arxiv', display_name: 'arXiv' },
      connection_status: 'active',
      capture_policy: 'extract_text',
      scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
    }])
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /run scan/i }))
    await waitFor(() => expect(sourcesApi.scanChannel).toHaveBeenCalledWith('channel-1'))

    fireEvent.click(await screen.findByRole('button', { name: /import history/i }))
    await waitFor(() => expect(projectsApi.proposeBindingBackfill).toHaveBeenCalledWith('project-1','binding-1',expect.objectContaining({strategy:expect.objectContaining({window_unit:'date_window'})})))
    expect(projectsApi.get).toHaveBeenCalledTimes(1)
  })

  it('uses the product confirmation dialog before removing a binding', async () => {
    vi.mocked(projectsApi.deleteSourceBinding).mockResolvedValue({ id: 'binding-1', status: 'archived' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))
    expect(screen.getByRole('heading', { name: /remove source from project/i })).toBeInTheDocument()
    expect(projectsApi.deleteSourceBinding).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /remove source/i }))
    await waitFor(() => expect(projectsApi.deleteSourceBinding).toHaveBeenCalledWith('project-1', 'binding-1'))
  })

  it('directly binds an existing Source for a Project writer', async () => {
    vi.mocked(projectsApi.sourceBindings).mockResolvedValueOnce([])
    vi.mocked(projectsApi.createSourceBinding).mockResolvedValue({ id: 'binding-new' } as never)
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /add source/i }))[0]!)
    const addSourceButtons = screen.getAllByRole('button', { name: /add source/i })
    fireEvent.click(addSourceButtons[addSourceButtons.length - 1]!)

    await waitFor(() => expect(projectsApi.createSourceBinding).toHaveBeenCalledWith('project-1', expect.objectContaining({
      source_channel_id: 'channel-1',
      delivery_scope: 'project_members',
      backfill_history: true,
      standing_comparison_enabled: true,
      extraction_policy: { profile_key: 'generic_document_v1' },
    })))
    expect(projectsApi.proposeSourceBinding).not.toHaveBeenCalled()
  })

  it('shows and persists each binding profile and Standing setting', async () => {
    vi.mocked(projectsApi.updateSourceBinding).mockResolvedValue({ id: 'binding-1' } as never)
    renderPage()

    expect(await screen.findByText('Generic document')).toBeInTheDocument()
    expect(screen.getByText('Standing off')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enable standing' }))
    await waitFor(() => expect(projectsApi.updateSourceBinding).toHaveBeenCalledWith(
      'project-1',
      'binding-1',
      { standing_comparison_enabled: true },
    ))
  })

  it('shows domain screening fields only when a bound profile declares them', async () => {
    vi.mocked(projectResearchApi.screeningCriteria).mockResolvedValueOnce({
      ...{
    id: null,
    project_id: 'project-1',
    include_keywords: [],
    exclude_keywords: [],
    domain_criteria: {},
    available_domain_criteria: [],
    date_range_start: null,
    date_range_end: null,
    source_restrictions: [],
    required_evidence_fields: [],
    created_at: null,
    updated_at: null,
  },
      domain_criteria: { methods: ['randomized'] },
      available_domain_criteria: ['methods'],
    })
    renderPage()

    expect(await screen.findByLabelText('Methods')).toHaveValue('randomized')
    expect(screen.queryByLabelText('sample size')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Methods'), { target: { value: 'randomized, observational' } })
    fireEvent.click(screen.getByRole('button', { name: /save criteria/i }))

    await waitFor(() => expect(projectResearchApi.upsertScreeningCriteria).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ domain_criteria: { methods: ['randomized', 'observational'] } }),
    ))
  })

  it('keeps domain screening fields absent when no active profile declares one', async () => {
    renderPage()
    await screen.findByText('Screening criteria')
    expect(screen.queryByLabelText('Methods')).not.toBeInTheDocument()
  })

  it('keeps corpus review controls out of the acquisition surface', async () => {
    renderPage()
    await screen.findByText('Collected paper')
    expect(screen.queryByRole('button', { name: /sync corpus/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^new$/i })).not.toBeInTheDocument()
    expect(projectsApi.backfillCorpusFromSources).not.toHaveBeenCalled()
    expect(projectsApi.updateCorpusItem).not.toHaveBeenCalled()
  })
})

/**
 * What this Project's sources produced, and saving a URL into them.
 *
 * These lived on the Project Overview while the bindings and items they
 * derive from lived here, so one source pipeline was split across two pages.
 */
describe('ProjectSourcesPage derived source signals', () => {
  it('shows active evidence, recommendations, and reader annotations for the project', async () => {
    vi.mocked(sourcesApi.evidence).mockResolvedValue({
      items: [{
        id: 'evidence-1', space_id: 'space-1', source_item_id: 'item-1',
        extraction_job_id: null, source_snapshot_id: null,
        source_object_type: null, source_object_id: null,
        evidence_type: 'excerpt', title: 'Useful evidence',
        content_excerpt: 'Project-relevant excerpt.', content_hash: null, artifact_id: null,
        source_uri: 'https://example.test/item', source_title: 'Collected paper', source_author: null,
        occurred_at: null, trust_level: 'normal', extraction_method: 'connection_scan',
        confidence: 0.7, status: 'active', metadata_json: null,
        created_by_user_id: null, created_by_agent_id: null, created_by_run_id: null,
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
      }],
      total: 1, limit: 5, offset: 0,
    } as never)
    vi.mocked(readerApi.listByProject).mockResolvedValue({
      items: [{
        id: 'ann-1', space_id: 'space-1', project_id: 'project-1',
        document_type: 'source_item', document_id: 'item-1',
        annotation_type: 'excerpt', quote_text: 'Highlighted content from the article.',
        anchor_json: {
          schema_version: 1, normalizer: 'plain_text_v1',
          quote_text: 'Highlighted content from the article.',
          text_range: { start: 0, end: 38, unit: 'utf16' as const },
          before_context: '', after_context: '',
        },
        color: null, label: null, visibility: 'space_shared', status: 'active',
        anchor_state: 'unverified' as const, created_by_user_id: 'user-1',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
      }],
    } as never)

    renderPage()

    expect(await screen.findByText('Useful evidence')).toBeInTheDocument()

    // The annotation card links back to the Library reader — it never owns
    // the reader, and offers no annotation controls of its own.
    const link = await screen.findByRole('link', { name: /highlighted content from the article/i })
    expect(link).toHaveAttribute('href', '/library/items/item-1')
    expect(screen.queryByRole('button', { name: /save annotation/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete annotation/i })).toBeNull()

    await waitFor(() => {
      expect(sourcesApi.evidence).toHaveBeenCalledWith({ project_id: 'project-1', status: 'active', limit: 5 })
      expect(sourcesApi.postProcessingDecisions).toHaveBeenCalled()
      expect(readerApi.listByProject).toHaveBeenCalledWith('project-1', 5)
    })
  })

  /**
   * Distinct from "Import history": this asks nothing of the provider, it
   * re-evaluates the binding against material the Source already collected.
   * The Project Overview owned it before Areas took their surfaces back, and
   * "Import history" is not a substitute — that one is proposal-gated and
   * offered only for search channels.
   */
  it('re-links already-collected items without going through a history-import proposal', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /re-link collected items/i }))

    await waitFor(() => {
      expect(sourcesApi.backfillProjectSourceBinding).toHaveBeenCalledWith('project-1', 'binding-1')
    })
    expect(projectsApi.proposeBindingBackfill).not.toHaveBeenCalled()
  })

  it('saves a URL directly to a project-linked Source', async () => {
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
    vi.mocked(sourcesApi.createManualUrl).mockResolvedValueOnce({
      ...manualUrlItem, id: 'item-existing', connection_id: null,
    } as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^save url$/i }))
    fireEvent.change(await screen.findByPlaceholderText('https://example.com/post'), { target: { value: 'https://example.test/existing' } })

    const buttons = screen.getAllByRole('button', { name: /^save url$/i })
    fireEvent.click(buttons[buttons.length - 1]!)

    await waitFor(() => {
      expect(sourcesApi.updateItem).toHaveBeenCalledWith('item-existing', { connection_id: 'conn-1' })
    })
  })

  it('changes the source for a manually saved URL item', async () => {
    vi.mocked(sourcesApi.channels).mockResolvedValue([
      {
        id: 'channel-1', space_id: 'space-1', source_connection_id: 'conn-1',
        source_name: 'RSS feeds', name: 'Research feed', channel_type: 'feed',
        endpoint_url: 'https://example.test/feed.xml', query: {}, provider_query: {},
        query_fingerprint: 'fingerprint-1', status: 'active', fetch_frequency: 'daily',
        schedule_rule: null, provider: { key: 'generic_rss', display_name: 'RSS' },
        connection_status: 'active', capture_policy: 'reference_only',
        scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
      },
      {
        id: 'channel-2', space_id: 'space-1', source_connection_id: 'conn-2',
        source_name: 'Engineering feeds', name: 'Engineering feed', channel_type: 'feed',
        endpoint_url: 'https://example.test/eng.xml', query: {}, provider_query: {},
        query_fingerprint: 'fingerprint-2', status: 'active', fetch_frequency: 'daily',
        schedule_rule: null, provider: { key: 'generic_rss', display_name: 'RSS' },
        connection_status: 'active', capture_policy: 'reference_only',
        scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
      },
    ] as never)
    vi.mocked(projectsApi.sourceBindings).mockResolvedValue([
      {
        id: 'binding-1', space_id: 'space-1', project_id: 'project-1',
        source_channel_id: 'channel-1', binding_key: 'default', status: 'active', priority: 0,
        delivery_scope: 'project_members', collection_notifications_enabled: true,
        standing_comparison_enabled: false, filters_json: {}, routing_policy_json: {},
        extraction_policy_json: {}, created_by_user_id: 'user-1',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'binding-2', space_id: 'space-1', project_id: 'project-1',
        source_channel_id: 'channel-2', binding_key: 'default', status: 'active', priority: 0,
        delivery_scope: 'project_members', collection_notifications_enabled: true,
        standing_comparison_enabled: false, filters_json: {}, routing_policy_json: {},
        extraction_policy_json: {}, created_by_user_id: 'user-1',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
      },
    ] as never)
    vi.mocked(sourcesApi.projectItems).mockResolvedValue({
      items: [{
        id: 'project-item-1', space_id: 'space-1', project_id: 'project-1',
        project_source_binding_id: 'binding-1', source_channel_id: 'channel-1',
        source_connection_id: 'conn-1', source_item_id: 'item-manual', status: 'active',
        matched_at: '2026-07-01T00:00:00.000Z',
        match_reason: 'project_source_binding:binding-1',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
        item: manualUrlItem,
      }],
      total: 1, limit: 50, offset: 0,
    } as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Source for Saved URL' }))
    fireEvent.click(screen.getByRole('option', { name: /^engineering feed .*rss$/i }))

    await waitFor(() => {
      expect(sourcesApi.updateItem).toHaveBeenCalledWith('item-manual', { connection_id: 'conn-2' })
    })
  })
})
