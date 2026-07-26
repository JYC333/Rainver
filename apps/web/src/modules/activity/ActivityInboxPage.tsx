import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Inbox, FolderKanban, Newspaper, X } from 'lucide-react'
import { toast } from 'sonner'
import { activityApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { ActivityInboxRecord, ActivityStatus, ActivitySourceType } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { ScopeBadge } from '../../components/ScopeBadge'

function fmt(dt: string) { return new Date(dt).toLocaleString() }

type StatusFilter = ActivityStatus | 'all'
const STATUS_FILTERS: StatusFilter[] = ['all', 'raw', 'proposals_generated', 'processed', 'failed', 'archived']

const SOURCE_COLORS: Record<ActivitySourceType, string> = {
  user_capture:    'default',
  chat_message:    'secondary',
  external_chat:   'secondary',
  web_capture:     'secondary',
  file_import:     'secondary',
  run_event:       'muted',
  project_folder_event: 'muted',
  system_event:    'muted',
  external_source: 'secondary',
  source:          'secondary',
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
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function briefingPointer(record: ActivityInboxRecord): BriefingPointer | null {
  if (record.source_type !== 'source') return null
  const metadata = recordValue(record.metadata_json)
  const connectionId = stringValue(metadata?.source_connection_id)
  const date = stringValue(metadata?.briefing_date)
  const countsRecord = recordValue(metadata?.decision_counts)
  if (!connectionId || !date || !countsRecord) return null
  const runIds = Array.isArray(metadata?.post_processing_run_ids)
    ? metadata.post_processing_run_ids.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
  return {
    connectionId,
    date,
    counts: {
      relevant: numberValue(countsRecord.relevant),
      maybe: numberValue(countsRecord.maybe),
      not_relevant: numberValue(countsRecord.not_relevant),
    },
    runCount: numberValue(metadata?.run_count) || runIds.length,
  }
}

function sourceRecommendationPointer(record: ActivityInboxRecord): SourceRecommendationPointer | null {
  if (record.source_type !== 'source') return null
  const metadata = recordValue(record.metadata_json)
  const pointerType = stringValue(metadata?.pointer_type)
  const connectionId = stringValue(metadata?.source_connection_id)
  if (pointerType !== 'source_recommendation' || !connectionId) return null
  return {
    connectionId,
    connectionName: stringValue(metadata?.source_connection_name),
  }
}

function projectSourceCollectionPointer(record: ActivityInboxRecord): ProjectSourceCollectionPointer | null {
  if (record.source_type !== 'source') return null
  const metadata = recordValue(record.metadata_json)
  const pointerType = stringValue(metadata?.pointer_type)
  const projectId = stringValue(metadata?.project_id)
  if (pointerType !== 'project_source_collection' || !projectId) return null
  return {
    projectId,
    date: stringValue(metadata?.local_date),
  }
}

export default function ActivityInboxPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [searchParams, setSearchParams] = useSearchParams()
  const projectFilter = searchParams.get('project_id') ?? ''

  const [records, setRecords]   = useState<ActivityInboxRecord[]>([])
  // Status filter is URL-driven so the Inbox scene sidebar and the header toggles stay in sync.
  const filter = (searchParams.get('status') as StatusFilter | null) ?? 'raw'
  const setFilter = (next: StatusFilter) => setSearchParams(p => { p.set('status', next); return p }, { replace: true })
  const [loading, setLoading]   = useState(false)
  const [busy, setBusy]         = useState<string | null>(null)

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

  function clearProjectFilter() {
    setSearchParams(p => { p.delete('project_id'); return p })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <Inbox className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Activity Inbox</h1>
            <p className="text-sm text-muted-foreground">Saved as activity first. Nothing becomes memory or changes files without review.</p>
            <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
            {projectFilter && (
              <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-accent/40 text-xs text-accent-foreground">
                <FolderKanban className="size-3" />
                Filtered by project
                <button onClick={clearProjectFilter} className="ml-0.5 hover:text-foreground" aria-label="Clear project filter">
                  <X className="size-3" />
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map(s => (
            <Button key={s} size="sm" variant={filter === s ? 'default' : 'ghost'} onClick={() => setFilter(s)}>
              {s === 'proposals_generated' ? 'proposals generated' : s.replace('_', ' ')}
            </Button>
          ))}
        </div>
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
            description="Capture a thought, paste a link, or save a snippet to get started."
            action={
              <Button variant="outline" asChild>
                <Link to="/capture">Open Capture</Link>
              </Button>
            }
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
