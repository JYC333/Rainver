import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { AlertTriangle, ArrowLeft, BookOpen, FileText, Link2, Network, Play, Plus, RefreshCw, Rss, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi, sourcesApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Project, ProjectExtractionProfile, ProjectSourceBinding, ProjectSourceItem, SourceBackfillPlan, SourceChannel, SourceHealth } from '../../types/api'
import { ScreeningCriteriaCard } from './ScreeningCriteriaCard'
import { ProjectSourceSignals } from './sourcesArea/ProjectSourceSignals'
import {
  isManualUrlItem, projectSourceOptions, SaveProjectUrlDialog,
} from './sourcesArea/SaveProjectUrlDialog'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { EmptyState } from '../../components/ui/empty-state'
import { sourceQueryText } from '../sources/sourceQueryText'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '-'
}

function projectGraphHref(projectId: string, bindings: ProjectSourceBinding[]): string {
  const params = new URLSearchParams({ project_id: projectId })
  const lenses = [...new Set(bindings
    .filter(binding => binding.status === 'active')
    .map(binding => binding.extraction_profile?.graph_lens_id)
    .filter((lens): lens is string => Boolean(lens)))]
  if (lenses.length === 1) params.set('lens_id', lenses[0]!)
  return `/graph?${params}`
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode
  label: string
  value: number
  detail: string
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </Card>
  )
}

