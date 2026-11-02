import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import LibraryModule from '../LibraryModule'
import { informationDigestsApi, projectsApi, sourcesApi } from '../../../api/client'
import { clearSessionResidue } from '../../../lib/sessionResidue'
import type { InformationDigest, InterestProfileSnapshot, SourceChannel, SourceItem } from '../../../types/api'

// First-content guidance is covered by ReadingStart integration tests.
vi.mock('../ReadingStart', () => ({ ReadingStart: () => <p>No pending recommendations</p> }))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../core/spaceNav', async () => {
  const { Link, useNavigate }=await import('react-router-dom')
  return {useSpaceNavigate: useNavigate, SpaceLink: ({to,children,...props}:{to:string;children:ReactNode})=><Link to={to} {...props}>{children}</Link>}
})

vi.mock('../../../api/client', () => ({
  sourceGoalsApi: { list: vi.fn().mockResolvedValue({goals:[]}) },
  projectsApi: {
    list: vi.fn(),
    addCorpusItem: vi.fn(),
  },
  informationDigestsApi: {
    reading: vi.fn().mockResolvedValue({items:[],total:0,next_cursor:null}),
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
    backfillPersonal: vi.fn(),
    annotationEpisodes: vi.fn(),
    retryAnnotation: vi.fn(),
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

/** A history read that found the day's scheduled snapshot. */
function available(digest: Omit<InformationDigest, 'timezone' | 'period_start_utc' | 'period_end_utc' | 'generation_kind' | 'generated_at'>) {
  return {
    status: 'available' as const,
    digest: {
      ...digest,
      timezone: 'UTC', period_start_utc: `${digest.digest_date}T00:00:00.000Z`, period_end_utc: `${digest.digest_date}T23:59:59.999Z`,
      generation_kind: 'scheduled' as const, generated_at: digest.created_at,
    },
  }
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
    vi.mocked(informationDigestsApi.personal).mockResolvedValue(available({
      id: 'digest-1', digest_type: 'personal', owner_user_id: 'user-1', project_id: null,
      digest_date: '2026-08-06', profile_maturity: 'cold', status: 'empty', settings: {},
      created_at: '2026-08-06T07:00:00Z', updated_at: '2026-08-06T07:00:00Z', items: [],
      team_aggregates_available: false, team_blind_spot_domains: [],
    }))
    vi.mocked(informationDigestsApi.profile).mockResolvedValue(interestProfile())
    vi.mocked(informationDigestsApi.annotationEpisodes).mockResolvedValue({ episodes: [] })
    vi.mocked(projectsApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
  })

  it('labels Agent-provided material in the compatible item cards',async()=>{
    vi.mocked(sourcesApi.items).mockResolvedValue(page([sourceItem({metadata_json:{result_provenance:'agent_provided_unverified'}})],1));renderLibrary();await screen.findByText('Agent-provided · Not independently verified');
  })

  it('shows a missing day without generating it, and backfills only when asked', async () => {
    vi.mocked(informationDigestsApi.personal).mockResolvedValue({
      status: 'missing', digest_date: '2026-08-06', timezone: 'Asia/Shanghai',
      period_start_utc: '2026-08-05T16:00:00.000Z', period_end_utc: '2026-08-06T16:00:00.000Z',
      reason: 'not_generated', backfill_available: true,
    })
    vi.mocked(informationDigestsApi.backfillPersonal).mockImplementation(async () => {
      const made = available({
        id: 'digest-9', digest_type: 'personal', owner_user_id: 'user-1', project_id: null,
        digest_date: '2026-08-06', profile_maturity: 'cold', status: 'empty', settings: {},
        created_at: '2026-08-10T09:00:00Z', updated_at: '2026-08-10T09:00:00Z', items: [],
        team_aggregates_available: false, team_blind_spot_domains: [],
      }).digest
      return { created: true, digest: { ...made, timezone: 'Asia/Shanghai', generation_kind: 'backfill' } }
    })

    renderLibrary('/library/digests')

    // The day is the digest's own calendar date, labelled with its timezone.
    expect(await screen.findByText('Aug 6, 2026 · Asia/Shanghai')).toBeInTheDocument()
    expect(screen.getByText('No digest for Aug 6, 2026')).toBeInTheDocument()
    expect(screen.getByText(/No digest was generated for this day/)).toBeInTheDocument()
    expect(informationDigestsApi.backfillPersonal).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Backfill this day' }))
    await waitFor(() => expect(informationDigestsApi.backfillPersonal).toHaveBeenCalledWith('space-1', '2026-08-06'))
    expect(await screen.findByText(/^Backfilled /)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Backfill this day' })).not.toBeInTheDocument()
  })

  it('reads an earlier day when stepping back', async () => {
    renderLibrary('/library/digests')
    fireEvent.click(await screen.findByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(informationDigestsApi.personal).toHaveBeenLastCalledWith('space-1', '2026-08-05'))
  })

  it('keeps the personal digest frame while another day loads, drops an out-of-order reply, and replaces the content', async () => {
    const replies: Array<{ date?: string; resolve: (value: never) => void }> = []
    vi.mocked(informationDigestsApi.personal).mockReset()
    vi.mocked(informationDigestsApi.personal).mockImplementation(((_space: string, date?: string) => new Promise(resolve => { replies.push({ date, resolve }) })) as never)
    const digestItem = (title: string) => ({
      id: `item-${title}`, source_item_id: `source-${title}`, section: 'interest' as const, position: 0,
      quota_slot: 'interest:1', matched_topic_id: null, serendipity_pool_item_id: null,
      target_domain_key: null, discovery_origin: null, score: 0.8, component_scores: {}, rationale: 'Fixture rationale.',
      title, source_uri: null, source_domain: null, author: null, excerpt: null, occurred_at: '2026-08-05T00:00:00Z',
      domain_key: 'history', depth: 'overview' as const, genre: 'explainer' as const, summary: null, read_status: 'unread' as const,
      serendipity_feedback: null, stance_target: null, stance_target_key: null, stance_polarity: 'neutral' as const, stance_confidence: 0,
      anonymous_read_count: null,
    })
    const digestFor = (date: string, title: string) => available({
      id: `digest-${date}`, digest_type: 'personal', owner_user_id: 'user-1', project_id: null, digest_date: date,
      profile_maturity: 'warm', status: 'ready', settings: {}, created_at: `${date}T07:00:00Z`, updated_at: `${date}T07:00:00Z`,
      team_aggregates_available: false, team_blind_spot_domains: [], items: [digestItem(title)],
    })
    renderLibrary('/library/digests')
    await waitFor(() => expect(replies).toHaveLength(1))
    await act(async () => { replies[0]!.resolve(digestFor('2026-08-06', 'First day item') as never) })
    expect(await screen.findByText('First day item')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(replies).toHaveLength(2))
    expect(screen.getByText('Aug 5, 2026 · UTC')).toBeInTheDocument()
    expect(screen.getByTestId('digest-day-pending')).toHaveTextContent('Loading Aug 5, 2026… Still showing Aug 6, 2026.')
    expect(screen.getByTestId('digest-day-content')).toHaveAttribute('inert')
    expect(screen.getByText('First day item')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(replies).toHaveLength(3))
    expect(replies[2]!.date).toBe('2026-08-04')
    await act(async () => { replies[2]!.resolve(digestFor('2026-08-04', 'Asked day item') as never) })
    expect(await screen.findByText('Asked day item')).toBeInTheDocument()
    expect(screen.queryByText('First day item')).not.toBeInTheDocument()
    await act(async () => { replies[1]!.resolve(digestFor('2026-08-05', 'Late day item') as never) })
    expect(screen.queryByText('Late day item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('digest-day-pending')).not.toBeInTheDocument()
  })

  it('on a failed personal day shows no earlier content, names the day and keeps the navigation', async () => {
    renderLibrary('/library/digests')
    const earlier = await screen.findByRole('button', { name: 'Previous day' })
    vi.mocked(informationDigestsApi.personal).mockRejectedValueOnce(new Error('Digest read refused'))
    fireEvent.click(earlier)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Aug 5, 2026.')
    expect(screen.getByRole('alert')).toHaveTextContent('Digest read refused')
    expect(screen.queryByTestId('digest-day-pending')).not.toBeInTheDocument()
    expect(screen.getByText('Aug 5, 2026 · UTC')).toBeInTheDocument()
    expect(screen.queryByText(/^Scheduled digest$/)).not.toBeInTheDocument()
  })

  describe('personal daily edition beside the slower reads', () => {
    const ready = (date: string, title: string) => available({
      id: `digest-${date}`, digest_type: 'personal', owner_user_id: 'user-1', project_id: null, digest_date: date,
      profile_maturity: 'warm', status: 'ready', settings: {}, created_at: `${date}T07:00:00Z`, updated_at: `${date}T07:00:00Z`,
      team_aggregates_available: false, team_blind_spot_domains: [], items: [{
        id: `item-${title}`, source_item_id: `source-${title}`, section: 'interest' as const, position: 0,
        quota_slot: 'interest:1', matched_topic_id: null, serendipity_pool_item_id: null,
        target_domain_key: null, discovery_origin: null, score: 0.8, component_scores: {}, rationale: 'Fixture rationale.',
        title, source_uri: null, source_domain: null, author: null, excerpt: null, occurred_at: `${date}T00:00:00Z`,
        domain_key: 'history', depth: 'overview' as const, genre: 'explainer' as const, summary: null, read_status: 'unread' as const,
        serendipity_feedback: null, stance_target: null, stance_target_key: null, stance_polarity: 'neutral' as const, stance_confidence: 0,
        anonymous_read_count: null,
      }],
    })
    const statusError = (status: number, message: string) => Object.assign(new Error(message), { status })
    /** Answers no read until the test says so, in the order they were asked. */
    const held = <T,>() => {
      const reads: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = []
      const read = () => new Promise<T>((resolve, reject) => { reads.push({ resolve, reject }) })
      return { reads, read: read as never }
    }
    const opened = async () => {
      vi.mocked(informationDigestsApi.personal).mockResolvedValueOnce(ready('2026-08-06', 'Old day body') as never)
      renderLibrary('/library/digests')
      expect(await screen.findByText('Old day body')).toBeInTheDocument()
    }
    const content = () => screen.getByTestId('digest-day-content')

    it.each([
      [403, 'Digest access revoked'],
      [503, 'Digest read unavailable'],
    ])('names a day that fails with %i and offers Retry while the Source history still hangs', async (status, message) => {
      await opened()
      const history = held()
      const day = held<never>()
      vi.mocked(sourcesApi.briefings).mockImplementation(history.read)
      vi.mocked(informationDigestsApi.personal).mockImplementationOnce(day.read)
      fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
      await waitFor(() => expect(day.reads).toHaveLength(1))
      await act(async () => { day.reads[0]!.reject(statusError(status, message)) })

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('Could not load Aug 5, 2026.')
      expect(alert).toHaveTextContent(message)
      expect(content()).toBeEmptyDOMElement()
      expect(screen.getByText('Aug 5, 2026 · UTC')).toBeInTheDocument()
      expect(history.reads).toHaveLength(1)

      vi.mocked(informationDigestsApi.personal).mockResolvedValueOnce(ready('2026-08-05', 'Retried day body') as never)
      const retry = within(alert).getByRole('button')
      expect(retry).toBeEnabled()
      fireEvent.click(retry)
      expect(await screen.findByText('Retried day body')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(history.reads).toHaveLength(2)
    })

    it('clears a same-day Refresh refused with 403 while the Source history hangs, and Refresh stays usable', async () => {
      await opened()
      const history = held()
      const day = held<never>()
      vi.mocked(sourcesApi.briefings).mockImplementation(history.read)
      vi.mocked(informationDigestsApi.personal).mockImplementationOnce(day.read)
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      await waitFor(() => expect(day.reads).toHaveLength(1))
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
      await act(async () => { day.reads[0]!.reject(statusError(403, 'Digest access revoked')) })

      expect(content()).toBeEmptyDOMElement()
      expect(screen.queryByText('Old day body')).not.toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load Aug 6, 2026.')
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
    })

    it('presents the asked day while every other read hangs, and backfill does not wait for them', async () => {
      const history = held()
      const profile = held()
      const projects = held()
      vi.mocked(sourcesApi.briefings).mockImplementation(history.read)
      vi.mocked(informationDigestsApi.profile).mockImplementation(profile.read)
      vi.mocked(projectsApi.list).mockImplementation(projects.read)
      vi.mocked(informationDigestsApi.personal).mockResolvedValueOnce(ready('2026-08-06', 'Old day body') as never)
      renderLibrary('/library/digests')
      expect(await screen.findByText('Old day body')).toBeInTheDocument()

      const missing = {
        status: 'missing', digest_date: '2026-08-05', timezone: 'UTC',
        period_start_utc: '2026-08-05T00:00:00.000Z', period_end_utc: '2026-08-06T00:00:00.000Z',
        reason: 'not_generated', backfill_available: true,
      }
      vi.mocked(informationDigestsApi.personal).mockResolvedValueOnce(missing as never)
      fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
      expect(await screen.findByRole('button', { name: 'Backfill this day' })).toBeEnabled()
      expect(content()).not.toHaveAttribute('inert')
      expect(screen.queryByTestId('digest-day-pending')).not.toBeInTheDocument()
    })

    it('lets no late reply of an earlier day touch the day now shown', async () => {
      await opened()
      const history = held<never>()
      const profile = held<never>()
      const projects = held<never>()
      const day = held<never>()
      vi.mocked(sourcesApi.briefings).mockImplementationOnce(history.read)
      vi.mocked(informationDigestsApi.profile).mockImplementationOnce(profile.read)
      vi.mocked(projectsApi.list).mockImplementationOnce(projects.read)
      vi.mocked(informationDigestsApi.personal).mockImplementationOnce(day.read)
      fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
      await waitFor(() => expect(day.reads).toHaveLength(1))

      vi.mocked(sourcesApi.briefings).mockResolvedValue({
        items: [{
          source_channel_id: 'channel-1', connection_name: 'Kept channel', project_id: null, date: '2026-08-04', run_ids: ['run-1'], run_count: 1,
          item_decision_counts: { relevant: 1, maybe: 0, not_relevant: 0 }, digest_artifact_id: null, digest_preview: 'Kept briefing', latest_run_created_at: '2026-08-04T07:00:00Z',
        }],
        total: 1, limit: 10, offset: 0,
      } as never)
      vi.mocked(informationDigestsApi.personal).mockResolvedValueOnce(ready('2026-08-04', 'New day body') as never)
      fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
      expect(await screen.findByText('New day body')).toBeInTheDocument()
      expect(await screen.findByText('Kept briefing')).toBeInTheDocument()
      vi.mocked(toast.error).mockClear()

      await act(async () => {
        const refused = statusError(403, 'Late refusal')
        day.reads[0]!.reject(refused)
        history.reads[0]!.reject(refused)
        profile.reads[0]!.reject(refused)
        projects.reads[0]!.reject(refused)
      })
      expect(screen.getByText('New day body')).toBeInTheDocument()
      expect(screen.getByText('Kept briefing')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('drops what is shown on logout and takes no late reply of that session', async () => {
      await opened()
      const history = held<never>()
      const day = held<never>()
      vi.mocked(sourcesApi.briefings).mockImplementationOnce(history.read)
      vi.mocked(informationDigestsApi.personal).mockImplementationOnce(day.read)
      fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
      await waitFor(() => expect(day.reads).toHaveLength(1))
      vi.mocked(toast.error).mockClear()

      act(() => { clearSessionResidue() })
      expect(screen.queryByText('Old day body')).not.toBeInTheDocument()
      await act(async () => {
        day.reads[0]!.reject(statusError(403, 'Late refusal'))
        history.reads[0]!.reject(statusError(403, 'Late refusal'))
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()
    })
  })

  it('shows a countdown only for a scheduled retry, names a waiting condition, and offers a retry only for a paused episode', async () => {
    const inTwoMinutes = new Date(Date.now() + 2 * 60_000).toISOString()
    vi.mocked(informationDigestsApi.annotationEpisodes).mockResolvedValueOnce({
      episodes: [
        { episode_id: 'episode-1', wait_reason: 'retry_scheduled', affected_count: 2, next_retry_at: inTwoMinutes, connection_ids: [] },
        { episode_id: 'episode-2', wait_reason: 'egress_denied', affected_count: 1, next_retry_at: null, connection_ids: ['connection-1'] },
      ],
    })
    vi.mocked(informationDigestsApi.retryAnnotation).mockResolvedValue({ reopened: 3 })

    const first = renderLibrary('/library/digests')

    expect(await screen.findByText(/2 of your items failed to annotate\. Next automatic retry in 2 minutes/)).toBeInTheDocument()
    const waiting = screen.getByText('1 of your items is waiting until its Source may be sent to the annotation Provider.')
    expect(waiting.textContent).not.toMatch(/retry|minute/i)
    // Both recover on their own: nothing for a person to retry.
    expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument()
    first.unmount()

    vi.mocked(informationDigestsApi.annotationEpisodes).mockResolvedValue({
      episodes: [{ episode_id: 'episode-3', wait_reason: 'budget_exhausted', affected_count: 3, next_retry_at: null, connection_ids: [] }],
    })
    renderLibrary('/library/digests')
    expect(await screen.findByText('3 of your items failed repeatedly and are paused.')).toBeInTheDocument()
    vi.mocked(informationDigestsApi.annotationEpisodes).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(informationDigestsApi.retryAnnotation).toHaveBeenCalledWith('space-1'))
    // The notice reads its episodes again after the retry.
    await waitFor(() => expect(informationDigestsApi.annotationEpisodes).toHaveBeenCalledTimes(1))
  })

  it('opens recommendations first and keeps the full material stream available', async () => {
    renderLibrary('/library')

    expect(await screen.findByRole('heading',{name:'My reading'})).toBeInTheDocument()
    await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenCalledWith('space-1',expect.objectContaining({view:'pending'}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)})))
    expect(sourcesApi.items).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'All material'}))
    await waitFor(()=>expect(informationDigestsApi.reading).toHaveBeenLastCalledWith('space-1',expect.objectContaining({view:'all'}),undefined,expect.objectContaining({signal:expect.any(AbortSignal)})))
  })

  it('renders source items as the primary reading stream', async () => {
    renderLibrary('/library/items')

    expect(await screen.findByText('Gaussian Splatting Paper')).toBeInTheDocument()
    expect(screen.getByText('A new paper summary.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Gaussian Splatting Paper' })).toHaveAttribute('href', '/library/items/item-1')
    expect(sourcesApi.items).toHaveBeenCalledWith(expect.objectContaining({ limit: 30, offset: 0 }))
    expect(sourcesApi.briefings).not.toHaveBeenCalled()
  })

  it('keeps the latest search answer when an earlier query answers later', async () => {
    let answerFirst: (value: unknown) => void = () => {}
    vi.mocked(sourcesApi.items).mockImplementation(async params => {
      if (params?.q === 'r') return new Promise(resolve => { answerFirst = resolve }) as never
      if (params?.q === 'ru') return page([sourceItem({ id: 'item-ru', title: 'Rust Paper' })], 30)
      return page([sourceItem()], 30)
    })
    renderLibrary('/library/items')
    expect(await screen.findByText('Gaussian Splatting Paper')).toBeInTheDocument()

    const search = screen.getByPlaceholderText('Search title, excerpt, URI, domain')
    fireEvent.change(search, { target: { value: 'r' } })
    fireEvent.change(search, { target: { value: 'ru' } })
    expect(await screen.findByText('Rust Paper')).toBeInTheDocument()

    expect(sourcesApi.items).toHaveBeenCalledWith(expect.objectContaining({ q: 'r' }))
    await act(async () => { answerFirst(page([sourceItem({ id: 'item-r', title: 'Reinforcement Paper' })], 30)) })
    expect(screen.queryByText('Reinforcement Paper')).not.toBeInTheDocument()
    expect(screen.getByText('Rust Paper')).toBeInTheDocument()
    expect(screen.getByText('1 items')).toBeInTheDocument()
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
    vi.mocked(informationDigestsApi.personal).mockResolvedValue(available({
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
    }))
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
    vi.mocked(informationDigestsApi.personal).mockResolvedValue(available({
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
    }))
    vi.mocked(projectsApi.addCorpusItem).mockResolvedValue({} as never)

    renderLibrary('/library/digests')

    fireEvent.click(await screen.findByRole('button', { name: 'Project for Useful paper' }))
    fireEvent.click(screen.getByRole('option', { name: 'Research Project' }))
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

  it('opens the shared Reader for processing rather than running extraction from a card',async()=>{
    renderLibrary('/library/items');const links=await screen.findAllByRole('link',{name:'Read'});expect(links[0]).toHaveAttribute('href','/library/items/item-1');expect(screen.queryByRole('button',{name:/extract text/i})).not.toBeInTheDocument();expect(sourcesApi.itemAction).not.toHaveBeenCalled();expect(sourcesApi.runJob).not.toHaveBeenCalled();
  });
  it('keeps already readable items on the same Reader path',async()=>{
    vi.mocked(sourcesApi.items).mockResolvedValue(page([sourceItem({content_state:'content_saved',retention_policy:'full_text',extracted_artifact_id:'artifact-1'})],30));renderLibrary('/library/items');expect((await screen.findAllByRole('link',{name:'Read'}))[0]).toHaveAttribute('href','/library/items/item-1');expect(screen.queryByRole('button',{name:/re-extract/i})).not.toBeInTheDocument();
  });

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
