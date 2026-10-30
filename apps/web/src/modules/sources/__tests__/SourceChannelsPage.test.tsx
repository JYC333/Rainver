import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import SourceChannelsPage from '../SourceChannelsPage'
import { ApiRequestError, sourcesApi } from '../../../api/client'
import { toast } from 'sonner'
import i18n from '../../../i18n'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const scope = vi.hoisted(() => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', userId: 'user-1' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => scope }))

vi.mock('../../../api/client', async importOriginal => ({
  ApiRequestError: (await importOriginal<typeof import('../../../api/client')>()).ApiRequestError,
  sourcesApi: {
    providers: vi.fn(),
    channels: vi.fn(),
    recommendations: vi.fn(),
    followed: vi.fn(),
    setChannelSubscription: vi.fn(),
    decideRecommendation: vi.fn(),
    createChannel: vi.fn(),
    previewQuery: vi.fn(),
    updateChannel: vi.fn(),
    scanChannel: vi.fn(),
    runJob: vi.fn(),
  },
}))

const providers = [
  {
    id: 'provider-arxiv',
    provider_key: 'arxiv',
    display_name: 'arXiv',
    provider_kind: 'named' as const,
    category: 'academic',
    status: 'active' as const,
    capabilities: { search: true },
    config_schema: null,
    setup_schema: {
      category_groups: [{
        group: 'Computer Science',
        options: [
          { value: 'cs.AI', label: 'Artificial Intelligence' },
          { value: 'cs.LG', label: 'Machine Learning' },
        ],
      }],
    },
  },
  {
    id: 'provider-rss',
    provider_key: 'generic_rss',
    display_name: 'RSS Feed',
    provider_kind: 'generic' as const,
    category: 'feed',
    status: 'active' as const,
    capabilities: { search: false },
    config_schema: null,
  },
]

function source(overrides: Partial<Awaited<ReturnType<typeof sourcesApi.channels>>[number]> = {}) {
  return {
    id: 'source-1',
    space_id: 'space-1',
    source_connection_id: 'connection-1',
    source_name: 'arXiv',
    name: 'Agent memory',
    channel_type: 'search' as const,
    endpoint_url: 'https://export.arxiv.org/api/query',
    query: { search_query: 'all:"agent memory"' },
    provider_query: { search_query: 'all:"agent memory"' },
    query_fingerprint: 'fingerprint-1',
    status: 'active' as const,
    fetch_frequency: 'daily' as const,
    schedule_rule: null,
    provider: { key: 'arxiv', display_name: 'arXiv' },
    connection_status: 'active',
    capture_policy: 'extract_text' as const,
    scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
    ...overrides,
  }
}

function renderPage(initialEntry = '/sources') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/sources" element={<SourceChannelsPage />} /><Route path="/library/reading/goals/new" element={<h1>Goal setup</h1>}/>
      </Routes>
    </MemoryRouter>,
  )
}

