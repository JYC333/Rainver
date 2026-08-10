import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import LibraryModule from '../LibraryModule'
import { informationDigestsApi, projectsApi, sourcesApi } from '../../../api/client'
import type { ExtractionJob, InterestProfileSnapshot, SourceChannel, SourceItem } from '../../../types/api'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    list: vi.fn(),
    addCorpusItem: vi.fn(),
  },
  informationDigestsApi: {
    personal: vi.fn(),
    profile: vi.fn(),
    acceptCandidate: vi.fn(),
    dismissCandidate: vi.fn(),
    updateProfileSettings: vi.fn(),
    createTopic: vi.fn(),
    updateTopic: vi.fn(),
    archiveTopic: vi.fn(),
    applyStarterPack: vi.fn(),
    backfillProfileHistory: vi.fn(),
    serendipityFeedback: vi.fn(),
  },
  sourcesApi: {
    channels: vi.fn(),
    items: vi.fn(),
    briefings: vi.fn(),
    itemAction: vi.fn(),
    jobs: vi.fn(),
    runJob: vi.fn(),
  },
}))

function page<T>(items: T[], limit = 20) {
  return { items, total: items.length, limit, offset: 0 }
}

function interestProfile(overrides: Partial<InterestProfileSnapshot> = {}): InterestProfileSnapshot {
  return {
    profile_id: 'profile-1', maturity: 'cold', read_item_count: 0, covered_domain_count: 0,
    skeleton_size: 50, exploration_share: 1, gaps_are_meaningful: false,
    coverage: [], topics: [], ready_candidates: [], domains: [],
    settings: {
      coverage_half_life_days: 180, new_topic_occurrence_threshold: 4, new_topic_read_threshold: 2,
      warming_min_read_items: 15, warm_min_read_items: 60, warm_min_covered_domains: 5,
      interest_slots: 6, serendipity_slots: 2, interesting_cooldown_days: 7,
      neutral_cooldown_days: 30, probe_domain_budget: 3,
    },
    starter_packs: [],
    ...overrides,
  }
}

function channel(): SourceChannel {
  return {
    id: 'channel-1',
    space_id: 'space-1',
    source_connection_id: 'conn-1',
    source_name: 'arXiv',
    name: 'arXiv: 3dgs',
    channel_type: 'search',
    endpoint_url: 'https://export.arxiv.org/api/query',
    query: { search_query: 'all:3dgs' },
    provider_query: { search_query: 'all:3dgs' },
    query_fingerprint: 'fingerprint-1',
    status: 'active',
    fetch_frequency: 'daily',
    schedule_rule: null,
    provider: { key: 'arxiv', display_name: 'arXiv' },
    connection_status: 'active',
    capture_policy: 'extract_text',
    scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  }
}

