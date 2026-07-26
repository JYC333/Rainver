import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ProjectSourcesPage from '../ProjectSourcesPage'
import { projectsApi, sourcesApi } from '../../../api/client'

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
    sourceHealth: vi.fn(),
    backfillSourceBinding: vi.fn(),
    updateSourceBinding: vi.fn(),
    deleteSourceBinding: vi.fn(),
    createSourceBinding: vi.fn(),
    proposeSourceBinding: vi.fn(),
    createOperation:vi.fn(),
    proposeBindingBackfill:vi.fn(),
  },
  sourcesApi: {
    channels: vi.fn(),
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
  vi.mocked(projectsApi.get).mockResolvedValue({
    id: 'project-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    name: 'Research Project',
    description: null,
    status: 'active',
    current_focus: null,
    settings_json: {},
    template_key: 'blank',
    primary_mode: 'inquiry',
    active_brief_version_id: null,
    archived_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  })
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
    filters_json: {},
    routing_policy_json: {},
    extraction_policy_json: {},
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
})

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

  it('opens the academic project graph with the citation lens', async () => {
    vi.mocked(projectsApi.get).mockResolvedValueOnce({
      id: 'project-1',
      space_id: 'space-1',
      owner_user_id: 'user-1',
      name: 'Academic Project',
      description: null,
      status: 'active',
      current_focus: null,
      settings_json: null,
      template_key: 'academic_research',
      primary_mode: 'inquiry',
      active_brief_version_id: null,
      archived_at: null,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    renderPage()

    const graphLink = await screen.findByRole('link', { name: /open graph/i })
    expect(graphLink).toHaveAttribute('href', '/graph?project_id=project-1&lens_id=academic_citation_v1')
    expect(screen.getByRole('link', { name: /create reusable source/i })).toHaveAttribute(
      'href',
      '/sources',
    )
    expect(screen.getByText('Literature sources')).toBeInTheDocument()
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
    })))
    expect(projectsApi.proposeSourceBinding).not.toHaveBeenCalled()
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
