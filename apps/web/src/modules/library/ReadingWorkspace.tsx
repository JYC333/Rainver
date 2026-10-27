import { BookOpen, RefreshCw, Search, Settings2 } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { readingHref } from './readingLinks'
import { ReadingStart } from './ReadingStart'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  const feed = useReading(spaceId, projectId, view, q)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const base = projectId ? `/projects/${projectId}/sources` : '/library/reading'
  const changeParams = (name: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value); else next.delete(name)
    if (name === 'view') next.delete('tab')
    setParams(next, { replace: true })
  }
  return <section className="space-y-6" aria-label={t('reading.list')}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
      <div className="flex min-w-0 items-center gap-4"><div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/35 bg-primary/12"><BookOpen className="size-5 text-accent-foreground" /></div><div className="space-y-1"><h1 className="text-xl font-semibold tracking-tight">{t(projectId ? 'reading.project' : 'reading.mine')}</h1><p className="max-w-2xl text-xs text-muted-foreground">{t(projectId ? 'reading.projectHint' : 'reading.pendingHint')}</p></div></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={feed.loading || feed.busy} onClick={() => void feed.reload()}><RefreshCw className="size-3.5" />{t('reading.refresh')}</Button><Button size="sm" variant="ghost" onClick={() => setPreferencesOpen(v => !v)} aria-expanded={preferencesOpen}><Settings2 className="size-3.5" />{t('reading.preferences')}</Button></div>
    </header>
    {preferencesOpen && <Card className="p-4">{projectId ? <ProjectReadingPreference key={`${spaceId}:${projectId}`} spaceId={spaceId} projectId={projectId} /> : <ReadingPreferences spaceId={spaceId} onChanged={() => void feed.reload()} />}</Card>}
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label={t('reading.views')}><div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
      {(['pending','read','all'] as const).map(option => <Button key={option} size="sm" className={view === option ? 'bg-background text-foreground shadow-sm hover:bg-background' : undefined} variant="ghost" aria-current={view === option ? 'page' : undefined} onClick={() => changeParams('view', option)}>{t(`reading.${option}`)}</Button>)}</div><div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" asChild><SpaceLink to={projectId ? `${base}?tab=digest` : '/library/digests'}>{t('reading.editions')}</SpaceLink></Button>
      <Button size="sm" variant="ghost" asChild><SpaceLink to={projectId ? `${base}?tab=settings` : '/sources'}>{t('reading.sources')}</SpaceLink></Button>
      <Button size="sm" variant="ghost" asChild><SpaceLink to={projectId ? `/proposals?project_id=${projectId}` : '/proposals'}>{t('reading.review')}</SpaceLink></Button>
    </div></nav>
    <p className="text-xs text-muted-foreground">{t(view === 'all' ? 'reading.allHint' : 'reading.backlogHint')}</p>
    <form className="flex gap-2" role="search" onSubmit={event => { event.preventDefault(); changeParams('q', draftQuery.trim()) }}>
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input className="pl-8" aria-label={t('reading.search')} placeholder={t('reading.search')} value={draftQuery} maxLength={500} onChange={event => setDraftQuery(event.target.value)} /></div>
      <Button type="submit" variant="outline">{t('reading.searchSubmit')}</Button>
    </form>
    {feed.error != null && <ReadingError error={feed.error} retry={() => void feed.reload()} />}
    {feed.loading && <div role="status" className="space-y-3"><span className="sr-only">{t('reading.loading')}</span>{!feed.page && <><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></>}</div>}
    {feed.page && <>
      <p className="text-xs text-muted-foreground">{t('reading.total', { count: feed.page.total })}</p>
      {feed.page.items.length === 0 ? (!q && view !== 'read' ? <ReadingStart key={`${spaceId}:${projectId ?? ''}:${view}`} spaceId={spaceId} projectId={projectId} view={view} onChanged={() => void feed.refresh()} /> : <EmptyState title={t(q ? 'reading.noMatches' : 'reading.noRead')} description={t(q ? 'reading.searchHint' : 'reading.emptyHint')} />) : <div className="min-w-0 space-y-3">{feed.page.items.map(item => <Card key={item.key} className="min-w-0 space-y-3 p-4">
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><Badge variant={item.read_status === 'read' || item.read_status === 'discussed' ? 'success' : 'muted'}>{t(`reading.status_${item.read_status}`)}</Badge>{item.dismissed && <Badge variant="muted">{t('reading.setAside')}</Badge>}{item.contributions.length === 0 && <Badge variant="outline">{t('reading.materialOnly')}</Badge>}</div>
        <h2 className="break-words text-sm font-medium leading-snug">{item.access_level === 'full' ? <SpaceLink className="hover:underline" to={readingHref(item, projectId)}>{item.title}</SpaceLink> : item.title}</h2>
        {item.summary && <p className="break-words text-sm leading-relaxed text-muted-foreground">{item.summary}</p>}
        {item.occurred_at && <p className="text-xs text-muted-foreground">{t('reading.published')}: {formatDateTime(item.occurred_at)}</p>}
        <ul className="space-y-2 border-l-2 border-border pl-3">{item.contributions.map(reason => <li key={reason.delivery_id} className="space-y-1 break-words text-sm">
          <p className="font-medium">{reason.project_id ? <SpaceLink className="hover:underline" to={`/projects/${reason.project_id}/sources`}>{reason.project_name}</SpaceLink> : t(reason.section === 'serendipity' ? 'reading.discovery' : 'reading.personalRecommendation')}</p>
          {reason.rationale && <p className="text-muted-foreground">{reason.rationale}</p>}
          <p className="text-xs text-muted-foreground">{reason.digest_date ? <SpaceLink className="underline" to={reason.project_id ? `/projects/${reason.project_id}/sources?tab=digest&date=${reason.digest_date}` : `/library/digests?date=${reason.digest_date}`}>{t('reading.edition')}: {formatCalendarDay(reason.digest_date, {year:'numeric',month:'short',day:'numeric'})} · {reason.timezone}</SpaceLink> : t('reading.initial')} · {t('reading.available')}: {formatDateTime(reason.available_at)}</p>
        </li>)}</ul>
        {item.material_links.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{t('reading.materialLinks')}</summary><ul>{item.material_links.map(link => <li key={`${link.kind}:${link.reference_id}`}><SpaceLink className="underline" to={`/projects/${link.project_id}/sources?view=all`}>{t(`reading.link_${link.kind}`)}</SpaceLink></li>)}</ul></details>}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {item.access_level === 'full' ? <Button size="sm" variant="outline" asChild><SpaceLink to={readingHref(item, projectId)}>{t('reading.open')}</SpaceLink></Button> : <span className="text-xs text-muted-foreground">{t('reading.summaryOnly')}</span>}
          <Button size="sm" variant="ghost" disabled={feed.busy || feed.loading} onClick={() => void feed.change(item.source_item_id, { read_status: item.read_status === 'read' || item.read_status === 'discussed' ? 'unread' : 'read' })}>{t(item.read_status === 'read' || item.read_status === 'discussed' ? 'reading.restore' : 'reading.markRead')}</Button>
          <Button size="sm" variant="ghost" disabled={feed.busy || feed.loading} onClick={() => void feed.change(item.source_item_id, { dismissed: !item.dismissed })}>{t(item.dismissed ? 'reading.restoreQueue' : 'reading.dismiss')}</Button>
        </div>
      </Card>)}</div>}
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