function sourceItem(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: 'item-1',
    space_id: 'space-1',
    connection_id: 'conn-1',
    item_type: 'feed_entry',
    source_object_type: null,
    source_object_id: null,
    created_by_user_id: null,
    title: 'Gaussian Splatting Paper',
    source_uri: 'https://arxiv.org/abs/2607.00001',
    canonical_uri: 'https://arxiv.org/abs/2607.00001',
    source_domain: 'arxiv.org',
    source_external_id: '2607.00001',
    author: 'Researcher',
    occurred_at: null,
    first_seen_at: '2026-07-07T00:00:00.000Z',
    last_seen_at: '2026-07-07T00:00:00.000Z',
    content_hash: null,
    excerpt: 'A new paper summary.',
    library_status: 'new',
    read_status: 'unread',
    content_state: 'excerpt_saved',
    retention_policy: 'summary_only',
    relevance_score: null,
    novelty_score: null,
    raw_artifact_id: null,
    extracted_artifact_id: null,
    summary_artifact_id: null,
    search_index_ref: null,
    embedding_index_ref: null,
    metadata_json: {},
    created_at: '2026-07-07T00:00:00.000Z',
    updated_at: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

function extractionJob(overrides: Partial<ExtractionJob> = {}): ExtractionJob {
  return {
    id: 'extract-job-1',
    space_id: 'space-1',
    connection_id: 'conn-1',
    source_item_id: 'item-1',
    source_snapshot_id: null,
    source_object_type: null,
    source_object_id: null,
    job_type: 'extract_text',
    status: 'pending',
    started_at: null,
    completed_at: null,
    items_seen: null,
    items_created: null,
    items_updated: null,
    error_code: null,
    error_message: null,
    metadata_json: null,
    created_at: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

function renderLibrary(path = '/library/items') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/library/*" element={<LibraryModule />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sourcesApi.channels).mockResolvedValue([channel()])
    vi.mocked(sourcesApi.items).mockResolvedValue(page([sourceItem()], 30))
    vi.mocked(sourcesApi.briefings).mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 })
    vi.mocked(informationDigestsApi.personal).mockResolvedValue({
      id: 'digest-1', digest_type: 'personal', owner_user_id: 'user-1', project_id: null,
      digest_date: '2026-08-06', profile_maturity: 'cold', status: 'empty', settings: {},
      created_at: '2026-08-06T07:00:00Z', updated_at: '2026-08-06T07:00:00Z', items: [],
      team_aggregates_available: false, team_blind_spot_domains: [],
    })
    vi.mocked(informationDigestsApi.profile).mockResolvedValue(interestProfile())
    vi.mocked(projectsApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
  })

  it('defaults the Library shell to the all items route', async () => {
    renderLibrary('/library')

    expect(await screen.findByText('Gaussian Splatting Paper')).toBeInTheDocument()
    expect(sourcesApi.channels).toHaveBeenCalledTimes(1)
    expect(sourcesApi.items).toHaveBeenCalledWith(expect.objectContaining({ limit: 30, offset: 0 }))
    expect(sourcesApi.briefings).not.toHaveBeenCalled()
  })

  it('renders source items as the primary reading stream', async () => {
    renderLibrary('/library/items')

    expect(await screen.findByText('Gaussian Splatting Paper')).toBeInTheDocument()
    expect(screen.getByText('A new paper summary.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Gaussian Splatting Paper' })).toHaveAttribute('href', '/library/items/item-1')
    expect(sourcesApi.items).toHaveBeenCalledWith(expect.objectContaining({ limit: 30, offset: 0 }))
    expect(sourcesApi.briefings).not.toHaveBeenCalled()
  })

  it('uses item type routes as soft library-type filters', async () => {
    renderLibrary('/library/items/pdfs')

    expect(await screen.findByRole('heading', { name: 'PDFs' })).toBeInTheDocument()
    await waitFor(() => {
      expect(sourcesApi.items).toHaveBeenCalledWith(expect.objectContaining({
        library_type: 'pdf',
        limit: 30,
        offset: 0,
      }))
    })
    expect(sourcesApi.briefings).not.toHaveBeenCalled()
  })

  it('uses the podcasts route as the podcast library-type filter', async () => {
    renderLibrary('/library/items/podcasts')

    expect(await screen.findByRole('heading', { name: 'Podcasts' })).toBeInTheDocument()
    await waitFor(() => {
      expect(sourcesApi.items).toHaveBeenCalledWith(expect.objectContaining({
        library_type: 'podcast',
        limit: 30,
        offset: 0,
      }))
    })
  })

  it('renders the digest stream with decision counts and a link into the day detail', async () => {
    vi.mocked(sourcesApi.briefings).mockResolvedValue({
      items: [
        {
          source_channel_id: 'channel-1',
          connection_name: 'arXiv: 3dgs',
          project_id: null,
          date: '2026-07-07',
          run_ids: ['run-1'],
          run_count: 1,
          item_decision_counts: { relevant: 1, maybe: 2, not_relevant: 2 },
          digest_artifact_id: 'artifact-1',
          digest_preview: 'Screened 5 new items from arXiv.',
          latest_run_created_at: '2026-07-07T02:31:31.179Z',
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    })

    renderLibrary('/library/digests')

    expect(await screen.findByText('arXiv: 3dgs')).toBeInTheDocument()
    expect(screen.getByText('Screened 5 new items from arXiv.')).toBeInTheDocument()
    expect(screen.getByText('1 relevant')).toBeInTheDocument()
    expect(screen.getByText('2 maybe')).toBeInTheDocument()
    expect(screen.getByText('2 not relevant')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /arXiv: 3dgs/ })).toHaveAttribute('href', '/library/digests/channel-1/2026-07-07')
    expect(sourcesApi.items).not.toHaveBeenCalled()
  })

  it('records explicit serendipity feedback and replaces controls with the saved state', async () => {
    vi.mocked(informationDigestsApi.personal).mockResolvedValue({
      id: 'digest-1', digest_type: 'personal', owner_user_id: 'user-1', project_id: null,
      digest_date: '2026-08-06', profile_maturity: 'cold', status: 'ready', settings: {},
      created_at: '2026-08-06T07:00:00Z', updated_at: '2026-08-06T07:00:00Z',
      items: [{
        id: 'digest-item-1', source_item_id: 'source-item-1', section: 'serendipity', position: 0,
        quota_slot: 'serendipity:distant:1', matched_topic_id: null, serendipity_pool_item_id: 'pool-1',
        target_domain_key: 'history', discovery_origin: 'weekly_probe', score: 0.8,
        component_scores: { rotation: 1 }, rationale: 'Why you are seeing this: history is distant.',
        title: 'Outside history', source_uri: null, source_domain: null, author: null, excerpt: null,
        occurred_at: '2026-08-05T00:00:00Z', domain_key: 'history', depth: 'overview', genre: 'explainer',
        summary: 'A history overview.', read_status: 'unread', serendipity_feedback: null,
        stance_target: null, stance_target_key: null, stance_polarity: 'neutral', stance_confidence: 0,
        anonymous_read_count: null,
      }],
      team_aggregates_available: false, team_blind_spot_domains: [],
    })
    vi.mocked(informationDigestsApi.serendipityFeedback).mockResolvedValue({
      digest_item_id: 'digest-item-1', domain_key: 'history', feedback: 'never', cooldown_until: null,
      blocked: true, created_at: '2026-08-06T12:00:00Z',
    })

    renderLibrary('/library/digests')

    fireEvent.click(await screen.findByRole('button', { name: 'Never this direction again' }))
    await waitFor(() => expect(informationDigestsApi.serendipityFeedback).toHaveBeenCalledWith('space-1', 'digest-item-1', 'never'))
    expect(await screen.findByText('Feedback: Never this direction again')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Never this direction again' })).not.toBeInTheDocument()
  })

  it('files a digest item into a selected Project Corpus through the existing Project gate', async () => {
    vi.mocked(projectsApi.list).mockResolvedValue({
      items: [{ id: 'project-1', name: 'Research Project' } as never], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(informationDigestsApi.personal).mockResolvedValue({
      id: 'digest-1', digest_type: 'personal', owner_user_id: 'user-1', project_id: null,
      digest_date: '2026-08-06', profile_maturity: 'cold', status: 'ready', settings: {},
      created_at: '2026-08-06T07:00:00Z', updated_at: '2026-08-06T07:00:00Z',
      team_aggregates_available: false, team_blind_spot_domains: [],
      items: [{
        id: 'digest-item-1', source_item_id: 'source-item-1', section: 'interest', position: 0,
        quota_slot: 'interest:1', matched_topic_id: null, serendipity_pool_item_id: null,
        target_domain_key: null, discovery_origin: null, score: 0.8, component_scores: {}, rationale: null,
        title: 'Useful paper', source_uri: null, source_domain: null, author: null, excerpt: null,
        occurred_at: '2026-08-05T00:00:00Z', domain_key: 'history', depth: 'overview', genre: 'paper',
        summary: null, stance_target: null, stance_target_key: null, stance_polarity: 'neutral', stance_confidence: 0,
        read_status: 'unread', serendipity_feedback: null, anonymous_read_count: null,
      }],
    })
    vi.mocked(projectsApi.addCorpusItem).mockResolvedValue({} as never)

    renderLibrary('/library/digests')

    fireEvent.change(await screen.findByLabelText('Project for Useful paper'), { target: { value: 'project-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to Project Corpus' }))
    await waitFor(() => expect(projectsApi.addCorpusItem).toHaveBeenCalledWith('project-1', {
      source_item_id: 'source-item-1', role: 'candidate', triage_status: 'new',
      metadata_json: { origin: 'information_digest', digest_item_id: 'digest-item-1' },
    }))
  })

  it('lets the owner accept a deterministic topic suggestion from the private profile', async () => {
    vi.mocked(informationDigestsApi.profile).mockResolvedValue(interestProfile({
      domains: [{ key: 'artificial_intelligence', label: 'Artificial intelligence', group: 'technology' }],
      ready_candidates: [{ id: 'candidate-1', phrase_key: 'model-evaluation', display_phrase: 'Model evaluation', domain_key: 'artificial_intelligence', occurrence_count: 4, read_count: 2 }],
    }))
    vi.mocked(informationDigestsApi.acceptCandidate).mockResolvedValue({} as never)

    renderLibrary('/library/digests')

    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(informationDigestsApi.acceptCandidate).toHaveBeenCalledWith('space-1', 'model-evaluation', {}))
  })

  it('runs text extraction from the source item reading stream', async () => {
    vi.mocked(sourcesApi.itemAction).mockResolvedValue(sourceItem({
      content_state: 'content_queued',
      retention_policy: 'full_text',
    }))
    vi.mocked(sourcesApi.jobs).mockResolvedValue(page([extractionJob()], 1))
    vi.mocked(sourcesApi.runJob).mockResolvedValue(extractionJob({ status: 'succeeded' }))

    renderLibrary('/library/items')

    fireEvent.click(await screen.findByRole('button', { name: /extract text gaussian splatting paper/i }))

    await waitFor(() => {
      expect(sourcesApi.itemAction).toHaveBeenCalledWith('item-1', 'queue_content')
      expect(sourcesApi.jobs).toHaveBeenCalledWith({
        source_item_id: 'item-1',
        job_type: 'extract_text',
        status: 'pending',
        limit: 1,
      })
      expect(sourcesApi.runJob).toHaveBeenCalledWith('extract-job-1')
      expect(screen.getByText('succeeded')).toBeInTheDocument()
    })
  })

  it('allows content-saved items to be re-extracted from Library', async () => {
    vi.mocked(sourcesApi.items).mockResolvedValue(page([sourceItem({
      content_state: 'content_saved',
      retention_policy: 'full_text',
      extracted_artifact_id: 'artifact-1',
    })], 30))
    vi.mocked(sourcesApi.itemAction).mockResolvedValue(sourceItem({
      content_state: 'content_queued',
      retention_policy: 'full_text',
    }))
    vi.mocked(sourcesApi.jobs).mockResolvedValue(page([extractionJob()], 1))
    vi.mocked(sourcesApi.runJob).mockResolvedValue(extractionJob({ status: 'succeeded' }))

    renderLibrary('/library/items')

    fireEvent.click(await screen.findByRole('button', { name: /re-extract gaussian splatting paper/i }))

    await waitFor(() => {
      expect(sourcesApi.itemAction).toHaveBeenCalledWith('item-1', 'queue_content')
      expect(sourcesApi.runJob).toHaveBeenCalledWith('extract-job-1')
    })
  })

  it('shows an empty state when no library items exist yet', async () => {
    vi.mocked(sourcesApi.items).mockResolvedValue({ items: [], total: 0, limit: 30, offset: 0 })
    renderLibrary('/library/items')
    expect(await screen.findByText('No library items')).toBeInTheDocument()
  })

  it('shows an empty state when no digests exist yet', async () => {
    vi.mocked(sourcesApi.briefings).mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 })
    renderLibrary('/library/digests')
    expect(await screen.findByText('No digests')).toBeInTheDocument()
    expect(sourcesApi.items).not.toHaveBeenCalled()
  })
})
