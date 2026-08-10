import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { toast } from 'sonner'
import { BookOpen, CheckCircle2, ExternalLink, FileText, Library, RefreshCw, Search, XCircle } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { informationDigestsApi, projectsApi, sourcesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { ExtractionJob, InformationDigest, InterestProfileSnapshot, Project, SourceChannel, SourceItem, SourcePostProcessingBriefingDaySummary } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { Pagination } from '../../components/ui/pagination'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import {
  fmt,
  preview,
  short,
  textExtractionActionLabel,
  textExtractionDisabledReason,
  type ItemFilter,
} from '../sources/sourcePageModel'
import { runPendingItemJob } from '../sources/sourceActions'
import { InformationDigestView } from './InformationDigestView'
import { InterestProfileControls } from './InterestProfileControls'

const ITEM_PAGE_SIZE = 30
const BRIEF_PAGE_SIZE = 10

type LibraryItemTypeFilter = 'article' | 'email' | 'video' | 'podcast' | 'pdf'

const TYPE_VIEW_COPY: Record<LibraryItemTypeFilter, { title: string; emptyTitle: string; emptyDescription: string }> = {
  article: {
    title: 'Articles',
    emptyTitle: 'No articles',
    emptyDescription: 'Article-like source items appear here when they can be classified from source metadata or URL hints.',
  },
  email: {
    title: 'Emails',
    emptyTitle: 'No emails',
    emptyDescription: 'Email items appear here when a source marks them as mail content.',
  },
  video: {
    title: 'Videos',
    emptyTitle: 'No videos',
    emptyDescription: 'Video items appear here when a source URL or metadata identifies video content.',
  },
  podcast: {
    title: 'Podcasts',
    emptyTitle: 'No podcasts',
    emptyDescription: 'Podcast items appear here when source metadata or URLs identify podcast content.',
  },
  pdf: {
    title: 'PDFs',
    emptyTitle: 'No PDFs',
    emptyDescription: 'PDF items appear here when a source URL or metadata identifies a PDF document.',
  },
}

function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export default function LibraryPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()

  if (!activeSpaceId) {
    return (
      <div className="p-6">
        <EmptyState title="No space selected" description="Select an operational space to read your source content." />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Library className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId}</p>
        </div>
      </div>

      <Outlet />
    </div>
  )
}

function DecisionCounts({ counts }: { counts: SourcePostProcessingBriefingDaySummary['item_decision_counts'] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {counts.relevant > 0 && <Badge variant="success">{counts.relevant} relevant</Badge>}
      {counts.maybe > 0 && <Badge variant="warning">{counts.maybe} maybe</Badge>}
      {counts.not_relevant > 0 && <Badge variant="muted">{counts.not_relevant} not relevant</Badge>}
    </div>
  )
}

function BriefingCard({ item }: { item: SourcePostProcessingBriefingDaySummary }) {
  return (
    <Link to={`/library/digests/${item.source_channel_id}/${item.date}`} className="block">
      <Card className="p-4 space-y-2 hover:bg-accent/40 transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium">{item.connection_name}</div>
            <div className="text-xs text-muted-foreground">{fmtDate(item.date)}</div>
          </div>
          {item.run_count > 1 && <Badge variant="outline">{item.run_count} runs</Badge>}
        </div>
        {item.digest_preview && (
          <p className="text-sm text-muted-foreground line-clamp-2">{item.digest_preview}</p>
        )}
        <DecisionCounts counts={item.item_decision_counts} />
      </Card>
    </Link>
  )
}

