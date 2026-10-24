import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  UsageDimensionsResponse,
  UsageBudgetPreviewResponse,
  UsageEventsResponse,
  UsageSessionsResponse,
  UsageSubjectsResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
  UsageTotals,
} from '@rainver/protocol'
import UsagePage from '../UsagePage'
import { usageApi } from '../../../api/client'
import i18n from '../../../i18n'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
  }),
}))

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { id: 'user-1', is_instance_admin: true },
  }),
}))

vi.mock('../../../api/client', () => ({
  usageApi: {
    summary: vi.fn(),
    timeseries: vi.fn(),
    dimensions: vi.fn(),
    subjects: vi.fn(),
    sessions: vi.fn(),
    budgetPreview: vi.fn(),
    events: vi.fn(),
  },
}))

const totals: UsageTotals = {
  event_count: 2,
  request_count: 3,
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 20,
  cache_creation_1h_input_tokens: 5,
  cache_read_input_tokens: 100,
  reasoning_tokens: 50,
  total_tokens: 1670,
  estimated_cost_usd: null,
  observed_event_percentage: 50,
}

function summary(groupBy = 'provider'): UsageSummaryResponse {
  const isSessionPath = groupBy === 'session_path'
  return {
    view: 'mine',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-10T00:00:00.000Z',
    group_by: groupBy,
    totals,
    items: [{
      group_key: isSessionPath ? 'sessions/main' : 'provider-1',
      group_label: isSessionPath ? 'sessions/main' : 'OpenAI',
      totals,
      accuracy_mix: {
        provider_reported: 1,
        proxy_observed: 0,
        transcript_lower_bound: 1,
        estimated: 0,
        quota_snapshot: 0,
        unknown: 0,
      },
      last_seen_at: '2026-07-09T12:00:00.000Z',
    }],
    total: 1,
    limit: 100,
    offset: 0,
  }
}

const dimensions: UsageDimensionsResponse = {
  providers: [{ id: 'provider-1', label: 'OpenAI', total_tokens: 1670 }],
  models: [{ model: 'gpt-4o', total_tokens: 1670 }],
  tasks: [{ task: 'runtime_host', total_tokens: 1670 }],
  execution_channels: [{ execution_channel: 'managed_api', total_tokens: 1670 }],
  accuracies: [{ usage_accuracy: 'provider_reported', event_count: 1 }],
  custom_dimension_keys: ['workflow'],
}

const timeseries: UsageTimeseriesResponse = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-10T00:00:00.000Z',
  granularity: 'day',
  group_by: 'provider',
  items: [{
    bucket_start: '2026-07-09T00:00:00.000Z',
    group_key: 'provider-1',
    group_label: 'OpenAI',
    totals,
    accuracy_mix: {
      provider_reported: 1,
      proxy_observed: 0,
      transcript_lower_bound: 1,
      estimated: 0,
      quota_snapshot: 0,
      unknown: 0,
    },
  }],
}

const subjects: UsageSubjectsResponse = {
  items: [{
    meter_subject_type: 'agent',
    meter_subject_id: 'agent-1',
    totals,
    last_seen_at: '2026-07-09T12:00:00.000Z',
  }],
  total: 1,
}

const sessions: UsageSessionsResponse = {
  items: [{
    session_id: 'session-1',
    external_session_id: null,
    session_path: 'sessions/main',
    session_name: 'Main session',
    run_ids: ['run-1'],
    totals,
    last_seen_at: '2026-07-09T12:00:00.000Z',
  }],
  total: 1,
  totals,
}

const events: UsageEventsResponse = {
  items: [{
    id: 'event-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    visibility: 'private',
    access_level: 'full',
    event_type: 'llm.generation',
    source_type: 'local_run',
    source_resource_type: 'run',
    source_resource_id: 'run-1',
    execution_channel: 'managed_api',
    meter_subject_type: 'agent',
    meter_subject_id: 'agent-1',
    provider_id: 'provider-1',
    provider_type: 'openai',
    provider_name_snapshot: 'OpenAI',
    vendor: 'openai',
    model: 'gpt-4o',
    task: 'runtime_host',
    run_id: 'run-1',
    session_id: 'session-1',
    external_session_id: null,
    session_path: 'sessions/main',
    session_name: 'Main session',
    agent_id: 'agent-1',
    project_id: null,
    project_folder_id: null,
    occurred_at: '2026-07-09T12:00:00.000Z',
    recorded_at: '2026-07-09T12:00:01.000Z',
    usage_details: { input: 1000, output: 500, total: 1500 },
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_tokens: 0,
    request_count: 1,
    estimated_cost_usd: null,
    cost_accuracy: 'unknown',
    usage_accuracy: 'provider_reported',
    total_tokens_source: 'provider_total',
    dimensions: { workflow: 'chat' },
    metadata: {},
    created_at: '2026-07-09T12:00:01.000Z',
  }],
  total: 1,
  limit: 25,
  offset: 0,
}

