import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  CheckCircle2,
  Database,
  Filter,
  History,
  Loader2,
  RefreshCw,
  TableProperties,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  UsageAccuracy,
  UsageBreakdownItem,
  UsageBudgetPreviewResponse,
  UsageCliHistoryImportResponse,
  UsageCliHistoryRuntime,
  UsageDimensionsResponse,
  UsageEventDTO,
  UsageExecutionChannel,
  UsageView,
  UsageSessionSummary,
  UsageSubjectSummary,
  UsageSummaryResponse,
  UsageTimeseriesPoint,
  UsageTimeseriesResponse,
  UsageTotals,
} from '@rainver/protocol'
import { credentialsApi, usageApi, type UsageApiQuery } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Select, type SelectOption } from '../../components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table'
import { useSpace } from '../../contexts/SpaceContext'
import { cn, errMsg } from '../../lib/utils'
import type { CliCredentialProfileOut } from '../../types/api'

type AccuracyFilter = UsageAccuracy | 'all'
type ChannelFilter = UsageExecutionChannel | 'all'
type SessionFilter =
  | { kind: 'all' }
  | { kind: 'session_id'; value: string }
  | { kind: 'external_session_id'; value: string }
  | { kind: 'session_path'; value: string }
type SubjectFilter = { kind: 'all' } | { kind: 'subject'; type: string; id: string }

interface DashboardData {
  summary: UsageSummaryResponse | null
  timeseries: UsageTimeseriesResponse | null
  dimensions: UsageDimensionsResponse | null
  subjects: UsageSubjectSummary[]
  sessions: UsageSessionSummary[]
  events: UsageEventDTO[]
  dimensionSummary: UsageSummaryResponse | null
  budgetPreview: UsageBudgetPreviewResponse | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const EMPTY_TOTALS: UsageTotals = {
  event_count: 0,
  request_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation_1h_input_tokens: 0,
  cache_read_input_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  estimated_cost_usd: null,
  observed_event_percentage: 0,
}

const ACCURACY_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Any accuracy' },
  { value: 'provider_reported', label: 'Provider reported' },
  { value: 'proxy_observed', label: 'Proxy observed' },
  { value: 'transcript_lower_bound', label: 'Transcript lower bound' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'quota_snapshot', label: 'Quota snapshot' },
  { value: 'unknown', label: 'Unknown' },
]

const CHANNEL_OPTIONS: SelectOption[] = [
  { value: 'all', label: 'Any platform' },
  { value: 'managed_api', label: 'Managed API' },
  { value: 'provider_proxy', label: 'Provider proxy' },
  { value: 'local_cli', label: 'CLI run' },
  { value: 'local_cli_transcript', label: 'CLI transcript' },
  { value: 'manual_import', label: 'Manual import' },
  { value: 'cross_instance_import', label: 'Cross-instance import' },
  { value: 'unknown', label: 'Unknown' },
]

const GROUP_OPTIONS: SelectOption[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'model', label: 'Model' },
  { value: 'platform', label: 'Platform' },
  { value: 'session', label: 'Session' },
  { value: 'session_path', label: 'Session path' },
  { value: 'subject', label: 'Subject' },
  { value: 'agent', label: 'Agent' },
  { value: 'task', label: 'Task' },
  { value: 'custom_dimension', label: 'Custom dimension' },
]

const RUNTIME_OPTIONS: SelectOption[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex_cli', label: 'Codex CLI' },
]

const BAR_COLORS = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-slate-400',
]

function initialDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - 30 * DAY_MS)
  return { from: dateInputValue(from), to: dateInputValue(to) }
}

function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function dateStartIso(value: string): string | undefined {
  if (!value) return undefined
  return new Date(`${value}T00:00:00.000Z`).toISOString()
}

function dateEndIso(value: string): string | undefined {
  if (!value) return undefined
  return new Date(new Date(`${value}T00:00:00.000Z`).getTime() + DAY_MS).toISOString()
}

function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.round(value ?? 0)))
}

function formatTokens(value: number | null | undefined): string {
  const n = Math.max(0, Math.round(value ?? 0))
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return formatNumber(n)
}

