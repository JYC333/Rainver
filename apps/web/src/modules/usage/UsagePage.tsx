import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  CheckCircle2,
  Database,
  Filter,
  Loader2,
  RefreshCw,
  TableProperties,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  UsageAccuracy,
  UsageBreakdownItem,
  UsageBudgetPreviewResponse,
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
import { usageApi, type UsageApiQuery } from '../../api/client'
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
import { Pagination } from '../../components/ui/pagination'
import i18n, { useAppTranslation } from '../../i18n'
import { formatCalendarDay, formatDateParts, formatNumber as formatLocaleNumber } from '../../i18n/format'

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
  /** Sessions matched by the filters; the list above holds at most one page. */
  sessionTotal: number
  /** Totals over those same sessions, at the same (full) access level as the count. */
  sessionTotals: UsageTotals
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

const ACCURACY_VALUES = ['all', 'provider_reported', 'proxy_observed', 'transcript_lower_bound', 'estimated', 'quota_snapshot', 'unknown'] as const
const CHANNEL_VALUES = ['all', 'managed_api', 'provider_proxy', 'local_cli', 'local_cli_transcript', 'manual_import', 'cross_instance_import', 'unknown'] as const
const GROUP_VALUES = ['provider', 'model', 'platform', 'session', 'session_path', 'subject', 'agent', 'task', 'custom_dimension'] as const

// Read at render time, so the labels follow the UI language.
function accuracyOptions(): SelectOption[] {
  return ACCURACY_VALUES.map(value => ({ value, label: i18n.t(`workspace_ui.usage.accuracy.${value}`) }))
}

function channelOptions(): SelectOption[] {
  return CHANNEL_VALUES.map(value => ({ value, label: i18n.t(`workspace_ui.usage.channel.${value}`) }))
}

function groupOptions(): SelectOption[] {
  return GROUP_VALUES.map(value => ({ value, label: i18n.t(`workspace_ui.usage.group.${value}`) }))
}

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
  return formatLocaleNumber(Math.max(0, Math.round(value ?? 0)))
}

function formatTokens(value: number | null | undefined): string {
  const n = Math.max(0, Math.round(value ?? 0))
  // Large counts in the locale's own compact form (1.2M, 120万).
  if (n >= 10_000) return formatLocaleNumber(n, { notation: 'compact', maximumFractionDigits: n >= 1_000_000 ? 2 : 1 })
  return formatNumber(n)
}

function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return formatLocaleNumber(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
}

function formatPercent(value: number | null | undefined): string {
  return formatLocaleNumber(Math.max(0, Math.min(100, value ?? 0)) / 100, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function formatDateTime(value: string | null | undefined): string {
  return formatDateParts(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, '-')
}

function labelForAccuracy(value: string): string {
  return accuracyOptions().find(option => option.value === value)?.label ?? value
}

function labelForChannel(value: string): string {
  return channelOptions().find(option => option.value === value)?.label ?? value
}

function labelForGroupBy(value: string): string {
  return groupOptions().find(option => option.value === value)?.label ?? value
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
  const { t } = useAppTranslation()
  const options: Array<{ value: UsageView; label: string }> = [
    { value: 'mine', label: t('workspace_ui.usage.view.mine') },
    { value: 'shared', label: t('workspace_ui.usage.view.shared') },
    { value: 'all_visible', label: t('workspace_ui.usage.view.all_visible') },
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
  const { t } = useAppTranslation()
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
              title={`${labelForAccuracy(part.key)}: ${formatNumber(count)}`}
            />
          )
        })}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t('workspace_ui.usage.observed', { percent: formatPercent(item.totals.observed_event_percentage) })}
      </div>
    </div>
  )
}

