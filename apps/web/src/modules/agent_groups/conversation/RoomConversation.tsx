import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { roomsApi, runsApi } from '../../../api/client'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { useSpace } from '../../../contexts/SpaceContext'
import { errMsg } from '../../../lib/utils'
import type {
  ChatActionPreview,
  RoomConversation as RoomConversationRecord,
  RoomConversationSummaryResponse,
  RoomDetail,
  RoomMessage,
  Run,
  SpaceMember,
} from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { MarkdownMessage } from '../MarkdownMessage'
import { RoomActionPreviewCard, type RoomActionDecision } from '../RoomActionPreviewCard'
import { RoomMessageComposer, emptyRoomMessageComposerValue } from '../RoomMessageComposer'

/**
 * One conversation, rendered wherever a conversation is read.
 *
 * The full Room page and the Project chat panel both show the same Room
 * conversation. They used to do so with two implementations: the page's,
 * with action cards, run progress and continuation after a decision, and the
 * panel's, a plain list with its own send and poll. Every feature then landed
 * on one side and was missing from the other — the panel had no way to decide
 * a proposal, which is how a person ended up leaving the Project to press a
 * button. The repository's rule is to reuse the existing capability rather
 * than build a second entry with its own authority; this is that capability,
 * and both surfaces render it.
 *
 * It owns what a conversation is: the messages and their paging, each turn's
 * proposals as decidable cards, the Runs a turn started and their live
 * progress, sending, and continuing after a decision. The surface around it —
 * the Room's roster and run settings on the page, the mainline binding and
 * width on the panel — stays with the surface.
 */

export type RoutingMode = 'direct' | 'agent_coordination'
export type RoomBackendSelection = { agent_id: string; runtime_profile_id: string; credential_profile_id: string | null }

type RunProgress = { event_type: string; status: string; summary?: string | null }
type PendingProposalContinuation = {
  proposalId: string
  action: RoomActionDecision
  phase: 'submitting' | 'running' | 'failed'
  runIds: string[]
  error?: string
}

const MESSAGE_PAGE_SIZE = 50

export interface RoomConversationProps {
  roomId: string
  conversationId: string
  /** The Room's roster, for mentions and labels. Fetched when not supplied. */
  detail?: RoomDetail | null
  /** `full` is the Room page; `panel` is the Project chat sidecar. */
  variant: 'full' | 'panel'
  /** Agents beyond the roster, for labelling a reply from one. */
  agents?: Array<{ id: string; name: string; kind?: string; status?: string }>
  humans?: SpaceMember[]
  routingMode?: RoutingMode
  /** Which backend each recipient runs on. Omitted, the server uses the stored binding. */
  backendsFor?: (recipientAgentIds: string[]) => RoomBackendSelection[]
  /** What the person is looking at; a hint the server states in the turn. */
  focusRefs?: Array<{ type: 'task'; id: string }>
  /** The conversation record the server returned with a send or a page — its title may have been generated. */
  onConversationUpdated?: (conversation: RoomConversationRecord) => void
  /** Runs once before an accepted proposal is continued from (the page refreshes the Project overview). */
  onBeforeContinue?: (action: RoomActionDecision) => Promise<void>
  /** Rendered between the transcript and the composer (the page's run settings). */
  runSettings?: ReactNode
  isOwner?: boolean
  emptyHint?: ReactNode
  /**
   * Text to put in the composer once when this conversation opens, so a caller
   * elsewhere can seed a conversation without building a second composer and a
   * second dispatch path beside this one. It is a draft, never a send: the
   * person still chooses recipients and presses the button.
   */
  seedText?: string | null
}

