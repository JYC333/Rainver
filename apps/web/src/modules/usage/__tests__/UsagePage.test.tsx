import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { credentialsApi, usageApi } from '../../../api/client'
import type { CliCredentialProfileOut } from '../../../types/api'

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
    previewCliHistory: vi.fn(),
    commitCliHistory: vi.fn(),
  },
  credentialsApi: {
    profiles: vi.fn(),
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

const profile: CliCredentialProfileOut = {
  id: 'profile-1',
  owner_user_id: 'user-1',
  runtime: 'claude_code',
  name: 'Team Claude',
  source_path: '',
  target_path: '',
  readonly: false,
  notes: '',
  network_profile_id: null,
  source_exists: true,
  logged_in: true,
  file_count: 3,
}

function setupMocks() {
  vi.mocked(usageApi.summary).mockImplementation(async (params = {}) => summary(params.group_by ?? 'provider'))
  vi.mocked(usageApi.timeseries).mockResolvedValue(timeseries)
  vi.mocked(usageApi.dimensions).mockResolvedValue(dimensions)
  vi.mocked(usageApi.subjects).mockResolvedValue(subjects)
  vi.mocked(usageApi.sessions).mockResolvedValue(sessions)
  vi.mocked(usageApi.budgetPreview).mockResolvedValue(budgetPreview)
  vi.mocked(usageApi.events).mockResolvedValue(events)
  vi.mocked(credentialsApi.profiles).mockResolvedValue([profile])
  vi.mocked(usageApi.previewCliHistory).mockResolvedValue({
    import_batch_id: 'batch-1',
    status: 'previewed',
    detected_runtime: 'claude_code',
    source_kind: 'managed_profile',
    source_fingerprint: 'fingerprint-1',
    credential_profile_id: 'profile-1',
    credential_profile_name: 'Team Claude',
    target_space_id: 'space-1',
    date_range: null,
    totals: {
      event_count: 2,
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_tokens: 150,
    },
    model_breakdown: [],
    token_totals_by_accuracy: {},
    session_count: 1,
    candidate_event_count: 2,
    duplicate_count: 0,
    existing_event_count: 0,
    imported_event_count: 0,
    unsupported_file_count: 0,
    unreadable_file_count: 0,
    privacy_notice: 'No prompt text is imported.',
    confirmation_required: true,
  })
  vi.mocked(usageApi.commitCliHistory).mockResolvedValue({
    import_batch_id: 'batch-1',
    status: 'completed',
    detected_runtime: 'claude_code',
    source_kind: 'managed_profile',
    target_space_id: 'space-1',
    date_range: null,
    totals: {
      event_count: 2,
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_tokens: 150,
    },
    model_breakdown: [],
    token_totals_by_accuracy: {},
    session_count: 1,
    candidate_event_count: 2,
    duplicate_count: 0,
    existing_event_count: 0,
    imported_event_count: 2,
    unsupported_file_count: 0,
    unreadable_file_count: 0,
    privacy_notice: 'No prompt text is imported.',
    confirmation_required: false,
  })
}

describe('UsagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
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

  it('renders shared empty-state panels instead of empty tables when there is no usage', async () => {
    vi.mocked(usageApi.summary).mockResolvedValue({ ...summary(), totals: { ...totals, event_count: 0, request_count: 0, total_tokens: 0 }, items: [] })
    vi.mocked(usageApi.timeseries).mockResolvedValue({ ...timeseries, items: [] })
    vi.mocked(usageApi.dimensions).mockResolvedValue({ ...dimensions, execution_channels: [] })
    vi.mocked(usageApi.sessions).mockResolvedValue({ items: [], total: 0 })
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

  it('previews and commits managed CLI history imports', async () => {
    render(<UsagePage />)

    expect((await screen.findAllByText('OpenAI')).length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(credentialsApi.profiles).toHaveBeenCalledWith('claude_code', 'space-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Team Claude (logged in)' }))
    fireEvent.click(screen.getByRole('button', { name: /preview/i }))

    await waitFor(() => {
      expect(usageApi.previewCliHistory).toHaveBeenCalledWith(expect.objectContaining({
        runtime: 'claude_code',
        source_kind: 'managed_profile',
        target_space_id: 'space-1',
        credential_profile_id: 'profile-1',
      }))
    })
    expect(await screen.findByTestId('usage-import-preview')).toHaveTextContent('previewed')

    fireEvent.click(screen.getByRole('button', { name: /commit/i }))

    await waitFor(() => {
      expect(usageApi.commitCliHistory).toHaveBeenCalledWith({
        import_batch_id: 'batch-1',
        target_space_id: 'space-1',
        confirmation: true,
      })
    })
    expect(await screen.findByTestId('usage-import-preview')).toHaveTextContent('completed')
  })
})
