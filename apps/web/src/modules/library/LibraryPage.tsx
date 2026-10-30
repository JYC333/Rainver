import {ReadingCard} from './ReadingCard'
import {AgentSearchProvenance} from './AgentSearchProvenance'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BookOpen, CheckCircle2, ExternalLink, Library, RefreshCw, Search, XCircle } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { informationDigestsApi, projectsApi, sourcesApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { registerInMemoryResidue, sessionEpoch } from '../../lib/sessionResidue'
import { errMsg } from '../../lib/utils'
import type { InformationDigestLookup, InterestProfileSnapshot, Project, SourceChannel, SourceItem, SourcePostProcessingBriefingDaySummary } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { SafeExternalLink } from '../../components/SafeExternalLink'
import { safeHttpUrl } from '../../lib/safeHttpUrl'
import { Pagination } from '../../components/ui/pagination'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import {
  fmt,
  type ItemFilter,
} from '../sources/sourcePageModel'
import { InformationDigestView } from './InformationDigestView'
import { AnnotationRecoveryNotice, DigestDayError, DigestDayNav, DigestDayPending, DigestMissing, DigestProvenance } from './DigestDay'
import { useAppTranslation } from '../../i18n'
import { InterestProfileControls } from './InterestProfileControls'
import { formatCalendarDay } from '../../i18n/format'

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
  return formatCalendarDay(date)
}

