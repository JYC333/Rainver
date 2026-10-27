import { formatDateTime } from '../../../i18n/format'
import { readingHref } from '../../library/readingLinks'
import type { ProjectMonitoringState } from '@rainver/protocol'
import { ArrowUpRight, BookOpen, RefreshCw, Sparkles } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { useAppTranslation } from '../../../i18n'
import { SpaceLink } from '../../../core/spaceNav'
import { safeHttpUrl } from '../../../lib/safeHttpUrl'
import { Button } from '../../../components/ui/button'
import { Badge } from '../../../components/ui/badge'
import { Card } from '../../../components/ui/card'
import { projectMonitoringApi } from '../../../api/client'

/** Reading presentation over the existing monitoring state; owns no acquisition or permission logic. */
export function MonitoringReadingView({ state, mode, busy, action, more }: {
  state: ProjectMonitoringState
  mode: 'results' | 'candidates'
  busy: boolean
  action: (fn: () => Promise<unknown>) => Promise<void>
  more: () => Promise<void>
}) {
  const { projectId = '' } = useParams()
  const { t } = useAppTranslation()
  const text = (key: string) => t(`monitoring.${key}`)
  const active = state.active
  const run = state.latest_run
  const items = state.candidates.filter(item => mode === 'candidates' || item.recommended)
  const settingsHref = `/projects/${projectId}/sources?tab=settings`
  if (!active && !state.draft) return (
    <Card className="mx-auto max-w-2xl space-y-4 p-8 md:p-12">
      <Sparkles className="size-8 text-primary" />
      <h2 className="text-xl font-semibold">{text('startFollowing')}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{text('startFollowingDescription')}</p>
      {state.can_write && <Button asChild><SpaceLink to={settingsHref}>{text('chooseDirection')}</SpaceLink></Button>}
    </Card>
  )
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg bg-muted/35 p-4">
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-muted-foreground">{text('following')}</p>
        <p className="font-medium break-words">{(active ?? state.draft)?.config.objective}</p>
        <p className="text-xs text-muted-foreground">{active ? text(state.paused ? 'paused' : active.config.schedule ? 'dailyFollowing' : 'manualOnly') : text('awaitingConfirmation')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {active && state.can_write && <Button size="sm" variant="outline" disabled={busy || state.paused || run?.status === 'active' && !state.can_reconcile} onClick={() => void action(() => state.can_reconcile ? projectMonitoringApi.reconcile(projectId) : projectMonitoringApi.run(projectId, active, active.config.schedule || run ? 'check' : 'initial'))}>
          <RefreshCw className="size-3.5" />{text(state.can_reconcile ? 'recover' : 'checkUpdates')}
        </Button>}
      </div>
    </div>
    {(run?.progress.reason || state.draft) && <div role="status" className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
      {state.draft ? text('awaitingConfirmation') : text(String(run?.progress.reason))}
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-primary" />{text(mode === 'results' ? 'worthReading' : 'allCandidates')}</h2>
      <span className="text-xs text-muted-foreground">{text('latestAvailable')}</span>
    </div>
    {items.length ? <div className="space-y-3">{items.map(item => <Card key={item.id} className="flex min-w-0 flex-col gap-3 p-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.occurred_at && <time>{formatDateTime(item.occurred_at)}</time>}
          {item.change && <Badge variant="outline">{text('pageChanges')}</Badge>}
          {mode === 'candidates' && <Badge variant="outline">{text(item.recommended ? 'recommended' : 'unselected')}</Badge>}
        </div>
        <h3 className="text-sm font-medium leading-snug break-words"><SpaceLink className="hover:underline" to={readingHref({ source_item_id: item.id, reader_origin: 'project' }, projectId, 'candidates')}>{item.title}</SpaceLink></h3>
        {item.summary && <p className="text-sm leading-relaxed text-muted-foreground break-words">{item.summary}</p>}
      </div>
      {item.reason && <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground leading-relaxed break-words"><span className="font-medium">{text('whyRead')} </span>{item.reason}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm">
        <SpaceLink className="inline-flex items-center gap-1 font-medium text-primary" to={readingHref({ source_item_id: item.id, reader_origin: 'project' }, projectId, 'candidates')}><BookOpen className="size-4" />{text('reader')}</SpaceLink>
        {safeHttpUrl(item.source_uri) && <a className="inline-flex items-center gap-1 text-muted-foreground" href={safeHttpUrl(item.source_uri)!} target="_blank" rel="noreferrer">{text('original')}<ArrowUpRight className="size-3.5" /></a>}
        <div className="flex flex-wrap gap-1 sm:ml-auto" aria-label={text('feedback')}>
          {(['read','relevant','not_relevant'] as const).map(feedback=><Button key={feedback} size="sm" variant={(feedback === 'read' ? item.read_status === 'read' : item.feedback === feedback) ? 'secondary' : 'ghost'} disabled={busy} onClick={()=>void action(()=>projectMonitoringApi.feedback(projectId,item.id,feedback))}>{text(feedback)}</Button>)}
        </div>
      </div>
    </Card>)}</div> : <Card className="space-y-2 p-8 text-center"><h3 className="font-medium">{text('nothingRecommended')}</h3><p className="text-sm text-muted-foreground">{text('nothingRecommendedDescription')}</p></Card>}
    {mode === 'candidates' && state.candidates_next_offset != null && <Button variant="outline" disabled={busy} onClick={()=>void more()}>{text('more')}</Button>}
    {run && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">{text('collectionDetails')}</summary><div className="space-y-2 rounded-lg border border-border p-3">
      <p>{text('phase')}: {text(String(run.progress.phase ?? run.status))}</p>
      {!!run.progress.coverage && <p>{text(String(run.progress.coverage))}</p>}
      {!!run.progress.used && <p>{text('used')}: {Object.entries(run.progress.used as Record<string,number>).map(([key,value])=>`${text(key)} ${value}`).join(' · ')}</p>}
    </div></details>}
  </div>
}