function SourceItemCard({
  item,
  connectionName,
  busy,
  extractionStatus,
  onAction,
}: {
  item: SourceItem
  connectionName: string | null
  busy: string | null
  extractionStatus: ExtractionJob['status'] | null
  onAction: (item: SourceItem, action: string) => void
}) {
  const textExtractionReason = textExtractionDisabledReason(item)
  const textExtractionLabel = textExtractionActionLabel(item)
  const itemBusy = busy?.startsWith(`item:${item.id}`) ?? false
  const extractionInProgress = extractionStatus === 'pending' || extractionStatus === 'running'
  const extractionLabel = extractionStatus === 'pending'
    ? 'Queued'
    : extractionStatus === 'running'
      ? 'Extracting…'
      : textExtractionLabel
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to={`/library/items/${item.id}`} className="block text-sm font-medium hover:underline">
            {item.title}
          </Link>
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
            {preview(item.excerpt, item.source_uri ?? 'No source URI')}
          </p>
        </div>
        <StatusBadge status={item.library_status} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">{item.item_type}</Badge>
        <Badge variant="muted">{item.content_state}</Badge>
        {extractionStatus && <StatusBadge status={extractionStatus === 'pending' ? 'queued' : extractionStatus} />}
        <Badge variant="muted">{item.read_status}</Badge>
        {connectionName && <Badge variant="muted">{connectionName}</Badge>}
        {item.source_domain && <Badge variant="muted">{item.source_domain}</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button asChild size="sm">
          <Link to={`/library/items/${item.id}`}>
            <BookOpen className="size-3.5" />
            Read
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`${extractionLabel} ${item.title}`}
          disabled={itemBusy || extractionInProgress || textExtractionReason !== null}
          title={textExtractionReason ?? undefined}
          onClick={() => onAction(item, 'queue_content')}
        >
          {item.content_state === 'content_saved' ? <RefreshCw className="size-3.5" /> : <FileText className="size-3.5" />}
          {extractionLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={itemBusy} onClick={() => onAction(item, 'mark_selected')}>
          <CheckCircle2 className="size-3.5" />
          Select
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={itemBusy} onClick={() => onAction(item, 'mark_ignored')}>
          <XCircle className="size-3.5" />
          Ignore
        </Button>
        {item.source_uri && (
          <Button type="button" size="sm" variant="ghost" asChild>
            <a href={item.source_uri} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              Source
            </a>
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Seen {fmt(item.first_seen_at)}{item.author ? ` · ${item.author}` : ''}{item.connection_id ? ` · source ${short(item.connection_id)}` : ''}
      </p>
    </Card>
  )
}

export function LibraryItemsPage() {
  return <LibraryItemsRoute />
}

export function LibraryArticlesPage() {
  return <LibraryItemsRoute libraryType="article" />
}

export function LibraryEmailsPage() {
  return <LibraryItemsRoute libraryType="email" />
}

export function LibraryVideosPage() {
  return <LibraryItemsRoute libraryType="video" />
}

export function LibraryPodcastsPage() {
  return <LibraryItemsRoute libraryType="podcast" />
}

export function LibraryPdfsPage() {
  return <LibraryItemsRoute libraryType="pdf" />
}

function LibraryItemsRoute({ libraryType }: { libraryType?: LibraryItemTypeFilter }) {
  const { activeSpaceId } = useSpace()
  const [channels, setChannels] = useState<SourceChannel[]>([])
  const [sourceItems, setSourceItems] = useState<SourceItem[]>([])
  const [itemTotal, setItemTotal] = useState(0)
  const [itemOffset, setItemOffset] = useState(0)
  const [itemFilter, setItemFilter] = useState<ItemFilter>('open')
  const [itemQuery, setItemQuery] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [extractionStatuses, setExtractionStatuses] = useState<Record<string, ExtractionJob['status']>>({})

  const channelByConnectionId = useMemo(
    () => new Map(channels.map(channel => [channel.source_connection_id, channel])),
    [channels],
  )

  const channelOptions = useMemo(
    () => [
      { value: '', label: 'All sources' },
      ...channels.map(channel => ({ value: channel.id, label: `${channel.name} · ${channel.provider.display_name ?? channel.provider.key ?? 'Provider'}` })),
    ],
    [channels],
  )

  const selectedConnectionId = useMemo(
    () => channelFilter ? channels.find(channel => channel.id === channelFilter)?.source_connection_id : undefined,
    [channelFilter, channels],
  )

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setChannels([])
      setSourceItems([])
      setItemTotal(0)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const itemStatus = itemFilter
      const [channelRows, itemPage] = await Promise.all([
        sourcesApi.channels(),
        sourcesApi.items({
          library_status: itemStatus,
          connection_id: selectedConnectionId,
          q: itemQuery.trim() || undefined,
          library_type: libraryType,
          limit: ITEM_PAGE_SIZE,
          offset: itemOffset,
        }),
      ])
      setChannels(channelRows)
      setSourceItems(itemPage.items)
      setItemTotal(itemPage.total)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, itemFilter, itemQuery, channelFilter, libraryType, itemOffset, selectedConnectionId])

  useEffect(() => { load() }, [load])

  function changeItemFilter(value: string) {
    setItemFilter(value as ItemFilter)
    setItemOffset(0)
  }

  function changeItemQuery(value: string) {
    setItemQuery(value)
    setItemOffset(0)
  }

  function changeChannelFilter(value: string) {
    setChannelFilter(value)
    setItemOffset(0)
  }

  async function itemAction(item: SourceItem, action: string) {
    setBusy(`item:${item.id}:${action}`)
    if (action === 'queue_content') {
      setExtractionStatuses(current => ({ ...current, [item.id]: 'pending' }))
    }
    try {
      const updatedItem = await sourcesApi.itemAction(item.id, action)
      if (action === 'queue_content') {
        setSourceItems(current => current.map(currentItem => currentItem.id === item.id ? updatedItem : currentItem))
        const result = await runQueuedItemJob(item.id, 'extract_text', 'Text extraction', () => {
          setExtractionStatuses(current => ({ ...current, [item.id]: 'running' }))
        })
        if (result) setExtractionStatuses(current => ({ ...current, [item.id]: result.status }))
      }
      await load()
    } catch (e) {
      if (action === 'queue_content') {
        setExtractionStatuses(current => {
          const { [item.id]: _discarded, ...rest } = current
          return rest
        })
      }
      toast.error(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  async function runQueuedItemJob(itemId: string, jobType: string, label: string, onJobStarted?: () => void) {
    const result = await runPendingItemJob(itemId, jobType, onJobStarted)
    if (!result) {
      toast.success(`${label} queued`)
      return null
    }
    toast.success(`${label} ${result.status}`)
    return result
  }

  const firstLoad = loading && sourceItems.length === 0
  const copy = libraryType ? TYPE_VIEW_COPY[libraryType] : null
  const title = copy?.title ?? 'All Items'
  const emptyTitle = copy?.emptyTitle ?? 'No library items'
  const emptyDescription = copy?.emptyDescription ?? 'New items appear here after a source scans or a URL is saved.'

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{itemTotal} items</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={itemQuery}
              onChange={event => changeItemQuery(event.target.value)}
              placeholder="Search title, excerpt, URI, domain"
              className="h-9 w-full pl-8 sm:w-72"
            />
          </div>
          <Select
            value={channelFilter}
            options={channelOptions}
            onChange={changeChannelFilter}
          />
          <Select
            value={itemFilter}
            onChange={changeItemFilter}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'new', label: 'New' },
              { value: 'triaged', label: 'Triaged' },
              { value: 'selected', label: 'Selected' },
              { value: 'ignored', label: 'Ignored' },
            ]}
          />
          <Button variant="outline" onClick={load} disabled={loading} type="button">
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </div>

      {firstLoad ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : sourceItems.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="space-y-3">
          {sourceItems.map(item => (
            <SourceItemCard
              key={item.id}
              item={item}
              connectionName={item.connection_id ? channelByConnectionId.get(item.connection_id)?.name ?? null : null}
              busy={busy}
              extractionStatus={extractionStatuses[item.id] ?? null}
              onAction={itemAction}
            />
          ))}
        </div>
      )}

      <Pagination total={itemTotal} limit={ITEM_PAGE_SIZE} offset={itemOffset} onChange={setItemOffset} />
    </section>
  )
}