function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
}

function formatPercent(value: number | null | undefined): string {
  return `${Math.max(0, Math.min(100, value ?? 0)).toFixed(1)}%`
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function labelForAccuracy(value: string): string {
  return ACCURACY_OPTIONS.find(option => option.value === value)?.label ?? value
}

function labelForChannel(value: string): string {
  return CHANNEL_OPTIONS.find(option => option.value === value)?.label ?? value
}

function labelForGroupBy(value: string): string {
  return GROUP_OPTIONS.find(option => option.value === value)?.label ?? value
}

function eventTotalTokens(event: UsageEventDTO): number {
  return event.total_tokens ?? (
    event.input_tokens +
    event.output_tokens +
    event.cache_creation_input_tokens +
    event.cache_read_input_tokens +
    event.reasoning_tokens
  )
}

function subjectFilterValue(filter: SubjectFilter): string {
  return filter.kind === 'all' ? 'all' : `${filter.type}\u001f${filter.id}`
}

function parseSubjectFilter(value: string): SubjectFilter {
  if (value === 'all') return { kind: 'all' }
  const [type, id] = value.split('\u001f')
  return type && id ? { kind: 'subject', type, id } : { kind: 'all' }
}

function sessionFilterValue(filter: SessionFilter): string {
  return filter.kind === 'all' ? 'all' : `${filter.kind}\u001f${filter.value}`
}

function parseSessionFilter(value: string): SessionFilter {
  if (value === 'all') return { kind: 'all' }
  const [kind, sessionValue] = value.split('\u001f')
  if (
    (kind === 'session_id' || kind === 'external_session_id' || kind === 'session_path') &&
    sessionValue
  ) {
    return { kind, value: sessionValue }
  }
  return { kind: 'all' }
}

function profileLabel(profile: CliCredentialProfileOut): string {
  const state = profile.logged_in ? 'logged in' : 'not logged in'
  return `${profile.name} (${state})`
}

function safeItems<T>(items: T[] | undefined): T[] {
  return items ?? []
}

function buildTimeseriesBuckets(points: UsageTimeseriesPoint[]): Array<{
  bucket: string
  total: number
  segments: Array<{ key: string; label: string; total: number }>
}> {
  const buckets = new Map<string, { bucket: string; total: number; segments: Map<string, { key: string; label: string; total: number }> }>()
  for (const point of points) {
    const bucketKey = point.bucket_start.slice(0, 10)
    const bucket = buckets.get(bucketKey) ?? { bucket: bucketKey, total: 0, segments: new Map() }
    const tokens = point.totals.total_tokens
    bucket.total += tokens
    const existing = bucket.segments.get(point.group_key) ?? {
      key: point.group_key,
      label: point.group_label,
      total: 0,
    }
    existing.total += tokens
    bucket.segments.set(point.group_key, existing)
    buckets.set(bucketKey, bucket)
  }
  return [...buckets.values()].map(bucket => ({
    bucket: bucket.bucket,
    total: bucket.total,
    segments: [...bucket.segments.values()].sort((a, b) => b.total - a.total).slice(0, 6),
  }))
}

function queryWithoutEmpty(params: UsageApiQuery): UsageApiQuery {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
  ) as UsageApiQuery
}

