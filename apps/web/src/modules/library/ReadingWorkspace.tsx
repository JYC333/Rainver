import {ReadingStatusBadge} from './ReadingStatusBadge'
import { toast } from 'sonner'
import { sessionEpoch } from '../../lib/sessionResidue'
import { ReadingItemPreview } from './ReadingItemPreview'
import {ReadingCard} from './ReadingCard'
import {topicTitle} from '../sources/topics/topicTitle'
import {AgentSearchProvenance} from './AgentSearchProvenance'
import {ReadingGoals,useScopeTopics} from './ReadingGoals'
import {Select} from '../../components/ui/select'
import {TopicLinkSummary} from '../sources/topics/TopicLinkSummary'
import {TopicSelectionToggle} from '../sources/topics/TopicSelectionToggle'
import { BookOpen, RefreshCw, Search, Settings2 } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { readingHref, readingHrefReturning } from './readingLinks'
import { ReadingStart } from './ReadingStart'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clearReadingReturn, readingReturnFor, saveReadingReturn, saveReadingSequence, sequenceEntry } from './readingSequence'
import { scrollBehavior } from '../../lib/motion'
import type { ReadingItem } from '@rainver/protocol'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatCalendarDay, formatDateTime } from '../../i18n/format'
import { SpaceLink } from '../../core/spaceNav'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { useReading } from './useReading'
import { ProjectReadingPreference, ReadingPreferences } from './ReadingPreferences'
import { ReadingError } from './ReadingError'
import { PersonalBriefingPanel } from './briefing/PersonalBriefingPanel'

