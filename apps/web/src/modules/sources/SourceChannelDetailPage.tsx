import {readingGoalPath} from './sourceGoalNavigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BookOpen, Globe2, Pause, Play, Plus, RefreshCw, Rss, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError, sourcesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { EmptyState } from '../../components/ui/empty-state'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import {useSpaceNavigate} from '../../core/spaceNav'
import { sourceQueryText } from './sourceQueryText'
import type { SourceChannel } from '../../types/api'
import { useAppTranslation } from '../../i18n'

function sourceIcon(channel: Pick<SourceChannel, 'channel_type'>) {
  switch (channel.channel_type) {
    case 'search': return <BookOpen className="size-5" />
    case 'feed': return <Rss className="size-5" />
    case 'web_page': return <Globe2 className="size-5" />
    default: return <BookOpen className="size-5" />
  }
}

function monitorDescription(channel: SourceChannel): string {
  return sourceQueryText(channel)
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not yet scanned'
}

function statusLabel(status: SourceChannel['status'] | 'mixed') {
  if (status === 'active') return 'Running'
  if (status === 'paused') return 'Paused'
  if (status === 'mixed') return 'Mixed'
  return 'Archived'
}

/** A source detail page manages one origin and all of its independent monitors. */
export default function SourceChannelDetailPage() {
  const { sourceId } = useParams<{ sourceId: string }>()
  const { activeSpaceId, userId } = useSpace()
  return <ScopedSourceChannelDetail key={`${activeSpaceId}:${userId}:${sourceId}`} />
}

function ScopedSourceChannelDetail() {
  const navigate=useSpaceNavigate()
  const { sourceId } = useParams<{ sourceId: string }>()
  const { activeSpaceId } = useSpace()
  const [channels, setChannels] = useState<SourceChannel[]>([])
  const [busyMonitorId, setBusyMonitorId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Kept apart from "not found": a request that failed says nothing about
  // whether the source exists.
  const [loadError, setLoadError] = useState<string | null>(null)
  const { t } = useAppTranslation()

  const load = useCallback(async () => {
    if (!sourceId) return
    setLoading(true)
    setLoadError(null)
    try {
      const channelRows=await sourcesApi.channels()
      const direct = channelRows.filter(channel => channel.source_connection_id === sourceId)
      setChannels(direct)
    } catch (error) {
      if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) setChannels([])
      setLoadError(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [sourceId])

  useEffect(() => { void load() }, [load])

  const source = channels[0] ?? null
  const sourceStatus = useMemo(() => {
    if (!channels.length) return 'paused' as const
    const active = channels.filter(channel => channel.status === 'active').length
    if (active === channels.length) return 'active' as const
    if (active === 0) return 'paused' as const
    return 'mixed' as const
  }, [channels])

  async function scan(monitor: SourceChannel) {
    setBusyMonitorId(monitor.id)
    try {
      const job = await sourcesApi.scanChannel(monitor.id)
      await sourcesApi.runJob(job.id)
      toast.success('Monitor scan completed')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
      if (error instanceof ApiRequestError && [403, 404].includes(error.status)) {
        setChannels([])
        await load()
      }
    } finally {
      setBusyMonitorId(null)
    }
  }

  async function toggle(monitor: SourceChannel) {
    setBusyMonitorId(monitor.id)
    try {
      await sourcesApi.updateChannel(monitor.id, { status: monitor.status === 'active' ? 'paused' : 'active' })
      await load()
    } catch (error) {
      toast.error(errMsg(error))
      if (error instanceof ApiRequestError && [403, 404].includes(error.status)) {
        setChannels([])
        await load()
      }
    } finally {
      setBusyMonitorId(null)
    }
  }

  if (loadError && !source) {
    return (
      <div className="p-6">
        <EmptyState
          title={t('sources_ui.detail.load_failed_title')}
          description={loadError}
          action={<Button variant="outline" onClick={() => void load()} disabled={loading}>{t('sources_ui.detail.retry')}</Button>}
        />
      </div>
    )
  }
  if (!activeSpaceId || (!loading && !source)) return <div className="p-6"><EmptyState title="Source not found" description="This source may have been archived or is unavailable." /></div>
  if (!source) return <div className="p-6"><EmptyState title="Loading source" description="Loading source monitors…" /></div>

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <Button variant="ghost" asChild><Link to=".."><ArrowLeft className="size-4 mr-2" />Back to sources</Link></Button>
      {loadError && (
        // A later refresh failed while the source is on screen: say so, keep what is shown.
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
          <span>{t('sources_ui.detail.refresh_failed', { message: loadError })}</span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{t('sources_ui.detail.retry')}</Button>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{sourceIcon(source)}</div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold truncate">{source.source_name}</h1>
            <p className="text-sm text-muted-foreground">{source.provider.display_name ?? source.provider.key ?? 'Provider'} · External source</p>
          </div>
        </div>
        <Badge variant="muted">{statusLabel(sourceStatus)}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Provider</p><p className="mt-1 text-sm font-medium">{source.provider.display_name ?? source.provider.key}</p></div>
        <div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Monitors</p><p className="mt-1 text-sm font-medium">{channels.length}</p></div>
        <div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Capture policy</p><p className="mt-1 text-sm font-medium">{source.capture_policy?.replace('_', ' ') ?? 'Default'}</p></div>
        <div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Connection</p><p className="mt-1 text-sm font-medium">Managed by the system</p></div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Monitors</h2>
            <p className="text-sm text-muted-foreground">{t('sourceGoals.legacy')}</p>
          </div>
          <Button onClick={() => navigate(readingGoalPath(source.project_id,'new'))}><Plus className="size-4 mr-2" />{t('sourceGoals.begin')}</Button>
        </div>

        <div className="space-y-3">
          {channels.map(monitor => {
            const busy = busyMonitorId === monitor.id
            return (
              <div key={monitor.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap"><h3 className="font-medium">{monitor.name}</h3><Badge variant="muted">{statusLabel(monitor.status)}</Badge></div>
                    <p className="text-sm text-muted-foreground">{monitorDescription(monitor)}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{monitor.fetch_frequency === 'manual' ? 'Manual updates' : `Updates ${monitor.fetch_frequency}`}</span>
                      <span>Last scan: {formatTimestamp(monitor.scan_state.last_run_at)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                        {monitor.goal_id&&<Button size="sm" variant="outline" onClick={()=>navigate(readingGoalPath(monitor.project_id,monitor.goal_id!))}>{t('sourceGoals.ownerControl')}</Button>}
                    <Button size="sm" variant="outline" onClick={() => navigate(monitor.goal_id?readingGoalPath(monitor.project_id,monitor.goal_id!):`${readingGoalPath(monitor.project_id,'new')}?channel_id=${encodeURIComponent(monitor.id)}`)}><Settings2 className="size-4 mr-1" />{t('sourceGoals.adjust')}</Button>
                    <Button size="sm" variant="outline" onClick={() => void toggle(monitor)} disabled={busy||!!monitor.goal_id}>{monitor.status === 'active' ? <Pause className="size-4" /> : <Play className="size-4" />}{monitor.status === 'active' ? 'Pause' : 'Resume'}</Button>
                    <Button size="sm" variant="outline" onClick={() => void scan(monitor)} disabled={busy||!!monitor.goal_id}><RefreshCw className="size-4 mr-1" />Scan now</Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>


    </div>
  )
}
