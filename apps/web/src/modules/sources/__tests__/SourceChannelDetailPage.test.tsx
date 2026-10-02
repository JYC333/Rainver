import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import SourceChannelDetailPage from '../SourceChannelDetailPage'
import { sourcesApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../api/client', () => ({
  sourcesApi: {
    providers: vi.fn(),
    channels: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    scanChannel: vi.fn(),
    runJob: vi.fn(),
  },
}))

const providers = [{
  id: 'provider-arxiv',
  provider_key: 'arxiv',
  display_name: 'arXiv',
  provider_kind: 'named' as const,
  category: 'academic',
  status: 'active' as const,
  capabilities: { search: true },
  config_schema: null,
  setup_schema: { category_groups: [] },
}]

function monitor(id: string, name: string, query: Record<string, unknown>) {
  return {
    id,
    space_id: 'space-1',
    source_connection_id: 'connection-1',
    source_name: 'arXiv Research',
    name,
    channel_type: 'search' as const,
    endpoint_url: 'https://export.arxiv.org/api/query',
    query,
    provider_query: query,
    query_fingerprint: id,
    status: 'active' as const,
    fetch_frequency: 'daily' as const,
    schedule_rule: null,
    provider: { key: 'arxiv', display_name: 'arXiv' },
    connection_status: 'active',
    capture_policy: 'extract_text' as const,
    scan_state: { status: 'active', cursor: {}, watermark: {}, next_run_at: null, last_run_at: null },
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/sources/connection-1']}>
      <Routes>
        <Route path="/sources/:sourceId" element={<SourceChannelDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Source detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sourcesApi.providers).mockResolvedValue(providers)
    vi.mocked(sourcesApi.channels).mockResolvedValue([
      monitor('monitor-1', 'Agent memory', { mode: 'search', search_query: 'all:"agent memory"' }),
      monitor('monitor-2', 'Planning methods', { mode: 'search', search_query: 'all:planning' }),
    ])
  })

  it('groups multiple monitors under one source origin', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'arXiv Research' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Monitors' })).toBeInTheDocument()
    expect(screen.getByText('Agent memory')).toBeInTheDocument()
    expect(screen.getByText('Planning methods')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('opens monitor configuration without changing the source origin', async () => {
    const user = userEvent.setup({ delay: null })
    renderPage()

    await user.click(await screen.findByRole('button', { name: /add monitor/i }))

    expect(screen.getByRole('heading', { name: 'Add monitor' })).toBeInTheDocument()
    expect(screen.getAllByText('arXiv Research')).toHaveLength(2)
    expect(screen.getByLabelText('Search scope')).toBeInTheDocument()
    expect(screen.queryByLabelText('Source platform')).not.toBeInTheDocument()
  })

  it('saves a search monitor edit without resubmitting its versioned query', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(sourcesApi.updateChannel).mockResolvedValue(monitor('monitor-1', 'Renamed', {}) as never)
    renderPage()

    await user.click((await screen.findAllByRole('button', { name: /edit/i }))[0]!)
    const name = screen.getByDisplayValue('Agent memory')
    await user.clear(name)
    await user.type(name, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save monitor' }))

    expect(sourcesApi.updateChannel).toHaveBeenCalledTimes(1)
    const [, body] = vi.mocked(sourcesApi.updateChannel).mock.calls[0]!
    expect(body).toMatchObject({ name: 'Renamed', fetch_frequency: 'daily' })
    expect(body).not.toHaveProperty('query')
    expect(body).not.toHaveProperty('endpoint_url')
  })

  it('adds a monitor to the Source being viewed, by its id', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(sourcesApi.createChannel).mockResolvedValue(monitor('monitor-3', 'Tool use', {}) as never)
    renderPage()

    await user.click(await screen.findByRole('button', { name: /add monitor/i }))
    await user.type(screen.getByPlaceholderText('e.g. all:"agent memory"'), 'all:tools')
    await user.click(screen.getByRole('button', { name: 'Create monitor' }))

    expect(sourcesApi.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      provider_key: 'arxiv',
      source_connection_id: 'connection-1',
    }))
  })
})