function AddProjectSourceDialog({
  open,
  onOpenChange,
  projectId,
  channels,
  bindings,
  profiles,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  channels: SourceChannel[]
  bindings: ProjectSourceBinding[]
  profiles: ProjectExtractionProfile[]
  onAdded: () => void
}) {
  const options = channels
    .filter(channel => !bindings.some(binding => binding.source_channel_id === channel.id && binding.binding_key === 'default' && binding.status !== 'archived'))
    .map(channel => ({ value: channel.id, label: channel.name }))
  const [connectionId, setConnectionId] = useState('')
  const [deliveryScope, setDeliveryScope] = useState<'project_members' | 'source_subscribers'>('project_members')
  const [backfill, setBackfill] = useState(true)
  const [standingComparison, setStandingComparison] = useState(true)
  const [profileKey, setProfileKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setConnectionId(options[0]?.value ?? '')
    setDeliveryScope('project_members')
    setBackfill(true)
    setStandingComparison(true)
    setProfileKey(profiles.find(profile => profile.is_default)?.key ?? profiles[0]?.key ?? '')
  }, [open, channels, bindings, profiles])

  async function submit() {
    if (!connectionId) return
    setSaving(true)
    try {
      await projectsApi.createSourceBinding(projectId, {
        source_channel_id: connectionId,
        delivery_scope: deliveryScope,
        backfill_history: backfill,
        standing_comparison_enabled: standingComparison,
        extraction_policy: { profile_key: profileKey },
      })
      toast.success('Source added to this project')
      onAdded()
      onOpenChange(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>Bind an existing source to this project.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Source</Label>
            {options.length === 0 ? (
              <p className="text-xs text-muted-foreground">No unbound sources are available.</p>
            ) : (
              <Select value={connectionId} options={options} onChange={setConnectionId} />
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Extraction profile</Label>
            <Select
              value={profileKey}
              options={profiles.map(profile => ({ value: profile.key, label: profile.display_name }))}
              onChange={setProfileKey}
              ariaLabel="Extraction profile"
            />
            <p className="text-xs text-muted-foreground">Controls how triage-approved material becomes a Project object.</p>
          </div>
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={standingComparison}
              onChange={event => setStandingComparison(event.target.checked)}
            />
            <span>
              <span className="block font-medium text-foreground">Compare new material with this Project</span>
              <span className="text-muted-foreground">Use the bounded Standing Research budget to surface possible new directions.</span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label>Delivery</Label>
            <Select
              value={deliveryScope}
              onChange={value => setDeliveryScope(value as 'project_members' | 'source_subscribers')}
              options={[
                { value: 'project_members', label: 'Project members' },
                { value: 'source_subscribers', label: 'Source subscribers' },
              ]}
            />
          </div>
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={backfill}
              onChange={event => setBackfill(event.target.checked)}
            />
            <span>
              <span className="block font-medium text-foreground">Backfill existing items</span>
              <span className="text-muted-foreground">Link already collected source items and evidence into this project.</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !connectionId || !profileKey}>{saving ? 'Adding...' : 'Add source'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ProjectSourcesPage() {
  const { projectId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [project, setProject] = useState<Project | null>(null)
  const [channels, setChannels] = useState<SourceChannel[]>([])
  const [bindings, setBindings] = useState<ProjectSourceBinding[]>([])
  const [profiles, setProfiles] = useState<ProjectExtractionProfile[]>([])
  const [backfillPlans,setBackfillPlans]=useState<SourceBackfillPlan[]>([])
  const [health, setHealth] = useState<SourceHealth[]>([])
  const [items, setItems] = useState<ProjectSourceItem[]>([])
  const [sourceFilter, setSourceFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [dateFilter, setDateFilter] = useState(() => searchParams.get('date') ?? '')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [saveUrlOpen, setSaveUrlOpen] = useState(false)
  const [updatingItemSourceId, setUpdatingItemSourceId] = useState<string | null>(null)
  const [bindingToRemove, setBindingToRemove] = useState<ProjectSourceBinding | null>(null)
  const [busyBindingId, setBusyBindingId] = useState<string | null>(null)

  const channelById = useMemo(
    () => Object.fromEntries(channels.map(channel => [channel.id, channel])) as Record<string, SourceChannel>,
    [channels],
  )
  const sourceOptions = useMemo(
    () => projectSourceOptions(bindings, channels),
    [bindings, channels],
  )
  const healthByBindingId = useMemo(
    () => Object.fromEntries(health.map(row => [row.binding_id ?? '', row])) as Record<string, SourceHealth>,
    [health],
  )

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [projectRow, channelRows, bindingRows, profileRows, healthRows, itemPage] = await Promise.all([
        projectsApi.get(projectId),
        sourcesApi.channels(),
        projectsApi.sourceBindings(projectId),
        projectsApi.sourceExtractionProfiles(projectId),
        projectsApi.sourceHealth(projectId),
        sourcesApi.projectItems({
          project_id: projectId,
          source_channel_id: sourceFilter || undefined,
          item_type: typeFilter || undefined,
          matched_date: dateFilter || undefined,
          q: query || undefined,
          limit: 50,
        }),
      ])
      setProject(projectRow)
      setChannels(channelRows)
      setBindings(bindingRows)
      setProfiles(profileRows)
      const plans=(await Promise.all([...new Set(bindingRows.map(binding=>binding.source_channel_id))].map(channelId=>sourcesApi.channelBackfillPlans(channelId).catch(()=>[] as SourceBackfillPlan[])))).flat()
      setBackfillPlans(plans.filter(plan=>bindingRows.some(binding=>binding.id===plan.project_source_binding_id)))
      setHealth(healthRows)
      setItems(itemPage.items)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId, sourceFilter, typeFilter, dateFilter, query])

  useEffect(() => { load() }, [load])

  const refreshSourceConfiguration = useCallback(async () => {
    if (!projectId) return
    try {
      const [channelRows, bindingRows, healthRows] = await Promise.all([
        sourcesApi.channels(),
        projectsApi.sourceBindings(projectId),
        projectsApi.sourceHealth(projectId),
      ])
      const plans = (await Promise.all(
        [...new Set(bindingRows.map(binding => binding.source_channel_id))]
          .map(channelId => sourcesApi.channelBackfillPlans(channelId).catch(() => [] as SourceBackfillPlan[])),
      )).flat()
      setChannels(channelRows)
      setBindings(bindingRows)
      setBackfillPlans(plans.filter(plan => bindingRows.some(binding => binding.id === plan.project_source_binding_id)))
      setHealth(healthRows)
    } catch {
      // Keep the current source configuration visible on a transient refresh failure.
    }
  }, [projectId])

  const refreshSourceCollections = useCallback(async () => {
    if (!projectId) return
    try {
      const itemPage = await sourcesApi.projectItems({
          project_id: projectId,
          source_channel_id: sourceFilter || undefined,
          item_type: typeFilter || undefined,
          matched_date: dateFilter || undefined,
          q: query || undefined,
          limit: 50,
        })
      setItems(itemPage.items)
    } catch {
      // Keep the current collections visible on a transient refresh failure.
    }
  }, [dateFilter, projectId, query, sourceFilter, typeFilter])

  const refreshSourceModule = useCallback(async () => {
    await Promise.all([refreshSourceConfiguration(), refreshSourceCollections()])
  }, [refreshSourceCollections, refreshSourceConfiguration])

  useEffect(() => {
    const nextDate = searchParams.get('date') ?? ''
    setDateFilter(current => current === nextDate ? current : nextDate)
  }, [searchParams])

  function updateDateFilter(value: string) {
    setDateFilter(value)
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      if (value) next.set('date', value)
      else next.delete('date')
      return next
    }, { replace: true })
  }

  /**
   * Recompute which already-collected SourceItems this binding routes into the
   * Project. Distinct from "Import history", which asks the provider for
   * material this Space has never seen and goes through Review; this only
   * re-evaluates the binding against items the Source already holds, so it is
   * the repair for a binding whose filters or scope changed after collection.
   */
  async function relinkCollectedItems(binding: ProjectSourceBinding) {
    setBusyBindingId(binding.id)
    try {
      const result = await sourcesApi.backfillProjectSourceBinding(projectId, binding.id)
      toast.success(`Re-linked ${result.created_links} project items`)
      await refreshSourceModule()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  async function backfill(binding: ProjectSourceBinding) {
    setBusyBindingId(binding.id)
    try {
      await projectsApi.proposeBindingBackfill(projectId,binding.id,{idempotency_key:crypto.randomUUID(),title:`Import history: ${channelById[binding.source_channel_id]?.name??binding.source_channel_id}`,strategy:{window_unit:'date_window',window_size:30,max_items:100,direction:'backward'},quota_policy:{window:'minute',limit_count:10}})
      toast.success('History import proposal sent to Review')
      await refreshSourceModule()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  async function runScan(binding: ProjectSourceBinding) {
    setBusyBindingId(binding.id)
    try {
      await sourcesApi.scanChannel(binding.source_channel_id)
      toast.success('Source scan queued')
      await refreshSourceModule()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  async function togglePause(binding: ProjectSourceBinding) {
    setBusyBindingId(binding.id)
    try {
      await (projectsApi.updateSourceBinding ?? sourcesApi.updateProjectSourceBinding)(projectId, binding.id, {
        status: binding.status === 'paused' ? 'active' : 'paused',
      })
      await refreshSourceConfiguration()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  async function toggleStanding(binding: ProjectSourceBinding) {
    setBusyBindingId(binding.id)
    try {
      await projectsApi.updateSourceBinding(projectId, binding.id, {
        standing_comparison_enabled: !binding.standing_comparison_enabled,
      })
      toast.success(binding.standing_comparison_enabled ? 'Standing comparison disabled' : 'Standing comparison enabled')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  async function updateExtractionProfile(binding: ProjectSourceBinding, profileKey: string) {
    setBusyBindingId(binding.id)
    try {
      await projectsApi.updateSourceBinding(projectId, binding.id, {
        extraction_policy: { ...binding.extraction_policy_json, profile_key: profileKey },
      })
      toast.success('Extraction profile updated')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  async function updateProjectItemSource(item: ProjectSourceItem['item'], connectionId: string) {
    if (item.connection_id === connectionId) return
    setUpdatingItemSourceId(item.id)
    try {
      await sourcesApi.updateItem(item.id, { connection_id: connectionId })
      toast.success('Item source updated')
      await refreshSourceCollections()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setUpdatingItemSourceId(null)
    }
  }

  async function confirmRemove() {
    const binding = bindingToRemove
    if (!binding) return
    setBusyBindingId(binding.id)
    try {
      await (projectsApi.deleteSourceBinding ?? sourcesApi.deleteProjectSourceBinding)(projectId, binding.id)
      toast.success('Source removed from project')
      setBindingToRemove(null)
      await refreshSourceModule()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyBindingId(null)
    }
  }

  const attentionCount = health.filter(row => row.status === 'attention' || row.status === 'failing').length
  return (
    <div className="p-6 space-y-6">
      <Link
        to={projectId ? `/projects/${projectId}` : '/projects'}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-3" />
        Project
      </Link>

      <div className="flex flex-wrap items-center gap-2 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <BookOpen className="size-3.5 shrink-0" />
        <span>Material triage and reading status live in the <Link className="font-medium text-foreground hover:underline" to={`/projects/${projectId}/research`}>Research Area → Reading List</Link>. This page manages collection only.</span>
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap pb-4 border-b border-border">
        <div className="flex items-start gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <Rss className="size-5 text-accent-foreground" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight">{project?.name ?? 'Project sources'}</h1>
              <Badge variant="outline">Sources</Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Monitor bound sources, collection health, and source items collected for this project.
            </p>
            {project && <p className="text-xs text-muted-foreground">Updated {fmt(project.updated_at)}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {projectId && <Button variant="outline" asChild><Link to={`/projects/${projectId}/research`}><BookOpen className="size-4" />Review reading list</Link></Button>}
          <Button variant="outline" className="gap-1.5 shrink-0" asChild disabled={!projectId}>
            <Link to={projectGraphHref(projectId, bindings)}>
              <Network className="size-4" />
              Open graph
            </Link>
          </Button>
          {projectId && <Button variant="secondary" className="gap-1.5 shrink-0" asChild><Link to="/sources"><Plus className="size-4" />Create reusable source</Link></Button>}
          <Button variant="secondary" className="gap-1.5 shrink-0" onClick={() => setSaveUrlOpen(true)} disabled={!projectId}>
            <FileText className="size-4" />
            Save URL
          </Button>
          <Button className="gap-1.5 shrink-0" onClick={() => setAddOpen(true)} disabled={!projectId}>
            <Plus className="size-4" />
            Add source
          </Button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <MetricCard
          icon={<Link2 className="size-3.5" />}
          label="Bound sources"
          value={bindings.length}
          detail="Sources routed into this project"
        />
        <MetricCard
          icon={<AlertTriangle className="size-3.5" />}
          label="Needs attention"
          value={attentionCount}
          detail="Bindings with source health issues"
        />
        <MetricCard
          icon={<FileText className="size-3.5" />}
          label="Collected items"
          value={items.length}
          detail="Items matching the current filters"
        />
      </div>

      {projectId && <ScreeningCriteriaCard projectId={projectId} />}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Source bindings</h2>
          {loading && <Badge variant="muted">Loading</Badge>}
        </div>
        <div className="space-y-2">
          {bindings.length === 0 ? (
            <Card className="p-0">
              <EmptyState
                title="No sources bound."
                description="Add a source to start collecting matching items into this project."
                action={
                  <Button size="sm" onClick={() => setAddOpen(true)} disabled={!projectId}>
                    <Plus className="size-3.5" />
                    Add source
                  </Button>
                }
              />
            </Card>
          ) : bindings.map(binding => {
            const channel = channelById[binding.source_channel_id]
            const rowHealth = healthByBindingId[binding.id]
            const busy = busyBindingId === binding.id
            const plan=backfillPlans.find(candidate=>candidate.project_source_binding_id===binding.id)
            return (
              <Card key={binding.id} className="p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 xl:flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link className="font-medium hover:underline" to={`/sources/${channel?.source_connection_id ?? binding.source_channel_id}`}>
                        {channel?.source_name ?? channel?.name ?? binding.source_channel_id}
                      </Link>
                      <StatusBadge status={rowHealth?.status ?? binding.status} />
                      <Badge variant="outline">{binding.delivery_scope.replace('_', ' ')}</Badge>
                      <Badge variant={binding.standing_comparison_enabled ? 'secondary' : 'outline'}>{binding.standing_comparison_enabled ? 'Standing on' : 'Standing off'}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground truncate">{channel?.provider.display_name ?? channel?.provider.key ?? binding.binding_key} · Monitor: {channel?.name ?? 'Configured monitor'} · {channel ? sourceQueryText(channel) : ''}</p>
                    {rowHealth && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Last success {fmt(rowHealth.last_success_at)} · next run {fmt(rowHealth.next_run_at)}
                      </p>
                    )}
                    {(['attention', 'failing'] as string[]).includes(rowHealth?.status ?? '') && rowHealth?.last_error && <p className="mt-1 text-xs text-destructive">Latest scan error: {rowHealth.last_error}</p>}
                    {plan&&<p className="mt-2 text-xs text-muted-foreground">History import: {plan.status} · {plan.segments_completed}/{plan.segments_total} segments · {plan.items_ingested} ingestion records{plan.next_eligible_at?` · paused until ${fmt(plan.next_eligible_at)}`:''}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Select
                      size="sm"
                      ariaLabel={`Extraction profile for ${channel?.name ?? binding.source_channel_id}`}
                      value={binding.extraction_profile?.key ?? ''}
                      options={profiles.map(profile => ({ value: profile.key, label: profile.display_name }))}
                      disabled={busy}
                      onChange={value => { void updateExtractionProfile(binding, value) }}
                    />
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleStanding(binding)}>
                      {binding.standing_comparison_enabled ? 'Disable standing' : 'Enable standing'}
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => runScan(binding)}>
                      <Play className="size-3.5" />
                      Run scan
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={busy || binding.status !== 'active'}
                      onClick={() => { void relinkCollectedItems(binding) }}
                    >
                      <Link2 className="size-3.5" />
                      Re-link collected items
                    </Button>
                    {channel?.channel_type === 'search'&&<Button size="sm" variant="outline" className="gap-1.5" disabled={busy || binding.status !== 'active' || Boolean(plan&&['draft','proposed','approved','running','paused'].includes(plan.status))} onClick={() => backfill(binding)}>
                      <RefreshCw className="size-3.5" />
                      {plan&&['draft','proposed','approved','running','paused'].includes(plan.status)?'Import in progress':'Import history'}
                    </Button>}
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => togglePause(binding)}>
                      {binding.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                    <Button size="sm" variant="ghost" className="gap-1.5 text-destructive" disabled={busy} onClick={() => setBindingToRemove(binding)}>
                      <Trash2 className="size-3.5" />
                      Remove
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      <details id="advanced" className="rounded-lg border border-border bg-card p-4">
          <summary className="cursor-pointer select-none text-sm font-medium">Advanced monitor state</summary>
          <p className="mt-2 text-xs text-muted-foreground">Operational scan details for diagnosing collection gaps. These values do not describe research outcomes.</p>
          <div className="mt-3 space-y-2">
            {bindings.length === 0 ? (
              <p className="text-xs text-muted-foreground">No source monitors are bound to this project.</p>
            ) : bindings.map(binding => {
              const channel = channelById[binding.source_channel_id]
              const rowHealth = healthByBindingId[binding.id]
              return (
                <div key={binding.id} className="rounded-md border border-border bg-muted/15 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{channel?.name ?? binding.source_channel_id}</span>
                    <Badge variant="outline">{channel?.scan_state.status ?? rowHealth?.status ?? 'not scheduled'}</Badge>
                  </div>
                  <p className="mt-2 text-muted-foreground">Last scan {fmt(channel?.scan_state.last_run_at ?? rowHealth?.last_success_at)} · next scan {fmt(channel?.scan_state.next_run_at ?? rowHealth?.next_run_at)}</p>
                  <p className="mt-1 text-muted-foreground">Cursor {Object.keys(channel?.scan_state.cursor ?? {}).length ? 'saved' : 'empty'} · watermark {String(channel?.scan_state.watermark?.value ?? '—')}</p>
                </div>
              )
            })}
          </div>
      </details>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Collected items</h2>
          <div className="grid w-full gap-2 sm:grid-cols-2 lg:w-auto lg:grid-cols-[16rem_10rem_9rem_10rem]">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search items" value={query} onChange={event => setQuery(event.target.value)} />
            </div>
            <Select
              className="w-full"
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: '', label: 'All sources' },
                ...bindings.map(binding => ({
                  value: binding.source_channel_id,
                  label: channelById[binding.source_channel_id]?.name ?? binding.source_channel_id,
                })),
              ]}
            />
            <Select
              className="w-full"
              value={typeFilter}
              onChange={setTypeFilter}
              options={[
                { value: '', label: 'All types' },
                { value: 'external_url', label: 'Articles' },
                { value: 'pdf', label: 'PDFs' },
                { value: 'book', label: 'Books' },
                { value: 'podcast', label: 'Podcasts' },
                { value: 'video', label: 'Videos' },
                { value: 'email', label: 'Emails' },
              ]}
            />
            <Input
              type="date"
              className="w-full"
              value={dateFilter}
              onChange={event => updateDateFilter(event.target.value)}
              aria-label="Collected date"
            />
          </div>
        </div>
        <div className="space-y-2">
          {items.length === 0 ? (
            <Card className="p-0">
              <EmptyState
                title="No collected items."
                description="No project source items match the current filters."
              />
            </Card>
          ) : items.map(row => (
            <Card key={row.id} className="p-4">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="font-medium truncate">{row.item.title || 'Untitled item'}</p>
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{row.item.excerpt ?? row.item.source_uri ?? row.item.item_type}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge variant="outline">{row.item.item_type}</Badge>
                    {row.item.source_domain && <Badge variant="muted">{row.item.source_domain}</Badge>}
                    <Badge variant="muted">matched {fmt(row.matched_at)}</Badge>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isManualUrlItem(row.item) && sourceOptions.length > 0 && (
                    <Select
                      size="sm"
                      ariaLabel={`Source for ${row.item.title || 'saved URL'}`}
                      value={row.item.connection_id ?? ''}
                      options={sourceOptions}
                      disabled={updatingItemSourceId === row.item.id}
                      onChange={value => { void updateProjectItemSource(row.item, value) }}
                    />
                  )}
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/library/items/${row.item.id}`}>Open reader</Link>
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {projectId && <ProjectSourceSignals projectId={projectId} channels={channels} />}

      <SaveProjectUrlDialog
        open={saveUrlOpen}
        onOpenChange={setSaveUrlOpen}
        sourceOptions={sourceOptions}
        onSaved={() => { void refreshSourceModule() }}
      />
      <AddProjectSourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        channels={channels}
        bindings={bindings}
        profiles={profiles}
        onAdded={refreshSourceModule}
      />
      <Dialog open={Boolean(bindingToRemove)} onOpenChange={open => { if (!open && !busyBindingId) setBindingToRemove(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove source from project?</DialogTitle>
            <DialogDescription>
              This stops this Project from consuming the source. The Source itself stays available and can be added back later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={Boolean(busyBindingId)} onClick={() => setBindingToRemove(null)}>Cancel</Button>
            <Button variant="destructive" disabled={Boolean(busyBindingId)} onClick={() => void confirmRemove()}>
              {busyBindingId ? 'Removing...' : 'Remove source'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
