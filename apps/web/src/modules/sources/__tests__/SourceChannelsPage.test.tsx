import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import SourceChannelsPage from '../SourceChannelsPage'
import { projectsApi, sourcesApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    createSourceBinding: vi.fn(),
  },
  sourcesApi: {
    providers: vi.fn(),
    channels: vi.fn(),
    recommendations: vi.fn(),
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
        <Route path="/sources" element={<SourceChannelsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Sources page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sourcesApi.providers).mockResolvedValue(providers)
    vi.mocked(sourcesApi.channels).mockResolvedValue([source()])
    vi.mocked(sourcesApi.recommendations).mockResolvedValue([])
    vi.mocked(sourcesApi.createChannel).mockResolvedValue(source())
    vi.mocked(sourcesApi.previewQuery).mockResolvedValue({
      provider_key: 'arxiv', compiled_query: 'all:"agent memory"', approximate_hit_count: 42,
      samples: [{ title: 'Agent memory systems', source_uri: 'https://arxiv.org/abs/1', occurred_at: '2026-07-18T00:00:00Z' }],
    })
    vi.mocked(projectsApi.createSourceBinding).mockResolvedValue({} as never)
  })

  it('presents sources instead of exposing the internal channel model', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument()
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
    await waitFor(() => expect(screen.queryByText('Outside Review · Systems monitor')).not.toBeInTheDocument())
  })

  it('configures an academic source through the provider-aware setup dialog', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /add source/i }))
    expect(screen.getByRole('heading', { name: 'Add source' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('e.g. all:"agent memory"'), { target: { value: 'all:"planning"' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Hour' }), { target: { value: '14' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minute' }), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create source' }))

    await waitFor(() => expect(sourcesApi.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      provider_key: 'arxiv',
      source_name: 'arXiv',
      name: 'all:"planning"',
      query: { mode: 'search', search_query: 'all:"planning"' },
      fetch_frequency: 'daily',
      schedule_rule: expect.objectContaining({ frequency: 'daily', hour: expect.any(Number), minute: 30 }),
      capture_policy: 'extract_text',
    })))
  })

  it('previews an arXiv query without saving the source', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /add source/i }))
    fireEvent.change(screen.getByPlaceholderText('e.g. all:"agent memory"'), { target: { value: 'agent memory' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test query' }))

    expect(await screen.findByText('Approximately 42 matches')).toBeInTheDocument()
    expect(screen.getByText('• Agent memory systems')).toBeInTheDocument()
    expect(sourcesApi.previewQuery).toHaveBeenCalledWith({ provider_key: 'arxiv', query: { mode: 'search', search_query: 'agent memory' } })
    expect(sourcesApi.createChannel).not.toHaveBeenCalled()
  })

  it('allows an explicit all-arXiv source without a user query', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /add source/i }))
    await user.click(screen.getByRole('button', { name: 'Search scope' }))
    await user.click(screen.getByRole('option', { name: 'All arXiv papers' }))
    await user.click(screen.getByRole('button', { name: 'Create source' }))

    await waitFor(() => expect(sourcesApi.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      provider_key: 'arxiv',
      query: { mode: 'all' },
    })))
  })

  it('allows selecting multiple arXiv categories from the searchable taxonomy', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: /add source/i }))
    await user.click(screen.getByRole('button', { name: 'Search scope' }))
    await user.click(screen.getByRole('option', { name: 'Category stream' }))
    await user.click(screen.getByText('Select categories'))
    await user.click(screen.getByRole('checkbox', { name: /cs\.AI/i }))
    await user.click(screen.getByRole('checkbox', { name: /cs\.LG/i }))
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('button', { name: 'Select categories' })).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /cs\.AI/i }))
    await user.click(screen.getByRole('checkbox', { name: /cs\.LG/i }))
    await user.click(screen.getByRole('button', { name: 'Create source' }))

    await waitFor(() => expect(sourcesApi.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      provider_key: 'arxiv',
      query: { mode: 'recent_by_category', categories: ['cs.AI', 'cs.LG'] },
    })))
  })

  it('creates a reusable source without binding it to a project', async () => {
    const user = userEvent.setup()
    const created = source({ id: 'channel-new', source_connection_id: 'connection-new' })
    vi.mocked(sourcesApi.createChannel).mockResolvedValueOnce(created)
    renderPage()

    await user.click(await screen.findByRole('button', { name: /add source/i }))
    await user.type(screen.getByPlaceholderText('e.g. all:"agent memory"'), 'all:"planning"')
    await user.click(screen.getByRole('button', { name: 'Create source' }))

    await waitFor(() => expect(sourcesApi.createChannel).toHaveBeenCalled())
    expect(projectsApi.createSourceBinding).not.toHaveBeenCalled()
  })
})
