import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
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
        <Route path="/sources/:sourceId" element={<SourceChannelDetailPage />} /><Route path="/sources/goals/new" element={<h1>Goal setup</h1>}/>
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

  it('offers a retry when the first load fails, instead of calling the source missing', async () => {
    vi.mocked(sourcesApi.channels).mockRejectedValueOnce(new Error('Network unavailable'))
    renderPage()

    expect(await screen.findByText('Could not load this source')).toBeInTheDocument()
    expect(screen.queryByText('Source not found')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'arXiv Research' })).toBeInTheDocument()
  })

  it('keeps the source on screen and says so when a later refresh fails', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'arXiv Research' })).toBeInTheDocument()
    vi.mocked(sourcesApi.channels).mockRejectedValueOnce(new Error('Network unavailable'))
    vi.mocked(sourcesApi.scanChannel).mockResolvedValue({ id: 'job-1' } as never)
    vi.mocked(sourcesApi.runJob).mockResolvedValue({} as never)
    await userEvent.click(screen.getAllByRole('button', { name: /Scan/ })[0]!)
    expect(await screen.findByText(/This source could not be refreshed/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'arXiv Research' })).toBeInTheDocument()
  })

  it('still says a source is missing when it loads and is not there', async () => {
    vi.mocked(sourcesApi.channels).mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('Source not found')).toBeInTheDocument()
  })

  it('groups multiple monitors under one source origin', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'arXiv Research' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Monitors' })).toBeInTheDocument()
    expect(screen.getByText('Agent memory')).toBeInTheDocument()
    expect(screen.getByText('Planning methods')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

})
