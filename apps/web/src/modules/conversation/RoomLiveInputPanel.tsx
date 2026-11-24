import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { RoomLiveInputCandidate, RunLiveInputResult } from '@rainver/protocol'
import { runsApi, type RequestOptions } from '../../api/client'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { mergeAbortSignals } from '../../lib/mergeAbortSignals'

type LiveState = RunLiveInputResult['state']

/** A message an ordinary send added to an active Run, and what the server last said happened to it. */
export interface RoomLiveDelivery {
  message_id: string
  run_id: string
  agent_name: string | null
  state: LiveState
  /** The start of what was sent, so several additions can be told apart. */
  excerpt?: string
}

/** Still owed by the server: delivery to the running turn, or to the parked turn's resume. */
const OWED = new Set<LiveState>(['pending', 'deferred'])
/** The first read follows the send's own first delivery attempt closely; later ones are paced. */
const FIRST_READ_MS = 500
const POLL_MS = 3000
/** Consecutive failed reads after which a status is shown as unreadable and no longer polled. */
const MAX_READ_FAILURES = 3

/**
 * One label per candidate that tells it apart from the others: the Agent and
 * its state, then its start time where that still repeats, then its place in
 * the list where even the time repeats (or is unknown).
 */
function candidateLabels(candidates: readonly RoomLiveInputCandidate[], t: ReturnType<typeof useAppTranslation>['t'], locale: string): string[] {
  const base = candidates.map(candidate => [
    candidate.agent_name ?? t('conversation_ui.surface.live_choice.agent'),
    t(candidate.delivery === 'live' ? 'conversation_ui.surface.live_choice.running' : 'conversation_ui.surface.live_choice.waiting'),
    candidate.delegated ? t('conversation_ui.surface.live_choice.delegated') : null,
  ].filter(Boolean).join(' · '))
  const repeated = (labels: string[], index: number) => labels.filter(label => label === labels[index]).length > 1
  const timed = base.map((label, index) => {
    const started = candidates[index]!.started_at
    return repeated(base, index) && started
      ? `${label} · ${t('conversation_ui.surface.live_choice.started', { time: new Date(started).toLocaleString(locale) })}`
      : label
  })
  return timed.map((label, index) => repeated(timed, index)
    ? `${label} · ${t('conversation_ui.surface.live_choice.ordinal', { n: timed.slice(0, index + 1).filter(other => other === label).length })}`
    : label)
}

/**
 * The Runs this send could go to; the person picks one or sends it as an
 * ordinary message. The draft is kept until one of those happens. `unavailable`
 * says the Run the person chose can no longer take it: nothing was sent, and
 * the remaining Runs (possibly none) are offered again.
 */
