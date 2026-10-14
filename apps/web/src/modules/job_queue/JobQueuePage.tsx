import { useState, useEffect, useCallback } from 'react'
import { ListChecks, RefreshCw, ChevronDown, ChevronRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { jobsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { StatusBadge, Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import type { Job, JobEvent, JobStatus } from '../../types/api'
import i18n, { useAppTranslation } from '../../i18n'
import { formatDateTime, formatNumber, formatTime } from '../../i18n/format'

function elapsed(start: string | null, end: string | null): string {
  if (!start) return '—'
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime()
  if (ms < 1000) return i18n.t('management_ui.job_queue.elapsed_ms', { value: formatNumber(ms) })
  if (ms < 60_000) return i18n.t('management_ui.job_queue.elapsed_seconds', { value: formatNumber(ms / 1000, { maximumFractionDigits: 1 }) })
  return i18n.t('management_ui.job_queue.elapsed_minutes', { minutes: Math.floor(ms / 60_000), seconds: Math.floor((ms % 60_000) / 1000) })
}

const ACTIVE: Set<JobStatus> = new Set(['pending', 'claimed', 'running'])

const EVENT_COLOR: Record<string, string> = {
  status_change: 'text-muted-foreground',
  log:           'text-foreground',
  artifact:      'text-accent-foreground',
  error:         'text-destructive',
}

const STATUS_FILTERS = ['', 'pending', 'running', 'completed', 'failed', 'cancelled'] as const

function statusFilterLabel(value: string): string {
  return i18n.t(`management_ui.job_queue.filter.${value || 'all'}`)
}

// ---------------------------------------------------------------------------
// JobRow
// ---------------------------------------------------------------------------
function JobRow({
  job,
  onCancel,
}: {
  job: Job
  onCancel: (id: string) => void
}) {
  const { t } = useAppTranslation()
  const [expanded, setExpanded] = useState(false)
  const [events, setEvents]     = useState<JobEvent[] | null>(null)
  const [loadingEvts, setLoadingEvts] = useState(false)

  async function toggleExpand() {
    if (expanded) { setExpanded(false); return }
    setExpanded(true)
    if (events === null) {
      setLoadingEvts(true)
      try {
        setEvents(await jobsApi.events(job.id))
      } catch (e) {
        toast.error(errMsg(e))
      } finally {
        setLoadingEvts(false)
      }
    }
  }

  const canCancel = job.status === 'pending' || job.status === 'claimed'
  const ChevronIcon = expanded ? ChevronDown : ChevronRight

  return (
    <div className="border-b border-border last:border-0">
      {/* Main row */}
      <div
        className="flex items-center gap-3 py-3 cursor-pointer hover:bg-muted/30 px-1 rounded transition-colors"
        onClick={toggleExpand}
      >
        <ChevronIcon className="size-3.5 text-muted-foreground shrink-0" />

        <StatusBadge status={job.status} />
        <Badge variant="outline">{job.job_type}</Badge>

        <span className="font-mono text-xs text-muted-foreground hidden sm:inline">
          {job.id.slice(0, 20)}…
        </span>

        <div className="flex-1 min-w-0">
          {job.error && (
            <p className="text-xs text-destructive truncate">{job.error}</p>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
          {(job.status === 'running' || job.status === 'completed' || job.status === 'failed') && (
            <span>{elapsed(job.started_at, job.completed_at)}</span>
          )}
          <span className="hidden md:inline">{formatDateTime(job.created_at)}</span>
          {job.attempts > 0 && job.max_attempts > 1 && (
            <span className="tabular-nums">{t('management_ui.job_queue.attempts', { attempts: job.attempts, max: job.max_attempts })}</span>
          )}
        </div>

        {canCancel && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={e => { e.stopPropagation(); onCancel(job.id) }}
            title={t('management_ui.job_queue.cancel_job')}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Events panel */}
      {expanded && (
        <div className="ml-6 mb-3 rounded-md border border-border bg-muted/20 overflow-hidden">
          {loadingEvts ? (
            <div className="p-3 space-y-1.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : !events || events.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-2">{t('management_ui.job_queue.no_events')}</p>
          ) : (
            <div className="divide-y divide-border/60">
              {events.map(evt => (
                <div key={evt.id} className="flex gap-3 px-3 py-1.5 items-baseline">
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0 w-[90px]">
                    {formatTime(evt.created_at)}
                  </span>
                  <Badge variant="muted" className="text-[10px] py-0 shrink-0">
                    {evt.event_type}
                  </Badge>
                  <span className={`text-xs ${EVENT_COLOR[evt.event_type] ?? 'text-foreground'}`}>
                    {evt.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Result / payload peek */}
          {job.result && (
            <div className="border-t border-border/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{t('management_ui.job_queue.result')}</p>
              <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
                {JSON.stringify(job.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function JobQueuePage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [jobs, setJobs]               = useState<Job[]>([])
  const [total, setTotal]             = useState(0)
  const [loading, setLoading]         = useState(true)
  const [refreshing, setRefreshing]   = useState(false)
  const [statusFilter, setStatusFilter] = useState('')

  const hasActive = jobs.some(j => ACTIVE.has(j.status))

  const load = useCallback(async (quiet = false) => {
    if (!activeSpaceId) {
      setJobs([])
      setTotal(0)
      setLoading(false)
      setRefreshing(false)
      return
    }
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const params: Record<string, string> = { limit: '100' }
      if (statusFilter) params.status = statusFilter
      const page = await jobsApi.list(params)
      setJobs(page.items)
      setTotal(page.total)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [statusFilter, activeSpaceId])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 3 s while any job is active
  useEffect(() => {
    if (!hasActive) return
    const id = setInterval(() => load(true), 3000)
    return () => clearInterval(id)
  }, [hasActive, load])

  async function cancel(jobId: string) {
    try {
      await jobsApi.cancel(jobId)
      toast.success(t('management_ui.job_queue.cancelled'))
      load(true)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const activeCount = jobs.filter(j => ACTIVE.has(j.status)).length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <ListChecks className="size-5 text-accent-foreground" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{t('management_ui.job_queue.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('management_ui.job_queue.subtitle')}
            {activeCount > 0 && (
              <span className="ml-2 text-warning font-medium">{t('management_ui.job_queue.active', { count: activeCount })}</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('management_ui.job_queue.viewing', { space: activeSpaceName ?? activeSpaceId ?? t('management_ui.job_queue.no_space') })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => load(true)}
          disabled={refreshing || !activeSpaceId}
          title={t('management_ui.job_queue.refresh')}
        >
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex gap-1 flex-wrap">
        {STATUS_FILTERS.map(value => (
          <button
            key={value}
            onClick={() => setStatusFilter(value)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
              ${statusFilter === value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
          >
            {statusFilterLabel(value)}
          </button>
        ))}
      </div>

      {/* Jobs list */}
      <Card>
        <CardTitle>
          {statusFilter ? t('management_ui.job_queue.jobs_with_status', { status: statusFilterLabel(statusFilter) }) : t('management_ui.job_queue.all_jobs')} · {formatNumber(total)}
        </CardTitle>

        {loading ? (
          <div className="space-y-3 mt-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-5/6" />
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">
            {!activeSpaceId
              ? t('management_ui.job_queue.select_space')
              : statusFilter ? t('management_ui.job_queue.none_with_status', { status: statusFilterLabel(statusFilter) }) : t('management_ui.job_queue.none')}
          </p>
        ) : (
          <div className="mt-1">
            {jobs.map(job => (
              <JobRow key={job.id} job={job} onCancel={cancel} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
