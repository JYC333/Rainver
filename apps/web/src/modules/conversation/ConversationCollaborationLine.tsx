import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { OperationOutput } from '@rainver/protocol'
import { roomsApi, type RequestOptions } from '../../api/client'
import { Button } from '../../components/ui/button'
import { cn, errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'

type Read = OperationOutput<'room.collaboration.get'>
type Collaboration = NonNullable<Read['collaboration']>
/**
 * A stop confirmation belongs to the exact scope and collaboration it was
 * opened on: changing conversation, Space, collaboration or the viewer's
 * management right discards it, so an old intent is never applied to another.
 */
type Pending = { key: string; group_id: string; task_id: string; phase: CollaborationPhase } | null
/**
 * How much the line shows. `normal` (admitting handoffs) and `ended` (the
 * group finished, failed or was stopped) are a small entry whose details open
 * on demand; `paused` and `blocked` (active but admitting no new handoff)
 * state their reason and the available actions without being opened.
 */
type CollaborationPhase = 'normal' | 'paused' | 'blocked' | 'ended'

const ENDED = ['succeeded', 'failed', 'cancelled', 'archived']
const collaborationPhase = (c: Collaboration): CollaborationPhase =>
  ENDED.includes(c.group_status) ? 'ended' : c.group_status === 'paused' ? 'paused' : c.active ? 'normal' : 'blocked'
const statusKey = (c: Collaboration, phase: CollaborationPhase) => phase === 'ended'
  ? (c.group_status === 'succeeded' || c.group_status === 'archived' ? 'ended' : 'stopped')
  : phase === 'paused' ? 'paused' : phase === 'normal' ? 'active' : 'waiting'

const manageableNow = (c: Collaboration, readOnly: boolean) => !readOnly && c.can_manage && ['active', 'paused'].includes(c.group_status)
const pendingApplies = (pending: Pending, key: string, c: Collaboration | null, readOnly: boolean) => Boolean(pending && c
  && pending.key === key && pending.group_id === c.group_id && pending.task_id === c.task_id && pending.phase === collaborationPhase(c) && manageableNow(c, readOnly))

/**
 * The viewer's own task collaboration in this conversation, above the
 * composer (`modules/rooms.md`, "Task collaboration"). While it runs normally
 * or after it ended it is one small entry; opening it shows the Task, counts,
 * next reminder and status, and — while running — the person's pause and
 * stop. A pause or a real admission stop is shown with its reason and the
 * actions that still apply. Threshold reminders stay in the conversation's
 * own notices. A read-only surface shows the state without controls. Nothing
 * here is an Agent permission; every action is rechecked by the server.
 */
export function ConversationCollaborationLine({ roomId, conversationId, scope, changeSignals, readOnly = false }: {
  roomId: string
  conversationId: string | null | undefined
  scope: RequestOptions
  changeSignals: ReadonlyArray<unknown>
  readOnly?: boolean
}) {
  const { t } = useAppTranslation()
  const detailsId = useId()
  const [read, setRead] = useState<{ key: string; value: Read } | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  // Details stay open only for the exact scope, collaboration and phase they were opened on.
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  const sequence = useRef(0)
  const key = `${roomId}\u0000${conversationId ?? ''}\u0000${scope.spaceId ?? ''}`
  const lifetime = useRef<object | null>(null)
  useLayoutEffect(() => {
    lifetime.current = {}
    setBusyKey(null)
    return () => {
      lifetime.current = null
      sequence.current++
    }
  }, [key])

  const load = useCallback(async () => {
    if (!conversationId) return
    const mine = ++sequence.current
    try {
      const value = await roomsApi.collaboration(roomId, conversationId, scope)
      if (mine === sequence.current) setRead({ key, value })
    } catch {
      // A refused or failed read shows nothing rather than a stale collaboration.
      if (mine === sequence.current) setRead(null)
    }
  }, [roomId, conversationId, scope, key])

  const loadRef = useRef(load)
  loadRef.current = load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load, ...changeSignals])

  const current = read?.key === key ? read.value : null
  const live = current && !current.invalid ? current.collaboration : null
  const confirmable = pendingApplies(pending, key, live, readOnly)
  useEffect(() => { if (pending && !confirmable) setPending(null) }, [pending, confirmable])
  const liveDetailsKey = live ? `${key}\u0000${live.group_id}\u0000${live.task_id}\u0000${collaborationPhase(live)}` : null
  // Details left behind by another scope, collaboration or phase are closed, not reopened on return.
  useEffect(() => { if (openedFor && openedFor !== liveDetailsKey) setOpenedFor(null) }, [openedFor, liveDetailsKey])

  if (!current) return null
  if (current.invalid) {
    return <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-testid="conversation-collaboration-line" role="status">
      {t('conversation_ui.collaboration.invalid')}
    </p>
  }
  const c = current.collaboration
  if (!c) return null
  const phase = collaborationPhase(c)
  const status = statusKey(c, phase)
  const detailsKey = liveDetailsKey
  const expanded = openedFor === detailsKey
  const attention = phase === 'paused' || phase === 'blocked'
  const busy = busyKey === key
  // A response arriving after the viewer moved to another scope changes nothing there.
  const act = async (run: () => Promise<unknown>) => {
    const origin = key
    const startedIn = lifetime.current
    const isCurrent = () => startedIn !== null && lifetime.current === startedIn
    setBusyKey(origin)
    try {
      await run()
      if (!isCurrent()) return
      toast.success(t('conversation_ui.collaboration.changed'))
      setPending((open) => open?.key === origin ? null : open)
    } catch (error) {
      if (isCurrent()) toast.error(errMsg(error))
    } finally {
      if (isCurrent()) {
        setBusyKey((held) => held === origin ? null : held)
        await loadRef.current()
      }
    }
  }
  const open = () => setPending({ key, group_id: c.group_id, task_id: c.task_id, phase })
  // Submit only what is still confirmable for the collaboration shown now.
  const confirm = () => {
    if (!pending || !confirmable) { setPending(null); return }
    void setStatus('cancelled')
  }
  const setStatus = (next: 'active' | 'paused' | 'cancelled') => act(() => roomsApi.setCollaborationStatus(c.group_id, next, crypto.randomUUID(), scope))
  // Closing the details withdraws a stop confirmation opened from them.
  const toggle = () => {
    if (expanded) { setOpenedFor(null); if (!attention) setPending(null) } else setOpenedFor(detailsKey)
  }
  const manageable = manageableNow(c, readOnly)
  // Paused and stopped are the status itself; any other stop is named beside it.
  const reason = c.stop_reason && !['paused', 'stopped'].includes(c.stop_reason) ? c.stop_reason : null
  const statusText = <>{t(`conversation_ui.collaboration.status_${status}`)}
    {reason && <> ({t(`conversation_ui.collaboration.reason_${reason}`)})</>}</>
  const actions = manageable && !confirmable && <span className="reading-touch flex flex-wrap gap-1">
    {c.group_status === 'active'
      ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus('paused')}>{t('conversation_ui.collaboration.pause')}</Button>
      : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus('active')}>{t('conversation_ui.collaboration.resume')}</Button>}
    <Button size="sm" variant="ghost" disabled={busy} onClick={open}>{t('conversation_ui.collaboration.stop')}</Button>
  </span>

  return (
    <div className={cn('text-xs text-muted-foreground', (attention || expanded || confirmable) && 'rounded border border-border bg-muted/40 px-2 py-1')}
      data-testid="conversation-collaboration-line" data-phase={phase}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="reading-touch inline-flex min-w-0 max-w-full">
          <Button type="button" size="sm" variant="ghost" className="h-7 min-w-0 max-w-full gap-1 px-1.5 text-xs font-normal text-muted-foreground"
            aria-expanded={expanded} aria-controls={detailsId} onClick={toggle} data-testid="conversation-collaboration-toggle"
            title={t(expanded ? 'conversation_ui.collaboration.hide_details' : 'conversation_ui.collaboration.show_details')}>
            <Users className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium text-foreground">{t('conversation_ui.collaboration.label')}</span>
            {!attention && <span className="truncate" data-testid="conversation-collaboration-status">· {statusText}</span>}
            <ChevronDown className={cn('size-3.5 shrink-0', expanded && 'rotate-180')} aria-hidden="true" />
          </Button>
        </span>
        {attention && <span role="status" className={cn('min-w-0', phase === 'blocked' ? 'text-warning' : 'text-foreground')}
          data-testid="conversation-collaboration-status">{statusText}</span>}
        {attention && actions && <span className="ml-auto">{actions}</span>}
      </div>
      {expanded && <div id={detailsId} className="mt-1 flex flex-col gap-1 border-t border-border pt-1"
        data-testid="conversation-collaboration-details">
        {c.task_title && <span className="min-w-0 max-w-full truncate text-foreground" title={c.task_title}>{c.task_title}</span>}
        <span className="flex flex-wrap gap-x-1.5">
          <span>{t('conversation_ui.collaboration.handoffs', { count: c.delegations_used })}</span>
          <span>· {t('conversation_ui.collaboration.turns', { count: c.turns_used })}</span>
          <span>· {t('conversation_ui.collaboration.next_reminder', { count: c.next_reminder_at })}</span>
        </span>
        {phase === 'normal' && actions && <span className="flex justify-end">{actions}</span>}
      </div>}
      {pending && confirmable && <div className="reading-touch mt-1 flex flex-wrap items-center gap-2 border-t border-border pt-1" role="group">
        <span className="min-w-0 flex-1 text-foreground">{t('conversation_ui.collaboration.stop_confirm')}</span>
        <Button size="sm" variant="destructive" disabled={busy}
          onClick={confirm}>{t('conversation_ui.collaboration.confirm')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>{t('conversation_ui.collaboration.cancel')}</Button>
      </div>}
    </div>
  )
}