const budgetPreview: UsageBudgetPreviewResponse = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-10T00:00:00.000Z',
  observed_days: 9,
  projection_window_days: 30,
  total_projected_estimated_cost_usd: 12.5,
  items: [{
    meter_subject_type: 'agent',
    meter_subject_id: 'agent-1',
    current_estimated_cost_usd: 3.75,
    projected_estimated_cost_usd: 12.5,
    costed_event_percentage: 100,
    totals,
    last_seen_at: '2026-07-09T12:00:00.000Z',
  }],
}

function setupMocks() {
  vi.mocked(usageApi.summary).mockImplementation(async (params = {}) => summary(params.group_by ?? 'provider'))
  vi.mocked(usageApi.timeseries).mockResolvedValue(timeseries)
  vi.mocked(usageApi.dimensions).mockResolvedValue(dimensions)
  vi.mocked(usageApi.subjects).mockResolvedValue(subjects)
  vi.mocked(usageApi.sessions).mockResolvedValue(sessions)
  vi.mocked(usageApi.budgetPreview).mockResolvedValue(budgetPreview)
  vi.mocked(usageApi.events).mockResolvedValue(events)
}

describe('UsagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('distinguishes unreported model calls, cumulative usage, delivery estimates and occupancy', async () => {
    vi.mocked(usageApi.summary).mockResolvedValue({ ...summary(), totals: { ...totals, request_count: 0, unknown_request_count_events: 1 } })
    vi.mocked(usageApi.events).mockResolvedValue({ ...events, items: [{
      ...events.items[0]!, execution_channel: 'local_cli', request_count: 0, request_count_known: false,
      cache_creation_input_tokens: 200, cache_creation_1h_input_tokens: 50, cache_read_input_tokens: 100,
      dimensions: { run_purpose: 'handoff', run_outcome: 'failed', run_attempt_number: 2 },
      metadata: { cli_usage: { acp_turns: 2, occupancy_used: 9000, occupancy_size: 1000000, usage_scope: 'last_model_request', usage_updates: 7, usage_updates_used_total: 61000, estimated_total: 500, estimate_instructions: 100, resumed_session: false } },
    }] })
    render(<UsagePage />)
    expect(await screen.findByText('1 record did not report internal model calls')).toBeInTheDocument()
    const diagnostics = (await screen.findByText('Usage diagnostics')).closest('details')!
    fireEvent.click(within(diagnostics).getByText('Usage diagnostics'))
    expect(within(diagnostics).getByText('Cumulative reported input (including cache)').parentElement).toHaveTextContent('1,300')
    expect(within(diagnostics).getByText('Model calls').parentElement).toHaveTextContent('Unknown')
    expect(within(diagnostics).getByText('ACP requests').parentElement).toHaveTextContent('2')
    expect(within(diagnostics).getByText('Context used / capacity').parentElement).toHaveTextContent('9,000 / 1,000,000')
    expect(within(diagnostics).getByText('Token counts cover').parentElement).toHaveTextContent('Last model request only (lower bound)')
    expect(within(diagnostics).getByText('Context reports (one per model request)').parentElement).toHaveTextContent('7')
    expect(within(diagnostics).getByText('Context volume processed').parentElement).toHaveTextContent('61,000')
    expect(within(diagnostics).getByText('This delivery estimate').parentElement).toHaveTextContent('500')
    expect(within(diagnostics).getByText('Native session').parentElement).toHaveTextContent('Started fresh')
    expect(within(diagnostics).getByText('Run purpose').parentElement).toHaveTextContent('Session handoff')
    expect(within(diagnostics).getByText('Run attempt number').parentElement).toHaveTextContent('2')
  })

  it('shows a lower bound when only part of the model call count is known', async () => {
    vi.mocked(usageApi.summary).mockResolvedValue({ ...summary(), totals: { ...totals, unknown_request_count_events: 1 } })
    render(<UsagePage />)
    expect(await screen.findByText('≥ 3')).toBeInTheDocument()
  })

  it('renders grouped usage and sends group and accuracy filters', async () => {
    render(<UsagePage />)

    expect((await screen.findAllByText('OpenAI')).length).toBeGreaterThan(0)
    expect(usageApi.summary).toHaveBeenCalledWith(expect.objectContaining({ view: 'mine' }))

    fireEvent.click(screen.getByRole('button', { name: 'Shared in space' }))
    await waitFor(() => {
      expect(usageApi.summary).toHaveBeenCalledWith(expect.objectContaining({ view: 'shared' }))
    })

    fireEvent.click(screen.getByRole('button', { name: 'Group by' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Session path' }))

    await waitFor(() => {
      expect(usageApi.summary).toHaveBeenCalledWith(expect.objectContaining({
        group_by: 'session_path',
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: 'Accuracy' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Transcript lower bound' }))

    await waitFor(() => {
      expect(usageApi.summary).toHaveBeenCalledWith(expect.objectContaining({
        group_by: 'session_path',
        accuracy: 'transcript_lower_bound',
      }))
    })
  })

  it('keeps the latest filter answer when an earlier window answers later', async () => {
    let answerEarlier: (value: UsageSummaryResponse) => void = () => {}
    vi.mocked(usageApi.summary).mockImplementation(async (params = {}) => {
      if (params.from?.startsWith('2025-01')) return new Promise(resolve => { answerEarlier = resolve })
      if (params.from?.startsWith('2026-06')) return { ...summary(), items: [{ ...summary().items[0], group_label: 'June Provider' }] }
      return summary()
    })
    render(<UsagePage />)
    expect((await screen.findAllByText('OpenAI')).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-06-01' } })
    expect((await screen.findAllByText('June Provider')).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeEnabled())

    await act(async () => {
      answerEarlier({ ...summary(), items: [{ ...summary().items[0], group_label: 'Year-Old Provider' }] })
    })
    expect(screen.queryByText('Year-Old Provider')).not.toBeInTheDocument()
    expect(screen.getAllByText('June Provider').length).toBeGreaterThan(0)
  })

  it('averages per session over every matched session, from the sessions\' own totals', async () => {
    // One session on the page, four matched: their 1670 tokens average to 418
    // per session. The summary's larger total also counts usage seen only at
    // summary level, which no session in the list stands for.
    vi.mocked(usageApi.summary).mockResolvedValue({ ...summary(), totals: { ...totals, total_tokens: 99_999 } })
    vi.mocked(usageApi.sessions).mockResolvedValue({ ...sessions, total: 4 })
    render(<UsagePage />)

    const row = (await screen.findByRole('cell', { name: 'Session' })).closest('tr')!
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('418')
  })

  it('pages through every matched group instead of stopping at the first page', async () => {
    vi.mocked(usageApi.summary).mockResolvedValue({ ...summary(), total: 150, limit: 100, offset: 0 })
    render(<UsagePage />)

    expect(await screen.findByText('1–100 of 150')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(usageApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100 })))

    // Back to the first page reads it again, rather than keeping page 2's rows.
    vi.mocked(usageApi.summary).mockClear()
    fireEvent.click(await screen.findByRole('button', { name: 'Previous page' }))
    await waitFor(() => expect(usageApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })))

    // Refresh starts again from the first page.
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(usageApi.summary).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100 })))
    vi.mocked(usageApi.summary).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    await waitFor(() => expect(usageApi.summary).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 })))
    expect(await screen.findByText('1–100 of 150')).toBeInTheDocument()
  })

  it('renders shared empty-state panels instead of empty tables when there is no usage', async () => {
    vi.mocked(usageApi.summary).mockResolvedValue({ ...summary(), totals: { ...totals, event_count: 0, request_count: 0, total_tokens: 0 }, items: [] })
    vi.mocked(usageApi.timeseries).mockResolvedValue({ ...timeseries, items: [] })
    vi.mocked(usageApi.dimensions).mockResolvedValue({ ...dimensions, execution_channels: [] })
    vi.mocked(usageApi.sessions).mockResolvedValue({ items: [], total: 0, totals: { ...totals, total_tokens: 0, event_count: 0, request_count: 0 } })
    vi.mocked(usageApi.events).mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 })

    render(<UsagePage />)

    for (const message of [
      'No usage events in this range.',
      'No grouped usage.',
      'No events.',
      'No platform data.',
      'No sessions.',
    ]) {
      expect(await screen.findByText(message)).toBeInTheDocument()
    }
    expect(screen.queryByText('provider')).not.toBeInTheDocument()
    expect((await screen.findAllByText('Provider')).length).toBeGreaterThan(0)
  })

  it('counts events, runs and the budget window in the right plural form', async () => {
    render(<UsagePage />)

    expect(await screen.findByText('2 events')).toBeInTheDocument()
    expect(screen.getByText('1 run')).toBeInTheDocument()
    expect(screen.getByText('30 days')).toBeInTheDocument()
    expect(screen.getAllByText('50.0% observed').length).toBeGreaterThan(0)
  })

  it('reads in Chinese, with dates, numbers and costs in Chinese form', async () => {
    await i18n.changeLanguage('zh-CN')
    try {
      render(<UsagePage />)

      expect(await screen.findByRole('heading', { name: 'Token 用量' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '空间内共享' })).toBeInTheDocument()
      expect(screen.getByText('2 个事件')).toBeInTheDocument()
      expect(screen.getByText('1 次运行')).toBeInTheDocument()
      expect(screen.getByText('30 天')).toBeInTheDocument()
      expect(screen.getAllByText('已观测 50.0%').length).toBeGreaterThan(0)
      // The timeseries day is the stored day, written the Chinese way.
      expect(screen.getByText('7月9日')).toBeInTheDocument()
      expect(screen.getAllByText(/7月9日 \d{2}:\d{2}/).length).toBeGreaterThan(0)
      expect(screen.getAllByText('US$12.50').length).toBeGreaterThan(0)
      // Provider names and model ids are data, not copy.
      expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0)
      expect(screen.getByRole('cell', { name: '每个会话' })).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
