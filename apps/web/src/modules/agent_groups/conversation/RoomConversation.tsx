import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Loader2, Quote, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError, roomsApi, runsApi } from '../../../api/client'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { useSpace } from '../../../contexts/SpaceContext'
import { errMsg } from '../../../lib/utils'
import type {
  ThreadReferencePick,
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
import { ReferenceMessage, messageReference } from './ReferenceMessage'
import { DisclosureDialog } from './DisclosureDialog'
import { PickToolbar } from './PickToolbar'
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
  /**
   * Null for a Room nobody has spoken in. There is no conversation to load and
   * none to create up front: the first message creates it
   * ([ADR 0018](../../../../../.agent/decisions/0018-room-as-visibility-boundary.md)
   * decision 5) and comes back on the send, which is reported through
   * `onConversationUpdated` so the surface can bind to it.
   */
  conversationId: string | null
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
  /**
   * A send refused for want of a usable Agent backend, with the setup targets
   * the server named. Provisioning moved to the first message (ADR 0018
   * decision 4), so this is where a Space with no configured provider or
   * granted CLI credential now finds out — a toast alone would leave the
   * person with an error and no next step.
   */
  onBackendRequired?: (setupTargets: string[]) => void
  /** A send that succeeded, so a surface showing a setup prompt can drop it. */
  onSent?: () => void
  /**
   * The Room's other conversations, so a pick can be attached to one.
   *
   * Picking happens at the source, so the destinations have to be reachable
   * from here. Omitted, only *use in a new thread* is offered.
   */
  siblingConversations?: RoomConversationRecord[]
  /**
   * Hold these picks for a thread that does not exist yet.
   *
   * The page owns that handoff — the picks ride its composer and are written
   * with the message that creates the conversation — so this only hands them
   * over rather than navigating itself.
   */
  onUseInNewThread?: (picks: ThreadReferencePick[]) => void
  /**
   * The held picks were refused for good and have been dropped.
   *
   * The page owns them, so only it can let them go — and it has to, or the
   * next send re-attaches the same doomed reference.
   */
  onReferencesRejected?: () => void
  /** Runs once before an accepted proposal is continued from (the page refreshes the Project overview). */
  onBeforeContinue?: (action: RoomActionDecision) => Promise<void>
  /** Rendered between the transcript and the composer (the page's run settings). */
  runSettings?: ReactNode
  isOwner?: boolean
  emptyHint?: ReactNode
  /**
   * Content picked elsewhere, to be copied in with the first message.
   *
   * Only meaningful when `conversationId` is null: they are written in the
   * same transaction as the message that creates the conversation, so they
   * are the thread's opening and abandoning the composer leaves nothing.
   */
  references?: ThreadReferencePick[]
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
  onBackendRequired,
  onSent,
  siblingConversations,
  onUseInNewThread,
  onReferencesRejected,
  onBeforeContinue,
  runSettings,
  isOwner = false,
  emptyHint,
  references,
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
  const [resetToken, setResetToken] = useState(0)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [continuation, setContinuation] = useState<PendingProposalContinuation | null>(null)
  /** Set when a send was refused for crossing an audience boundary. */
  const [disclosure, setDisclosure] = useState<
    { gainsAccessUserIds: string[]; detail: string; attachTo?: string } | null
  >(null)
  /**
   * Messages picked to be copied elsewhere. Empty means not picking at all —
   * the transcript is for reading, and selection controls appear only once
   * somebody has asked for one.
   */
  const [picked, setPicked] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)
  /**
   * One key per attempt at *this* first message, held across retries.
   *
   * Only the session-less send needs it: it creates the conversation, and it
   * is the send that carries references — so a retry after a lost response
   * would otherwise make a second thread and copy their content into it
   * again. Cleared once a send succeeds, so the next new thread gets its own.
   */
  const firstMessageKey = useRef<string | null>(null)

  useEffect(() => { runsRef.current = runs }, [runs])
  // Held in a ref, never in a dependency list. `loadMessages` reports the
  // conversation it read, and the mount effect below depends on
  // `loadMessages` — so a caller passing an inline arrow would make every
  // report re-run the effect, which re-reads and reports again. That loop was
  // real: the Project chat panel spun on it from first paint.
  const conversationUpdatedRef = useRef(onConversationUpdated)
  useEffect(() => { conversationUpdatedRef.current = onConversationUpdated }, [onConversationUpdated])
  const onSentRef = useRef(onSent)
  useEffect(() => { onSentRef.current = onSent }, [onSent])
  useEffect(() => { if (suppliedDetail !== undefined) setDetail(suppliedDetail) }, [suppliedDetail])
  useEffect(() => {
    if (suppliedDetail !== undefined) return
    let active = true
    roomsApi.get(roomId).then(next => { if (active) setDetail(next) }).catch(() => { /* labels degrade to roles */ })
    return () => { active = false }
  }, [roomId, suppliedDetail])

  const loadMessages = useCallback(async () => {
    // Nothing has been said, so there is nothing to read. Returning rather
    // than guarding each caller keeps the polling and stream effects below
    // unaware that a conversation can be absent.
    if (!conversationId) return
    const sequence = ++requestSequence.current
    const page = await roomsApi.messages(roomId, conversationId, { limit: MESSAGE_PAGE_SIZE, offset: 0 })
    if (sequence !== requestSequence.current) return
    // Only the conversation this instance is reading. A poll issued before the
    // reader switched conversations lands after the switch — this component is
    // keyed by id, so the new instance's sequence guard does not cover the old
    // instance's request, and reporting it would drag the surface back to the
    // conversation the person just left.
    if (page.conversation && page.conversation.id === conversationId) {
      conversationUpdatedRef.current?.(page.conversation)
    }
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
  }, [conversationId, roomId, variant])

  const loadOlderMessages = useCallback(async () => {
    if (!hasOlderMessages || !conversationId) return
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

  const sendMessage = useCallback(async (confirmDisclosure?: string[]) => {
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
      // Only the send that creates a conversation is keyed; an addressed one
      // is already guarded by `claimTurn` on the conversation it names.
      if (conversationId === null && !firstMessageKey.current) {
        firstMessageKey.current = crypto.randomUUID()
      }
      const dispatched = await roomsApi.sendMessage(roomId, conversationId, {
        content: text,
        ...(conversationId === null && references?.length
          ? { references, ...(confirmDisclosure ? { confirm_disclosure: confirmDisclosure } : {}) }
          : {}),
        routing_mode: routingMode,
        ...(variant === 'full' && routingMode === 'direct' && segments.length > 0
          ? { recipient_segments: segments }
          : variant === 'full' ? { recipient_segments: null } : {}),
        backends: backendsFor?.(recipientAgentIds) ?? [],
        ...(focusRefs ? { focus_refs: focusRefs } : {}),
      }, ...(conversationId === null ? [firstMessageKey.current!] as const : [] as const))
      watchRuns(dispatched.run_ids)
      setMessages(current => uniqueMessages([...current, dispatched.message]))
      // Reported when this instance had no conversation — that is the only
      // case the surface must bind to, and reporting otherwise drags a reader
      // who switched conversations mid-send back to the one they left.
      if (dispatched.conversation && (conversationId === null || dispatched.conversation.id === conversationId)) {
        conversationUpdatedRef.current?.(dispatched.conversation)
      }
      firstMessageKey.current = null
      onSentRef.current?.()
      setResetToken(value => value + 1)
    } catch (error) {
      // The one refusal the person can answer. Held rather than reported: the
      // dialog names who would gain access and re-sends with their ids, and
      // the composer keeps what was typed so nothing is lost either way.
      if (error instanceof ApiRequestError && error.code === 'reference_disclosure_confirmation_required') {
        setDisclosure(disclosureRequestFrom(error))
        return
      }
      // A pick the server will never accept — a thread with no summary yet,
      // or a source that has gone. On the codes only: the send 404s for a
      // missing *Room* too, and dropping the pick for that would throw away
      // good content because the destination was wrong. Dropped rather than
      // left for the person to clear: these two codes are unrecoverable, so
      // every further attempt would fail identically, and saying so with the
      // pick already gone is what lets the next send actually go.
      if (error instanceof ApiRequestError
        && (error.code === 'reference_summary_unavailable' || error.code === 'reference_source_unavailable')
        && (references?.length ?? 0) > 0) {
        onReferencesRejected?.()
        toast.error(`${errMsg(error)} — the message was not sent, and what you picked has been dropped. Send again to post it on its own.`)
        return
      }
      if (error instanceof ApiRequestError && error.code === 'conversation_backend_required') {
        const targets = error.payload?.setup_targets
        onBackendRequired?.(Array.isArray(targets)
          ? targets.filter((target): target is string => typeof target === 'string')
          : [])
      }
      toast.error(errMsg(error))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [backendsFor, composer, conversationId, focusRefs, managerAgentId, onBackendRequired, onReferencesRejected, references, roomId, routingMode, variant, watchRuns])

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
      if (!conversationId) throw new Error('This conversation is no longer available')
      const dispatched = await roomsApi.continueAfterProposal(roomId, conversationId, {
        proposal_id: preview.proposal_id,
        backends: backendsFor?.(managerAgentId ? [managerAgentId] : []) ?? [],
      })
      setContinuation(current => current && current.proposalId === preview.proposal_id
        ? { ...current, phase: 'running', runIds: dispatched.run_ids }
        : current)
      watchRuns(dispatched.run_ids)
      if (dispatched.conversation) conversationUpdatedRef.current?.(dispatched.conversation)
    } catch (error) {
      setContinuation(current => current && current.proposalId === preview.proposal_id
        ? { ...current, phase: 'failed', error: errMsg(error) }
        : current)
      throw error
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [backendsFor, conversationId, managerAgentId, onBeforeContinue, roomId, watchRuns])

  /** The pick, in the shape the server takes. Always from *this* conversation. */
  const picksFromSelection = useCallback((): ThreadReferencePick[] => (
    conversationId && picked.length > 0
      ? [{ kind: 'messages', id: conversationId, item_ids: picked }]
      : []
  ), [conversationId, picked])

  const attachPickTo = useCallback(async (sessionId: string, confirmDisclosure?: string[]) => {
    const references = picksFromSelection()
    if (references.length === 0 || pickingRef.current) return
    // A ref, not the state flag: two clicks in one tick both read the old
    // state and both attach. Sends guard this way for the same reason.
    pickingRef.current = true
    setPicking(true)
    try {
      await roomsApi.attachReferences(roomId, sessionId, {
        references,
        ...(confirmDisclosure ? { confirm_disclosure: confirmDisclosure } : {}),
      })
      setPicked([])
      toast.success('Attached')
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'reference_disclosure_confirmation_required') {
        // Held with the destination, because confirming re-sends to that same
        // thread — a dialog that forgot it would attach somewhere else.
        setDisclosure({ ...disclosureRequestFrom(error), attachTo: sessionId })
        return
      }
      toast.error(errMsg(error))
    } finally {
      pickingRef.current = false
      setPicking(false)
    }
  }, [picksFromSelection, roomId])

  /**
   * Whether messages may be picked at all.
   *
   * Needs a conversation — a reference names the one its messages came from,
   * and there is none until the first message — *and* somewhere for a pick to
   * go. Without the second test a surface that supplies neither destination
   * still shows checkboxes and a button that silently does nothing.
   */
  const canPick = Boolean(conversationId) && (
    Boolean(onUseInNewThread) || (siblingConversations?.length ?? 0) > 1
  )

  const compact = variant === 'panel'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {variant === 'full' && <RoomSummaryFreshness summary={summary} isOwner={isOwner} />}
      {picked.length > 0 && (
        <PickToolbar
          count={picked.length}
          busy={picking}
          conversations={siblingConversations ?? []}
          currentConversationId={conversationId}
          onCancel={() => setPicked([])}
          canUseInNewThread={Boolean(onUseInNewThread)}
          onUseInNewThread={() => {
            const picks = picksFromSelection()
            setPicked([])
            onUseInNewThread?.(picks)
          }}
          onAttachTo={sessionId => { void attachPickTo(sessionId) }}
        />
      )}
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
        {messages.map(message => {
          // A reference has no speaker, so it is not rendered as one.
          const reference = messageReference(message.metadata_json)
          if (reference) return (
            <ReferenceMessage
              key={message.id}
              message={message}
              reference={reference}
              humans={humans}
              viewerUserId={userId ?? null}
              projectId={detail?.room.project_id ?? null}
            />
          )
          return (
          <RoomMessageView
            key={message.id}
            message={message}
            picked={picked.includes(message.id)}
            pickable={canPick}
            onPickedChange={next => setPicked(current => next
              ? [...current, message.id]
              : current.filter(id => id !== message.id))}
            compact={compact}
            viewerUserId={userId ?? null}
            agents={labelAgents}
            humans={humans}
            runs={runs}
            progress={runProgress}
            deltas={runDeltas}
            onActionDecision={continueAfterDecision}
          />
          )
        })}
        {continuation && <ProposalContinuationStatus continuation={continuation} progress={runProgress} />}
        <DisclosureDialog
          request={disclosure}
          humans={humans}
          busy={disclosure?.attachTo ? picking : sending}
          onCancel={() => setDisclosure(null)}
          onConfirm={confirmUserIds => {
            const attachTo = disclosure?.attachTo
            setDisclosure(null)
            if (attachTo) void attachPickTo(attachTo, confirmUserIds)
            else void sendMessage(confirmUserIds)
          }}
        />
      </div>
      <div className={compact ? 'space-y-2 border-t border-border p-3' : 'space-y-3 border-t border-border bg-card px-5 py-3'}>
        {/* A draft has to be visible to be a draft; until this, the pick rode
            the composer with nothing naming it and no way to drop it.
            On the same condition the send uses, not merely "there are picks":
            a banner promising content the send would drop is the failure this
            exists to close. */}
        {conversationId === null && (references?.length ?? 0) > 0 && (
          <div className="flex items-center gap-2 rounded border border-dashed border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            <Quote className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {referenceDraftLabel(references!)} will be copied in with this message
            </span>
            {onReferencesRejected && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1"
                aria-label="Do not carry this in"
                onClick={onReferencesRejected}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        )}
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
  message, compact, picked, pickable, onPickedChange,
  viewerUserId, agents, humans, runs, progress, deltas, onActionDecision,
}: {
  message: RoomMessage
  compact: boolean
  /** Selected to be copied elsewhere. */
  picked: boolean
  /**
   * Whether it may be picked at all. False for a conversation that does not
   * exist yet: a reference names the conversation its messages came from, and
   * there is nothing to name until the first message has been sent.
   */
  pickable: boolean
  onPickedChange: (picked: boolean) => void
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
    <div
      className={`group ${mine ? 'flex justify-end pl-6' : 'flex justify-start pr-6'} ${picked ? 'bg-accent/40' : ''}`}
      data-role={mine ? 'user' : 'agent'}
    >
      {pickable && (
        // Shown on hover, or whenever anything is picked, so the transcript
        // reads as a transcript until somebody wants to take something out of
        // it. `mine` bubbles sit on the right, so the control leads there too.
        <label className={`flex shrink-0 items-start pt-2 ${mine ? 'order-last pl-2' : 'pr-2'} ${picked ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'}`}>
          <input
            type="checkbox"
            checked={picked}
            aria-label={`Pick this message`}
            onChange={event => onPickedChange(event.target.checked)}
          />
        </label>
      )}
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

/** What the composer says it is holding. */
function referenceDraftLabel(references: readonly ThreadReferencePick[]): string {
  if (references.length > 1) return `${references.length} picks`
  const only = references[0]!
  const items = only.item_ids?.length ?? 0
  switch (only.kind) {
    case 'thread': return 'A conversation'
    case 'messages': return `${items} ${items === 1 ? 'message' : 'messages'}`
    case 'imported_session': return 'An imported session'
    case 'imported_records': return `${items} imported ${items === 1 ? 'record' : 'records'}`
  }
}

/** What a disclosure refusal said: who would gain access, and why it was refused. */
function disclosureRequestFrom(error: ApiRequestError): { gainsAccessUserIds: string[]; detail: string } {
  const gains = error.payload?.gains_access_user_ids
  return {
    gainsAccessUserIds: Array.isArray(gains) ? gains.filter((id): id is string => typeof id === 'string') : [],
    detail: typeof error.payload?.detail === 'string' ? error.payload.detail : errMsg(error),
  }
}