function KpiTile({
  label,
  value,
  detail,
  icon,
}: {
  label: string
  value: string
  detail?: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function ViewSelector({
  value,
  onChange,
}: {
  value: UsageView
  onChange: (value: UsageView) => void
}) {
  const options: Array<{ value: UsageView; label: string }> = [
    { value: 'mine', label: 'Mine' },
    { value: 'shared', label: 'Shared in space' },
    { value: 'all_visible', label: 'All visible' },
  ]
  return (
    <div className="inline-flex max-w-full flex-nowrap gap-1 overflow-x-auto rounded-lg border border-border bg-muted/30 p-1">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 shrink-0 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors',
            option.value === value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function AccuracyMix({ item }: { item: UsageBreakdownItem }) {
  const mix = item.accuracy_mix
  const total = Math.max(1, item.totals.event_count)
  const parts = [
    { key: 'provider_reported', className: 'bg-emerald-500' },
    { key: 'proxy_observed', className: 'bg-sky-500' },
    { key: 'transcript_lower_bound', className: 'bg-amber-500' },
    { key: 'estimated', className: 'bg-violet-500' },
    { key: 'quota_snapshot', className: 'bg-rose-500' },
    { key: 'unknown', className: 'bg-slate-400' },
  ] as const
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {parts.map(part => {
          const count = mix[part.key]
          if (!count) return null
          return (
            <div
              key={part.key}
              className={part.className}
              style={{ width: `${Math.max(3, (count / total) * 100)}%` }}
              title={`${labelForAccuracy(part.key)}: ${count}`}
            />
          )
        })}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {formatPercent(item.totals.observed_event_percentage)} observed
      </div>
    </div>
  )
}

export default function UsagePage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const initialRange = useMemo(initialDateRange, [])
  const [view, setView] = useState<UsageView>('mine')
  const [fromDate, setFromDate] = useState(initialRange.from)
  const [toDate, setToDate] = useState(initialRange.to)
  const [groupBy, setGroupBy] = useState('provider')
  const [customDimensionKey, setCustomDimensionKey] = useState('')
  const [accuracy, setAccuracy] = useState<AccuracyFilter>('all')
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [providerId, setProviderId] = useState('all')
  const [model, setModel] = useState('all')
  const [task, setTask] = useState('all')
  const [subjectFilter, setSubjectFilter] = useState<SubjectFilter>({ kind: 'all' })
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>({ kind: 'all' })
  const [dimensionFilterKey, setDimensionFilterKey] = useState('')
  const [dimensionFilterValue, setDimensionFilterValue] = useState('')
  const [includeImported, setIncludeImported] = useState(true)
  const [data, setData] = useState<DashboardData>({
    summary: null,
    timeseries: null,
    dimensions: null,
    subjects: [],
    sessions: [],
    events: [],
    dimensionSummary: null,
    budgetPreview: null,
  })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [importRuntime, setImportRuntime] = useState<UsageCliHistoryRuntime>('claude_code')
  const [profiles, setProfiles] = useState<CliCredentialProfileOut[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [importProfileId, setImportProfileId] = useState('default')
  const [importPreview, setImportPreview] = useState<UsageCliHistoryImportResponse | null>(null)
  const [importBusy, setImportBusy] = useState(false)

  const resolvedGroupBy = groupBy === 'custom_dimension'
    ? (customDimensionKey ? `dimension:${customDimensionKey}` : 'provider')
    : groupBy
  const selectedTotals = data.summary?.totals ?? EMPTY_TOTALS

  const query = useMemo<UsageApiQuery>(() => {
    const subject = subjectFilter.kind === 'subject'
      ? { subject_type: subjectFilter.type, subject_id: subjectFilter.id }
      : {}
    const session = sessionFilter.kind === 'all'
      ? {}
      : { [sessionFilter.kind]: sessionFilter.value }
    return queryWithoutEmpty({
      view,
      from: dateStartIso(fromDate),
      to: dateEndIso(toDate),
      group_by: resolvedGroupBy,
      accuracy: accuracy === 'all' ? undefined : accuracy,
      execution_channel: channel === 'all' ? undefined : channel,
      provider_id: providerId === 'all' ? undefined : providerId,
      model: model === 'all' ? undefined : model,
      task: task === 'all' ? undefined : task,
      include_imported: includeImported,
      dimension_key: dimensionFilterKey || undefined,
      dimension_value: dimensionFilterValue.trim() || undefined,
      limit: 100,
      ...subject,
      ...session,
    })
  }, [
    accuracy,
    channel,
    dimensionFilterKey,
    dimensionFilterValue,
    fromDate,
    includeImported,
    model,
    providerId,
    resolvedGroupBy,
    view,
    sessionFilter,
    subjectFilter,
    task,
    toDate,
  ])

  const queryKey = useMemo(() => JSON.stringify(query), [query])

  async function loadDashboard(nextQuery: UsageApiQuery = query) {
    if (!activeSpaceId) {
      setData({
        summary: null,
        timeseries: null,
        dimensions: null,
        subjects: [],
        sessions: [],
        events: [],
        dimensionSummary: null,
        budgetPreview: null,
      })
      setLoading(false)
      return
    }
    setRefreshing(true)
    if (!data.summary) setLoading(true)
    try {
      const dimensionSummaryQuery = customDimensionKey
        ? usageApi.summary({ ...nextQuery, group_by: `dimension:${customDimensionKey}`, limit: 50 })
        : Promise.resolve(null)
      const [summary, timeseries, dimensions, subjects, sessions, events, dimensionSummary, budgetPreview] = await Promise.all([
        usageApi.summary(nextQuery),
        usageApi.timeseries({ ...nextQuery, granularity: 'day', limit: 20 }),
        usageApi.dimensions(nextQuery),
        usageApi.subjects({ ...nextQuery, limit: 100 }),
        usageApi.sessions({ ...nextQuery, limit: 100 }),
        usageApi.events({ ...nextQuery, limit: 25, offset: 0 }),
        dimensionSummaryQuery,
        usageApi.budgetPreview({ ...nextQuery, projection_window_days: 30, limit: 8 }),
      ])
      setData({
        summary,
        timeseries,
        dimensions,
        subjects: safeItems(subjects.items),
        sessions: safeItems(sessions.items),
        events: safeItems(events.items),
        dimensionSummary,
        budgetPreview,
      })
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadDashboard(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, queryKey, customDimensionKey])

  useEffect(() => {
    let cancelled = false
    async function loadProfiles() {
      if (!activeSpaceId) {
        setProfiles([])
        return
      }
      setProfilesLoading(true)
      try {
        const nextProfiles = await credentialsApi.profiles(importRuntime, activeSpaceId)
        if (!cancelled) {
          setProfiles(nextProfiles)
          setImportProfileId(current => {
            if (current === 'default') return current
            return nextProfiles.some(profile => profile.id === current) ? current : 'default'
          })
        }
      } catch (error) {
        if (!cancelled) toast.error(errMsg(error))
      } finally {
        if (!cancelled) setProfilesLoading(false)
      }
    }
    void loadProfiles()
    return () => { cancelled = true }
  }, [activeSpaceId, importRuntime])

  async function previewImport() {
    if (!activeSpaceId) return
    setImportBusy(true)
    try {
      const result = await usageApi.previewCliHistory({
        runtime: importRuntime,
        source_kind: 'managed_profile',
        target_space_id: activeSpaceId,
        credential_profile_id: importProfileId === 'default' ? undefined : importProfileId,
      })
      setImportPreview(result)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setImportBusy(false)
    }
  }

  async function commitImport() {
    if (!activeSpaceId || !importPreview) return
    setImportBusy(true)
    try {
      const result = await usageApi.commitCliHistory({
        import_batch_id: importPreview.import_batch_id,
        target_space_id: activeSpaceId,
        confirmation: true,
      })
      setImportPreview(result)
      toast.success('Usage history imported')
      await loadDashboard(query)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setImportBusy(false)
    }
  }

  const providerOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: 'All providers' },
    ...safeItems(data.dimensions?.providers)
      .filter(provider => provider.id)
      .map(provider => ({ value: provider.id as string, label: provider.label })),
  ], [data.dimensions?.providers])

  const modelOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: 'All models' },
    ...safeItems(data.dimensions?.models).map(item => ({ value: item.model, label: item.model })),
  ], [data.dimensions?.models])

  const taskOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: 'All tasks' },
    ...safeItems(data.dimensions?.tasks).map(item => ({ value: item.task, label: item.task })),
  ], [data.dimensions?.tasks])

  const subjectOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: 'All subjects' },
    ...data.subjects.map(item => ({
      value: `${item.meter_subject_type}\u001f${item.meter_subject_id}`,
      label: `${item.meter_subject_type}: ${item.meter_subject_id}`,
    })),
  ], [data.subjects])

  const sessionOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ value: 'all', label: 'All sessions' }]
    for (const session of data.sessions) {
      if (session.session_id) {
        options.push({
          value: `session_id\u001f${session.session_id}`,
          label: session.session_name ?? session.session_id,
        })
      } else if (session.external_session_id) {
        options.push({
          value: `external_session_id\u001f${session.external_session_id}`,
          label: session.session_name ?? session.external_session_id,
        })
      } else if (session.session_path) {
        options.push({
          value: `session_path\u001f${session.session_path}`,
          label: session.session_path,
        })
      }
    }
    return options
  }, [data.sessions])

  const dimensionKeyOptions = useMemo<SelectOption[]>(() => [
    { value: '', label: 'No dimension key' },
    ...safeItems(data.dimensions?.custom_dimension_keys).map(key => ({ value: key, label: key })),
  ], [data.dimensions?.custom_dimension_keys])

  const profileOptions = useMemo<SelectOption[]>(() => [
    { value: 'default', label: profilesLoading ? 'Loading profiles' : 'Default profile' },
    ...profiles.map(profile => ({ value: profile.id, label: profileLabel(profile) })),
  ], [profiles, profilesLoading])

  const timeBuckets = useMemo(
    () => buildTimeseriesBuckets(data.timeseries?.items ?? []),
    [data.timeseries?.items],
  )
  const maxBucketTokens = Math.max(1, ...timeBuckets.map(bucket => bucket.total))
  const dimensionRows = data.dimensionSummary?.items ?? []
  const missingDimensionRow = dimensionRows.find(row => row.group_key === 'missing')

  if (!activeSpaceId) {
    return (
      <div className="p-6">
        <Card>
          <CardTitle>Token Usage</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">Select an operational space to view usage.</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <BarChart3 className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Token Usage</h1>
            <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void loadDashboard(query)}
          disabled={refreshing}
          aria-label="Refresh usage"
        >
          {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </Button>
      </div>

      <section className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_repeat(3,minmax(160px,1fr))] xl:grid-cols-[minmax(260px,0.9fr)_repeat(5,minmax(160px,1fr))]">
          <Field label="View">
            <ViewSelector value={view} onChange={setView} />
          </Field>
          <Field label="From">
            <Input aria-label="From" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
          </Field>
          <Field label="To">
            <Input aria-label="To" type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
          </Field>
          <Field label="Group by">
            <Select ariaLabel="Group by" options={GROUP_OPTIONS} value={groupBy} onChange={setGroupBy} />
          </Field>
          <Field label="Accuracy">
            <Select ariaLabel="Accuracy" options={ACCURACY_OPTIONS} value={accuracy} onChange={value => setAccuracy(value as AccuracyFilter)} />
          </Field>
          <Field label="Platform">
            <Select ariaLabel="Platform" options={CHANNEL_OPTIONS} value={channel} onChange={value => setChannel(value as ChannelFilter)} />
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Provider">
            <Select ariaLabel="Provider" options={providerOptions} value={providerId} onChange={setProviderId} />
          </Field>
          <Field label="Model">
            <Select ariaLabel="Model" options={modelOptions} value={model} onChange={setModel} />
          </Field>
          <Field label="Task">
            <Select ariaLabel="Task" options={taskOptions} value={task} onChange={setTask} />
          </Field>
          <Field label="Subject">
            <Select
              ariaLabel="Subject"
              options={subjectOptions}
              value={subjectFilterValue(subjectFilter)}
              onChange={value => setSubjectFilter(parseSubjectFilter(value))}
            />
          </Field>
          <Field label="Session">
            <Select
              ariaLabel="Session"
              options={sessionOptions}
              value={sessionFilterValue(sessionFilter)}
              onChange={value => setSessionFilter(parseSessionFilter(value))}
            />
          </Field>
          <Field label="Dimension filter">
            <Select ariaLabel="Dimension filter" options={dimensionKeyOptions} value={dimensionFilterKey} onChange={setDimensionFilterKey} />
          </Field>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid flex-1 gap-3 md:grid-cols-2">
            <Field label="Custom dimension">
              <Select
                ariaLabel="Custom dimension"
                options={dimensionKeyOptions}
                value={customDimensionKey}
                onChange={value => {
                  setCustomDimensionKey(value)
                  if (groupBy === 'custom_dimension' && !value) setGroupBy('provider')
                }}
              />
            </Field>
            <Field label="Dimension value">
              <Input
                aria-label="Dimension value"
                value={dimensionFilterValue}
                onChange={event => setDimensionFilterValue(event.target.value)}
                placeholder="Exact value"
                disabled={!dimensionFilterKey}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4 pb-1 text-sm">
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={includeImported}
                onChange={event => setIncludeImported(event.target.checked)}
              />
              Include imported
            </label>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading usage...
        </div>
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <KpiTile
              label="Total tokens"
              value={formatTokens(selectedTotals.total_tokens)}
              detail={`${formatNumber(selectedTotals.event_count)} events`}
              icon={<Database className="size-4" />}
            />
            <KpiTile
              label="Input / output"
              value={`${formatTokens(selectedTotals.input_tokens)} / ${formatTokens(selectedTotals.output_tokens)}`}
              detail={`${formatTokens(selectedTotals.cache_read_input_tokens)} cache read`}
              icon={<TableProperties className="size-4" />}
            />
            <KpiTile
              label="Reasoning"
              value={formatTokens(selectedTotals.reasoning_tokens)}
              detail={`${formatTokens(selectedTotals.cache_creation_input_tokens)} cache create · ${formatTokens(selectedTotals.cache_creation_1h_input_tokens)} at 1h`}
              icon={<Filter className="size-4" />}
            />
            <KpiTile
              label="Estimated cost"
              value={formatCost(selectedTotals.estimated_cost_usd)}
              detail="USD"
              icon={<BarChart3 className="size-4" />}
            />
            <KpiTile
              label="Requests"
              value={formatNumber(selectedTotals.request_count)}
              detail={`${formatPercent(selectedTotals.observed_event_percentage)} observed`}
              icon={<CheckCircle2 className="size-4" />}
            />
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.95fr)]">
            <div className="space-y-4">
              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>Timeseries</CardTitle>
                  <Badge variant="outline">{data.timeseries?.granularity ?? 'day'}</Badge>
                </div>
                {timeBuckets.length === 0 ? (
                  <EmptyState title="No usage events in this range." />
                ) : (
                  <div className="space-y-3">
                    {timeBuckets.map(bucket => (
                      <div key={bucket.bucket} className="grid grid-cols-[84px_minmax(0,1fr)_76px] items-center gap-3 text-sm">
                        <div className="font-mono text-xs text-muted-foreground">{bucket.bucket}</div>
                        <div className="h-4 overflow-hidden rounded-full bg-muted">
                          <div className="flex h-full" style={{ width: `${Math.max(4, (bucket.total / maxBucketTokens) * 100)}%` }}>
                            {bucket.segments.map((segment, index) => (
                              <div
                                key={segment.key}
                                className={BAR_COLORS[index % BAR_COLORS.length]}
                                style={{ width: `${Math.max(4, (segment.total / bucket.total) * 100)}%` }}
                                title={`${segment.label}: ${formatTokens(segment.total)}`}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="text-right font-mono text-xs">{formatTokens(bucket.total)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>Breakdown</CardTitle>
                  <Badge variant="secondary">{labelForGroupBy(data.summary?.group_by ?? resolvedGroupBy)}</Badge>
                </div>
                {data.summary?.items.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Group</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead>Accuracy</TableHead>
                        <TableHead>Last seen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.summary.items.map(item => (
                        <TableRow key={`${item.group_key}:${item.group_label}`}>
                          <TableCell>
                            <div className="max-w-[260px] truncate font-medium">{item.group_label}</div>
                            <div className="max-w-[260px] truncate font-mono text-[11px] text-muted-foreground">{item.group_key}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatTokens(item.totals.total_tokens)}</TableCell>
                          <TableCell className="text-right font-mono">{formatCost(item.totals.estimated_cost_usd)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(item.totals.request_count)}</TableCell>
                          <TableCell className="min-w-36"><AccuracyMix item={item} /></TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatDateTime(item.last_seen_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState title="No grouped usage." />
                )}
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>Recent Events</CardTitle>
                  <Badge variant="outline">{data.events.length}</Badge>
                </div>
                {data.events.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Platform</TableHead>
                        <TableHead>Provider / model</TableHead>
                        <TableHead>Subject</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead>Accuracy</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.events.map(event => (
                        <TableRow key={event.id}>
                          <TableCell className="text-xs text-muted-foreground">{formatDateTime(event.occurred_at)}</TableCell>
                          <TableCell>{labelForChannel(event.execution_channel)}</TableCell>
                          <TableCell>
                            <div className="max-w-[220px] truncate">{event.provider_name_snapshot ?? event.provider_type ?? 'Unknown provider'}</div>
                            <div className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground">{event.model ?? 'unknown model'}</div>
                          </TableCell>
                          <TableCell>
                            <div className="max-w-[180px] truncate">{event.meter_subject_type}</div>
                            <div className="max-w-[180px] truncate font-mono text-[11px] text-muted-foreground">{event.meter_subject_id}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatTokens(eventTotalTokens(event))}</TableCell>
                          <TableCell><Badge variant="outline">{labelForAccuracy(event.usage_accuracy)}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState title="No events." />
                )}
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardTitle className="mb-4">Platform</CardTitle>
                <div className="space-y-3">
                  {safeItems(data.dimensions?.execution_channels).length ? data.dimensions!.execution_channels.map(item => {
                    const pct = selectedTotals.total_tokens > 0 ? (item.total_tokens / selectedTotals.total_tokens) * 100 : 0
                    return (
                      <div key={item.execution_channel} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span>{labelForChannel(item.execution_channel)}</span>
                          <span className="font-mono text-xs">{formatTokens(item.total_tokens)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted">
                          <div className="h-2 rounded-full bg-sky-500" style={{ width: `${Math.max(2, pct)}%` }} />
                        </div>
                      </div>
                    )
                  }) : (
                    <EmptyState title="No platform data." />
                  )}
                </div>
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>Session Drilldown</CardTitle>
                  <Badge variant="outline">{data.sessions.length}</Badge>
                </div>
                {data.sessions.length === 0 ? (
                  <EmptyState title="No sessions." />
                ) : (
                  <div className="space-y-3">
                    {data.sessions.slice(0, 8).map(session => (
                      <div key={`${session.session_id ?? session.external_session_id ?? session.session_path ?? 'unknown'}`} className="rounded-lg border border-border p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {session.session_name ?? session.session_path ?? session.session_id ?? session.external_session_id ?? 'Unknown session'}
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {session.session_path ?? session.external_session_id ?? session.session_id ?? 'no session id'}
                            </div>
                          </div>
                          <div className="text-right font-mono text-xs">{formatTokens(session.totals.total_tokens)}</div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                          <Badge variant="muted">{formatNumber(session.run_ids.length)} runs</Badge>
                          <span>{formatDateTime(session.last_seen_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <CardTitle className="mb-4">Unit Economics</CardTitle>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Unit</TableHead>
                      <TableHead className="text-right">Avg tokens</TableHead>
                      <TableHead className="text-right">Avg cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      { label: 'Request', divisor: selectedTotals.request_count },
                      { label: 'Event', divisor: selectedTotals.event_count },
                      { label: 'Session', divisor: data.sessions.length },
                      { label: labelForGroupBy(data.summary?.group_by ?? 'Group'), divisor: data.summary?.items.length ?? 0 },
                    ].map(row => {
                      const divisor = Math.max(0, row.divisor)
                      const cost = selectedTotals.estimated_cost_usd
                      return (
                        <TableRow key={row.label}>
                          <TableCell>{row.label}</TableCell>
                          <TableCell className="text-right font-mono">
                            {divisor > 0 ? formatTokens(selectedTotals.total_tokens / divisor) : '-'}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {divisor > 0 && cost !== null ? formatCost(cost / divisor) : '-'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>Budget Preview</CardTitle>
                  <Badge variant="outline">{data.budgetPreview?.projection_window_days ?? 30} days</Badge>
                </div>
                {data.budgetPreview?.items.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Subject</TableHead>
                        <TableHead className="text-right">Projected</TableHead>
                        <TableHead className="text-right">Costed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.budgetPreview.items.slice(0, 6).map(item => (
                        <TableRow key={`${item.meter_subject_type}:${item.meter_subject_id}`}>
                          <TableCell>
                            <div className="max-w-[180px] truncate">{item.meter_subject_type}</div>
                            <div className="max-w-[180px] truncate font-mono text-[11px] text-muted-foreground">{item.meter_subject_id}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatCost(item.projected_estimated_cost_usd)}</TableCell>
                          <TableCell className="text-right font-mono">{formatPercent(item.costed_event_percentage)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState title="No costed subjects." />
                )}
                {data.budgetPreview && data.budgetPreview.total_projected_estimated_cost_usd !== null && (
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm">
                    <span className="text-muted-foreground">Projected total</span>
                    <span className="font-mono">{formatCost(data.budgetPreview.total_projected_estimated_cost_usd)}</span>
                  </div>
                )}
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>Dimensions</CardTitle>
                  <Badge variant="outline">{safeItems(data.dimensions?.custom_dimension_keys).length}</Badge>
                </div>
                <div className="space-y-3">
                  <Select ariaLabel="Dimension explorer key" options={dimensionKeyOptions} value={customDimensionKey} onChange={setCustomDimensionKey} />
                  {customDimensionKey && (
                    dimensionRows.length === 0 ? (
                      <EmptyState title="No dimension values." />
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Value</TableHead>
                            <TableHead className="text-right">Tokens</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {dimensionRows.slice(0, 8).map(row => (
                            <TableRow key={row.group_key}>
                              <TableCell className="max-w-[220px] truncate">{row.group_label}</TableCell>
                              <TableCell className="text-right font-mono">{formatTokens(row.totals.total_tokens)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )
                  )}
                  {customDimensionKey && missingDimensionRow && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Missing {customDimensionKey}: {formatTokens(missingDimensionRow.totals.total_tokens)} tokens
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>CLI History Import</CardTitle>
                  <History className="size-4 text-muted-foreground" />
                </div>
                <div className="space-y-3">
                  <Field label="Runtime">
                    <Select
                      ariaLabel="Runtime"
                      options={RUNTIME_OPTIONS}
                      value={importRuntime}
                      onChange={value => {
                        setImportRuntime(value as UsageCliHistoryRuntime)
                        setImportPreview(null)
                      }}
                    />
                  </Field>
                  <Field label="Profile">
                    <Select
                      ariaLabel="Profile"
                      options={profileOptions}
                      value={importProfileId}
                      onChange={value => {
                        setImportProfileId(value)
                        setImportPreview(null)
                      }}
                      disabled={profilesLoading}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={previewImport} disabled={importBusy || profilesLoading}>
                      {importBusy && !importPreview ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                      Preview
                    </Button>
                    <Button
                      size="sm"
                      onClick={commitImport}
                      disabled={importBusy || !importPreview || importPreview.confirmation_required === false}
                    >
                      {importBusy && importPreview ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                      Commit
                    </Button>
                  </div>
                  {importPreview && (
                    <div className="rounded-lg border border-border p-3 text-sm" data-testid="usage-import-preview">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="font-medium">{importPreview.status}</span>
                        <Badge variant="secondary">{importPreview.detected_runtime ?? importRuntime}</Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <span>Candidate events</span>
                        <span className="text-right font-mono text-foreground">{formatNumber(importPreview.candidate_event_count)}</span>
                        <span>Duplicates</span>
                        <span className="text-right font-mono text-foreground">{formatNumber(importPreview.duplicate_count)}</span>
                        <span>Imported</span>
                        <span className="text-right font-mono text-foreground">{formatNumber(importPreview.imported_event_count ?? 0)}</span>
                        <span>Total tokens</span>
                        <span className="text-right font-mono text-foreground">{formatTokens(importPreview.totals.total_tokens)}</span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">{importPreview.privacy_notice}</p>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
