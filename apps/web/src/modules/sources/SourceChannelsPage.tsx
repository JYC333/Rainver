import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, Globe2, Pause, Play, Plus, RefreshCw, Rss, Search, SlidersHorizontal, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { sourcesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { EmptyState } from '../../components/ui/empty-state'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'
import { SourceMonitorDialog } from './SourceMonitorDialog'
import { sourceQueryText } from './sourceQueryText'
import type { SourceChannel, SourceProvider, SourceProviderCategoryGroup, SourceRecommendation } from '../../types/api'

interface SourceGroup {
  id: string
  name: string
  provider: SourceChannel['provider']
  monitors: SourceChannel[]
  status: 'active' | 'paused' | 'mixed'
}

function monitorKindLabel(channel: Pick<SourceChannel, 'channel_type'>): string {
  switch (channel.channel_type) {
    case 'search': return 'Academic search'
    case 'feed': return 'Feed subscription'
    case 'web_page': return 'Web page monitor'
    case 'custom_source': return 'Custom monitor'
    default: return 'Monitor'
  }
}

function sourceIcon(channel: Pick<SourceChannel, 'channel_type'>) {
  switch (channel.channel_type) {
    case 'search': return <BookOpen className="size-4" />
    case 'feed': return <Rss className="size-4" />
    case 'web_page': return <Globe2 className="size-4" />
    default: return <Search className="size-4" />
  }
}

function monitorDescription(channel: SourceChannel): string {
  return sourceQueryText(channel)
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not yet scanned'
}

function groupSources(channels: SourceChannel[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()
  for (const channel of channels) {
    const existing = groups.get(channel.source_connection_id)
    if (existing) {
      existing.monitors.push(channel)
      existing.status = existing.status === 'mixed' || existing.status !== channel.status
        ? 'mixed'
        : existing.status
      continue
    }
    groups.set(channel.source_connection_id, {
      id: channel.source_connection_id,
      name: channel.source_name,
      provider: channel.provider,
      monitors: [channel],
      status: channel.status === 'active' ? 'active' : 'paused',
    })
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function statusLabel(status: SourceGroup['status'] | SourceChannel['status']) {
  if (status === 'active') return 'Running'
  if (status === 'paused') return 'Paused'
  if (status === 'mixed') return 'Mixed'
  return 'Archived'
}

/** Sources are origins; query and scheduling rules are shown as nested monitors. */
export default function SourceChannelsPage() {
  const { activeSpaceId } = useSpace()
  const [providers, setProviders] = useState<SourceProvider[]>([])
  const [arxivCategoryGroups, setArxivCategoryGroups] = useState<readonly SourceProviderCategoryGroup[]>([])
  const [channels, setChannels] = useState<SourceChannel[]>([])
  const [recommendations, setRecommendations] = useState<SourceRecommendation[]>([])
  const [providerFilter, setProviderFilter] = useState('')
  const [search, setSearch] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [busyMonitorId, setBusyMonitorId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!activeSpaceId) return
    setLoading(true)
    try {
      const [providerRows, channelRows, recommendationRows] = await Promise.all([
        sourcesApi.providers(),
        sourcesApi.channels(),
        sourcesApi.recommendations(),
      ])
      setProviders(providerRows)
      setChannels(channelRows)
      setRecommendations(recommendationRows)
      setArxivCategoryGroups(providerRows.find(provider => provider.provider_key === 'arxiv')?.setup_schema?.category_groups ?? [])
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId])

  useEffect(() => { void load() }, [load])

  const sourceGroups = useMemo(() => groupSources(channels), [channels])
  const visibleSources = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return sourceGroups.filter(source => {
      if (providerFilter && source.provider.key !== providerFilter) return false
      if (!needle) return true
      const text = [source.name, source.provider.display_name ?? '', ...source.monitors.flatMap(monitor => [monitor.name, monitorDescription(monitor)])].join(' ')
      return text.toLowerCase().includes(needle)
    })
  }, [providerFilter, search, sourceGroups])

  async function scan(monitor: SourceChannel) {
    setBusyMonitorId(monitor.id)
    try {
      const job = await sourcesApi.scanChannel(monitor.id)
      await sourcesApi.runJob(job.id)
      toast.success('Monitor scan completed')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
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
    } finally {
      setBusyMonitorId(null)
    }
  }

  async function decideRecommendation(recommendation: SourceRecommendation, decision: 'subscribed' | 'dismissed' | 'muted') {
    setBusyMonitorId(recommendation.id)
    try {
      await sourcesApi.decideRecommendation(recommendation.id, decision)
      setRecommendations(current => current.filter(item => item.id !== recommendation.id))
      toast.success(decision === 'subscribed' ? 'Source followed' : decision === 'muted' ? 'Source recommendation muted' : 'Recommendation dismissed')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyMonitorId(null)
    }
  }

  if (!activeSpaceId) return <div className="p-6"><EmptyState title="No space selected" description="Select an operational space to manage sources." /></div>

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Sources</h1>
          <p className="text-sm text-muted-foreground">Manage external origins and the monitors that collect content from them.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4 mr-2" />Refresh</Button>
          <Button onClick={() => setSetupOpen(true)}><Plus className="size-4 mr-2" />Add source</Button>
        </div>
      </div>

      {recommendations.length > 0 && (
        <section className="space-y-3 rounded-lg border border-accent bg-accent/20 p-4" aria-label="Source recommendations">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 size-4 text-accent-foreground" />
            <div>
              <h2 className="font-medium">Sources to broaden your coverage</h2>
              <p className="text-xs text-muted-foreground">These remain suggestions until you choose to follow them.</p>
            </div>
          </div>
          <div className="space-y-2">
            {recommendations.map(recommendation => {
              const busy = busyMonitorId === recommendation.id
              return (
                <div key={recommendation.id} className="flex flex-col gap-3 rounded-md border bg-card p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium">{recommendation.source_name} · {recommendation.name}</p>
                    <p className="text-xs text-muted-foreground">{recommendation.recommendation_message ?? 'Recommended from outside your current subscriptions.'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void decideRecommendation(recommendation, 'subscribed')} disabled={busy}>Follow</Button>
                    <Button size="sm" variant="outline" onClick={() => void decideRecommendation(recommendation, 'dismissed')} disabled={busy}>Not now</Button>
                    <Button size="sm" variant="ghost" onClick={() => void decideRecommendation(recommendation, 'muted')} disabled={busy}>Mute</Button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1 max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search sources or monitors" className="pl-8" />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><SlidersHorizontal className="size-4" /><Select options={[{ value: '', label: 'All platforms' }, ...providers.map(provider => ({ value: provider.provider_key, label: provider.display_name }))]} value={providerFilter} onChange={setProviderFilter} size="sm" ariaLabel="Filter sources by platform" /></div>
      </div>

      {channels.length === 0 && !loading ? (
        <EmptyState title="No sources yet" description="Add an academic search, feed subscription, or web page to start collecting content." action={<Button onClick={() => setSetupOpen(true)}><Plus className="size-4 mr-2" />Add source</Button>} />
      ) : visibleSources.length === 0 && !loading ? (
        <EmptyState title="No matching sources" description="Try a different source, platform, or monitor name." />
      ) : (
        <div className="space-y-4">
          {visibleSources.map(source => (
            <div key={source.id} className="rounded-lg border bg-card p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">{sourceIcon(source.monitors[0]!)}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link className="font-medium hover:underline truncate" to={source.id}>{source.name}</Link>
                      <Badge variant="outline">{source.provider.display_name ?? source.provider.key ?? 'Provider'}</Badge>
                      <Badge variant="muted">{statusLabel(source.status)}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{source.monitors.length} {source.monitors.length === 1 ? 'monitor' : 'monitors'} · {source.provider.display_name ?? source.provider.key ?? 'External source'}</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" asChild><Link to={source.id}>Open source</Link></Button>
              </div>

              <div className="divide-y rounded-md border border-border">
                {source.monitors.map(monitor => {
                  const busy = busyMonitorId === monitor.id
                  return (
                    <div key={monitor.id} className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{monitor.name}</span>
                          <Badge variant="muted">{statusLabel(monitor.status)}</Badge>
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">{monitorDescription(monitor)}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{monitorKindLabel(monitor)}</span>
                          <span>{monitor.fetch_frequency === 'manual' ? 'Manual updates' : `Updates ${monitor.fetch_frequency}`}</span>
                          <span>Last scan: {formatTimestamp(monitor.scan_state.last_run_at)}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button variant="outline" size="sm" onClick={() => void toggle(monitor)} disabled={busy}>{monitor.status === 'active' ? <Pause className="size-4" /> : <Play className="size-4" />}{monitor.status === 'active' ? 'Pause' : 'Resume'}</Button>
                        <Button variant="outline" size="sm" onClick={() => void scan(monitor)} disabled={busy}><RefreshCw className="size-4 mr-1" />Scan now</Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <SourceMonitorDialog
        open={setupOpen}
        mode="source"
        providers={providers}
        categoryGroups={arxivCategoryGroups}
        onOpenChange={setSetupOpen}
        onSaved={load}
      />
    </div>
  )
}
