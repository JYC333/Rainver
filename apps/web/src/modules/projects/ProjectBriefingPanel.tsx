import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { Briefing, BriefingOverviewResponse } from '@rainver/protocol'
import { informationBriefingsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { useAppTranslation } from '../../i18n'
import { sessionEpoch } from '../../lib/sessionResidue'
import { errMsg } from '../../lib/utils'
import { readerHrefFor } from '../library/readingLinks'
import { BriefingView } from '../library/briefing/BriefingView'

const POLL_MS = 4000
// At most 30 minutes of automatic re-reads per mount (or per manual refresh); then Refresh re-reads on demand.
const MAX_POLLS = 450
const KNOWN_ERRORS = new Set([
  'briefing_output_invalid', 'briefing_access_changed', 'briefing_execution_setup_required', 'briefing_budget_exhausted',
  'briefing_daily_limit', 'briefing_writer_required', 'briefing_cancelled', 'briefing_inputs_changed',
  'briefing_context_widened', 'briefing_version_stale', 'briefing_scope_busy', 'briefing_earlier_day_pending',
])
const HELD_CODES = new Set(['briefing_scope_busy', 'briefing_earlier_day_pending'])
/** Still moving on the server without anyone acting: being generated, or a sealed day held for its turn. */
const recoverable = (b: { status: string; error_code: string | null } | null | undefined) =>
  Boolean(b && (b.status === 'queued' || (b.status === 'blocked' && b.error_code !== null && HELD_CODES.has(b.error_code))))

/**
 * The Project's briefing inside its Sources digest area. Readers read what
 * the server re-authorized for the whole Project; writers may also generate,
 * cancel and switch the daily briefing. Mount it keyed by Space and Project.
 */
export function ProjectBriefingPanel({ spaceId, projectId }: { spaceId: string; projectId: string }) {
  const { t } = useAppTranslation()
  const [overview, setOverview] = useState<BriefingOverviewResponse | null>(null)
  const [selected, setSelected] = useState<Briefing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // Only the newest request of this mount, in this login session, may land.
  const sequence = useRef(0)
  const mounted = useRef(true)
  const epoch = useRef(sessionEpoch())
  const selectedRef = useRef<Briefing | null>(null)
  // Completed re-reads of this mount: the poll re-arms after each one lands, whatever it returned.
  const [reads, setReads] = useState(0)
  const pollsLeft = useRef(MAX_POLLS)
  const begin = () => {
    const token = ++sequence.current
    return () => mounted.current && sequence.current === token && sessionEpoch() === epoch.current
  }

  // Re-reads the overview and, when an earlier version is selected, that version too (the selection stays).
  const load = useCallback(async () => {
    const live = begin()
    try {
      const next = await informationBriefingsApi.project(spaceId, projectId)
      if (!live()) return
      setOverview(next); setError(null)
      const current = selectedRef.current
      if (!current || next.latest?.id === current.id) { selectedRef.current = null; setSelected(null); return }
      const fresh = await informationBriefingsApi.get(spaceId, projectId, current.id)
      if (live() && selectedRef.current?.id === fresh.id) { selectedRef.current = fresh; setSelected(fresh) }
    } catch (caught) {
      if (live()) setError(caught)
    } finally {
      if (live()) setReads(count => count + 1)
    }
  }, [spaceId, projectId])
  const refresh = () => { pollsLeft.current = MAX_POLLS; void load() }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; sequence.current++ }
  }, [load])

  const latest = overview?.latest ?? null
  const shown = selected ?? latest
  // A later "nothing new" check or failure never hides the last real briefing.
  const lastBriefing = overview?.latest_briefing ?? null
  // Something is still moving on the server: a version being generated, or a held day waiting its turn
  // (the latest, the selected one, or any in history). A read never generates; quota or other refusals do not poll.
  const moving = recoverable(latest) || recoverable(selected) || Boolean(overview?.history.some(recoverable))
  const inFlight = Boolean(overview?.history.some(entry => entry.status === 'queued'))
  // Progress: one bounded re-read at a time, re-armed only after the previous one landed.
  useEffect(() => {
    if (!moving || pollsLeft.current <= 0) return
    const timer = window.setTimeout(() => { pollsLeft.current -= 1; void load() }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [moving, reads, load])

  const select = async (briefingId: string) => {
    if (briefingId === latest?.id) { sequence.current++; selectedRef.current = null; setSelected(null); return }
    const live = begin()
    try {
      const next = await informationBriefingsApi.get(spaceId, projectId, briefingId)
      if (live()) { selectedRef.current = next; setSelected(next) }
    } catch (caught) {
      if (live()) toast.error(errMsg(caught))
    }
  }

  const act = async (action: () => Promise<unknown>) => {
    const live = begin()
    setBusy(true)
    try {
      await action()
      if (!live()) return
      selectedRef.current = null
      setSelected(null)
      pollsLeft.current = MAX_POLLS
      await load()
    } catch (caught) {
      if (live()) toast.error(errMsg(caught))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const evidenceHref = (evidence: Briefing['evidence'][number]) =>
    readerHrefFor(evidence.source_item_id, 'project', `/projects/${projectId}/sources?tab=digest`)

  return (
    <Card className="space-y-4 p-4" data-testid="project-briefing">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-base font-semibold">{t('briefing.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('briefing.hint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {overview ? (
            <Button variant="ghost" size="sm" onClick={refresh} aria-label={t('reading.refresh')}><RefreshCw className="size-4" />{t('reading.refresh')}</Button>
          ) : null}
        {overview?.can_generate ? (
          <>
            {shown?.status === 'queued' && shown.id === latest?.id ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => informationBriefingsApi.cancel(spaceId, projectId, shown.id))}>{t('briefing.cancel')}</Button>
            ) : null}
            <Button size="sm" disabled={busy || inFlight} onClick={() => act(() => informationBriefingsApi.generate(spaceId, projectId))}>
              <Sparkles className="size-4" />{busy ? t('briefing.generating') : t('briefing.generate')}
            </Button>
          </>
        ) : null}
        </div>
      </div>
      {overview?.can_generate ? (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={overview.daily_enabled}
            disabled={busy}
            onChange={event => { const enabled = event.target.checked; void act(() => informationBriefingsApi.setDaily(spaceId, projectId, enabled)) }}
          />
          <span><span className="font-medium">{t('briefing.daily')}</span> — {overview.daily_enabled ? t('briefing.daily_on') : t('briefing.daily_off')}</span>
        </label>
      ) : overview ? <p className="text-xs text-muted-foreground">{t('briefing.readers_only')}</p> : null}
      {error != null && !overview ? <div role="alert" className="text-sm">{errMsg(error)} <Button variant="ghost" size="sm" onClick={() => void load()}>{t('reading.retry')}</Button></div> : null}
      {!overview && error == null ? <Skeleton className="h-24" /> : null}
      {overview && !shown ? <p className="text-sm text-muted-foreground">{t('briefing.empty')}</p> : null}
      {shown ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t('briefing.version', { version: shown.version })}</span>
            <span>{t(`briefing.kind.${shown.kind}`)}{shown.period_date ? ` · ${shown.period_date}` : ''}</span>
            <time dateTime={shown.cutoff_at}>{new Date(shown.cutoff_at).toLocaleString()}</time>
          </div>
          <BriefingStatus briefing={shown} />
          {shown.checked_at ? <p className="text-xs text-muted-foreground">{t('briefing.checked', { when: new Date(shown.checked_at).toLocaleString() })}</p> : null}
          {shown.status === 'ready' && shown.outcome === 'briefing' ? <BriefingView briefing={shown} evidenceHref={evidenceHref} /> : null}
        </div>
      ) : null}
      {!selected && lastBriefing && lastBriefing.id !== shown?.id ? (
        <section aria-label={t('briefing.last_briefing')} className="space-y-3 border-t border-border pt-3" data-testid="project-briefing-last">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t('briefing.last_briefing')}</span>
            <span>{t('briefing.version', { version: lastBriefing.version })}</span>
            <time dateTime={lastBriefing.cutoff_at}>{new Date(lastBriefing.cutoff_at).toLocaleString()}</time>
          </div>
          <BriefingView briefing={lastBriefing} evidenceHref={evidenceHref} />
        </section>
      ) : null}
      {overview && overview.history.length > 1 ? (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('briefing.history')}</span>
          <select
            className="max-w-full rounded-md border border-border bg-background px-2 py-1"
            value={shown?.id ?? ''}
            onChange={event => void select(event.target.value)}
          >
            {overview.history.map(entry => (
              <option key={entry.id} value={entry.id}>
                {t('briefing.version', { version: entry.version })} · {t(`briefing.kind.${entry.kind}`)}{entry.period_date ? ` ${entry.period_date}` : ''} · {new Date(entry.cutoff_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </Card>
  )
}

function BriefingStatus({ briefing }: { briefing: Briefing }) {
  const { t } = useAppTranslation()
  if (briefing.status === 'queued') {
    return <p role="status" className="text-sm text-muted-foreground">{briefing.run_status ? t('briefing.status.queued_run', { status: briefing.run_status }) : t('briefing.status.queued')}</p>
  }
  if (briefing.status === 'ready') {
    return briefing.outcome === 'briefing' ? null : (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t(`briefing.outcome.${briefing.outcome ?? 'no_material'}`)}</p>
        <BriefingView briefing={briefing} evidenceHref={() => '#'} />
      </div>
    )
  }
  const code = briefing.error_code
  const reason = code && KNOWN_ERRORS.has(code) ? t(`briefing.error.${code}`) : code ? t('briefing.error.other', { code }) : null
  // A held day is waiting its turn, not failed.
  const held = briefing.status === 'blocked' && code !== null && HELD_CODES.has(code)
  return (
    <div role={held ? 'status' : 'alert'} className="space-y-1 text-sm">
      <p>{held ? t('briefing.status.held', { date: briefing.period_date }) : t(`briefing.status.${briefing.status}`)}</p>
      {reason && briefing.status !== 'cancelled' ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
    </div>
  )
}