describe('Sources page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scope.activeSpaceId = 'space-1'
    vi.mocked(sourcesApi.providers).mockResolvedValue(providers)
    vi.mocked(sourcesApi.channels).mockResolvedValue([source()])
    vi.mocked(sourcesApi.recommendations).mockResolvedValue([])
    vi.mocked(sourcesApi.followed).mockResolvedValue([])
    vi.mocked(sourcesApi.createChannel).mockResolvedValue(source())
    vi.mocked(sourcesApi.previewQuery).mockResolvedValue({
      provider_key: 'arxiv', compiled_query: 'all:"agent memory"', approximate_hit_count: 42,
      samples: [{ title: 'Agent memory systems', source_uri: 'https://arxiv.org/abs/1', occurred_at: '2026-07-18T00:00:00Z' }],
    })
  })

  it('does not restore a previous Space list when its request arrives after switching', async () => {
    let resolve!: (rows: Awaited<ReturnType<typeof sourcesApi.channels>>) => void
    vi.mocked(sourcesApi.channels).mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValue([])
    const { rerender } = render(<MemoryRouter><SourceChannelsPage /></MemoryRouter>)
    await waitFor(() => expect(sourcesApi.channels).toHaveBeenCalledTimes(1))
    scope.activeSpaceId = 'space-2'
    rerender(<MemoryRouter><SourceChannelsPage /></MemoryRouter>)
    await act(async () => { resolve([source({ name: 'Previous private monitor' })]) })
    expect(screen.queryByText('Previous private monitor')).not.toBeInTheDocument()
    expect(sourcesApi.channels).toHaveBeenCalledTimes(2)
  })

  it.each([403, 404])('refreshes stale source rows after a scan job is denied with %s', async status => {
    renderPage()
    await screen.findByText('Agent memory')
    vi.mocked(sourcesApi.scanChannel).mockResolvedValue({ id: 'job-1' } as never)
    vi.mocked(sourcesApi.runJob).mockRejectedValueOnce(new ApiRequestError('Access changed', status))
    vi.mocked(sourcesApi.channels).mockResolvedValueOnce([])

    fireEvent.click(screen.getByRole('button', { name: /Scan now/ }))

    await waitFor(() => expect(screen.queryByText('Agent memory')).not.toBeInTheDocument())
    expect(toast.error).toHaveBeenCalledWith('Access changed')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('clears loaded sources when refresh is denied after Space membership is revoked', async () => {
    renderPage()
    await screen.findByText('Agent memory')
    vi.mocked(sourcesApi.channels).mockRejectedValueOnce(new ApiRequestError('Space access revoked', 403))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(screen.queryByText('Agent memory')).not.toBeInTheDocument())
    expect(toast.error).toHaveBeenCalledWith('Space access revoked')
  })

  it('presents sources instead of exposing the internal channel model', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Source settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'arXiv' })).toHaveAttribute('href', '/sources/connection-1')
    expect(screen.getByText('Agent memory')).toBeInTheDocument()
    expect(screen.queryByText(/source channel/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/connection-1/i)).not.toBeInTheDocument()
  })

  it('keeps discovered sources pending until the reader decides to follow them', async () => {
    vi.mocked(sourcesApi.recommendations).mockResolvedValue([{
      ...source({ id: 'recommended-channel', source_name: 'Outside Review', name: 'Systems monitor' }),
      subscription_status: 'pending',
      recommendation_message: 'Recommended to broaden coverage into systems.',
      last_notified_at: null,
    }])
    vi.mocked(sourcesApi.decideRecommendation).mockResolvedValue({
      source_channel_id: 'recommended-channel', status: 'subscribed', updated_at: '2026-08-06T12:00:00Z',
    })

    renderPage()

    expect(await screen.findByText('Sources to broaden your coverage')).toBeInTheDocument()
    expect(screen.getByText('These remain suggestions until you choose to follow them.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    await waitFor(() => expect(sourcesApi.decideRecommendation).toHaveBeenCalledWith('recommended-channel', 'subscribed'))
    // No longer a suggestion: it is one of the sources this person follows.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Source recommendations' })).not.toBeInTheDocument())
    const followedRegion = await screen.findByRole('region', { name: 'Followed sources' })
    expect(followedRegion).toHaveTextContent('Outside Review · Systems monitor')
  })

  it('still shows the page when only the followed list fails to load, in either language', async () => {
    vi.mocked(sourcesApi.followed).mockRejectedValue(new Error('Followed unavailable'))
    renderPage()
    expect(await screen.findByText(/Sources you follow could not be loaded/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Source settings' })).toBeInTheDocument()

    await i18n.changeLanguage('zh-CN')
    try {
      expect(await screen.findByText(/无法加载你关注的来源/)).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('calls a source whose monitors are all stopped Paused, whatever order they come in', async () => {
    vi.mocked(sourcesApi.channels).mockResolvedValue([
      source({ id: 'source-1', name: 'Agent memory', status: 'paused' }),
      source({ id: 'source-2', name: 'Agent planning', status: 'archived' }),
    ])
    renderPage()

    await screen.findByText('Agent memory')
    expect(screen.queryByText('Mixed')).not.toBeInTheDocument()
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0)
  })

  it('lets a follower leave another member\'s source and follow it again', async () => {
    const followedChannel = { ...source({ id: 'channel-shared', name: 'Team feed' }), subscription_status: 'subscribed' as const }
    vi.mocked(sourcesApi.followed).mockResolvedValue([followedChannel])
    vi.mocked(sourcesApi.setChannelSubscription).mockResolvedValue({ source_channel_id: 'channel-shared', status: 'muted', updated_at: '2026-10-14T00:00:00Z' })
    renderPage()
    const leave = await screen.findByRole('button', { name: 'Leave' })
    fireEvent.click(leave)
    await waitFor(() => expect(sourcesApi.setChannelSubscription).toHaveBeenCalledWith('channel-shared', 'muted'))
    expect(await screen.findByRole('button', { name: 'Follow again' })).toBeInTheDocument()
  })
})
