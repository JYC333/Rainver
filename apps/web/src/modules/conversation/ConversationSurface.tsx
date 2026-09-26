import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, Loader2, MessagesSquare, Quote, X } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, ApiRequestError, conversationInputApi, roomsApi, runsApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  ThreadReferencePick,
  ChatActionPreview,
  ConversationBackendCatalog,
  OpenRoomDiscussionRequest,
  QueuedRoomMessage,
  RoomConversation as RoomConversationRecord,
  RoomConversationSummaryResponse,
  RoomConversationQuota,
  RoomDetail,
  RoomDiscussion,
  RoomDiscussionDetail,
  RoomMessage,
  RunTurn,
  Run,
  SpaceMember,
} from '../../types/api'
import { Button } from '../../components/ui/button'
import { ReferenceMessage, messageReference } from '../agent_groups/conversation/ReferenceMessage'
import { DisclosureDialog } from '../agent_groups/conversation/DisclosureDialog'
import { PickToolbar } from '../agent_groups/conversation/PickToolbar'
import { ActionPreviewCards, type ActionDecision } from './ActionPreviewCard'
import { MessageResponse } from '../../components/ai-elements/message'
import { AwaitingAnswerMarker, ConversationTurn } from './ConversationTurn'
import { readBackTurnState, settledTurn } from './settledTurn'
import { RoomMessageComposer, emptyRoomMessageComposerValue } from '../agent_groups/RoomMessageComposer'
import {
  ConversationAgentSessionConfigs,
  mergeSessionConfig,
  type SessionConfigSelection,
} from './ConversationSessionConfig'
import { ConversationComposer } from './ConversationComposer'
import type { ConversationInputPart } from '@rainver/protocol'
import { ConversationInputPartsView, type ConversationInputFileSource } from './ConversationInputComposer'
import type { CurrentFileAttachment } from '../projects/ProjectFolderConversationContext'
import { clearConversationDraft, readConversationDraft, writeConversationDraft } from './conversationDraft'
import { ConversationRunControls } from './ConversationRunControls'
import { notifyProjectFolderContentChanged } from '../../core/projectFolderEvents'
import {
  DiscussionGroup,
  DiscussionNoticeCard,
  discussionNoticeOf,
  groupDiscussionMessages,
  referencedDiscussionIds,
} from './DiscussionGroup'
import { OpenDiscussionDialog } from './OpenDiscussionDialog'
import { ConversationQuotaLine } from './ConversationQuotaLine'

/**
 * One conversation, rendered wherever a conversation is read.
 *
 * The full Room page and the Project sidecar both show the same Conversation.
 * They used to do so with two implementations: the page's,
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
export type ConversationBackendSelection = {
  agent_id: string
  runtime_profile_id: string
  session_config?: SessionConfigSelection[]
}

type PendingProposalContinuation = {
  proposalId: string
  action: ActionDecision
  phase: 'submitting' | 'running' | 'failed'
  runIds: string[]
  error?: string
}

const MESSAGE_PAGE_SIZE = 50

function sameCurrentFilePart(part: ConversationInputPart, current: CurrentFileAttachment): boolean {
  if (part.kind === 'file_reference') {
    return part.project_folder_id === current.projectFolderId
      && part.workspace_location_id === current.workspaceLocationId
      && part.relative_path === current.relativePath
  }
  if (part.kind !== 'input_resource') return false
  return part.source_state === 'draft'
    ? part.draft_id === current.draftId
    : part.project_folder_id === current.projectFolderId
      && part.workspace_location_id === current.workspaceLocationId
      && part.relative_path === current.relativePath
}

export interface ConversationSurfaceProps {
  roomId: string
  /** Null while a new Conversation is still awaiting explicit execution setup. */
  conversationId: string | null
  /** The Room's roster, for mentions and labels. Fetched when not supplied. */
  detail?: RoomDetail | null
  /** `full` is the Room page; `panel` is the Project chat sidecar. */
  variant: 'full' | 'panel'
  /** Agents beyond the roster, for labelling a reply from one. */
  agents?: Array<{ id: string; name: string; kind?: string; status?: string }>
  humans?: SpaceMember[]
  routingMode?: RoutingMode
  /** Which backend each recipient runs on before the Conversation is initialized. */
  backendsFor?: (recipientAgentIds: string[]) => ConversationBackendSelection[]
  /** Catalogs already loaded by a containing execution-settings surface. */
  backendCatalogs?: Record<string, ConversationBackendCatalog>
  /** What the person is looking at; a hint the server states in the turn. */
  focusRefs?: Array<{ type: 'task'; id: string }>
  /** The conversation record the server returned with a send or a page — its title may have been generated. */
  onConversationUpdated?: (conversation: RoomConversationRecord) => void
  /** A send refused for want of a usable Agent backend, with the setup targets the server named. */
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
   * after the user explicitly opens that conversation — so this only hands
   * them over rather than navigating itself.
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
  onBeforeContinue?: (action: ActionDecision) => Promise<void>
  /** Rendered between the transcript and the composer (the page's run settings). */
  runSettings?: ReactNode
  /** Persistent execution selection shown immediately above the composer. */
  executionPreflight?: ReactNode
  /** Primary and attached Folder roots authorized by the initialized context. */
  inputFileSources?: ConversationInputFileSource[]
  /** The Files & Code sidecar's one implicit current-file producer. */
  implicitInputResource?: CurrentFileAttachment | null
  /** False while the execution context is missing, blocked, or being configured. */
  executionReady?: boolean
  isOwner?: boolean
  emptyHint?: ReactNode
  /** Content picked elsewhere to attach before the next message in this thread. */
  references?: ThreadReferencePick[]
}