export function RoomLiveInputChoice({ candidates, disabled, unavailable = false, onChoose, onOrdinary, onDismiss }: {
  candidates: readonly RoomLiveInputCandidate[]
  disabled: boolean
  unavailable?: boolean
  onChoose: (candidate: RoomLiveInputCandidate) => void
  onOrdinary: () => void
  onDismiss: () => void
}) {
  const { t, locale } = useAppTranslation()
  const labels = candidateLabels(candidates, t, locale)
  const title = !unavailable ? t('conversation_ui.surface.live_choice.title')
    : candidates.length > 0 ? t('conversation_ui.surface.live_choice.unavailable') : t('conversation_ui.surface.live_choice.unavailable_none')
  return (
    <div role="group" aria-label={title}
      className={`space-y-2 rounded border px-3 py-2 text-sm ${unavailable ? 'border-destructive/60' : 'border-border'} bg-muted/30`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-muted-foreground">{title}</p>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1" disabled={disabled}
          aria-label={t('conversation_ui.surface.live_choice.dismiss')} onClick={onDismiss}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {candidates.map((candidate, index) => (
          <Button key={candidate.run_id} type="button" size="sm" variant="outline"
            className="h-auto min-h-7 max-w-full whitespace-normal break-words px-2 py-1 text-left text-xs" disabled={disabled}
            onClick={() => onChoose(candidate)}>
            {labels[index]}
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={disabled} onClick={onOrdinary}>
          {t('conversation_ui.surface.live_choice.ordinary')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Deliveries made from this composer, re-read from the Run until the server
 * records their outcome. An unconfirmed one is never sent again on its own; a
 * definitely undelivered one can be sent as a new message by the person. A
 * status that repeatedly cannot be read stops being polled and can be dismissed;
 * the server's delivery obligation is unaffected by what this view shows.
 */
export function RoomLiveInputStatus({ deliveries, scope, disabled = false, onState, onDismiss, onResend }: {
  deliveries: readonly RoomLiveDelivery[]
  scope: RequestOptions
  /** Another send is in progress or the conversation cannot send now. */
  disabled?: boolean
  onState: (messageId: string, state: LiveState) => void
  onDismiss: (messageId: string) => void
  onResend: (messageId: string) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [resending, setResending] = useState<string | null>(null)
  const resendingRef = useRef(false)
  const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(new Set())
  const failures = useRef(new Map<string, number>())
  const owedKey = deliveries.filter(item => OWED.has(item.state) && !unreadable.has(item.message_id))
    .map(item => `${item.run_id}:${item.message_id}:${item.state}`).join('|')
  const latest = useRef(deliveries)
  latest.current = deliveries
  const unreadableRef = useRef(unreadable)
  unreadableRef.current = unreadable
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  useEffect(() => {
    if (!owedKey) return
    const controller = new AbortController()
    const signal = mergeAbortSignals(controller.signal, scope.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      const lost: string[] = []
      for (const item of latest.current.filter(entry => OWED.has(entry.state) && !unreadableRef.current.has(entry.message_id))) {
        const state = await runsApi.liveInputOutcome(item.run_id, item.message_id, { ...scopeRef.current, signal }).catch(() => null)
        if (signal?.aborted) return
        if (!state) {
          const count = (failures.current.get(item.message_id) ?? 0) + 1
          failures.current.set(item.message_id, count)
          if (count >= MAX_READ_FAILURES) lost.push(item.message_id)
          continue
        }
        failures.current.delete(item.message_id)
        if (state !== item.state) onState(item.message_id, state)
      }
      // Changing the owed set restarts this effect, which schedules the next read itself.
      if (lost.length > 0) { setUnreadable(current => new Set([...current, ...lost])); return }
      if (!signal?.aborted) timer = setTimeout(() => void check(), POLL_MS)
    }
    timer = setTimeout(() => void check(), FIRST_READ_MS)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [owedKey, onState, scope.spaceId, scope.signal])
  const resend = useCallback(async (messageId: string) => {
    if (resendingRef.current) return
    resendingRef.current = true
    setResending(messageId)
    try { await onResend(messageId) } finally { resendingRef.current = false; setResending(null) }
  }, [onResend])
  if (deliveries.length === 0) return null
  return (
    <div className="space-y-1">
      {deliveries.map(item => {
        const agent = item.agent_name ?? t('conversation_ui.surface.live_choice.agent')
        const lost = unreadable.has(item.message_id) && OWED.has(item.state)
        const failed = lost || item.state === 'not_injected' || item.state === 'unconfirmed'
        return (
          <div key={item.message_id} role="status" data-testid={`live-input-${item.message_id}`}
            className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${failed ? 'border-destructive/60' : 'border-dashed border-border'} text-muted-foreground`}>
            <span className="min-w-0 flex-1 break-words">
              {t(lost ? 'conversation_ui.surface.live_status.unreadable' : `conversation_ui.surface.live_status.${item.state}`, { agent })}
              {item.excerpt && <q className="ml-1 text-foreground/80">{item.excerpt}</q>}
            </span>
            {item.state === 'not_injected' && (
              <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={disabled || resending !== null}
                onClick={() => void resend(item.message_id)}>
                {t('conversation_ui.surface.live_choice.ordinary')}
              </Button>
            )}
            {(lost || !OWED.has(item.state)) && (
              <Button type="button" variant="ghost" size="sm" className="h-6 px-1" aria-label={t('conversation_ui.surface.live_choice.dismiss')}
                onClick={() => onDismiss(item.message_id)}>
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
