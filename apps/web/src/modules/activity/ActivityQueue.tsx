import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { FolderKanban, Newspaper, X } from 'lucide-react'
import { toast } from 'sonner'
import { activityApi, projectsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { ActivityInboxRecord, ActivityStatus, ActivitySourceType, Project } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { ScopeBadge } from '../../components/ScopeBadge'

function fmt(dt: string) { return new Date(dt).toLocaleString() }

type StatusFilter = ActivityStatus | 'all'
const STATUS_FILTERS: StatusFilter[] = ['all', 'raw', 'proposals_generated', 'processed', 'failed', 'archived']

const SOURCE_COLORS: Record<ActivitySourceType, string> = {
  user_capture: 'default',
  web_capture: 'secondary',
  file_import: 'secondary',
  chat_message: 'secondary',
  external_chat: 'secondary',
  run_event: 'muted',
  system_event: 'muted',
  project_folder_event: 'muted',
  external_source: 'secondary',
  source: 'secondary',
}

interface BriefingPointer {
  connectionId: string
  date: string
  counts: { relevant: number; maybe: number; not_relevant: number }
  runCount: number
}

interface SourceRecommendationPointer {
  connectionId: string
  connectionName: string | null
}

interface ProjectSourceCollectionPointer {
  projectId: string
  date: string | null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function briefingPointer(record: ActivityInboxRecord): BriefingPointer | null {
  const metadata = recordValue(record.metadata_json)
  const date = stringValue(metadata?.briefing_date)
  const connectionId = stringValue(metadata?.source_connection_id)
  if (!date || !connectionId) return null
  const counts = recordValue(metadata?.decision_counts)
  const runIds = Array.isArray(metadata?.post_processing_run_ids) ? metadata?.post_processing_run_ids : []
  return {
    connectionId,
    date,
    counts: {
      relevant: numberValue(counts?.relevant),
      maybe: numberValue(counts?.maybe),
      not_relevant: numberValue(counts?.not_relevant),
    },
    runCount: numberValue(metadata?.run_count) || runIds.length,
  }
}

function sourceRecommendationPointer(record: ActivityInboxRecord): SourceRecommendationPointer | null {
  const metadata = recordValue(record.metadata_json)
  const pointerType = stringValue(metadata?.pointer_type)
  const connectionId = stringValue(metadata?.source_connection_id)
  if (pointerType !== 'source_recommendation' || !connectionId) return null
  return { connectionId, connectionName: stringValue(metadata?.source_connection_name) }
}

function projectSourceCollectionPointer(record: ActivityInboxRecord): ProjectSourceCollectionPointer | null {
  const metadata = recordValue(record.metadata_json)
  const pointerType = stringValue(metadata?.pointer_type)
  const projectId = stringValue(metadata?.project_id)
  if (pointerType !== 'project_source_collection' || !projectId) return null
  return { projectId, date: stringValue(metadata?.local_date) }
}

export interface ActivityQueueProps {
  /**
   * Pin the queue to one Project. Omitted on the Space Inbox, where the Project
   * filter is a URL param the reader sets and clears; pinned, there is nothing
   * to filter by and no way to widen the scope from inside the queue.
   */
  projectId?: string
}

/**
 * The raw-review queue: filters, records, and the review/archive actions on
 * them. There is exactly one of these per Space, and this is its one
 * implementation — the Space Inbox and a Project's Raw material page are two
 * mountings of it, not two queues. A second implementation would be free to
 * drift on what "reviewed" does, which is the whole content of the pipeline.
 */
export function ActivityQueue({ projectId }: ActivityQueueProps) {
  const { activeSpaceId } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  // Pinned wins over the URL: a Project's page cannot be pointed at another
  // Project's material by editing the address bar.
  const projectFilter = projectId ?? searchParams.get('project_id') ?? ''
  const pinned = projectId !== undefined

  const [records, setRecords]   = useState<ActivityInboxRecord[]>([])
  // Status filter is URL-driven so the Inbox scene sidebar and the header toggles stay in sync.
  const filter = (searchParams.get('status') as StatusFilter | null) ?? 'raw'
  const setFilter = (next: StatusFilter) => setSearchParams(p => { p.set('status', next); return p }, { replace: true })
  const [loading, setLoading]   = useState(false)
  const [busy, setBusy]         = useState<string | null>(null)
  // Project names for the ownership tag below. A record carries `project_id`
  // but no name, and an id is not something a reader can recognise.
  const [projectNames, setProjectNames] = useState<Map<string, string>>(() => new Map())

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setRecords([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const items = await activityApi.list({
        status: filter === 'all' ? undefined : filter,
        project_id: projectFilter || undefined,
      })
      setRecords(items)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [filter, projectFilter, activeSpaceId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // Pinned to one Project, every row carries the same name and none is shown.
    if (!activeSpaceId || pinned) {
      setProjectNames(new Map())
      return
    }
    let cancelled = false
    projectsApi.list({ limit: 200 })
      .then(page => {
        if (!cancelled) setProjectNames(new Map(page.items.map((p: Project) => [p.id, p.name])))
      })
      // Advisory: without names the records still read, they just lose the tag.
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeSpaceId, pinned])

  function filterByProject(id: string) {
    setSearchParams(p => { p.set('project_id', id); return p })
  }

  function clearProjectFilter() {
    setSearchParams(p => { p.delete('project_id'); return p })
  }

  async function doReview(id: string) {
    setBusy(id)
    try {
      await activityApi.review(id)
      toast.success('Marked as reviewed')
      await load()
    } catch (e) { toast.error(errMsg(e)) }
    finally { setBusy(null) }
  }

  async function doArchive(id: string) {
    setBusy(id)
    try {
      await activityApi.archive(id)
      toast.success('Archived')
      await load()
    } catch (e) { toast.error(errMsg(e)) }
    finally { setBusy(null) }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map(s => (
            <Button key={s} size="sm" variant={filter === s ? 'default' : 'ghost'} onClick={() => setFilter(s)}>
              {s === 'proposals_generated' ? 'proposals generated' : s.replace('_', ' ')}
            </Button>
          ))}
        </div>
        {!pinned && projectFilter && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/40 text-xs text-accent-foreground">
            <FolderKanban className="size-3" />
            {projectNames.get(projectFilter) ?? 'Filtered by project'}
            <button onClick={clearProjectFilter} className="ml-0.5 hover:text-foreground" aria-label="Clear project filter">
              <X className="size-3" />
            </button>
          </span>
        )}
      </div>

      {loading && (
        <Card><p className="text-muted-foreground text-center py-10 text-sm">Loading…</p></Card>
      )}

      {!loading && records.length === 0 && (
        !activeSpaceId ? (
          <EmptyState
            title="No space selected"
            description="Select an operational space to browse activity."
          />
        ) : filter === 'raw' ? (
          <EmptyState
            title="No captures yet"
            description={pinned
              ? 'Capture something inside this project, or paste a link, and it lands here first.'
              : 'Capture a thought, paste a link, or save a snippet to get started.'}
            action={pinned ? undefined : (
              <Button variant="outline" asChild>
                <Link to="/capture">Open Capture</Link>
              </Button>
            )}
          />
        ) : (
          <EmptyState
            title={filter === 'all' ? 'No activity yet' : `No ${filter.replace(/_/g, ' ')} activity`}
            description={filter === 'archived'
              ? 'Archived records appear here after you dismiss them.'
              : 'Records with proposals generated appear here.'}
          />
        )
      )}

      {!loading && records.map(r => {
        const briefing = briefingPointer(r)
        const recommendation = sourceRecommendationPointer(r)
        const projectCollection = projectSourceCollectionPointer(r)
        const targetPath = briefing
          ? `/library/digests/${briefing.connectionId}/${briefing.date}`
          : recommendation
            ? `/sources?view=pending&connection_id=${encodeURIComponent(recommendation.connectionId)}`
            : projectCollection
              ? `/projects/${encodeURIComponent(projectCollection.projectId)}/sources${projectCollection.date ? `?date=${encodeURIComponent(projectCollection.date)}` : ''}`
              : `/activity/${r.id}`
        return (
          <Card key={r.id}>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-3">
              <div>
                <span className="font-medium text-sm">
                  <Link to={targetPath} className="text-accent-foreground hover:underline">
                    {r.title ?? r.content.slice(0, 80)}
                  </Link>
                </span>
                {r.title && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{r.content}</p>}
                {briefing && (
                  <div className="flex gap-1.5 flex-wrap mt-2">
                    <Badge variant="default">{briefing.counts.relevant} relevant</Badge>
                    <Badge variant="secondary">{briefing.counts.maybe} maybe</Badge>
                    <Badge variant="muted">{briefing.counts.not_relevant} not relevant</Badge>
                    {briefing.runCount > 1 && <Badge variant="outline">{briefing.runCount} runs</Badge>}
                  </div>
                )}
                {recommendation && (
                  <div className="flex gap-1.5 flex-wrap mt-2">
                    <Badge variant="secondary">source recommendation</Badge>
                    {recommendation.connectionName && <Badge variant="muted">{recommendation.connectionName}</Badge>}
                  </div>
                )}
                {projectCollection && (
                  <div className="flex gap-1.5 flex-wrap mt-2">
                    <Badge variant="secondary">project sources</Badge>
                    {projectCollection.date && <Badge variant="muted">{projectCollection.date}</Badge>}
                  </div>
                )}
              </div>
              {(r.status === 'raw' || r.status === 'proposals_generated') && (
                <div className="flex flex-wrap gap-1.5 shrink-0">
                  {r.status === 'raw' && (
                    <Button
                      size="sm" variant="secondary"
                      disabled={busy === r.id}
                      onClick={() => doReview(r.id)}
                    >
                      Mark reviewed
                    </Button>
                  )}
                  <Button
                    size="sm" variant="default"
                    disabled={busy === r.id}
                    asChild
                  >
                    <Link to={targetPath}>
                      {briefing && <Newspaper className="size-3.5 mr-1" />}
                      {briefing ? 'Open Digest' : recommendation ? 'Review Source' : projectCollection ? 'Open Sources' : 'Generate proposals'}
                    </Link>
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    disabled={busy === r.id}
                    onClick={() => doArchive(r.id)}
                  >
                    Archive
                  </Button>
                </div>
              )}
            </div>

            <div className="flex gap-1.5 flex-wrap mb-2">
              <Badge variant={SOURCE_COLORS[r.source_type] as 'default' | 'secondary' | 'muted' ?? 'secondary'}>
                {briefing ? 'briefing' : recommendation ? 'source recommendation' : r.source_type.replace('_', ' ')}
              </Badge>
              <Badge variant="outline">{r.status.replace('_', ' ')}</Badge>
              <ScopeBadge visibility={r.visibility} omitShared />
              {/* Which Project owns this. A capture made inside a Project lands
                  in the Space's raw queue by design, and without this tag that
                  reads as the capture having gone somewhere else entirely. */}
              {!pinned && r.project_id && (
                <button
                  type="button"
                  onClick={() => filterByProject(r.project_id!)}
                  title={`Show only this project's activity`}
                  aria-label={`Filter by project ${projectNames.get(r.project_id) ?? r.project_id}`}
                >
                  <Badge variant="secondary" className="cursor-pointer hover:opacity-80">
                    <FolderKanban className="size-3 mr-1" />
                    {projectNames.get(r.project_id) ?? 'project'}
                  </Badge>
                </button>
              )}
              {r.project_folder_id && <Badge variant="muted">ws: {r.project_folder_id.slice(0, 8)}…</Badge>}
              {r.source_run_id && <Badge variant="muted">run: {r.source_run_id.slice(0, 8)}…</Badge>}
            </div>

            <p className="text-xs text-muted-foreground">{fmt(r.created_at)}</p>
          </Card>
        )
      })}
    </div>
  )
}