export function ConversationSurface({
  roomId,
  conversationId,
  detail: suppliedDetail,
  variant,
  agents = [],
  humans = [],
  routingMode = 'direct',
  backendsFor,
  backendCatalogs: suppliedBackendCatalogs,
  focusRefs,
  onConversationUpdated,
  onBackendRequired,
  onSent,
  siblingConversations,
  onUseInNewThread,
  onReferencesRejected,
  onBeforeContinue,
  runSettings,
  executionPreflight,
  inputFileSources,
  implicitInputResource = null,
  executionReady = true,
  isOwner = false,
  emptyHint,
  references,
}: ConversationSurfaceProps) {
  const { userId } = useSpace()
  const [detail, setDetail] = useState<RoomDetail | null>(suppliedDetail ?? null)
  const [messages, setMessages] = useState<RoomMessage[]>([])
  // Messages waiting for the conversation's turn, posted by the server at the
  // next turn boundary; the poll replaces this with what still waits.
  const [queued, setQueued] = useState<QueuedRoomMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(true)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [summary, setSummary] = useState<RoomConversationSummaryResponse | null>(null)
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const runsRef = useRef<Record<string, Run>>({})
  // The turn each running Run is producing, so the Agent's work appears as
  // the Agent speaking rather than as a badge under the person's message.
  const [liveTurns, setLiveTurns] = useState<Record<string, RunTurn>>({})
  /** Runs whose turn is in flight or already held, so a render does not re-ask. */
  const fetchedTurns = useRef(new Set<string>())
  const streamControllers = useRef(new Map<string, AbortController>())
  const requestSequence = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [composer, setComposer] = useState(emptyRoomMessageComposerValue)
  const [inputParts, setInputParts] = useState<ConversationInputPart[]>([])
  const previousConversationId = useRef<string | null | undefined>(undefined)
  const [resetToken, setResetToken] = useState(0)
  const [sending, setSending] = useState(false)
  const [loadedBackendCatalogs, setLoadedBackendCatalogs] = useState<Record<string, ConversationBackendCatalog>>({})
  const [sessionConfig, setSessionConfig] = useState<Record<string, SessionConfigSelection[]>>({})
  const sendingRef = useRef(false)
  const [continuation, setContinuation] = useState<PendingProposalContinuation | null>(null)
  /** The conversation's discussions, by id; read when a message names one. */
  const [discussions, setDiscussions] = useState<Record<string, RoomDiscussion>>({})
  const discussionsRef = useRef<Record<string, RoomDiscussion>>({})
  const [discussionDialogOpen, setDiscussionDialogOpen] = useState(false)
  const [discussionSendMode, setDiscussionSendMode] = useState<'join' | 'separate'>('join')
  /**
   * Each discussion's cost lines and quota hold, read when
   * its record changes — once per wave, not on every poll.
   */
  const [discussionDetails, setDiscussionDetails] = useState<Record<string, RoomDiscussionDetail>>({})
  const detailVersions = useRef(new Map<string, string>())
  /** The Space's subscription lines, this conversation's logins, and what is held (`modules/rooms.md`, "Subscription quota gate"). */
  const [quota, setQuota] = useState<RoomConversationQuota | null>(null)
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
  const referencesAttachedRef = useRef(false)
  const draftDestination = `room:${roomId}:${conversationId ?? 'new'}`
  const draftReadyRef = useRef<string | null>(null)

  useEffect(() => {
    const previous = previousConversationId.current
    // Keep a draft typed before explicit execution setup when the new
    // Conversation is opened. All other navigation starts with a clean
    // composer, so text cannot accidentally follow an existing thread.
    if (previous !== undefined && !(previous === null && conversationId !== null)) {
      setComposer(emptyRoomMessageComposerValue())
      setInputParts([])
      setResetToken(value => value + 1)
    }
    previousConversationId.current = conversationId
    setDiscussionSendMode('join')
  }, [conversationId])

  useEffect(() => {
    let cancelled = false
    if (draftReadyRef.current === draftDestination) return () => { cancelled = true }
    draftReadyRef.current = null
    const draft = readConversationDraft(draftDestination)
    if (!draft) {
      draftReadyRef.current = draftDestination
      return
    }
    void (async () => {
      const validated = await Promise.all(draft.input_parts.map(async part => {
        try {
          if (part.kind === 'image') {
            await conversationInputApi.imageBlob(part.media_id)
            return part
          }
          if (conversationId && part.kind === 'file_reference') {
            const result = await conversationInputApi.searchFiles(conversationId, part.relative_path)
            return result.items.some(item => item.project_folder_id === part.project_folder_id
              && item.workspace_location_id === part.workspace_location_id
              && item.relative_path === part.relative_path)
              ? part
              : null
          }
          if (part.kind === 'input_resource') return part
          return part.kind === 'file_reference' && inputFileSources?.some(source => source.projectFolderId === part.project_folder_id
            && (!source.workspaceLocationId || source.workspaceLocationId === part.workspace_location_id))
            ? part
            : null
        } catch {
          return null
        }
      }))
      if (cancelled) return
      setComposer(current => ({ ...current, text: draft.text }))
      setInputParts(validated.filter((part): part is ConversationInputPart => part !== null))
      setResetToken(value => value + 1)
      draftReadyRef.current = draftDestination
    })()
    return () => { cancelled = true }
  }, [conversationId, draftDestination, inputFileSources])

  useEffect(() => {
    if (draftReadyRef.current !== draftDestination) return
    const timer = window.setTimeout(() => writeConversationDraft({
      destination: draftDestination,
      text: composer.text,
      input_parts: inputParts,
    }), 250)
    return () => window.clearTimeout(timer)
  }, [composer.text, draftDestination, inputParts])

  useEffect(() => { runsRef.current = runs }, [runs])
  useEffect(() => { discussionsRef.current = discussions }, [discussions])
  // Held in a ref, never in a dependency list. `loadMessages` reports the
  // conversation it read, and the mount effect below depends on
  // `loadMessages` — so a caller passing an inline arrow would make every
  // report re-run the effect, which re-reads and reports again. That loop was
  // real: the Project chat panel spun on it from first paint.
  const conversationUpdatedRef = useRef(onConversationUpdated)
  useEffect(() => { conversationUpdatedRef.current = onConversationUpdated }, [onConversationUpdated])
  const onSentRef = useRef(onSent)
  useEffect(() => { onSentRef.current = onSent }, [onSent])
  const inputFileSourcesRef = useRef(inputFileSources ?? [])
  useEffect(() => { inputFileSourcesRef.current = inputFileSources ?? [] }, [inputFileSources])
  useEffect(() => { if (suppliedDetail !== undefined) setDetail(suppliedDetail) }, [suppliedDetail])
  useEffect(() => {
    if (suppliedDetail !== undefined) return
    let active = true
    roomsApi.get(roomId).then(next => { if (active) setDetail(next) }).catch(() => { /* labels degrade to roles */ })
    return () => { active = false }
  }, [roomId, suppliedDetail])

  const refreshRuns = useCallback(async (
    runIds: readonly string[],
    isCurrent: () => boolean = () => true,
  ) => {
    const idsToRefresh = uniqueIds([...runIds]).filter(id => {
      const held = runsRef.current[id]
      return !held || !isTerminalRunStatus(held.status) || held.status === 'waiting_for_review'
    })
    if (idsToRefresh.length === 0) return
    const results = await Promise.all(idsToRefresh.map(async id => {
      try { return await runsApi.get(id) } catch { return null }
    }))
    if (!isCurrent()) return
    setRuns(current => ({
      ...current,
      ...Object.fromEntries(results.filter((run): run is Run => Boolean(run)).map(run => [run.id, run])),
    }))
  }, [])

  const refreshDiscussionDetails = useCallback((items: readonly RoomDiscussion[]) => {
    if (!conversationId) return
    for (const item of items) {
      if (detailVersions.current.get(item.id) === item.updated_at) continue
      const version = item.updated_at
      detailVersions.current.set(item.id, version)
      // Only the read for the latest version lands: an older one resolving
      // last would otherwise leave a hold that has already lifted on screen.
      void roomsApi.discussion(roomId, conversationId, item.id)
        .then(next => {
          if (detailVersions.current.get(item.id) !== version) return
          setDiscussionDetails(current => ({ ...current, [item.id]: next }))
          // Later discussion waves are dispatched by hidden internal messages,
          // so their Runs do not appear in the visible transcript until they
          // reply. The detail is the authoritative live wave index: load its
          // Runs now, and the normal Run effect opens their turn streams.
          void refreshRuns(
            next.waves.flatMap(wave => wave.run_ids),
            () => detailVersions.current.get(item.id) === version,
          )
        })
        .catch(() => { if (detailVersions.current.get(item.id) === version) detailVersions.current.delete(item.id) })
    }
  }, [conversationId, refreshRuns, roomId])

  /**
   * Re-read the discussions these messages name, the way Runs are refreshed:
   * only while one is unknown or not yet concluded, so a transcript whose
   * discussions are all closed costs nothing on each poll.
   */
  const refreshDiscussions = useCallback((items: readonly RoomMessage[]) => {
    if (!conversationId) return
    const referenced = referencedDiscussionIds(items)
    // Re-read while one is unknown or running, and whenever a message of it
    // is newer than the record held — a closing reply, a wave after another
    // member added rounds. Otherwise nothing about it has moved.
    const newest = new Map<string, string>()
    for (const message of items) {
      const id = message.discussion_id
      if (id && (newest.get(id) ?? '') < message.created_at) newest.set(id, message.created_at)
    }
    const settled = (id: string) => {
      const held = discussionsRef.current[id]
      if (!held || held.status === 'active') return false
      return (newest.get(id) ?? '') <= held.updated_at
    }
    if (referenced.every(settled)) return
    void roomsApi.discussions(roomId, conversationId)
      .then(list => {
        setDiscussions(current => {
          const next = { ...current }
          // A read that left before a stop or extend landed must not undo it.
          for (const item of list.items) {
            if (item.session_id !== conversationId) continue
            const held = current[item.id]
            if (!held || held.updated_at <= item.updated_at) next[item.id] = item
          }
          return next
        })
        // Only the discussions this transcript shows get their cost lines read.
        refreshDiscussionDetails(list.items.filter(item => item.session_id === conversationId && referenced.includes(item.id)))
      })
      .catch(() => { /* Messages remain visible even when discussion header facts cannot be read. */ })
  }, [conversationId, refreshDiscussionDetails, roomId])

  const loadMessages = useCallback(async (options: { replace?: boolean } = {}) => {
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
      !options.replace && current.length > 0 && current.every(message => message.session_id === conversationId)
        ? mergeMessages(current, page.items)
        : page.items)
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
    setQueued(page.queued ?? [])
    refreshDiscussions(page.items)
    if (variant === 'full') {
      void roomsApi.summary(roomId, conversationId)
        .then(next => { if (sequence === requestSequence.current) setSummary(next) })
        .catch(() => { if (sequence === requestSequence.current) setSummary(null) })
    }
    const runIds = uniqueIds(page.items.flatMap(message => messageRunIds(message)))
    await refreshRuns(runIds, () => sequence === requestSequence.current)
    if (sequence !== requestSequence.current) return
    // Whether a turn still belongs on screen is decided in one place, where
    // it is rendered: it stays until its reply is a message of its own.
    // Dropping it here on the Run's status instead would take it away at an
    // earlier and different moment — a failed Run writes no reply at all, so
    // its turn would simply vanish along with the only account of what went
    // wrong, and a succeeded one would blink out until the next poll brought
    // the message back.
  }, [conversationId, refreshDiscussions, refreshRuns, roomId, variant])

  const loadOlderMessages = useCallback(async () => {
    if (!hasOlderMessages || !conversationId) return
    const page = await roomsApi.messages(roomId, conversationId, { limit: MESSAGE_PAGE_SIZE, offset: messages.length })
    setMessages(current => uniqueMessages([...page.items, ...current]))
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
    refreshDiscussions(page.items)
  }, [conversationId, hasOlderMessages, messages.length, refreshDiscussions, roomId])

  const watchRuns = useCallback((runIds: string[]) => {
    for (const runId of uniqueIds(runIds)) {
      if (streamControllers.current.has(runId)) continue
      const controller = new AbortController()
      streamControllers.current.set(runId, controller)
      void runsApi.streamTurn(runId, {
        signal: controller.signal,
        onTurn: turn => {
          setLiveTurns(current => ({ ...current, [runId]: turn }))
          // A blocked turn is still open — it resumes when somebody decides —
          // so the controller stays. Dropping it here would let the watch
          // effect open a second stream for the same Run on its next run, and
          // each one would drop its own controller again.
          if (turn.state === 'working' || turn.state === 'blocked') return
          streamControllers.current.delete(runId)
          notifyProjectFolderContentChanged(inputFileSourcesRef.current.map(source => source.projectFolderId))
          void loadMessages()
        },
      }).catch(error => {
        if (controller.signal.aborted) return
        toast.error(errMsg(error))
        // A stream that died before the turn settled left a turn on screen
        // saying the Agent is still working. Nothing else would ever correct
        // it — the stream is gone, and the read-once effect skips any run a
        // turn is already held for — so the hold is released and that effect
        // reads the settled turn back once the Run is terminal.
        setLiveTurns(current => {
          const held = current[runId]
          // Only a turn stranded mid-work — which includes one blocked on the
          // workspace, a Run its host has not started yet. A turn blocked on
          // a person is not stale: it is the only thing on screen carrying
          // the link to go and decide, and nothing would read it back,
          // because the read-once effect skips a paused Run by design.
          if (held?.state !== 'working' && !(held?.state === 'blocked' && held.blocked_on === 'workspace')) return current
          const { [runId]: _dropped, ...rest } = current
          return rest
        })
        fetchedTurns.current.delete(runId)
      }).finally(() => {
        if (streamControllers.current.get(runId) === controller) streamControllers.current.delete(runId)
      })
    }
  }, [loadMessages])

  const retryRun = useCallback(async (runId: string) => {
    if (!conversationId) throw new Error('This conversation is no longer available')
    const retried = await roomsApi.retryMessage(roomId, conversationId, runId)
    watchRuns(retried.run_ids)
    await loadMessages({ replace: true })
  }, [conversationId, loadMessages, roomId, watchRuns])

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
    setLiveTurns({})
    setDiscussions({})
    discussionsRef.current = {}
    setDiscussionDetails({})
    detailVersions.current.clear()
    setQuota(null)
    setQueued([])
    fetchedTurns.current.clear()
    referencesAttachedRef.current = false
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
    // A paused Run is watched too: it is waiting on a person, not finished,
    // and the stream carries the rest of the turn once they decide.
    watchRuns(Object.values(runs)
      .filter(run => !isTerminalRunStatus(run.status) || run.status === 'waiting_for_review')
      .map(run => run.id))
  }, [runs, watchRuns])

  // Runs whose reply is already a message here. Their turn has been said.
  const repliedRunIds = new Set(messages.flatMap(message =>
    message.role === 'assistant' ? messageRunIds(message) : []))
  // Visible messages anchor ordinary recipients and real delegated children.
  // A later discussion wave is started by a hidden internal message, so its
  // live turn is rendered from the discussion detail until its reply lands.
  const anchoredRunIds = new Set(messages.flatMap(message => messageRunIds(message)))
  const allDelegatedRunIds = new Set(messages.flatMap(message => delegatedRunIds(message)))

  useEffect(() => {
    // A terminal Run this surface never streamed — it failed, was cancelled
    // or reaped, or the page was simply opened after it finished. Its turn is
    // read once: an Agent reply renders *as* its turn, so without this every
    // reply on a reloaded page would be a plain bubble with its work gone,
    // and a Run that failed after writing its reply would lose both its steps
    // and the fact that it failed.
    for (const run of Object.values(runs)) {
      if (!isTerminalRunStatus(run.status) || run.status === 'waiting_for_review') continue
      if (liveTurns[run.id] || fetchedTurns.current.has(run.id)) continue
      // Marked while the request is open, so a render mid-flight does not ask
      // again — and released if it fails, so the next poll can. Keeping the
      // mark on failure would turn one blip into permanent silence about a
      // Run whose turn is the only account of what went wrong.
      fetchedTurns.current.add(run.id)
      void runsApi.turn(run.id)
        // Settled on arrival, for the same reason the chat panel settles its
        // history: the reply is written before `chat_completed`, so a turn
        // read back can still say `working` on finished work — and a read is
        // not a stream, so nothing here would ever correct it.
        .then(turn => setLiveTurns(current => {
          const state = readBackTurnState(turn.state, turn.blocked_on)
          return {
            ...current,
            [run.id]: { ...turn, state, blocked_on: state === 'blocked' ? turn.blocked_on : null },
          }
        }))
        .catch(() => { fetchedTurns.current.delete(run.id) })
    }
  }, [runs, repliedRunIds, liveTurns])

  // The continuation status shows until the reply it waits for is visible.
  useEffect(() => {
    if (!continuation?.runIds.length) return
    const visible = messages.some(message =>
      message.role === 'assistant' && messageRunIds(message).some(runId => continuation.runIds.includes(runId)))
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
  }, [messages, messagesLoading, continuation, liveTurns])

  const managerAgentId = detail?.agent_members.find(member => member.role === 'manager')?.agent_id
  const roomAgents = detail?.agent_members.map(member => ({
    id: member.agent_id, name: member.agent_name, kind: member.agent_kind, status: member.status,
  })) ?? []
  const labelAgents = [...roomAgents, ...agents.filter(agent => !roomAgents.some(item => item.id === agent.id))]
  // Who is speaking in a turn that has no reply yet: the Run record names
  // the Agent, the roster names it for people. Unknown until the Run has
  // been read once, which the refresh after a send does.
  const agentNameForRun = (runId: string) => labelAgents.find(agent => agent.id === runs[runId]?.agent_id)?.name
  // A delegated child Run is its own turn; the line under its name says who
  // handed it the work — the parent Run's Agent, or the Room's Manager while
  // that Run has not been read.
  const delegatorNameForRun = (runId: string) => {
    const parentRunId = runs[runId]?.parent_run_id
    if (!parentRunId) return undefined
    return agentNameForRun(parentRunId)
      ?? labelAgents.find(agent => agent.id === managerAgentId)?.name
      ?? 'the Manager'
  }
  const configurableAgentKey = roomAgents
    .filter(agent => agent.status === 'active')
    .map(agent => agent.id)
    .sort()
    .join(':')
  // A persisted Conversation's binding is session-owned. The containing Room
  // can supply chooser data for a draft, but that pre-initialization catalog
  // must never override the catalog read back for the initialized session.
  const backendCatalogs = conversationId
    ? loadedBackendCatalogs
    : { ...loadedBackendCatalogs, ...(suppliedBackendCatalogs ?? {}) }
  const inputCapabilityMessage = useMemo(() => {
    if (!inputParts.some(part => part.kind === 'image')) return null
    const targetIds = routingMode === 'agent_coordination'
      ? managerAgentId ? [managerAgentId] : []
      : composer.routingSegments.length > 0
        ? uniqueIds(composer.routingSegments.flatMap(segment => segment.recipient_agent_ids))
        : managerAgentId ? [managerAgentId] : []
    const incompatible = targetIds.flatMap(agentId => {
      const catalog = backendCatalogs[agentId]
      const binding = catalog?.binding ?? catalog?.options.find(option => option.usable !== false)
      const option = catalog?.options.find(candidate => candidate.runtime_profile_id === binding?.runtime_profile_id)
      return option?.prompt_capabilities?.image === false ? [roomAgents.find(agent => agent.id === agentId)?.name ?? agentId] : []
    })
    return incompatible.length > 0
      ? `Images are not supported by ${incompatible.join(', ')}. Remove the affected image or choose another target.`
      : null
  }, [backendCatalogs, composer.routingSegments, inputParts, managerAgentId, roomAgents, routingMode])

  useEffect(() => {
    const agentIds = configurableAgentKey ? configurableAgentKey.split(':') : []
    // A draft has no session boundary yet. The backend catalog endpoint
    // authorizes a Project Agent through that Conversation's Room membership,
    // so asking for a catalog before the draft exists is indistinguishable
    // from asking for an unknown Agent and correctly returns 404. Preflight
    // owns draft backend choices; this surface only needs catalogs after the
    // server has created the Conversation.
    const requestedAgentIds = conversationId ? agentIds : []
    if (requestedAgentIds.length === 0) {
      setSessionConfig(current => Object.fromEntries(agentIds.map(agentId => {
        const catalog = suppliedBackendCatalogs?.[agentId]
        const backend = catalog?.binding ?? catalog?.options.find(option => option.usable !== false)
        const option = catalog?.options.find(candidate => candidate.runtime_profile_id === backend?.runtime_profile_id)
        return [agentId, mergeSessionConfig(option?.session_config_options ?? [], catalog?.session_config ?? current[agentId] ?? [])]
      })))
      return
    }
    if (agentIds.length === 0) {
      setLoadedBackendCatalogs({})
      setSessionConfig({})
      return
    }
    let cancelled = false
    Promise.all(requestedAgentIds.map(async agentId => ({
      agentId,
      catalog: await agentsApi.conversationBackends(agentId, {
        ...(conversationId ? { sessionId: conversationId } : {}),
      }),
    }))).then(entries => {
      if (cancelled) return
      const fetched = Object.fromEntries(entries.map(entry => [entry.agentId, entry.catalog]))
      setLoadedBackendCatalogs(fetched)
      const catalogs = { ...(suppliedBackendCatalogs ?? {}), ...fetched }
      setSessionConfig(current => Object.fromEntries(agentIds.map(agentId => {
        const catalog = catalogs[agentId]
        const backend = catalog.binding ?? catalog.options.find(option => option.usable !== false)
        const option = catalog.options.find(candidate => candidate.runtime_profile_id === backend?.runtime_profile_id)
        return [agentId, mergeSessionConfig(option?.session_config_options ?? [], catalog.session_config ?? current[agentId] ?? [])]
      })))
    }).catch(error => {
      if (!cancelled) toast.error(errMsg(error))
    })
    return () => { cancelled = true }
  }, [configurableAgentKey, conversationId, executionReady, suppliedBackendCatalogs])

  const configuredBackendsFor = useCallback((recipientAgentIds: string[]): ConversationBackendSelection[] => {
    const supplied = new Map((backendsFor?.(recipientAgentIds) ?? []).map(backend => [backend.agent_id, backend]))
    return recipientAgentIds.flatMap(agentId => {
      const catalog = backendCatalogs[agentId]
      const fallback = catalog?.binding ?? catalog?.options.find(option => option.usable !== false)
      const backend = supplied.get(agentId) ?? (fallback ? {
        agent_id: agentId,
        runtime_profile_id: fallback.runtime_profile_id,
      } : null)
      if (!backend) return []
      const selected = sessionConfig[agentId] ?? []
      return [{ ...backend, ...(selected.length ? { session_config: selected } : {}) }]
    })
  }, [backendCatalogs, backendsFor, sessionConfig])

  const activeDiscussion = Object.values(discussions).find(item =>
    item.session_id === conversationId && item.status === 'active') ?? null

  const sendMessage = useCallback(async (confirmDisclosure?: string[]) => {
    const text = composer.text.trim()
    if (!conversationId || sendingRef.current || !executionReady) return
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
      let effectiveInputParts = inputParts.filter(part => !implicitInputResource || !sameCurrentFilePart(part, implicitInputResource))
      if (implicitInputResource) {
        const resource = await implicitInputResource.flushForSend()
        if (!resource) throw new Error('The current file is no longer available to attach')
        effectiveInputParts = [...effectiveInputParts, resource]
      }
      if (!text && effectiveInputParts.length === 0) return
      // Preflight opens the draft explicitly, so attach held references
      // immediately before the first addressed send and keep them idempotent
      // across retries.
      if (references?.length && !referencesAttachedRef.current) {
        await roomsApi.attachReferences(roomId, conversationId, {
          references,
          ...(confirmDisclosure ? { confirm_disclosure: confirmDisclosure } : {}),
        })
        referencesAttachedRef.current = true
      }
      const dispatched = await roomsApi.sendMessage(roomId, conversationId, {
        content: text,
        ...(activeDiscussion && discussionSendMode === 'join' ? { discussion_id: activeDiscussion.id } : {}),
        ...(effectiveInputParts.length > 0 ? { input_parts: effectiveInputParts } : {}),
        routing_mode: routingMode,
        // Mentions route in both places a conversation is read. The panel
        // once left this out, so an `@Agent` typed there chose which
        // backends to send and addressed nobody.
        ...(routingMode === 'direct' && segments.length > 0
          ? { recipient_segments: segments }
          : variant === 'full' ? { recipient_segments: null } : {}),
        backends: configuredBackendsFor(recipientAgentIds),
        ...(focusRefs ? { focus_refs: focusRefs } : {}),
        // A turn already running does not refuse this: the message waits for
        // it and is sent when it ends. Attachments are claimed at send, so a
        // message with any is sent now or refused as before.
        ...(effectiveInputParts.length === 0 ? { queue: true } : {}),
      })
      if ('queued' in dispatched) {
        // A poll already in flight read the list before this message joined it.
        requestSequence.current += 1
        setQueued(current => [...current.filter(item => item.id !== dispatched.queued.id), dispatched.queued])
      } else {
        watchRuns(dispatched.run_ids)
        setMessages(current => uniqueMessages([...current, dispatched.message]))
        if (dispatched.conversation?.id === conversationId) {
          conversationUpdatedRef.current?.(dispatched.conversation)
        }
      }
      onSentRef.current?.()
      clearConversationDraft(draftDestination)
      clearConversationDraft(`room:${roomId}:new`)
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
  }, [activeDiscussion, composer, configuredBackendsFor, conversationId, discussionSendMode, executionReady, focusRefs, implicitInputResource, inputParts, managerAgentId, onBackendRequired, onReferencesRejected, references, roomId, routingMode, variant, watchRuns])

  // A decision made here continues the conversation here.
  const continueAfterDecision = useCallback(async (preview: ChatActionPreview, action: ActionDecision) => {
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
        backends: configuredBackendsFor(managerAgentId ? [managerAgentId] : []),
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
  }, [configuredBackendsFor, conversationId, managerAgentId, onBeforeContinue, roomId, watchRuns])

  const keepDiscussion = useCallback((discussion: RoomDiscussion) => {
    setDiscussions(current => ({ ...current, [discussion.id]: discussion }))
  }, [])

  // The subscription line is a cache read on the server: re-read it as the
  // transcript grows, which is when a window can have moved, and when a
  // discussion's record changes — a hold starting or lifting bumps it.
  const refreshQuota = useCallback(() => {
    if (!conversationId) return
    void roomsApi.conversationQuota(roomId, conversationId)
      .then(setQuota)
      .catch(() => { /* the line is a courtesy; sending does not depend on it */ })
  }, [conversationId, roomId])
  const discussionsVersion = useMemo(
    () => Object.values(discussions).map(item => `${item.id}@${item.updated_at}`).sort().join('|'),
    [discussions],
  )
  useEffect(() => { refreshQuota() }, [refreshQuota, messages.length, discussionsVersion])

  // "Continue anyway": the held turns are admitted now; their Runs arrive on
  // the next read, and each discussion's header re-reads its hold.
  const continuePastQuota = useCallback(async () => {
    if (!conversationId) throw new Error('This conversation is no longer available')
    setQuota(await roomsApi.continuePastQuota(roomId, conversationId))
    detailVersions.current.clear()
    await loadMessages()
  }, [conversationId, loadMessages, roomId])

  const stopDiscussion = useCallback(async (discussionId: string) => {
    if (!conversationId) throw new Error('This conversation is no longer available')
    keepDiscussion(await roomsApi.stopDiscussion(roomId, conversationId, discussionId))
    await loadMessages()
  }, [conversationId, keepDiscussion, loadMessages, roomId])

  // Extending re-posts the held mentions as the next wave; their Runs arrive
  // on the messages the next read brings back.
  const extendDiscussion = useCallback(async (discussionId: string, rounds: number) => {
    if (!conversationId) throw new Error('This conversation is no longer available')
    keepDiscussion(await roomsApi.extendDiscussion(roomId, conversationId, discussionId, { rounds }))
    await loadMessages()
  }, [conversationId, keepDiscussion, loadMessages, roomId])

  // Opening a discussion posts its topic as the person's message, so it lands
  // the way a send does.
  const openDiscussion = useCallback(async (request: OpenRoomDiscussionRequest) => {
    if (!conversationId) throw new Error('This conversation is no longer available')
    if (sendingRef.current) throw new Error('Wait for the current message to send')
    sendingRef.current = true
    setSending(true)
    followRef.current = true
    try {
      const opened = await roomsApi.openDiscussion(roomId, conversationId, request)
      keepDiscussion(opened.discussion)
      setDiscussionSendMode('join')
      watchRuns(opened.run_ids)
      setMessages(current => uniqueMessages([...current, opened.message]))
      if (opened.conversation?.id === conversationId) conversationUpdatedRef.current?.(opened.conversation)
      onSentRef.current?.()
      setDiscussionDialogOpen(false)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [conversationId, keepDiscussion, roomId, watchRuns])

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
   * Needs an existing conversation — a reference names the one its messages
   * came from — and somewhere for a pick to go. Without the second test a
   * surface that supplies neither destination still shows checkboxes and a
   * button that silently does nothing.
   */
  const canPick = Boolean(conversationId) && (
    Boolean(onUseInNewThread) || (siblingConversations?.length ?? 0) > 1
  )

  const compact = variant === 'panel'
  const timelineItems = groupDiscussionMessages(messages, discussions)
  const lastSegment = new Map(timelineItems.flatMap(item =>
    item.kind === 'discussion' ? [[item.discussionId, item.segment] as const] : []))

  /** One message as the transcript shows it, inside a discussion or not. */
  const renderMessage = (message: RoomMessage) => {
    const notice = discussionNoticeOf(message)
    if (notice) return (
      <DiscussionNoticeCard
        key={message.id}
        message={message}
        notice={notice}
        discussion={discussions[notice.discussion_id]}
        agents={labelAgents}
        onExtend={detail?.viewer_can_write ? extendDiscussion : undefined}
      />
    )
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
    const delegatedIds = new Set(delegatedRunIds(message))
    return (
      <Fragment key={message.id}>
        <RoomMessageView
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
          turn={message.role === 'assistant'
            ? messageRunIds(message).map(runId => liveTurns[runId]).find(Boolean)
            : undefined}
          runIds={message.role === 'assistant' ? messageRunIds(message) : []}
          delegatedRunIds={[...allDelegatedRunIds]}
          runs={runs}
          projectId={detail?.room.project_id ?? null}
          onRetry={retryRun}
          onActionDecision={continueAfterDecision}
        />
        {/*
          The turns this message started, as the Agent speaking after the
          person — not as an attachment under what the person said. A turn
          that has already produced its reply is a message of its own by
          then, so only the ones still running are rendered here.
        */}
        {messageRunIds(message)
          // A turn is shown until its reply is a message of its own —
          // and then it is shown *as* that message (see `RoomMessageView`,
          // which renders an Agent reply through the same component when
          // a turn for it is held), so the steps fold above the reply
          // instead of disappearing with it.
          .filter(runId => !repliedRunIds.has(runId))
          .map(runId => (
            <RoomAgentTurn
              key={runId}
              runId={runId}
              turn={liveTurns[runId]}
              agentName={agentNameForRun(runId)}
              delegatedBy={delegatedIds.has(runId) ? delegatorNameForRun(runId) : undefined}
              run={runs[runId]}
              projectId={detail?.room.project_id ?? null}
              onRetry={allDelegatedRunIds.has(runId) ? undefined : retryRun}
            />
          ))}
      </Fragment>
    )
  }

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
        {timelineItems.map(item => item.kind === 'message'
          ? renderMessage(item.message)
          : (
            <DiscussionGroup
              key={`discussion:${item.discussionId}:${item.messages[0]!.id}`}
              discussionId={item.discussionId}
              segment={item.segment}
              latest={lastSegment.get(item.discussionId) === item.segment}
              discussion={discussions[item.discussionId]}
              detail={discussionDetails[item.discussionId]}
              warnPct={quota?.warn_pct}
              messages={item.messages}
              agents={labelAgents}
              onStop={stopDiscussion}
              onExtend={detail?.viewer_can_write ? extendDiscussion : undefined}
              onContinueAnyway={detail?.viewer_can_write ? continuePastQuota : undefined}
            >
              {item.messages.map(renderMessage)}
              {lastSegment.get(item.discussionId) === item.segment && uniqueIds((discussionDetails[item.discussionId]?.waves ?? [])
                .flatMap(wave => wave.run_ids))
                .filter(runId => !repliedRunIds.has(runId)
                  && !anchoredRunIds.has(runId))
                .map(runId => (
                  <RoomAgentTurn
                    key={runId}
                    runId={runId}
                    turn={liveTurns[runId]}
                    agentName={agentNameForRun(runId)}
                    run={runs[runId]}
                    projectId={detail?.room.project_id ?? null}
                    onRetry={allDelegatedRunIds.has(runId) ? undefined : retryRun}
                  />
                ))}
            </DiscussionGroup>
          ))}
        {queued.map(item => (
          <QueuedMessageCard
            key={item.id}
            message={item}
            author={humans.find(human => human.user_id === item.user_id)?.display_name ?? 'Someone'}
            canWithdraw={item.user_id === userId}
            onWithdraw={async () => {
              await roomsApi.withdrawQueuedMessage(roomId, conversationId!, item.id)
              // A poll already in flight read the list with this message still in it.
              requestSequence.current += 1
              setQueued(current => current.filter(entry => entry.id !== item.id))
            }}
          />
        ))}
        {continuation && <ProposalContinuationStatus continuation={continuation} turns={liveTurns} />}
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
        {(references?.length ?? 0) > 0 && (
          <div className="flex items-center gap-2 rounded border border-dashed border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            <Quote className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {referenceDraftLabel(references!)} will be attached to this conversation before the message
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
        {executionPreflight}
        {runSettings}
        <ConversationQuotaLine quota={quota} onContinueAnyway={detail?.viewer_can_write ? continuePastQuota : undefined} />
        <ConversationComposer
          renderInputReferences={false}
          editor={<RoomMessageComposer
            value={composer}
            onChange={setComposer}
            agents={roomAgents}
            members={detail?.agent_members ?? []}
            // Setup gates sending, not drafting: a blocked/offline preflight
            // must still let the user write and retain the message.
            disabled={sending}
            resetToken={resetToken}
            onSubmit={() => void sendMessage()}
            projectId={detail?.room.project_id}
            projectFolderId={detail?.room.project_folder_id}
            fileSources={inputFileSources}
            sessionId={conversationId}
            inputParts={inputParts}
            onInputPartsChange={setInputParts}
            embedded
          />}
          controls={(
            <>
              {activeDiscussion && (
                <div role="group" aria-label="Message destination" className="flex items-center gap-1 text-xs">
                  <span className="mr-1 text-muted-foreground">Send to</span>
                  <Button type="button" size="sm" variant={discussionSendMode === 'join' ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-xs" aria-pressed={discussionSendMode === 'join'}
                    disabled={sending} onClick={() => setDiscussionSendMode('join')}>Current discussion</Button>
                  <Button type="button" size="sm" variant={discussionSendMode === 'separate' ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-xs" aria-pressed={discussionSendMode === 'separate'}
                    disabled={sending} onClick={() => setDiscussionSendMode('separate')}>Ordinary message</Button>
                </div>
              )}
              {variant === 'full' && detail?.viewer_can_write && !activeDiscussion && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={!conversationId || !executionReady || sending}
                  onClick={() => setDiscussionDialogOpen(true)}
                >
                  <MessagesSquare className="size-3.5" />Open a discussion
                </Button>
              )}
              <ConversationAgentSessionConfigs
                agents={roomAgents.flatMap(agent => {
                  const catalog = backendCatalogs[agent.id]
                  const backend = catalog?.binding ?? catalog?.options.find(option => option.usable !== false)
                  const option = catalog?.options.find(candidate => candidate.runtime_profile_id === backend?.runtime_profile_id)
                  return option?.session_config_options?.length ? [{
                    id: agent.id,
                    name: agent.name,
                    options: option.session_config_options,
                    value: sessionConfig[agent.id] ?? [],
                    onChange: (value: SessionConfigSelection[]) => setSessionConfig(current => ({ ...current, [agent.id]: value })),
                  }] : []
                })}
                disabled={sending}
              />
            </>
          )}
          note={!executionReady ? 'Configure the execution context before sending.' : undefined}
          sending={sending}
          sendDisabled={sending || !executionReady || (!composer.text.trim() && inputParts.length === 0 && !implicitInputResource)}
          onSend={() => void sendMessage()}
          inputParts={inputParts}
          onInputPartsChange={setInputParts}
          inputCapabilityMessage={inputCapabilityMessage}
          projectId={detail?.room.project_id}
          projectFolderId={detail?.room.project_folder_id}
          fileSources={inputFileSources}
          sessionId={conversationId}
          inputResetToken={resetToken}
        />
      </div>
      {variant === 'full' && (
        <OpenDiscussionDialog
          open={discussionDialogOpen}
          agents={roomAgents.filter(agent => agent.status === 'active')}
          onClose={() => setDiscussionDialogOpen(false)}
          onSubmit={openDiscussion}
        />
      )}
    </div>
  )
}

function RoomMessageView({
  message, compact, picked, pickable, onPickedChange,
  viewerUserId, agents, humans, turn, runIds, delegatedRunIds, runs, projectId, onRetry, onActionDecision,
}: {
  message: RoomMessage
  compact: boolean
  /** Selected to be copied elsewhere. */
  picked: boolean
  /**
   * Whether it may be picked at all. False for a conversation that does not
   * exist yet: a reference names the conversation its messages came from, and
   * there is no transcript to select from before a draft has been opened.
   */
  pickable: boolean
  onPickedChange: (picked: boolean) => void
  viewerUserId: string | null
  agents: Array<{ id: string; name: string; kind?: string }>
  humans: SpaceMember[]
  /** The turn this reply came from, when one is held for it. */
  turn?: RunTurn
  runIds: string[]
  runs: Record<string, Run>
  projectId?: string | null
  /** Child Runs an Agent delegated: shown live, never retried as a recipient. */
  delegatedRunIds: string[]
  onRetry: (runId: string) => Promise<void>
  onActionDecision: (preview: ChatActionPreview, action: ActionDecision) => Promise<void>
}) {
  const mine = message.role === 'user'
  const system = message.role === 'system'
  const human = humans.find(member => member.user_id === message.user_id)
  const label = system
    ? 'Execution'
    : mine
    ? (human?.display_name ?? human?.email ?? (message.user_id === viewerUserId ? 'You' : 'Person'))
    : agents.find(agent => agent.id === message.sender_agent_id)?.name ?? 'Agent'
  return (
    // Who said it has to be readable at a glance in a column of mixed-language
    // text, so the two sides differ in alignment, fill and edge at once.
    <div
      className={`group ${mine ? 'flex justify-end pl-6' : 'flex w-full justify-start pr-6'} ${picked ? 'bg-accent/40' : ''}`}
      data-role={system ? 'system' : mine ? 'user' : 'agent'}
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
      <div className={`min-w-0 ${mine ? (compact ? 'max-w-full' : 'max-w-[82%]') : 'w-full max-w-none'}`}>
        <div className={system
          ? 'min-w-0 max-w-full rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-muted-foreground'
          : mine
          ? 'min-w-0 max-w-full rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground'
          : 'min-w-0 max-w-full rounded-2xl rounded-bl-sm border border-border bg-muted/60 px-3 py-2'}>
          <div className={`mb-1 flex min-w-0 items-center gap-2 text-[11px] font-medium ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
            {!mine && <Bot className="size-3.5 shrink-0" />}
            <span className="truncate">{label}</span>
            <span className="shrink-0">{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          {/*
            An Agent reply is its turn, when one is held: the reply with the
            work that produced it folded above, which is what D3 asks for and
            what a plain bubble cannot show.

            The state is the turn's own. The server decides it in one place
            (`turnReadModel.turnState`) with facts a client does not have — that
            a `degraded` Run still carries a usable reply, that a chat Run
            reaches `succeeded` before its reply is written — and re-deriving it
            here from the Run's status produces a second, worse answer. Only the
            prose is replaced, with what was actually saved.
          */}
          <ConversationInputPartsView parts={message.input_parts} />
          {turn
            ? (
              <ConversationTurn
                turn={settledTurn(turn, turn.state, message.content)!}
                runHref={`/runs/${turn.run_id}`}
                className="max-w-none"
              />
            )
            : message.content && <MessageResponse>{message.content}</MessageResponse>}
          {message.metadata_json?.awaiting_answer && <AwaitingAnswerMarker />}
          <ActionPreviewCards
            previews={metadataActionPreviews(message.metadata_json)}
            viewerUserId={viewerUserId}
            onDecision={onActionDecision}
            testId={`previews-${message.id}`}
          />
        </div>
        {runIds.filter(runId => runs[runId]).map(runId => (
          <ConversationRunControls
            key={runId}
            runId={runId}
            run={runs[runId]}
            projectId={projectId}
            onRetry={delegatedRunIds.includes(runId) ? undefined : onRetry}
            showStatus={false}
            // If a saved Agent reply ever names several Runs, keep each
            // reply-side control explicitly attributed to its Agent.
            agentLabel={runIds.length > 1 ? agents.find(agent => agent.id === runs[runId]?.agent_id)?.name ?? 'Agent' : undefined}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * An Agent turn in progress, as its own message.
 *
 * A Run a person's message started used to be shown under that message — a
 * badge, a link, a status line and a box of streaming text. None of that is
 * how a conversation reads: while the Agent works there was no Agent-side
 * bubble at all, and after it replied the status stayed under the person.
 * This is the Agent speaking, in the place the Agent speaks.
 */
function RoomAgentTurn({ runId, turn, agentName, delegatedBy, run, projectId, onRetry }: {
  runId: string
  turn?: RunTurn
  agentName?: string
  delegatedBy?: string
  run?: Run
  projectId?: string | null
  onRetry?: (runId: string) => Promise<void>
}) {
  const waiting = !run || run.status === 'queued' || run.status === 'waiting_for_dependency'
  return (
    <div className="group flex w-full justify-start pr-6" data-role="agent" data-testid={`turn-${runId}`}>
      <div className="w-full min-w-0">
        <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <Bot className="size-3.5 shrink-0" />
          <span className="truncate">{agentName ?? 'Agent'}</span>
          {delegatedBy && <span className="shrink-0 font-normal">delegated by {delegatedBy}</span>}
        </div>
        {waiting
          ? <p className="text-sm text-muted-foreground">{run?.status === 'waiting_for_dependency' ? 'Waiting for previous Agent…' : run?.status === 'queued' ? 'Queued…' : 'Checking status…'}</p>
          : turn
            ? <ConversationTurn turn={turn} runHref={`/runs/${runId}`} className="max-w-none" />
            : <p className="text-sm text-muted-foreground">{run && ['failed', 'succeeded', 'degraded', 'cancelled', 'orphaned'].includes(run.status) ? 'Loading result…' : 'Starting…'}</p>}
        {run && <ConversationRunControls runId={runId} run={run} projectId={projectId} onRetry={onRetry} showStatus={false} />}
      </div>
    </div>
  )
}

function ProposalContinuationStatus({ continuation, turns }: {
  continuation: PendingProposalContinuation
  turns: Record<string, RunTurn>
}) {
  // The newest step the follow-up turn has taken, which is the closest thing
  // to a status while it runs.
  const activeLabel = continuation.runIds.reduce<string | null>((latest, runId) => {
    const step = [...(turns[runId]?.parts ?? [])].reverse().find(part => part.type === 'tool_call')
    return step?.type === 'tool_call' ? step.name : latest
  }, null)
  const actionLabel = continuation.action === 'accept' ? '已接受' : '已拒绝'
  const statusText = continuation.phase === 'failed'
    ? `后续处理未能启动：${continuation.error || '未知错误'}`
    : continuation.phase === 'submitting'
      ? `${actionLabel}，正在启动下一步…`
      : activeLabel || `${actionLabel}，助手正在处理…`
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
    ? isOwner ? 'Summary not configured — add an API provider to resume' : 'Summary not configured; the Room owner can add a provider'
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

function isTerminalRunStatus(status: string): boolean {
  return ['succeeded', 'failed', 'degraded', 'cancelled', 'orphaned', 'waiting_for_review'].includes(status)
}

/**
 * A message waiting for the conversation's turn, shown where it will land,
 * with Cancel for its sender — or one that could not be posted, with the
 * reason and Dismiss.
 */
function QueuedMessageCard({ message, author, canWithdraw, onWithdraw }: {
  message: QueuedRoomMessage
  author: string
  canWithdraw: boolean
  onWithdraw: () => Promise<void>
}) {
  const [withdrawing, setWithdrawing] = useState(false)
  const failed = message.status === 'failed'
  return (
    <div
      className={`ml-auto max-w-[85%] rounded-lg border border-dashed px-3 py-2 text-sm ${failed ? 'border-destructive' : 'border-border'}`}
      role="status"
      data-testid={`queued-${message.id}`}
    >
      <p className="whitespace-pre-wrap">{message.content}</p>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className={failed ? 'text-destructive' : undefined}>
          {author} · {message.discussion_id ? 'joining discussion' : 'ordinary message'} · {failed ? `could not be sent: ${message.failure_reason ?? 'unknown reason'}` : 'will be sent when the current turn ends'}
        </span>
        {canWithdraw && (
          <button
            type="button"
            className="underline"
            disabled={withdrawing}
            onClick={() => {
              setWithdrawing(true)
              void onWithdraw().catch((error) => {
                setWithdrawing(false)
                toast.error(errMsg(error))
              })
            }}
          >
            {failed ? 'Dismiss' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * A poll's page merged into what is held: a message already held takes the
 * page's copy in place, since the server revises messages after sending them
 * (a discussion stamp, a delegated child's Run id), and new ones follow.
 */
export function mergeMessages(current: RoomMessage[], incoming: readonly RoomMessage[]): RoomMessage[] {
  const fresh = new Map(incoming.map(message => [message.id, message]))
  const merged = current.map(message => fresh.get(message.id) ?? message)
  const held = new Set(current.map(message => message.id))
  return uniqueMessages([...merged, ...incoming.filter(message => !held.has(message.id))])
}

export function uniqueMessages(messages: RoomMessage[]): RoomMessage[] {
  const seen = new Set<string>()
  return messages.filter(message => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

/**
 * Every Run this message is tied to.
 *
 * `run_id` is the column: the Run that produced an Agent reply, or the Run a
 * person's message started. `metadata_json.run_ids` is the separate Room case
 * where one dispatched message fanned out to several recipients;
 * `delegated_run_ids` lists the child Runs an Agent delegated while answering
 * it.
 */
export function messageRunIds(message: {
  metadata_json?: RoomMessage['metadata_json']
  run_id?: string | null
}): string[] {
  const fanout = message.metadata_json?.run_ids
  const retries = message.metadata_json?.retry_run_ids
  const superseded = new Set(Array.isArray(message.metadata_json?.retry_superseded_run_ids)
    ? message.metadata_json.retry_superseded_run_ids.filter((id): id is string => typeof id === 'string')
    : [])
  const delegated = message.metadata_json?.delegated_run_ids
  const ids = [
    ...(Array.isArray(fanout) ? fanout.filter(id => typeof id === 'string' && !superseded.has(id)) : []),
    ...(Array.isArray(retries) ? retries.filter(id => typeof id === 'string' && !superseded.has(id)) : []),
    ...(Array.isArray(delegated) ? delegated : []),
    ...(message.run_id ? [message.run_id] : []),
  ]
  return uniqueIds(ids.filter((id): id is string => typeof id === 'string'))
}

export function delegatedRunIds(message: { metadata_json?: RoomMessage['metadata_json'] }): string[] {
  const delegated = message.metadata_json?.delegated_run_ids
  return Array.isArray(delegated) ? delegated.filter((id): id is string => typeof id === 'string') : []
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