export default function UsagePage() {
  const { t } = useAppTranslation()
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
    sessionTotal: 0,
    sessionTotals: EMPTY_TOTALS,
    events: [],
    dimensionSummary: null,
    budgetPreview: null,
  })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Every filter change starts eight requests; only the latest set may
  // become the dashboard, or a slow earlier window answers over a fast one.
  const dashboardRequest = useRef(0)

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
  // The group table pages through every matched group. Every summary read
  // names its offset, page 1 included; a reload (new query or Refresh) starts
  // again from the first page, and only the latest group read may land.
  const [groupOffset, setGroupOffset] = useState(0)
  const groupRequest = useRef(0)
  function loadGroupPage(offset: number) {
    if (!activeSpaceId) return
    setGroupOffset(offset)
    const request = ++groupRequest.current
    usageApi.summary({ ...query, offset })
      .then(summary => { if (request === groupRequest.current) setData(current => ({ ...current, summary })) })
      .catch(error => { if (request === groupRequest.current) toast.error(errMsg(error)) })
  }

  async function loadDashboard(nextQuery: UsageApiQuery = query) {
    if (!activeSpaceId) {
      setData({
        summary: null,
        timeseries: null,
        dimensions: null,
        subjects: [],
        sessions: [],
        sessionTotal: 0,
        sessionTotals: EMPTY_TOTALS,
        events: [],
        dimensionSummary: null,
        budgetPreview: null,
      })
      setLoading(false)
      return
    }
    const request = ++dashboardRequest.current
    const summaryRequest = ++groupRequest.current
    setGroupOffset(0)
    setRefreshing(true)
    if (!data.summary) setLoading(true)
    try {
      const dimensionSummaryQuery = customDimensionKey
        ? usageApi.summary({ ...nextQuery, group_by: `dimension:${customDimensionKey}`, limit: 50 })
        : Promise.resolve(null)
      const [summary, timeseries, dimensions, subjects, sessions, events, dimensionSummary, budgetPreview] = await Promise.all([
        usageApi.summary({ ...nextQuery, offset: 0 }),
        usageApi.timeseries({ ...nextQuery, granularity: 'day', limit: 20 }),
        usageApi.dimensions(nextQuery),
        usageApi.subjects({ ...nextQuery, limit: 100 }),
        usageApi.sessions({ ...nextQuery, limit: 100 }),
        usageApi.events({ ...nextQuery, limit: 25, offset: 0 }),
        dimensionSummaryQuery,
        usageApi.budgetPreview({ ...nextQuery, projection_window_days: 30, limit: 8 }),
      ])
      if (request !== dashboardRequest.current) return
      setData(current => ({
        summary: summaryRequest === groupRequest.current ? summary : current.summary,
        timeseries,
        dimensions,
        subjects: safeItems(subjects.items),
        sessions: safeItems(sessions.items),
        sessionTotal: sessions.total,
        sessionTotals: sessions.totals,
        events: safeItems(events.items),
        dimensionSummary,
        budgetPreview,
      }))
    } catch (error) {
      if (request !== dashboardRequest.current) return
      toast.error(errMsg(error))
    } finally {
      if (request === dashboardRequest.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  useEffect(() => {
    void loadDashboard(query)
    // queryKey stands in for query, so an equal query in a new object does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, queryKey, customDimensionKey])

  const providerOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: t('workspace_ui.usage.all_providers') },
    ...safeItems(data.dimensions?.providers)
      .filter(provider => provider.id)
      .map(provider => ({ value: provider.id as string, label: provider.label })),
  ], [data.dimensions?.providers, t])

  const modelOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: t('workspace_ui.usage.all_models') },
    ...safeItems(data.dimensions?.models).map(item => ({ value: item.model, label: item.model })),
  ], [data.dimensions?.models, t])

  const taskOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: t('workspace_ui.usage.all_tasks') },
    ...safeItems(data.dimensions?.tasks).map(item => ({ value: item.task, label: item.task })),
  ], [data.dimensions?.tasks, t])

  const subjectOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: t('workspace_ui.usage.all_subjects') },
    ...data.subjects.map(item => ({
      value: `${item.meter_subject_type}\u001f${item.meter_subject_id}`,
      label: `${item.meter_subject_type}: ${item.meter_subject_id}`,
    })),
  ], [data.subjects, t])

  const sessionOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ value: 'all', label: t('workspace_ui.usage.all_sessions') }]
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
  }, [data.sessions, t])

  const dimensionKeyOptions = useMemo<SelectOption[]>(() => [
    { value: '', label: t('workspace_ui.usage.no_dimension_key') },
    ...safeItems(data.dimensions?.custom_dimension_keys).map(key => ({ value: key, label: key })),
  ], [data.dimensions?.custom_dimension_keys, t])

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
          <CardTitle>{t('workspace_ui.usage.title')}</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">{t('workspace_ui.usage.no_space')}</p>
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
            <h1 className="text-xl font-semibold tracking-tight">{t('workspace_ui.usage.title')}</h1>
            <p className="text-xs text-muted-foreground">{t('workspace_ui.usage.viewing', { space: activeSpaceName ?? activeSpaceId })}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void loadDashboard(query)}
          disabled={refreshing}
          aria-label={t('workspace_ui.usage.refresh_aria')}
        >
          {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t('workspace_ui.usage.refresh')}
        </Button>
      </div>

      <section className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_repeat(3,minmax(160px,1fr))] xl:grid-cols-[minmax(260px,0.9fr)_repeat(5,minmax(160px,1fr))]">
          <Field label={t('workspace_ui.usage.field.view')}>
            <ViewSelector value={view} onChange={setView} />
          </Field>
          <Field label={t('workspace_ui.usage.field.from')}>
            <Input aria-label={t('workspace_ui.usage.field.from')} type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
          </Field>
          <Field label={t('workspace_ui.usage.field.to')}>
            <Input aria-label={t('workspace_ui.usage.field.to')} type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
          </Field>
          <Field label={t('workspace_ui.usage.field.group_by')}>
            <Select ariaLabel={t('workspace_ui.usage.field.group_by')} options={groupOptions()} value={groupBy} onChange={setGroupBy} />
          </Field>
          <Field label={t('workspace_ui.usage.field.accuracy_label')}>
            <Select ariaLabel={t('workspace_ui.usage.field.accuracy_label')} options={accuracyOptions()} value={accuracy} onChange={value => setAccuracy(value as AccuracyFilter)} />
          </Field>
          <Field label={t('workspace_ui.usage.field.platform')}>
            <Select ariaLabel={t('workspace_ui.usage.field.platform')} options={channelOptions()} value={channel} onChange={value => setChannel(value as ChannelFilter)} />
          </Field>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label={t('workspace_ui.usage.field.provider')}>
            <Select ariaLabel={t('workspace_ui.usage.field.provider')} options={providerOptions} value={providerId} onChange={setProviderId} />
          </Field>
          <Field label={t('workspace_ui.usage.field.model')}>
            <Select ariaLabel={t('workspace_ui.usage.field.model')} options={modelOptions} value={model} onChange={setModel} />
          </Field>
          <Field label={t('workspace_ui.usage.field.task')}>
            <Select ariaLabel={t('workspace_ui.usage.field.task')} options={taskOptions} value={task} onChange={setTask} />
          </Field>
          <Field label={t('workspace_ui.usage.field.subject')}>
            <Select
              ariaLabel={t('workspace_ui.usage.field.subject')}
              options={subjectOptions}
              value={subjectFilterValue(subjectFilter)}
              onChange={value => setSubjectFilter(parseSubjectFilter(value))}
            />
          </Field>
          <Field label={t('workspace_ui.usage.field.session')}>
            <Select
              ariaLabel={t('workspace_ui.usage.field.session')}
              options={sessionOptions}
              value={sessionFilterValue(sessionFilter)}
              onChange={value => setSessionFilter(parseSessionFilter(value))}
            />
          </Field>
          <Field label={t('workspace_ui.usage.field.dimension_filter')}>
            <Select ariaLabel={t('workspace_ui.usage.field.dimension_filter')} options={dimensionKeyOptions} value={dimensionFilterKey} onChange={setDimensionFilterKey} />
          </Field>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid flex-1 gap-3 md:grid-cols-2">
            <Field label={t('workspace_ui.usage.field.custom_dimension')}>
              <Select
                ariaLabel={t('workspace_ui.usage.field.custom_dimension')}
                options={dimensionKeyOptions}
                value={customDimensionKey}
                onChange={value => {
                  setCustomDimensionKey(value)
                  if (groupBy === 'custom_dimension' && !value) setGroupBy('provider')
                }}
              />
            </Field>
            <Field label={t('workspace_ui.usage.field.dimension_value')}>
              <Input
                aria-label={t('workspace_ui.usage.field.dimension_value')}
                value={dimensionFilterValue}
                onChange={event => setDimensionFilterValue(event.target.value)}
                placeholder={t('workspace_ui.usage.exact_value')}
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
              {t('workspace_ui.usage.include_imported')}
            </label>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> {t('workspace_ui.usage.loading')}
        </div>
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <KpiTile
              label={t('workspace_ui.usage.kpi.total_tokens')}
              value={formatTokens(selectedTotals.total_tokens)}
              detail={t('workspace_ui.usage.kpi.events', { count: selectedTotals.event_count, formatted: formatNumber(selectedTotals.event_count) })}
              icon={<Database className="size-4" />}
            />
            <KpiTile
              label={t('workspace_ui.usage.kpi.input_output')}
              value={`${formatTokens(selectedTotals.input_tokens)} / ${formatTokens(selectedTotals.output_tokens)}`}
              detail={t('workspace_ui.usage.kpi.cache_read', { tokens: formatTokens(selectedTotals.cache_read_input_tokens) })}
              icon={<TableProperties className="size-4" />}
            />
            <KpiTile
              label={t('workspace_ui.usage.kpi.reasoning')}
              value={formatTokens(selectedTotals.reasoning_tokens)}
              detail={t('workspace_ui.usage.kpi.cache_create', { tokens: formatTokens(selectedTotals.cache_creation_input_tokens), hour: formatTokens(selectedTotals.cache_creation_1h_input_tokens) })}
              icon={<Filter className="size-4" />}
            />
            <KpiTile
              label={t('workspace_ui.usage.kpi.estimated_cost')}
              value={formatCost(selectedTotals.estimated_cost_usd)}
              detail="USD"
              icon={<BarChart3 className="size-4" />}
            />
            <KpiTile
              label={t('workspace_ui.usage.kpi.requests')}
              value={formatNumber(selectedTotals.request_count)}
              detail={t('workspace_ui.usage.observed', { percent: formatPercent(selectedTotals.observed_event_percentage) })}
              icon={<CheckCircle2 className="size-4" />}
            />
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.95fr)]">
            <div className="space-y-4">
              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>{t('workspace_ui.usage.timeseries')}</CardTitle>
                  <Badge variant="outline">{data.timeseries?.granularity ?? 'day'}</Badge>
                </div>
                {timeBuckets.length === 0 ? (
                  <EmptyState title={t('workspace_ui.usage.empty.events_in_range')} />
                ) : (
                  <div className="space-y-3">
                    {timeBuckets.map(bucket => (
                      <div key={bucket.bucket} className="grid grid-cols-[84px_minmax(0,1fr)_76px] items-center gap-3 text-sm">
                        <div className="font-mono text-xs text-muted-foreground">{formatCalendarDay(bucket.bucket, { month: 'short', day: 'numeric' })}</div>
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
                  <CardTitle>{t('workspace_ui.usage.breakdown')}</CardTitle>
                  <Badge variant="secondary">{labelForGroupBy(data.summary?.group_by ?? resolvedGroupBy)}</Badge>
                </div>
                {data.summary?.items.length ? (
                  <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('workspace_ui.usage.col.group')}</TableHead>
                        <TableHead className="text-right">{t('workspace_ui.usage.col.tokens')}</TableHead>
                        <TableHead className="text-right">{t('workspace_ui.usage.col.cost')}</TableHead>
                        <TableHead className="text-right">{t('workspace_ui.usage.col.requests')}</TableHead>
                        <TableHead>{t('workspace_ui.usage.col.accuracy')}</TableHead>
                        <TableHead>{t('workspace_ui.usage.col.last_seen')}</TableHead>
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
                  <Pagination className="mt-3" total={data.summary.total} limit={data.summary.limit} offset={groupOffset} onChange={loadGroupPage} />
                  </>
                ) : (
                  <EmptyState title={t('workspace_ui.usage.empty.grouped')} />
                )}
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>{t('workspace_ui.usage.recent_events')}</CardTitle>
                  <Badge variant="outline">{data.events.length}</Badge>
                </div>
                {data.events.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('workspace_ui.usage.col.time')}</TableHead>
                        <TableHead>{t('workspace_ui.usage.col.platform')}</TableHead>
                        <TableHead>{t('workspace_ui.usage.col.provider_model')}</TableHead>
                        <TableHead>{t('workspace_ui.usage.col.subject')}</TableHead>
                        <TableHead className="text-right">{t('workspace_ui.usage.col.tokens')}</TableHead>
                        <TableHead>{t('workspace_ui.usage.col.accuracy')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.events.map(event => (
                        <TableRow key={event.id}>
                          <TableCell className="text-xs text-muted-foreground">{formatDateTime(event.occurred_at)}</TableCell>
                          <TableCell>{labelForChannel(event.execution_channel)}</TableCell>
                          <TableCell>
                            <div className="max-w-[220px] truncate">{event.provider_name_snapshot ?? event.provider_type ?? t('workspace_ui.usage.unknown_provider')}</div>
                            <div className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground">{event.model ?? t('workspace_ui.usage.unknown_model')}</div>
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
                  <EmptyState title={t('workspace_ui.usage.empty.events')} />
                )}
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardTitle className="mb-4">{t('workspace_ui.usage.platform_title')}</CardTitle>
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
                    <EmptyState title={t('workspace_ui.usage.empty.platform')} />
                  )}
                </div>
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>{t('workspace_ui.usage.session_drilldown')}</CardTitle>
                  <Badge variant="outline">{data.sessions.length}</Badge>
                </div>
                {data.sessions.length === 0 ? (
                  <EmptyState title={t('workspace_ui.usage.empty.sessions')} />
                ) : (
                  <div className="space-y-3">
                    {data.sessions.slice(0, 8).map(session => (
                      <div key={`${session.session_id ?? session.external_session_id ?? session.session_path ?? 'unknown'}`} className="rounded-lg border border-border p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {session.session_name ?? session.session_path ?? session.session_id ?? session.external_session_id ?? t('workspace_ui.usage.unknown_session')}
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {session.session_path ?? session.external_session_id ?? session.session_id ?? t('workspace_ui.usage.no_session_id')}
                            </div>
                          </div>
                          <div className="text-right font-mono text-xs">{formatTokens(session.totals.total_tokens)}</div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                          <Badge variant="muted">{t('workspace_ui.usage.runs', { count: session.run_ids.length, formatted: formatNumber(session.run_ids.length) })}</Badge>
                          <span>{formatDateTime(session.last_seen_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <CardTitle className="mb-4">{t('workspace_ui.usage.unit_economics')}</CardTitle>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('workspace_ui.usage.col.unit')}</TableHead>
                      <TableHead className="text-right">{t('workspace_ui.usage.col.avg_tokens')}</TableHead>
                      <TableHead className="text-right">{t('workspace_ui.usage.col.avg_cost')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      { label: t('workspace_ui.usage.unit.request'), totals: selectedTotals, divisor: selectedTotals.request_count },
                      { label: t('workspace_ui.usage.unit.event'), totals: selectedTotals, divisor: selectedTotals.event_count },
                      // Sessions are listed only at full access, so their
                      // average divides their own totals, not the summary's.
                      { label: t('workspace_ui.usage.unit.session'), totals: data.sessionTotals, divisor: data.sessionTotal },
                      { label: data.summary?.group_by ? labelForGroupBy(data.summary.group_by) : t('workspace_ui.usage.col.group'), totals: selectedTotals, divisor: data.summary?.total ?? 0 },
                    ].map(row => {
                      const divisor = Math.max(0, row.divisor)
                      const cost = row.totals.estimated_cost_usd
                      return (
                        <TableRow key={row.label}>
                          <TableCell>{row.label}</TableCell>
                          <TableCell className="text-right font-mono">
                            {divisor > 0 ? formatTokens(row.totals.total_tokens / divisor) : '-'}
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
                  <CardTitle>{t('workspace_ui.usage.budget_preview')}</CardTitle>
                  <Badge variant="outline">{t('workspace_ui.usage.days', { count: data.budgetPreview?.projection_window_days ?? 30 })}</Badge>
                </div>
                {data.budgetPreview?.items.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('workspace_ui.usage.col.subject')}</TableHead>
                        <TableHead className="text-right">{t('workspace_ui.usage.col.projected')}</TableHead>
                        <TableHead className="text-right">{t('workspace_ui.usage.col.costed')}</TableHead>
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
                  <EmptyState title={t('workspace_ui.usage.empty.costed')} />
                )}
                {data.budgetPreview && data.budgetPreview.total_projected_estimated_cost_usd !== null && (
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm">
                    <span className="text-muted-foreground">{t('workspace_ui.usage.projected_total')}</span>
                    <span className="font-mono">{formatCost(data.budgetPreview.total_projected_estimated_cost_usd)}</span>
                  </div>
                )}
              </Card>

              <Card>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <CardTitle>{t('workspace_ui.usage.dimensions')}</CardTitle>
                  <Badge variant="outline">{safeItems(data.dimensions?.custom_dimension_keys).length}</Badge>
                </div>
                <div className="space-y-3">
                  <Select ariaLabel={t('workspace_ui.usage.dimension_explorer_key')} options={dimensionKeyOptions} value={customDimensionKey} onChange={setCustomDimensionKey} />
                  {customDimensionKey && (
                    dimensionRows.length === 0 ? (
                      <EmptyState title={t('workspace_ui.usage.empty.dimension_values')} />
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('workspace_ui.usage.col.value')}</TableHead>
                            <TableHead className="text-right">{t('workspace_ui.usage.col.tokens')}</TableHead>
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
                      {t('workspace_ui.usage.missing_dimension', { key: customDimensionKey, tokens: formatTokens(missingDimensionRow.totals.total_tokens) })}
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