const DENSITY_KEY = 'rainver:reading-density'
function readDensity(): 'comfortable' | 'compact' {
  try { return window.localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable' } catch { return 'comfortable' }
}
/** Rows a return to the list reloads at most to find the item it left from. */
const RETURN_WINDOW_MAX = 150

export default function ReadingWorkspace({ projectId }: { projectId?: string }) {
  const { activeSpaceId } = useSpace()
  const { t } = useAppTranslation()
  if (!activeSpaceId) return <p>{t('reading.chooseSpace')}</p>
  return <ScopedReading key={`${activeSpaceId}:${projectId ?? ''}`} spaceId={activeSpaceId} projectId={projectId} />
}

function ScopedReading({ spaceId, projectId }: { spaceId: string; projectId?: string }) {
  const { t } = useAppTranslation()
  const [params, setParams] = useSearchParams()
  const requested = params.get('view')
  const view = params.get('tab') === 'materials' ? 'all' : requested === 'read' || requested === 'all' ? requested : 'pending'
  const q = params.get('q') ?? ''
  const [draftQuery, setDraftQuery] = useState(q)
  useEffect(() => { setDraftQuery(q) }, [q])
  const topics = useScopeTopics(spaceId, projectId)
  // A topic filter shows its important updates by default; All shows every
  // material that topic actually collected. Both are server queries.
  const topic = params.get('topic') ?? ''
  const topicSelection = params.get('topic_selection') === 'all' ? 'all' : 'important'
  const sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest'
  const feed = useReading(spaceId, projectId, view, q, 30, topic ? { id: topic, selection: topicSelection } : undefined, sort)
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const previewItem = !feed.loading && !feed.error ? feed.page?.items.find(item => item.key === previewKey) ?? null : null
  const [density, setDensity] = useState(readDensity)
  const chooseDensity = (value: 'comfortable' | 'compact') => { setDensity(value); try { window.localStorage.setItem(DENSITY_KEY, value) } catch { /* private mode */ } }
  const listRef = useRef<HTMLDivElement>(null)
  const [returnNotice, setReturnNotice] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const base = projectId ? `/projects/${projectId}/sources` : '/library/reading'
  const changeParams = (name: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value); else next.delete(name)
    if (name === 'view') next.delete('tab')
    if (name === 'topic') next.delete('topic_selection')
    setParams(next, { replace: true })
  }
  // Reader returns to this exact scope, read-state view, topic filter and submitted search.
  const returnQuery = new URLSearchParams()
  if (view !== 'pending') returnQuery.set('view', view)
  if (topic) { returnQuery.set('topic', topic); if (topicSelection === 'all') returnQuery.set('topic_selection', 'all') }
  if (q) returnQuery.set('q', q)
  if (sort !== 'newest') returnQuery.set('sort', sort)
  const returnTo = `${base}${returnQuery.size ? `?${returnQuery}` : ''}`
  const itemHref = (item: Parameters<typeof readingHref>[0]) => returnQuery.size ? readingHrefReturning(item, returnTo) : readingHref(item, projectId)
  const currentView = useRef({ key: returnTo, version: 0, live: true })
  if (currentView.current.key !== returnTo) { currentView.current.key = returnTo; currentView.current.version++ }
  useEffect(() => {
    currentView.current.live = true
    return () => { currentView.current.live = false; currentView.current.version++ }
  }, [])
  const changePersonalState = async (item: ReadingItem, field: 'read_status' | 'dismissed') => {
    const previous = item[field]
    const next = field === 'dismissed' ? !item.dismissed : item.read_status === 'read' || item.read_status === 'discussed' ? 'unread' : 'read'
    const body = item.topic_change ? { topic_change_id: item.topic_change.id } : {}
    const epoch = sessionEpoch()
    const origin = returnTo
    const version = currentView.current.version
    const active = () => currentView.current.live && currentView.current.key === origin && currentView.current.version === version && sessionEpoch() === epoch
    if (!await feed.change(item.source_item_id, { ...body, [field]: next })) return
    if (!active()) return
    let used = false
    const toastId = toast.success(t(field === 'dismissed' ? next ? 'reading.setAside' : 'reading.restoreQueue' : next === 'read' ? 'reading.markedRead' : 'reading.restoredUnread'), { duration: Infinity, closeButton: true, action: {
      label: t('reading.undo'), onClick: async (event) => {
        event?.preventDefault()
        if (used || !active()) return
        used = true
        if (await feed.change(item.source_item_id, { ...body, [field]: previous })) toast.dismiss(toastId)
        else used = false
      },
    } })
  }
  // Opening an item keeps this list (for the Reader's previous/next) and where the person was in it.
  const remember = (item: ReadingItem) => {
    if (!feed.page) return
    saveReadingSequence({ spaceId, projectId: projectId ?? null, returnTo, query: { view, q: q || undefined, topic: topic || undefined, topic_selection: topic ? topicSelection : undefined, sort }, entries: feed.page.items.map(sequenceEntry), next_cursor: feed.page.next_cursor })
    saveReadingReturn({ spaceId, returnTo, key: item.key, loaded: feed.page.items.length })
  }
  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-reading-row]') ?? [])]
  const focusRow = (row: HTMLElement | undefined) => { if (!row) return; row.focus(); row.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() }) }
  // ↑/↓ (or k/j) move between rows, Home/End to the ends, Enter opens; keys inside a row's controls stay theirs.
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const row = target.closest<HTMLElement>('[data-reading-row]')
    if (!row || (row !== target && !['ArrowDown', 'ArrowUp'].includes(event.key))) return
    const all = rows(); const index = all.indexOf(row)
    const move = { ArrowDown: index + 1, j: index + 1, ArrowUp: index - 1, k: index - 1, Home: 0, End: all.length - 1 }[event.key]
    if (move !== undefined) { event.preventDefault(); focusRow(all[Math.max(0, Math.min(all.length - 1, move))]) }
    else if (event.key === 'Enter' && row === target) {
      // The row's own Reader link: the same address and bookkeeping as a click on it.
      const link = row.querySelector<HTMLAnchorElement>('a[data-reader-link]')
      if (link) { event.preventDefault(); link.click() }
    }
  }
  // Back from the Reader: reload as many rows as were open and return to the item, or say it is gone.
  const returnState = useRef(readingReturnFor(spaceId, returnTo))
  const restoring = useRef(false)
  useEffect(() => {
    const state = returnState.current
    if (!state || !feed.page || feed.loading) return
    if (!restoring.current && state.loaded > feed.page.items.length && feed.page.next_cursor) {
      restoring.current = true
      void feed.loadWindow(Math.min(RETURN_WINDOW_MAX, state.loaded))
      return
    }
    returnState.current = null; clearReadingReturn()
    const row = rows().find(element => element.dataset.key === state.key)
    if (row) { row.focus({ preventScroll: true }); row.scrollIntoView?.({ block: 'center' }) } else setReturnNotice(true)
  }, [feed.page, feed.loading])
  return <section className="reading-touch reading-with-preview space-y-6" aria-label={t('reading.list')}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
      <div className="flex min-w-0 items-center gap-4"><div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/35 bg-primary/12"><BookOpen className="size-5 text-accent-foreground" /></div><div className="space-y-1"><h1 className="text-xl font-semibold tracking-tight">{t(projectId ? 'reading.project' : 'reading.mine')}</h1><p className="max-w-2xl text-xs text-muted-foreground">{t(projectId ? 'reading.projectHint' : 'reading.pendingHint')}</p></div></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={feed.loading || feed.busy} onClick={() => void feed.reload()}><RefreshCw className="size-3.5" />{t('reading.refresh')}</Button><Button size="sm" variant="ghost" onClick={() => setPreferencesOpen(v => !v)} aria-expanded={preferencesOpen}><Settings2 className="size-3.5" />{t('reading.preferences')}</Button></div>
    </header>
    {preferencesOpen && <Card className="p-4">{projectId ? <ProjectReadingPreference key={`${spaceId}:${projectId}`} spaceId={spaceId} projectId={projectId} /> : <ReadingPreferences spaceId={spaceId} onChanged={() => void feed.reload()} />}</Card>}
    {!projectId && <PersonalBriefingPanel key={spaceId} spaceId={spaceId} />}
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label={t('reading.views')}><div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
      {(['pending','read','all'] as const).map(option => <Button key={option} size="sm" className={view === option ? 'bg-background text-foreground shadow-sm hover:bg-background' : undefined} variant="ghost" aria-current={view === option ? 'page' : undefined} onClick={() => changeParams('view', option)}>{t(`reading.${option}`)}</Button>)}</div><div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" asChild><SpaceLink to={projectId ? `${base}?tab=digest` : '/library/digests'}>{t('reading.editions')}</SpaceLink></Button>
      <ReadingGoals projectId={projectId} topics={topics}/>
      <Button size="sm" variant="ghost" asChild><SpaceLink to={projectId ? `${base}?tab=settings` : '/sources'}>{t('reading.sources')}</SpaceLink></Button>
      <Button size="sm" variant="ghost" asChild><SpaceLink to={projectId ? `/proposals?project_id=${projectId}` : '/proposals'}>{t('reading.review')}</SpaceLink></Button>
    </div></nav>
    {(topics.goals?.length ?? 0) > 0 && <div className="flex flex-wrap items-center gap-3">
      <div className="w-full min-w-0 sm:w-72"><Select ariaLabel={t('topics.filter')} value={topic} onChange={value => changeParams('topic', value)} options={[{ value: '', label: t('topics.allTopics') }, ...(topics.goals ?? []).map(g => ({ value: g.id, label: topicTitle(g).slice(0, 60) || t('topics.untitled') }))]} /></div>
      {topic && <TopicSelectionToggle value={topicSelection} onChange={value => changeParams('topic_selection', value === 'all' ? 'all' : '')} />}
    </div>}
    <p className="text-xs text-muted-foreground">{t(topic ? (topicSelection === 'all' ? 'topics.allHint' : 'topics.importantHint') : view === 'all' ? 'reading.allHint' : 'reading.backlogHint')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-40"><Select ariaLabel={t('reading.sort')} value={sort} onChange={value => changeParams('sort', value === 'oldest' ? 'oldest' : '')} options={[{ value: 'newest', label: t('reading.sortNewest') }, { value: 'oldest', label: t('reading.sortOldest') }]} /></div>
      <div role="group" aria-label={t('reading.density')} className="inline-flex rounded-lg bg-muted p-1">
        {(['comfortable', 'compact'] as const).map(option => <Button key={option} size="sm" variant="ghost" aria-pressed={density === option} className={density === option ? 'bg-background text-foreground shadow-sm hover:bg-background' : undefined} onClick={() => chooseDensity(option)}>{t(`reading.density_${option}`)}</Button>)}
      </div>
    </div>
    <form className="flex gap-2" role="search" onSubmit={event => { event.preventDefault(); changeParams('q', draftQuery.trim()) }}>
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input className="pl-8" aria-label={t('reading.search')} placeholder={t('reading.search')} value={draftQuery} maxLength={500} onChange={event => setDraftQuery(event.target.value)} /></div>
      <Button type="submit" variant="outline">{t('reading.searchSubmit')}</Button>
    </form>
    {feed.error != null && <ReadingError error={feed.error} retry={() => void feed.reload()} />}
    {feed.loading && <div role="status" className="space-y-3"><span className="sr-only">{t('reading.loading')}</span>{!feed.page && <><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></>}</div>}
    {returnNotice && <p role="status" className="rounded-md border border-border bg-card px-3 py-2 text-xs">{t('reading.returnItemGone')} <button type="button" className="underline" onClick={() => setReturnNotice(false)}>{t('reading.dismissNotice')}</button></p>}
    {feed.page && <>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"><p>{t('reading.total', { count: feed.page.total })}</p><p className="hidden md:block">{t('reading.listKeysHint')}</p></div>
      {feed.page.items.length === 0 ? (!q && !topic && view !== 'read' ? <ReadingStart key={`${spaceId}:${projectId ?? ''}:${view}`} spaceId={spaceId} projectId={projectId} view={view} onChanged={() => void feed.refresh()} /> : <EmptyState title={t(topic && !q ? (topicSelection === 'important' ? 'topics.empty.importantNone' : 'topics.empty.none') : q ? 'reading.noMatches' : 'reading.noRead')} description={topic && !q ? undefined : t(q ? 'reading.searchHint' : 'reading.emptyHint')} />) : <div className="reading-preview-layout"><div ref={listRef} role="list" aria-label={t('reading.list')} onKeyDown={onListKey} className={`grid min-w-0 ${density === 'compact' ? 'gap-1.5' : 'gap-3'}`}>{feed.page.items.map((item, index) => <div key={item.key} role="listitem" data-reading-row data-key={item.key}
        tabIndex={index === 0 ? 0 : -1} aria-label={item.title} onFocus={() => setPreviewKey(item.key)} data-preview-selected={previewKey === item.key || undefined}
        className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"><ReadingCard compact={density === 'compact'} progress={item.reading_progress}
        title={item.access_level === 'full' ? <SpaceLink data-reader-link className="hover:underline" to={itemHref(item)} onClick={() => remember(item)}>{item.title}</SpaceLink> : item.title}
        summary={item.summary ?? item.contributions.find(reason => reason.summary)?.summary ?? null}
        metadata={<><AgentSearchProvenance value={item.result_provenance}/><ReadingStatusBadge item={item} topic={topic??undefined}/>{item.dismissed && <Badge variant="muted">{t('reading.setAside')}</Badge>}{item.contributions.length === 0 && <Badge variant="outline">{t('reading.materialOnly')}</Badge>}{item.topic_change&&<Badge variant="outline">{t('reading.topicChange')}</Badge>}{item.occurred_at&&<span>{t('reading.published')}: {formatDateTime(item.occurred_at)}</span>}</>}
        topics={<>{item.topics.filter(link => !topic || link.goal_id === topic).map(link => <TopicLinkSummary key={link.goal_id} link={link} showTopic compact />)}</>}
        details={<><ul className="space-y-3">{item.contributions.map(reason => <li key={reason.delivery_id} className="space-y-1 break-words text-sm">
          <p className="font-medium">{reason.project_id ? <SpaceLink className="hover:underline" to={`/projects/${reason.project_id}/sources`}>{reason.project_name}</SpaceLink> : t(reason.section === 'serendipity' ? 'reading.discovery' : 'reading.personalRecommendation')}</p>
          {reason.rationale && <p className="text-muted-foreground">{reason.rationale}</p>}
          <p className="text-xs text-muted-foreground">{reason.digest_date ? <SpaceLink className="underline" to={reason.project_id ? `/projects/${reason.project_id}/sources?tab=digest&date=${reason.digest_date}` : `/library/digests?date=${reason.digest_date}`}>{t('reading.edition')}: {formatCalendarDay(reason.digest_date, {year:'numeric',month:'short',day:'numeric'})} · {reason.timezone}</SpaceLink> : t('reading.initial')} · {t('reading.available')}: {formatDateTime(reason.available_at)}</p>
        </li>)}</ul>
        {item.topics.filter(link => !topic || link.goal_id === topic).map(link => <TopicLinkSummary key={link.goal_id} link={link} />)}
        {item.material_links.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{t('reading.materialLinks')}</summary><ul>{item.material_links.map(link => <li key={`${link.kind}:${link.reference_id}`}><SpaceLink className="underline" to={`/projects/${link.project_id}/sources?view=all`}>{t(`reading.link_${link.kind}`)}</SpaceLink></li>)}</ul></details>}
        </>}
        actions={<><Button size="sm" variant="ghost" className="reading-preview-trigger" onClick={() => setPreviewKey(item.key)} aria-label={t('reading.previewItem', { title: item.title })}>{t('reading.itemPreview')}</Button>
          {item.access_level === 'full' ? <Button size="sm" variant="outline" asChild><SpaceLink to={itemHref(item)} onClick={() => remember(item)}>{t('reading.open')}</SpaceLink></Button> : <span className="text-xs text-muted-foreground">{t('reading.summaryOnly')}</span>}
          <Button size="sm" variant="ghost" disabled={feed.busy || feed.loading} onClick={() => void changePersonalState(item, 'read_status')}>{t(item.read_status === 'read' || item.read_status === 'discussed' ? 'reading.restore' : 'reading.markRead')}</Button>
          <Button size="sm" variant="ghost" disabled={feed.busy || feed.loading} onClick={() => void changePersonalState(item, 'dismissed')}>{t(item.dismissed ? 'reading.restoreQueue' : 'reading.dismiss')}</Button>
        </>}
      /></div>)}</div><ReadingItemPreview item={previewItem} href={previewItem ? itemHref(previewItem) : ''} onOpen={() => { if (previewItem) remember(previewItem) }} /></div>}
      {feed.page.next_cursor && <Button variant="outline" disabled={feed.loading || feed.busy} onClick={() => void feed.more()}>{t('reading.more')}</Button>}
    </>}
  </section>
}

export function ReadingPreview() {
  const { preferredSpaceId } = useSpace()
  return preferredSpaceId ? <ScopedPreview key={preferredSpaceId} spaceId={preferredSpaceId} /> : null
}
function ScopedPreview({ spaceId }: { spaceId: string }) {
  const { t } = useAppTranslation()
  const feed = useReading(spaceId, undefined, 'pending', '', 3)
  return <Card className="space-y-3 p-4"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{t('reading.mine')}</h2><SpaceLink to="/library/reading" className="text-sm underline">{t('reading.openAll')}</SpaceLink></div><p className="text-xs text-muted-foreground">{t('reading.previewHint')}</p>{feed.loading && <p role="status">{t('reading.loading')}</p>}{feed.error != null && <ReadingError error={feed.error} retry={() => void feed.reload()} />}{feed.page?.items.map(item => <div key={item.key}>{item.access_level === 'full' ? <SpaceLink to={readingHref(item)} className="break-words text-sm hover:underline">{item.title}</SpaceLink> : <span className="break-words text-sm">{item.title}</span>}</div>)}{feed.page?.total === 0 && <p className="text-sm text-muted-foreground">{t('reading.noPending')}</p>}</Card>
}