export function LibraryDigestsPage() {
  const { activeSpaceId } = useSpace()
  const [briefings, setBriefings] = useState<SourcePostProcessingBriefingDaySummary[]>([])
  const [briefingTotal, setBriefingTotal] = useState(0)
  const [briefingOffset, setBriefingOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [daily, setDaily] = useState<InformationDigest | null>(null)
  const [profile, setProfile] = useState<InterestProfileSnapshot | null>(null)
  const [projects, setProjects] = useState<Project[]>([])

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setBriefings([])
      setBriefingTotal(0)
      setProjects([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [briefingResult, dailyResult, profileResult, projectResult] = await Promise.allSettled([
        sourcesApi.briefings({ limit: BRIEF_PAGE_SIZE, offset: briefingOffset }),
        informationDigestsApi.personal(activeSpaceId),
        informationDigestsApi.profile(activeSpaceId),
        projectsApi.list({ status: 'active', limit: 200 }),
      ])
      if (briefingResult.status === 'fulfilled') {
        setBriefings(briefingResult.value.items)
        setBriefingTotal(briefingResult.value.total)
      } else {
        throw briefingResult.reason
      }
      if (dailyResult.status === 'fulfilled') setDaily(dailyResult.value)
      if (profileResult.status === 'fulfilled') setProfile(profileResult.value)
      setProjects(projectResult.status === 'fulfilled' ? projectResult.value.items : [])
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, briefingOffset])

  useEffect(() => { load() }, [load])

  const firstLoad = loading && briefings.length === 0

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Today for you</h2>
          <p className="text-xs text-muted-foreground">
            {profile ? `${profile.maturity} profile · ${profile.read_item_count} read items` : 'Cross-source daily selection'}
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading} type="button">
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>

      {daily && <InformationDigestView digest={daily} projects={projects} onFileToProject={async (itemId, sourceItemId, projectId) => {
        try {
          await projectsApi.addCorpusItem(projectId, {
            source_item_id: sourceItemId,
            role: 'candidate',
            triage_status: 'new',
            metadata_json: { origin: 'information_digest', digest_item_id: itemId },
          })
          toast.success('Added to Project Corpus')
        } catch (error) {
          toast.error(errMsg(error))
        }
      }} onSerendipityFeedback={async (itemId, feedback) => {
        if (!activeSpaceId) return
        try {
          const result = await informationDigestsApi.serendipityFeedback(activeSpaceId, itemId, feedback)
          setDaily(current => current ? {
            ...current,
            items: current.items.map(item => item.id === itemId ? { ...item, serendipity_feedback: result.feedback } : item),
          } : current)
          toast.success(result.blocked ? 'Direction blocked' : 'Feedback saved')
        } catch (error) {
          toast.error(errMsg(error))
        }
      }} />}

      {activeSpaceId && profile && <InterestProfileControls spaceId={activeSpaceId} profile={profile} onChanged={load} />}

      <div className="pt-3 border-t space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Source run briefings</h3>
          <p className="text-xs text-muted-foreground">{briefingTotal} digests from individual processing rules</p>
        </div>
      {firstLoad ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : briefings.length === 0 ? (
        <EmptyState
          title="No digests"
          description="Digests appear here after a source post-processing rule finishes a run."
        />
      ) : (
        <div className="space-y-3">
          {briefings.map(item => (
            <BriefingCard key={`${item.source_channel_id}:${item.date}`} item={item} />
          ))}
        </div>
      )}

      <Pagination total={briefingTotal} limit={BRIEF_PAGE_SIZE} offset={briefingOffset} onChange={setBriefingOffset} />
      </div>
    </section>
  )
}