export default function LibraryPage() {
  const { t } = useAppTranslation()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const location = useLocation()
  if (location.pathname.endsWith('/reading')) return <div className="p-4 md:p-6"><Outlet /></div>

  if (!activeSpaceId) {
    return (
      <div className="p-6">
        <EmptyState title="No space selected" description="Select an operational space to read your source content." />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-wrap items-center gap-4 pb-4 border-b border-border">
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
          <h1 className="text-xl font-semibold tracking-tight">{t(location.pathname.endsWith('/digests') ? 'reading.editions' : 'reading.mine')}</h1>
          <p className="text-xs text-muted-foreground">{activeSpaceName} · {t('monitoring.readingIntro')}</p>
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
  onAction,
}: {
  item: SourceItem
  connectionName: string | null
  busy: string | null
  onAction: (item: SourceItem, action: string) => void
}) {
  const itemBusy = busy?.startsWith(`item:${item.id}`) ?? false
  return (
    <ReadingCard
      title={<Link to={`/library/items/${item.id}`} className="hover:underline">{item.title}</Link>}
      summary={item.excerpt ?? null}
      metadata={<><StatusBadge status={item.library_status}/><span>{item.item_type}</span>{connectionName&&<span>{connectionName}</span>}{item.source_domain&&<span>{item.source_domain}</span>}<AgentSearchProvenance value={item.metadata_json?.result_provenance}/></>}
      details={<><div className="flex flex-wrap gap-1.5"><Badge variant="muted">{item.content_state}</Badge><Badge variant="muted">{item.read_status}</Badge></div><p>Seen {fmt(item.first_seen_at)}{item.author ? ` · ${item.author}` : ''}</p></>}
      actions={<><Button asChild size="sm">
          <Link to={`/library/items/${item.id}`}>
            <BookOpen className="size-3.5" />
            Read
          </Link>
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={itemBusy} onClick={() => onAction(item, 'mark_selected')}>
          <CheckCircle2 className="size-3.5" />
          Select
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={itemBusy} onClick={() => onAction(item, 'mark_ignored')}>
          <XCircle className="size-3.5" />
          Ignore
        </Button>
        {safeHttpUrl(item.source_uri) && (
          <Button type="button" size="sm" variant="ghost" asChild>
            <SafeExternalLink href={item.source_uri}>
              <ExternalLink className="size-3.5" />
              Source
            </SafeExternalLink>
          </Button>
        )}
      </>}
    />
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
  const { t } = useAppTranslation()
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
  // Every keystroke in the search box is a request; only the latest one's
  // answer may become the list.
  const listRequest = useRef(0)

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
    const request = ++listRequest.current
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
      if (request !== listRequest.current) return
      setChannels(channelRows)
      setSourceItems(itemPage.items)
      setItemTotal(itemPage.total)
    } catch (e) {
      if (request !== listRequest.current) return
      toast.error(errMsg(e))
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }, [activeSpaceId, itemFilter, itemQuery, channelFilter, libraryType, itemOffset, selectedConnectionId])

  useEffect(() => { void load(); return () => { listRequest.current++ } }, [load])

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
    try {await sourcesApi.itemAction(item.id,action);await load()}
    catch(e){toast.error(errMsg(e))}finally{setBusy(null)}
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
            {t('reading.refresh')}
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
        <div className="grid gap-3">
          {sourceItems.map(item => (
            <SourceItemCard
              key={item.id}
              item={item}
              connectionName={item.connection_id ? channelByConnectionId.get(item.connection_id)?.name ?? null : null}
              busy={busy}
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
  return <ScopedLibraryDigestsPage key={activeSpaceId} />
}
function ScopedLibraryDigestsPage() {
  const [params, setParams] = useSearchParams()
  const { activeSpaceId } = useSpace()
  const [briefings, setBriefings] = useState<SourcePostProcessingBriefingDaySummary[]>([])
  const [briefingTotal, setBriefingTotal] = useState(0)
  const [briefingOffset, setBriefingOffset] = useState(0)
  // Only the daily edition's read: Refresh, Retry and backfill never wait on the history.
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const { t } = useAppTranslation()
  // The shown day; null asks for the latest complete day of the digest's timezone.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date') : null
  const setDay = (value: string) => { const next = new URLSearchParams(params); next.set('date', value); setParams(next) }
  const [latestDay, setLatestDay] = useState<string | null>(null)
  const [dailyError, setDailyError] = useState<unknown>(null)
  // What is on screen, with the day it answers. It stays while another day is
  // fetched, so the page keeps its frame, but it is that earlier day's until
  // the new one lands: `stale` from the very render the URL changes.
  const [loaded, setLoaded] = useState<{ day: string | null; lookup: InformationDigestLookup } | null>(null)
  // The day and timezone last known, for the day navigation when no content is shown.
  const [frame, setFrame] = useState<{ date: string; timezone: string } | null>(null)
  const daily = loaded?.lookup ?? null
  const stale = loaded !== null && loaded.day !== day
  const shownDay = daily ? (daily.status === 'available' ? daily.digest.digest_date : daily.digest_date) : null
  // The day asked for steers the navigation, so stepping quickly counts from it.
  const navDay = day ?? shownDay ?? frame?.date ?? null
  const [profile, setProfile] = useState<InterestProfileSnapshot | null>(null)
  const [projects, setProjects] = useState<Project[]>([])

  // Fast prev/next fires overlapping loads: only the latest of this login may
  // land, so the day shown is always the day asked for.
  const loadRequest = useRef(0)
  const epoch = useRef(sessionEpoch())
  // Kept content must not outlive the session it was read in.
  useEffect(() => registerInMemoryResidue(() => { setLoaded(null); setFrame(null) }), [])
  const load = useCallback(async () => {
    const request = ++loadRequest.current
    const live = () => request === loadRequest.current && sessionEpoch() === epoch.current
    if (!activeSpaceId) {
      setBriefings([])
      setBriefingTotal(0)
      setProjects([])
      setLoading(false)
      setHistoryLoading(false)
      return
    }
    setLoading(true)
    setHistoryLoading(true)
    setDailyError(null)
    // Each read lands alone: a slow one holds up none of the others, and the
    // daily edition answers on its own. All of them answer to the same guard.
    const land = <T,>(read: Promise<T>, done: (value: T) => void, failed: (error: unknown) => void) =>
      read.then(value => { if (live()) done(value) }).catch(error => { if (live()) failed(error) })
    await Promise.all([
      land(sourcesApi.briefings({ limit: BRIEF_PAGE_SIZE, offset: briefingOffset }), value => {
        setBriefings(value.items)
        setBriefingTotal(value.total)
      }, error => {
        setBriefings([])
        setBriefingTotal(0)
        toast.error(errMsg(error))
      }).finally(() => { if (live()) setHistoryLoading(false) }),
      land(informationDigestsApi.personal(activeSpaceId, day ?? undefined), lookup => {
        const answered = lookup.status === 'available' ? lookup.digest : lookup
        setLoaded({ day, lookup })
        setFrame({ date: answered.digest_date, timezone: answered.timezone })
        if (day === null) setLatestDay(answered.digest_date)
      }, error => {
        // The day could not be read: say so rather than keep showing the
        // previous day under the newly selected one.
        setLoaded(null)
        setDailyError(error)
        toast.error(errMsg(error))
      }).finally(() => { if (live()) setLoading(false) }),
      land(informationDigestsApi.profile(activeSpaceId), setProfile, () => {}),
      land(projectsApi.list({ status: 'active', limit: 200 }), value => setProjects(value.items), () => setProjects([])),
    ])
  }, [activeSpaceId, briefingOffset, day])

  useEffect(() => { void load(); return () => { loadRequest.current++ } }, [load])

  const firstLoad = historyLoading && briefings.length === 0

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            {t('reading.historyHint')}
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading} type="button">
          <RefreshCw className="size-4" />
          {t('reading.refresh')}
        </Button>
      </div>



      <Link className="text-sm underline" to="/library/reading">{t('reading.mine')}</Link>
      {dailyError != null && <DigestDayError date={navDay} error={dailyError} onRetry={load} />}
      {navDay && frame && (
        <DigestDayNav
          date={navDay}
          timezone={frame.timezone}
          canGoForward={latestDay !== null && navDay < latestDay}
          onSelect={setDay}
        />
      )}
      {(stale || (loading && !daily && frame)) && <DigestDayPending date={day} shown={shownDay} />}
      <div inert={stale} aria-busy={stale} className={stale ? 'space-y-6 opacity-50' : 'space-y-6'} data-testid="digest-day-content">
      {daily?.status === 'missing' && (
        <DigestMissing key={daily.digest_date} missing={daily} onBackfill={stale || loading ? undefined : async (date) => {
          if (!activeSpaceId) return
          const request = loadRequest.current
          try {
            const result = await informationDigestsApi.backfillPersonal(activeSpaceId, date)
            if (request !== loadRequest.current || sessionEpoch() !== epoch.current) return
            setLoaded({ day, lookup: { status: 'available', digest: result.digest } })
            toast.success(result.created ? t('digest_reports.backfill_done') : t('digest_reports.backfill_existing'))
          } catch (error) {
            toast.error(errMsg(error))
          }
        }} />
      )}
      {daily?.status === 'available' && <DigestProvenance digest={daily.digest} />}
      {daily?.status === 'available' && <InformationDigestView key={daily.digest.id} reading digest={daily.digest} projects={projects} onFileToProject={async (itemId, sourceItemId, projectId) => {
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
          setLoaded(current => current?.lookup.status === 'available' ? {
            ...current,
            lookup: {
              status: 'available',
              digest: {
                ...current.lookup.digest,
                items: current.lookup.digest.items.map(item => item.id === itemId ? { ...item, serendipity_feedback: result.feedback } : item),
              },
            },
          } : current)
          toast.success(result.blocked ? 'Direction blocked' : 'Feedback saved')
        } catch (error) {
          toast.error(errMsg(error))
        }
      }} />}
      </div>

      <details className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">{t('monitoring.readingPreferences')}</summary><div className="mt-4 space-y-4">
        {activeSpaceId && <AnnotationRecoveryNotice spaceId={activeSpaceId} />}
        {activeSpaceId && profile && <InterestProfileControls spaceId={activeSpaceId} profile={profile} onChanged={load} />}
      </div></details>

      <details className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">{t('monitoring.sourceProcessingHistory')}</summary><div className="mt-4 space-y-3">
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
      </div></details>
    </section>
  )
}