export function RoomConversation({
  roomId,
  conversationId,
  detail: suppliedDetail,
  variant,
  agents = [],
  humans = [],
  routingMode = 'direct',
  backendsFor,
  focusRefs,
  onConversationUpdated,
  onBeforeContinue,
  runSettings,
  isOwner = false,
  emptyHint,
  seedText,
}: RoomConversationProps) {
  const { userId } = useSpace()
  const [detail, setDetail] = useState<RoomDetail | null>(suppliedDetail ?? null)
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(true)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [summary, setSummary] = useState<RoomConversationSummaryResponse | null>(null)
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const runsRef = useRef<Record<string, Run>>({})
  const [runProgress, setRunProgress] = useState<Record<string, RunProgress>>({})
  const [runDeltas, setRunDeltas] = useState<Record<string, string>>({})
  const streamControllers = useRef(new Map<string, AbortController>())
  const requestSequence = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [composer, setComposer] = useState(emptyRoomMessageComposerValue)
  const seededRef = useRef<string | null>(null)
  const [resetToken, setResetToken] = useState(0)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [continuation, setContinuation] = useState<PendingProposalContinuation | null>(null)

  useEffect(() => { runsRef.current = runs }, [runs])
  // Once per conversation, and never over something already typed.
  useEffect(() => {
    if (!seedText || seededRef.current === conversationId) return
    seededRef.current = conversationId
    setComposer(current => (current.text.trim() ? current : { ...current, text: seedText }))
  }, [conversationId, seedText])
  useEffect(() => { if (suppliedDetail !== undefined) setDetail(suppliedDetail) }, [suppliedDetail])
  useEffect(() => {
    if (suppliedDetail !== undefined) return
    let active = true
    roomsApi.get(roomId).then(next => { if (active) setDetail(next) }).catch(() => { /* labels degrade to roles */ })
    return () => { active = false }
  }, [roomId, suppliedDetail])

  const loadMessages = useCallback(async () => {
    const sequence = ++requestSequence.current
    const page = await roomsApi.messages(roomId, conversationId, { limit: MESSAGE_PAGE_SIZE, offset: 0 })
    if (sequence !== requestSequence.current) return
    if (page.conversation) onConversationUpdated?.(page.conversation)
    setMessages(current =>
      current.length > 0 && current.every(message => message.session_id === conversationId)
        ? uniqueMessages([...current, ...page.items])
        : page.items)
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
    if (variant === 'full') {
      void roomsApi.summary(roomId, conversationId)
        .then(next => { if (sequence === requestSequence.current) setSummary(next) })
        .catch(() => { if (sequence === requestSequence.current) setSummary(null) })
    }
    const runIds = uniqueIds(page.items.flatMap(message => metadataRunIds(message.metadata_json)))
    const idsToRefresh = runIds.filter(id => !runsRef.current[id] || !isTerminalRunStatus(runsRef.current[id]!.status))
    const results = await Promise.all(idsToRefresh.map(async id => {
      try { return await runsApi.get(id) } catch { return null }
    }))
    if (sequence !== requestSequence.current) return
    setRuns(current => ({
      ...current,
      ...Object.fromEntries(results.filter((run): run is Run => Boolean(run)).map(run => [run.id, run])),
    }))
    const terminalIds = results.flatMap(run => run && isTerminalRunStatus(run.status) ? [run.id] : [])
    if (terminalIds.length > 0) clearTransientRuns(terminalIds, setRunProgress, setRunDeltas)
  }, [conversationId, onConversationUpdated, roomId, variant])

  const loadOlderMessages = useCallback(async () => {
    if (!hasOlderMessages) return
    const page = await roomsApi.messages(roomId, conversationId, { limit: MESSAGE_PAGE_SIZE, offset: messages.length })
    setMessages(current => uniqueMessages([...page.items, ...current]))
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
  }, [conversationId, hasOlderMessages, messages.length, roomId])

  const watchRuns = useCallback((runIds: string[]) => {
    for (const runId of uniqueIds(runIds)) {
      if (streamControllers.current.has(runId)) continue
      const controller = new AbortController()
      streamControllers.current.set(runId, controller)
      void runsApi.streamEvents(runId, {
        signal: controller.signal,
        onLifecycle: event => {
          setRunProgress(current => ({ ...current, [runId]: event }))
          if (event.event_type === 'run_finalized') {
            streamControllers.current.delete(runId)
            clearTransientRuns([runId], setRunProgress, setRunDeltas)
            void loadMessages()
          }
        },
        onTextDelta: delta => {
          setRunDeltas(current => ({ ...current, [runId]: `${current[runId] ?? ''}${delta}` }))
        },
      }).catch(error => {
        if (!controller.signal.aborted) toast.error(errMsg(error))
      }).finally(() => {
        if (streamControllers.current.get(runId) === controller) streamControllers.current.delete(runId)
      })
    }
  }, [loadMessages])

  // A new conversation starts from nothing and follows its tail.
  useEffect(() => {
    let cancelled = false
    followRef.current = true
    setContinuation(null)
    setMessagesLoading(true)
    setMessages([])
    setSummary(null)
    setHasOlderMessages(false)
    setRuns({})
    setRunProgress({})
    setRunDeltas({})
    loadMessages()
      .catch(error => toast.error(errMsg(error)))
      .finally(() => { if (!cancelled) setMessagesLoading(false) })
    return () => { cancelled = true }
  }, [conversationId, loadMessages, roomId])

  // Poll faster while a Run is live; never while a send is in flight, or a
  // poll issued before the send can land after it and hide the message just
  // written.
  useEffect(() => {
    const activeRunIds = Object.values(runs).filter(run => !isTerminalRunStatus(run.status)).map(run => run.id)
    const timer = window.setInterval(() => {
      if (!sendingRef.current) loadMessages().catch(() => undefined)
    }, activeRunIds.length > 0 ? 2500 : 5000)
    return () => window.clearInterval(timer)
  }, [conversationId, loadMessages, roomId, runs])

  useEffect(() => {
    const controllers = streamControllers.current
    return () => {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
    }
  }, [conversationId])

  useEffect(() => {
    watchRuns(Object.values(runs).filter(run => !isTerminalRunStatus(run.status)).map(run => run.id))
  }, [runs, watchRuns])

  // The continuation status shows until the reply it waits for is visible.
  useEffect(() => {
    if (!continuation?.runIds.length) return
    const visible = messages.some(message =>
      message.role === 'assistant' && metadataRunIds(message.metadata_json).some(runId => continuation.runIds.includes(runId)))
    if (visible) setContinuation(null)
  }, [messages, continuation])

  // Follow the tail unless the person scrolled up to read.
  useEffect(() => {
    const container = scrollRef.current
    if (messagesLoading || !container || !followRef.current || typeof container.scrollTo !== 'function') return
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, messagesLoading, continuation, runDeltas, runProgress])

  const managerAgentId = detail?.agent_members.find(member => member.role === 'manager')?.agent_id
  const roomAgents = detail?.agent_members.map(member => ({
    id: member.agent_id, name: member.agent_name, kind: member.agent_kind, status: member.status,
  })) ?? []
  const labelAgents = [...roomAgents, ...agents.filter(agent => !roomAgents.some(item => item.id === agent.id))]

  const sendMessage = useCallback(async () => {
    const text = composer.text.trim()
    if (!text || sendingRef.current) return
    const segments = composer.routingSegments
      .map(segment => ({ recipient_agent_ids: uniqueIds(segment.recipient_agent_ids), content: segment.content.trim() }))
      .filter(segment => segment.recipient_agent_ids.length > 0 && segment.content)
    const recipientAgentIds = uniqueIds(
      routingMode === 'agent_coordination' || segments.length === 0
        ? managerAgentId ? [managerAgentId] : []
        : segments.flatMap(segment => segment.recipient_agent_ids),
    )
    sendingRef.current = true
    setSending(true)
    followRef.current = true
    try {
      const dispatched = await roomsApi.sendMessage(roomId, conversationId, {
        content: text,
        routing_mode: routingMode,
        ...(variant === 'full' && routingMode === 'direct' && segments.length > 0
          ? { recipient_segments: segments }
          : variant === 'full' ? { recipient_segments: null } : {}),
        backends: backendsFor?.(recipientAgentIds) ?? [],
        ...(focusRefs ? { focus_refs: focusRefs } : {}),
      })
      watchRuns(dispatched.run_ids)
      setMessages(current => uniqueMessages([...current, dispatched.message]))
      if (dispatched.conversation) onConversationUpdated?.(dispatched.conversation)
      setResetToken(value => value + 1)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [backendsFor, composer, conversationId, focusRefs, managerAgentId, onConversationUpdated, roomId, routingMode, variant, watchRuns])

  // A decision made here continues the conversation here.
  const continueAfterDecision = useCallback(async (preview: ChatActionPreview, action: RoomActionDecision) => {
    if (!preview.proposal_id) throw new Error('The proposal is no longer available')
    if (sendingRef.current) throw new Error('Wait for the current reply before continuing')
    sendingRef.current = true
    setSending(true)
    followRef.current = true
    setContinuation({ proposalId: preview.proposal_id, action, phase: 'submitting', runIds: [] })
    try {
      if (action === 'accept') await onBeforeContinue?.(action)
      const dispatched = await roomsApi.continueAfterProposal(roomId, conversationId, {
        proposal_id: preview.proposal_id,
        backends: backendsFor?.(managerAgentId ? [managerAgentId] : []) ?? [],
      })
      setContinuation(current => current && current.proposalId === preview.proposal_id
        ? { ...current, phase: 'running', runIds: dispatched.run_ids }
        : current)
      watchRuns(dispatched.run_ids)
      if (dispatched.conversation) onConversationUpdated?.(dispatched.conversation)
    } catch (error) {
      setContinuation(current => current && current.proposalId === preview.proposal_id
        ? { ...current, phase: 'failed', error: errMsg(error) }
        : current)
      throw error
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [backendsFor, conversationId, managerAgentId, onBeforeContinue, onConversationUpdated, roomId, watchRuns])

  const compact = variant === 'panel'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {variant === 'full' && <RoomSummaryFreshness summary={summary} isOwner={isOwner} />}
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
        className={compact ? 'min-h-0 flex-1 space-y-3 overflow-y-auto p-3' : 'min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4'}
        onScroll={event => {
          const container = event.currentTarget
          followRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 80
        }}
      >
        {messagesLoading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />Loading conversation…
          </div>
        )}
        {hasOlderMessages && (
          <div className="text-center">
            <Button variant="outline" size="sm" onClick={() => void loadOlderMessages()}>Load older</Button>
          </div>
        )}
        {!messagesLoading && messages.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">{emptyHint ?? 'No messages yet.'}</p>
        )}
        {messages.map(message => (
          <RoomMessageView
            key={message.id}
            message={message}
            compact={compact}
            viewerUserId={userId ?? null}
            agents={labelAgents}
            humans={humans}
            runs={runs}
            progress={runProgress}
            deltas={runDeltas}
            onActionDecision={continueAfterDecision}
          />
        ))}
        {continuation && <ProposalContinuationStatus continuation={continuation} progress={runProgress} />}
      </div>
      <div className={compact ? 'space-y-2 border-t border-border p-3' : 'space-y-3 border-t border-border bg-card px-5 py-3'}>
        {runSettings}
        <RoomMessageComposer
          value={composer}
          onChange={setComposer}
          agents={roomAgents}
          members={detail?.agent_members ?? []}
          disabled={sending}
          resetToken={resetToken}
          onSubmit={() => void sendMessage()}
        />
        <div className="flex justify-end">
          <Button size={compact ? 'sm' : 'default'} disabled={sending || !composer.text.trim()} onClick={() => void sendMessage()}>
            {sending ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Send className="mr-1 size-4" />}Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function RoomMessageView({
  message, compact, viewerUserId, agents, humans, runs, progress, deltas, onActionDecision,
}: {
  message: RoomMessage
  compact: boolean
  viewerUserId: string | null
  agents: Array<{ id: string; name: string; kind?: string }>
  humans: SpaceMember[]
  runs: Record<string, Run>
  progress: Record<string, RunProgress>
  deltas: Record<string, string>
  onActionDecision: (preview: ChatActionPreview, action: RoomActionDecision) => Promise<void>
}) {
  const runIds = metadataRunIds(message.metadata_json)
  const mine = message.role === 'user'
  const human = humans.find(member => member.user_id === message.user_id)
  const label = mine
    ? (human?.display_name ?? human?.email ?? (message.user_id === viewerUserId ? 'You' : 'Person'))
    : agents.find(agent => agent.id === message.sender_agent_id)?.name ?? 'Agent'
  const previews = metadataActionPreviews(message.metadata_json)
  return (
    // Who said it has to be readable at a glance in a column of mixed-language
    // text, so the two sides differ in alignment, fill and edge at once.
    <div className={mine ? 'flex justify-end pl-6' : 'flex justify-start pr-6'} data-role={mine ? 'user' : 'agent'}>
      <div className={mine
        ? `${compact ? 'max-w-full' : 'max-w-[82%]'} rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground`
        : `${compact ? 'max-w-full' : 'max-w-[82%]'} rounded-2xl rounded-bl-sm border border-border bg-muted/60 px-3 py-2`}>
        <div className={`mb-1 flex items-center gap-2 text-[11px] font-medium ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
          {!mine && <Bot className="size-3.5" />}
          <span>{label}</span>
          <span>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <MarkdownMessage content={message.content} className={mine ? '[&_a]:text-primary-foreground [&_code]:bg-primary-foreground/15' : ''} />
        {previews.length > 0 && (
          <div className="mt-2 space-y-2" data-testid={`previews-${message.id}`}>
            {previews.map((preview, index) => (
              <RoomActionPreviewCard
                key={`${preview.action_id}:${preview.proposal_id ?? index}`}
                preview={preview}
                onDecision={onActionDecision}
              />
            ))}
          </div>
        )}
        {runIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {runIds.map(runId => (
              <span key={runId} className="inline-flex flex-col items-start gap-1">
                <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 text-xs hover:underline">
                  <RoomRunStatusBadge run={runs[runId]} fallbackStatus={progress[runId]?.status ?? 'queued'} />
                  {roomRunLinkLabel(runs[runId], progress[runId]?.status)}
                </Link>
                {progress[runId] && (
                  <span className="text-[11px] text-muted-foreground">
                    {progress[runId].summary || lifecycleLabel(progress[runId].event_type)}
                  </span>
                )}
                {deltas[runId] && (
                  <span className="max-w-md whitespace-pre-wrap text-xs text-muted-foreground">{deltas[runId]}</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProposalContinuationStatus({ continuation, progress }: {
  continuation: PendingProposalContinuation
  progress: Record<string, RunProgress>
}) {
  const activeProgress = continuation.runIds.reduce<RunProgress | undefined>((latest, runId) => progress[runId] ?? latest, undefined)
  const actionLabel = continuation.action === 'accept' ? '已接受' : '已拒绝'
  const statusText = continuation.phase === 'failed'
    ? `后续处理未能启动：${continuation.error || '未知错误'}`
    : continuation.phase === 'submitting'
      ? `${actionLabel}，正在启动下一步…`
      : activeProgress?.summary || (activeProgress ? lifecycleLabel(activeProgress.event_type) : `${actionLabel}，助手正在处理…`)
  return (
    <div className="flex justify-start" role="status" aria-live="polite">
      <div className={`max-w-[82%] rounded-lg border px-3 py-2 ${continuation.phase === 'failed' ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/30'}`}>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          {continuation.phase === 'failed' ? <Bot className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
          <span>系统状态</span>
        </div>
        <p className="text-sm">{statusText}</p>
      </div>
    </div>
  )
}

function RoomSummaryFreshness({ summary, isOwner }: { summary: RoomConversationSummaryResponse | null; isOwner: boolean }) {
  if (!summary?.state) return null
  const state = summary.state
  const label = state.status === 'waiting_provider'
    ? isOwner ? 'Summary paused — configure an API provider to resume' : 'Summary waiting for the Room owner’s API provider'
    : state.status === 'retry_wait'
      ? `Summary retry scheduled${state.next_attempt_at ? ` for ${new Date(state.next_attempt_at).toLocaleTimeString()}` : ''}`
      : state.status === 'running' || state.status === 'queued'
        ? 'Summary updating…'
        : state.status === 'failed'
          ? 'Summary update stopped after repeated provider failures'
          : summary.summary
            ? `Summary v${summary.summary.version} · covers ${summary.summary.covered_message_count} messages`
            : 'Summary not created yet'
  return (
    <div className="border-b border-border px-5 py-2 text-xs text-muted-foreground" role="status">
      <span>{label}</span>
      {state.status === 'waiting_provider' && isOwner && <Link to="/providers" className="ml-2 underline">Configure provider</Link>}
    </div>
  )
}

function RoomRunStatusBadge({ run, fallbackStatus }: { run?: Run; fallbackStatus: string }) {
  const status = run?.status ?? fallbackStatus
  const authorization = status === 'waiting_for_review' && run?.error_json?.supervisor_review !== true
  const supervisorHold = status === 'waiting_for_review' && run?.error_json?.supervisor_review === true
  const presentation = authorization
    ? { label: 'approval needed', variant: 'warning' as const }
    : supervisorHold
      ? { label: 'decision needed', variant: 'warning' as const }
      : ({
          queued: { label: 'waiting', variant: 'muted' as const },
          running: { label: 'working', variant: 'warning' as const },
          succeeded: { label: 'replied', variant: 'success' as const },
          failed: { label: 'failed', variant: 'destructive' as const },
          degraded: { label: 'replied with warning', variant: 'warning' as const },
          cancelled: { label: 'cancelled', variant: 'muted' as const },
          orphaned: { label: 'interrupted', variant: 'destructive' as const },
          waiting_for_dependency: { label: 'waiting for collaborators', variant: 'warning' as const },
          waiting_for_review: { label: 'input needed', variant: 'warning' as const },
        }[status] ?? { label: status.replace(/_/g, ' '), variant: 'muted' as const })
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>
}

function roomRunLinkLabel(run: Run | undefined, fallbackStatus?: string): string {
  const status = run?.status ?? fallbackStatus
  if (status === 'waiting_for_review') return run?.error_json?.supervisor_review !== true ? 'Review request' : 'Resolve Run'
  return 'Run details'
}

function lifecycleLabel(eventType: string): string { return eventType.replace(/_/g, ' ') }

function isTerminalRunStatus(status: string): boolean {
  return ['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned', 'waiting_for_review'].includes(status)
}

function clearTransientRuns(
  runIds: string[],
  setProgress: React.Dispatch<React.SetStateAction<Record<string, RunProgress>>>,
  setDeltas: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): void {
  const remove = <T,>(current: Record<string, T>): Record<string, T> => {
    const next = { ...current }
    for (const runId of runIds) delete next[runId]
    return next
  }
  setProgress(remove)
  setDeltas(remove)
}

export function uniqueMessages(messages: RoomMessage[]): RoomMessage[] {
  const seen = new Set<string>()
  return messages.filter(message => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

export function metadataRunIds(metadata: Record<string, unknown> | null | undefined): string[] {
  const value = metadata?.run_ids
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string')
  const runId = metadata?.run_id
  return typeof runId === 'string' ? [runId] : []
}

export function metadataActionPreviews(metadata: Record<string, unknown> | null | undefined): ChatActionPreview[] {
  const value = metadata?.action_previews
  return Array.isArray(value) ? value as ChatActionPreview[] : []
}

export function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
