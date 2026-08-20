import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Bot, Loader2, MessageSquarePlus, Plus, RefreshCw, Send, Users } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, ApiRequestError, projectFoldersApi, projectsApi, roomsApi, runsApi, spacesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  AgentOut,
  ChatActionPreview,
  ConversationBackendCatalog,
  Project,
  ProjectFolder,
  ProjectOverview,
  Room,
  RoomConversation,
  RoomConversationSummaryResponse,
  RoomDetail,
  RoomMessage,
  RoomPendingApproval,
  RoomPendingApprovalListResponse,
  Run,
  SpaceMember,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import {
  RoomMessageComposer,
  emptyRoomMessageComposerValue,
} from './RoomMessageComposer'
import { MarkdownMessage } from './MarkdownMessage'
import { RoomRosterPanel } from './RoomRosterPanel'
import { RoomActionPreviewCard, type RoomActionDecision } from './RoomActionPreviewCard'

type RoutingMode = 'direct' | 'agent_coordination'
type BackendSelection = {
  runtime_profile_id: string
  credential_profile_id: string | null
}
type RunProgress = {
  event_type: string
  status: string
  summary?: string | null
}
type PendingProposalContinuation = {
  proposalId: string
  action: RoomActionDecision
  phase: 'submitting' | 'running' | 'failed'
  runIds: string[]
  error?: string
}
const MESSAGE_PAGE_SIZE = 50
const LIST_PAGE_SIZE = 100

export default function AgentGroupsPage() {
  const { activeSpaceId, userId } = useSpace()
  const { projectId: projectRouteId } = useParams()
  const [search, setSearch] = useSearchParams()
  const roomId = search.get('room')
  const conversationId = search.get('conversation')
  const projectFilter = projectRouteId || search.get('project') || undefined
  const isProjectScoped = Boolean(projectRouteId)
  const [rooms, setRooms] = useState<Room[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [spaceMembers, setSpaceMembers] = useState<SpaceMember[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<RoomPendingApproval[]>([])
  const [detail, setDetail] = useState<RoomDetail | null>(null)
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [boundFolderName, setBoundFolderName] = useState<string | null>(null)
  const [conversations, setConversations] = useState<RoomConversation[]>([])
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [conversationSummary, setConversationSummary] = useState<RoomConversationSummaryResponse | null>(null)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const runsRef = useRef<Record<string, Run>>({})
  const [runProgress, setRunProgress] = useState<Record<string, RunProgress>>({})
  const [runDeltas, setRunDeltas] = useState<Record<string, string>>({})
  const streamControllers = useRef(new Map<string, AbortController>())
  const locallyCommittedRooms = useRef(new Map<string, Room>())
  const roomCreationIdempotency = useRef<{ fingerprint: string; key: string } | null>(null)
  const catalogRequestSequence = useRef(0)
  const roomRequestSequence = useRef(0)
  const messageRequestSequence = useRef(0)
  const conversationScrollRef = useRef<HTMLDivElement>(null)
  const followConversationRef = useRef(true)
  const [backendCatalogs, setBackendCatalogs] = useState<Record<string, ConversationBackendCatalog>>({})
  const [backendSelections, setBackendSelections] = useState<Record<string, BackendSelection>>({})
  const [loading, setLoading] = useState(true)
  const [roomLoading, setRoomLoading] = useState(false)
  const [roomLoadError, setRoomLoadError] = useState<string | null>(null)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState(false)
  const [pendingProposalContinuation, setPendingProposalContinuation] = useState<PendingProposalContinuation | null>(null)
  const [composer, setComposer] = useState(emptyRoomMessageComposerValue)
  const [resetToken, setResetToken] = useState(0)
  const [roomSetupTargets, setRoomSetupTargets] = useState<string[]>([])
  const [routingMode, setRoutingMode] = useState<RoutingMode>('direct')
  const [draft, setDraft] = useState({
    title: '',
    project_id: projectFilter ?? '',
    project_folder_id: '',
  })

  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  useEffect(() => {
    followConversationRef.current = true
    setPendingProposalContinuation(null)
  }, [conversationId])

  useEffect(() => {
    if (!pendingProposalContinuation?.runIds.length) return
    const hasVisibleReply = messages.some(message =>
      message.role === 'assistant'
      && metadataRunIds(message.metadata_json).some(runId => pendingProposalContinuation.runIds.includes(runId)))
    if (hasVisibleReply) setPendingProposalContinuation(null)
  }, [messages, pendingProposalContinuation])

  useEffect(() => {
    const container = conversationScrollRef.current
    if (
      messagesLoading
      || !container
      || !followConversationRef.current
      || typeof container.scrollTo !== 'function'
    ) return
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, messagesLoading, pendingProposalContinuation, runDeltas, runProgress])

  useEffect(() => {
    if (!draft.project_id) {
      setProjectFolders([])
      return
    }
    let cancelled = false
    projectFoldersApi.list(draft.project_id, { status: 'active', limit: '100' })
      .then(page => {
        if (cancelled) return
        const executable = page.items.filter(folder => folder.execution_enabled)
        setProjectFolders(executable)
        setDraft(current => {
          if (current.project_id !== draft.project_id) return current
          if (executable.some(folder => folder.id === current.project_folder_id)) return current
          return { ...current, project_folder_id: '' }
        })
      })
      .catch(error => {
        if (!cancelled) toast.error(errMsg(error))
      })
    return () => {
      cancelled = true
    }
  }, [draft.project_id])

  const loadCatalog = useCallback(async () => {
    if (!activeSpaceId) return
    const requestSequence = ++catalogRequestSequence.current
    const pendingApprovalsRequest: Promise<RoomPendingApprovalListResponse> = typeof roomsApi.pendingApprovals === 'function'
      ? roomsApi.pendingApprovals({ limit: 100 })
      : Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 })
    const roomsRequest = loadAllPages((limit, offset) =>
      roomsApi.list({ project_id: projectFilter, limit, offset }))
    const supportingCatalogRequest = Promise.all([
      projectsApi.list({ status: 'active', limit: 100 }),
      agentsApi.list({ status: 'active' }),
      spacesApi.members(activeSpaceId),
      pendingApprovalsRequest,
    ])
    const allRooms = await roomsRequest
    // URL changes and the post-create refresh can overlap. Only the newest
    // request may replace catalog state; otherwise an older empty response can
    // arrive after a newer response observed the committed Room and removed
    // its local pending entry.
    if (requestSequence !== catalogRequestSequence.current) return
    const observedRoomIds = new Set(allRooms.map(room => room.id))
    for (const roomId of observedRoomIds) locallyCommittedRooms.current.delete(roomId)
    const pendingRooms = [...locallyCommittedRooms.current.values()].filter(room =>
      room.space_id === activeSpaceId && (!projectFilter || room.project_id === projectFilter))
    const nextRooms = [...allRooms, ...pendingRooms.filter(room => !observedRoomIds.has(room.id))]
    setRooms(nextRooms)
    // Existing Rooms are the critical path. Let selection and detail loading
    // begin without waiting for secondary catalogs used by roster/setup UI.
    if (nextRooms.length > 0) setLoading(false)

    const [projectPage, agentList, members, approvalPage] = await supportingCatalogRequest
    if (requestSequence !== catalogRequestSequence.current) return
    const selectableAgents = agentList.filter(agent => agent.agent_kind !== 'system_assistant')
    setProjects(projectPage.items)
    setAgents(selectableAgents)
    setSpaceMembers(members)
    setPendingApprovals(approvalPage.items)
    setDraft(current => ({
      ...current,
      project_id:
        projectRouteId
        || current.project_id
        || projectFilter
        || projectPage.items[0]?.id
        || '',
    }))
  }, [activeSpaceId, projectFilter, projectRouteId])

  async function decidePendingApproval(item: RoomPendingApproval, decision: 'approved' | 'rejected') {
    try {
      await roomsApi.decideInvitation(item.room_id, item.invitation_id, {
        agent_id: item.agent_id,
        decision,
      })
      await loadCatalog()
      toast.success(decision === 'approved' ? 'Private Agent sharing approved' : 'Invitation rejected')
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  const loadRoom = useCallback(async () => {
    const requestSequence = ++roomRequestSequence.current
    if (!roomId) {
      setDetail(null)
      setConversations([])
      setBoundFolderName(null)
      setOverview(null)
      return
    }
    const conversationsRequest = loadAllPages((limit, offset) =>
      roomsApi.conversations(roomId, { limit, offset }))
    const nextDetail = await roomsApi.get(roomId)
    const allConversations = await conversationsRequest
    if (requestSequence !== roomRequestSequence.current) return
    setDetail(nextDetail)
    setConversations(current => sortConversationsNewestFirst(allConversations.map(conversation => {
      const locallyUpdated = current.find(item => item.id === conversation.id)
      return locallyUpdated
        && Date.parse(locallyUpdated.updated_at) > Date.parse(conversation.updated_at)
        ? locallyUpdated
        : conversation
    })))

    const [folderPage, nextOverview] = await Promise.all([
      nextDetail.room.project_folder_id
        ? projectFoldersApi.list(nextDetail.room.project_id, {
            status: 'active',
            limit: String(LIST_PAGE_SIZE),
          })
        : Promise.resolve({ items: [] as ProjectFolder[] }),
      // Ambient Project state beside the conversation (plan Phase B): the
      // same Overview contract the Project Overview page renders, never a
      // Room-specific read. A failure here should not block the Room from
      // loading.
      projectsApi.getOverview(nextDetail.room.project_id).catch(() => null),
    ])
    if (requestSequence !== roomRequestSequence.current) return
    setOverview(nextOverview)
    setBoundFolderName(
      nextDetail.room.project_folder_id
        ? folderPage.items.find(folder =>
            folder.id === nextDetail.room.project_folder_id)?.name
          ?? 'Unavailable folder'
        : null,
    )
  }, [roomId])

  const loadMessages = useCallback(async () => {
    const requestSequence = ++messageRequestSequence.current
    if (!roomId || !conversationId) {
      setMessages([])
      setConversationSummary(null)
      setRuns({})
      return
    }
    const page = await roomsApi.messages(roomId, conversationId, {
      limit: MESSAGE_PAGE_SIZE,
      offset: 0,
    })
    if (requestSequence !== messageRequestSequence.current) return
    if (page.conversation) {
      setConversations(current => sortConversationsNewestFirst(current.some(conversation => conversation.id === page.conversation!.id)
        ? current.map(conversation =>
            conversation.id === page.conversation!.id ? page.conversation! : conversation)
        : [...current, page.conversation!]))
    }
    setMessages(current =>
      current.length > 0
      && current.every(message => message.session_id === conversationId)
        ? uniqueMessages([...current, ...page.items])
        : page.items)
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
    void roomsApi.summary(roomId, conversationId)
      .then(summary => {
        if (requestSequence === messageRequestSequence.current) setConversationSummary(summary)
      })
      .catch(() => {
        if (requestSequence === messageRequestSequence.current) setConversationSummary(null)
      })
    const runIds = uniqueIds(page.items.flatMap(message => metadataRunIds(message.metadata_json)))
    const idsToRefresh = runIds.filter(id =>
      !runsRef.current[id] || !isTerminalRunStatus(runsRef.current[id]!.status))
    const results = await Promise.all(idsToRefresh.map(async id => {
      try {
        return await runsApi.get(id)
      } catch {
        return null
      }
    }))
    if (requestSequence !== messageRequestSequence.current) return
    setRuns(current => ({
      ...current,
      ...Object.fromEntries(results.filter((run): run is Run => Boolean(run)).map(run => [run.id, run])),
    }))
    const terminalIds = results.flatMap(run =>
      run && isTerminalRunStatus(run.status) ? [run.id] : [])
    if (terminalIds.length > 0) clearTransientRuns(terminalIds, setRunProgress, setRunDeltas)
  }, [conversationId, roomId])

  const loadOlderMessages = useCallback(async () => {
    if (!roomId || !conversationId || !hasOlderMessages) return
    const page = await roomsApi.messages(roomId, conversationId, {
      limit: MESSAGE_PAGE_SIZE,
      offset: messages.length,
    })
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
          setRunDeltas(current => ({
            ...current,
            [runId]: `${current[runId] ?? ''}${delta}`,
          }))
        },
      }).catch(error => {
        if (!controller.signal.aborted) toast.error(errMsg(error))
      }).finally(() => {
        if (streamControllers.current.get(runId) === controller) {
          streamControllers.current.delete(runId)
        }
      })
    }
  }, [loadMessages])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadCatalog()
      .catch(error => toast.error(errMsg(error)))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [loadCatalog])

  useEffect(() => {
    if (roomId || rooms.length === 0) return
    const newestRoom = [...rooms].sort(compareCreatedNewestFirst)[0]
    if (!newestRoom) return
    setSearch(current => {
      const next = new URLSearchParams(current)
      next.set('room', newestRoom.id)
      next.delete('conversation')
      return next
    }, { replace: true })
  }, [roomId, rooms, setSearch])

  useEffect(() => {
    let cancelled = false
    setRoomLoading(true)
    setRoomLoadError(null)
    setDetail(null)
    setConversations([])
    setBoundFolderName(null)
    setOverview(null)
    loadRoom()
      .catch(error => {
        if (cancelled) return
        const message = errMsg(error)
        setRoomLoadError(message)
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) setRoomLoading(false)
      })
    return () => { cancelled = true }
  }, [loadRoom])

  useEffect(() => {
    if (
      !roomId
      || conversationId
      || detail?.room.id !== roomId
      || conversations.length === 0
    ) return
    setSearch(current => {
      const next = new URLSearchParams(current)
      next.set('room', roomId)
      next.set('conversation', conversations[0]!.id)
      return next
    }, { replace: true })
  }, [conversationId, conversations, detail, roomId, setSearch])

  useEffect(() => {
    let cancelled = false
    setMessagesLoading(Boolean(roomId && conversationId))
    setMessages([])
    setConversationSummary(null)
    setHasOlderMessages(false)
    setRuns({})
    setRunProgress({})
    setRunDeltas({})
    loadMessages()
      .catch(error => toast.error(errMsg(error)))
      .finally(() => {
        if (!cancelled) setMessagesLoading(false)
      })
    return () => { cancelled = true }
  }, [conversationId, loadMessages, roomId])

  useEffect(() => {
    if (!roomId || !conversationId) return
    const activeRunIds = Object.values(runs)
      .filter(run => !isTerminalRunStatus(run.status))
      .map(run => run.id)
    const timer = window.setInterval(() => {
      loadMessages().catch(() => undefined)
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
    watchRuns(Object.values(runs)
      .filter(run => !isTerminalRunStatus(run.status))
      .map(run => run.id))
  }, [runs, watchRuns])

  useEffect(() => {
    if (!conversationId || !detail) {
      setBackendCatalogs({})
      setBackendSelections({})
      return
    }
    let cancelled = false
    Promise.all(detail.agent_members
      .filter(member => member.agent_kind !== 'system_assistant')
      .map(async member => ({
        agentId: member.agent_id,
        catalog: await agentsApi.conversationBackends(member.agent_id, {
          sessionId: conversationId,
        }),
      }))).then(entries => {
      if (cancelled) return
      const catalogs = Object.fromEntries(entries.map(entry => [entry.agentId, entry.catalog]))
      setBackendCatalogs(catalogs)
      setBackendSelections(current => {
        const next: Record<string, BackendSelection> = {}
        for (const entry of entries) {
          const selection = current[entry.agentId] ?? selectedBackend(entry.catalog)
          if (selection) next[entry.agentId] = selection
        }
        return next
      })
    }).catch(error => {
      if (!cancelled) toast.error(errMsg(error))
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, detail])

  async function createRoom() {
    if (!draft.title.trim() || !draft.project_id) return
    if (await openRoom({
      project_id: draft.project_id,
      project_folder_id: draft.project_folder_id || null,
      title: draft.title.trim(),
    })) {
      setDraft(current => ({ ...current, title: '' }))
    }
  }

  /**
   * A Room with no conversation cannot be spoken to, and a Room is only ever
   * created in order to speak — so the first conversation opens with it
   * rather than being a second thing to go and find.
   */
  async function openRoom(input: Parameters<typeof roomsApi.create>[0]): Promise<boolean> {
    setCreating(true)
    let createdRoom: Room | null = null
    const fingerprint = JSON.stringify(input)
    const key = roomCreationIdempotency.current?.fingerprint === fingerprint
      ? roomCreationIdempotency.current.key
      : newRoomCreationIdempotencyKey()
    roomCreationIdempotency.current = { fingerprint, key }
    try {
      const created = await roomsApi.create(input, key)
      setRoomSetupTargets([])
      createdRoom = created.room
      // The Room is already committed. Retain it before any subsequent
      // request so a lagging detail read or failed catalog refresh cannot
      // restore the empty-state CTA and create a duplicate.
      locallyCommittedRooms.current.set(created.room.id, created.room)
      setRooms(current => current.some(room => room.id === created.room.id)
        ? current
        : [...current, created.room])
      if (!created.conversation) throw new Error('Room creation returned no initial conversation')
      setSearch({ room: created.room.id, conversation: created.conversation.id })
      roomCreationIdempotency.current = null
      return true
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'conversation_backend_required') {
        const targets = error.payload?.setup_targets
        setRoomSetupTargets(Array.isArray(targets)
          ? targets.filter((target): target is string => typeof target === 'string')
          : [])
      }
      if (createdRoom) {
        setSearch({ room: createdRoom.id })
      }
      toast.error(errMsg(error))
      return false
    } finally {
      try {
        await loadCatalog()
      } catch (error) {
        toast.error(errMsg(error))
      } finally {
        setCreating(false)
      }
    }
  }

  async function createConversation() {
    if (!roomId) return
    try {
      const conversation = await roomsApi.createConversation(roomId, {})
      setConversations(current => sortConversationsNewestFirst(current.some(item => item.id === conversation.id)
        ? current
        : [...current, conversation]))
      setSearch({ room: roomId, conversation: conversation.id })
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function sendMessage() {
    if (!roomId || !conversationId || !composer.text.trim() || sending) return
    const segments = composer.routingSegments
      .map(segment => ({
        recipient_agent_ids: uniqueIds(segment.recipient_agent_ids),
        content: segment.content.trim(),
      }))
      .filter(segment => segment.recipient_agent_ids.length > 0 && segment.content)
    const managerAgentId = detail?.agent_members.find(member => member.role === 'manager')?.agent_id
    const recipientAgentIds = uniqueIds(
      routingMode === 'agent_coordination' || segments.length === 0
        ? managerAgentId ? [managerAgentId] : []
        : segments.flatMap(segment => segment.recipient_agent_ids),
    )
    setSending(true)
    followConversationRef.current = true
    try {
      const dispatched = await roomsApi.sendMessage(roomId, conversationId, {
        content: composer.text.trim(),
        routing_mode: routingMode,
        recipient_segments: routingMode === 'direct' && segments.length > 0 ? segments : null,
        backends: recipientAgentIds.flatMap(agent_id => {
          const selection = backendSelections[agent_id]
          return selection ? [{ agent_id, ...selection }] : []
        }),
      })
      watchRuns(dispatched.run_ids)
      setMessages(current => uniqueMessages([...current, dispatched.message]))
      if (dispatched.conversation) {
        setConversations(current => sortConversationsNewestFirst(current.some(conversation => conversation.id === dispatched.conversation!.id)
          ? current.map(conversation =>
              conversation.id === dispatched.conversation!.id ? dispatched.conversation! : conversation)
          : [...current, dispatched.conversation!]))
      }
      setResetToken(value => value + 1)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSending(false)
    }
  }

  async function continueAfterProposalDecision(
    preview: ChatActionPreview,
    action: RoomActionDecision,
  ) {
    if (!roomId || !conversationId || !detail) {
      throw new Error('The conversation is no longer available')
    }
    if (!preview.proposal_id) throw new Error('The proposal is no longer available')
    if (sending) throw new Error('Wait for the current reply before continuing')
    setSending(true)
    followConversationRef.current = true
    setPendingProposalContinuation({
      proposalId: preview.proposal_id,
      action,
      phase: 'submitting',
      runIds: [],
    })
    try {
      if (action === 'accept') {
        const refreshed = await projectsApi.getOverview(detail.room.project_id).catch(() => null)
        if (refreshed) setOverview(refreshed)
      }
      const managerAgentId = detail.agent_members.find(member => member.role === 'manager')?.agent_id
      const selection = managerAgentId ? backendSelections[managerAgentId] : null
      const dispatched = await roomsApi.continueAfterProposal(roomId, conversationId, {
        proposal_id: preview.proposal_id,
        backends: managerAgentId && selection
          ? [{ agent_id: managerAgentId, ...selection }]
          : [],
      })
      setPendingProposalContinuation(current => current && current.proposalId === preview.proposal_id
        ? { ...current, phase: 'running', runIds: dispatched.run_ids }
        : current)
      watchRuns(dispatched.run_ids)
      if (dispatched.conversation) {
        setConversations(current => sortConversationsNewestFirst(current.some(conversation => conversation.id === dispatched.conversation!.id)
          ? current.map(conversation =>
              conversation.id === dispatched.conversation!.id ? dispatched.conversation! : conversation)
          : [...current, dispatched.conversation!]))
      }
    } catch (error) {
      setPendingProposalContinuation(current => current && current.proposalId === preview.proposal_id
        ? { ...current, phase: 'failed', error: errMsg(error) }
        : current)
      throw error
    } finally {
      setSending(false)
    }
  }

  const roomAgents = useMemo(() => {
    return detail?.agent_members.map(member => ({
      id: member.agent_id,
      name: member.agent_name,
      kind: member.agent_kind,
      status: member.status,
    })) ?? []
  }, [detail])
  const currentConversation = conversations.find(item => item.id === conversationId) ?? null

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading Rooms…</div>
  }

  // A populated Rooms route resolves its default selection before rendering
  // the workspace. The create/select landing state is reserved for a truly
  // empty catalog, so users never see it flash before the selected Room.
  if (!roomId && rooms.length > 0) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading Room…</div>
  }

  if (roomId && !detail) {
    if (roomLoadError) {
      const selectedRoom = rooms.find(room => room.id === roomId)
      return (
        <div className="p-6 max-w-[1600px] mx-auto space-y-3">
          {selectedRoom && <h1 className="text-xl font-semibold">{displayRoomTitle(selectedRoom, projects)}</h1>}
          <p className="text-sm text-destructive">Room details could not be loaded: {roomLoadError}</p>
          <Button variant="outline" size="sm" onClick={() => void loadRoom()}>Try again</Button>
        </div>
      )
    }
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading Room…</div>
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <header className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Users className="size-5" />Rooms</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Project-bound conversations where every human speaks under their own identity and subscription.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => Promise.all([loadCatalog(), loadRoom(), loadMessages()])}>
          <RefreshCw className="size-3.5 mr-1" />Refresh
        </Button>
      </header>

      {roomSetupTargets.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">Set up a conversation backend to start this Room.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {roomSetupTargets.includes('model_providers') && <Link to="/providers" className="text-sm underline">Configure an API provider</Link>}
            {roomSetupTargets.includes('cli_credentials') && <Link to="/cli-profiles" className="text-sm underline">Grant a CLI credential</Link>}
          </div>
        </Card>
      )}

      {pendingApprovals.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <CardTitle className="text-sm">Pending private-Agent approvals</CardTitle>
          <div className="mt-2 space-y-2">
            {pendingApprovals.map(item => (
              <div key={`${item.invitation_id}:${item.agent_id}`} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                <div>
                  <p>{item.agent_name} · {item.room_title}</p>
                  <p className="text-xs text-muted-foreground">Project {item.project_name} · invited user {item.invitee_display_name || item.invitee_email || item.invitee_user_id}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void decidePendingApproval(item, 'approved')}>Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => void decidePendingApproval(item, 'rejected')}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!detail ? (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="space-y-3">
          {(!isProjectScoped || rooms.length > 0) && <Card className="p-3 space-y-3">
            <CardTitle>New Room</CardTitle>
            <div className="space-y-1"><Label>Title</Label><Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></div>
            {!isProjectScoped && (
              <div className="space-y-1">
                <Label>Project</Label>
                <Select
                  value={draft.project_id}
                  onChange={project_id => setDraft({
                    ...draft,
                    project_id,
                    project_folder_id: '',
                  })}
                  options={[
                    { value: '', label: 'Choose Project' },
                    ...projects.map(project => ({ value: project.id, label: project.name })),
                  ]}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Project Folder</Label>
              <Select
                value={draft.project_folder_id}
                onChange={project_folder_id => setDraft({ ...draft, project_folder_id })}
                options={[
                  { value: '', label: 'No folder' },
                  ...projectFolders.map(folder => ({ value: folder.id, label: folder.name })),
                ]}
              />
            </div>
            <Button
              className="w-full"
              size="sm"
              disabled={creating || !draft.title.trim() || !draft.project_id}
              onClick={createRoom}
            >
              {creating ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Plus className="size-3.5 mr-1" />}Create Room
            </Button>
          </Card>}
            <div className="space-y-2">
            {rooms.map(room => (
              <button
                key={room.id}
                className={`w-full text-left rounded-md border p-3 ${room.id === roomId ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'}`}
                onClick={() => setSearch({ room: room.id })}
              >
                <div className="font-medium text-sm">{displayRoomTitle(room, projects)}</div>
                {!isProjectScoped && (
                  <div className="text-xs text-muted-foreground mt-1">{projects.find(project => project.id === room.project_id)?.name ?? 'Project'}</div>
                )}
              </button>
            ))}
            </div>
          </aside>

          <Card className="p-8 text-center text-muted-foreground space-y-3">
            {/* Inside a Project with nothing set up yet, the honest next step
                is one button, not a form asking which Agent should manage a
                Room the user has not decided to have yet. */}
            {roomLoading ? (
              <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Loading Room…</span>
            ) : isProjectScoped && rooms.length === 0 ? (
              <>
                <p className="text-sm">Talk to this Project to move it forward.</p>
                <Button
                  disabled={creating}
                  onClick={() => openRoom({
                    project_id: projectFilter!,
                    project_folder_id: null,
                    title: defaultRoomTitle(projects.find(project => project.id === projectFilter)),
                  })}
                >
                  {creating ? <Loader2 className="size-4 mr-1 animate-spin" /> : <MessageSquarePlus className="size-4 mr-1" />}
                  Start a conversation
                </Button>
              </>
            ) : (
              'Choose or create a Room.'
            )}
          </Card>
          </div>
      ) : (
        <section className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)_240px]">
          <aside aria-label="Room and conversation navigation" className="space-y-3 lg:sticky lg:top-4">
            <Card className="p-3 space-y-3">
              <div>
                <CardTitle>{displayRoomTitle(detail.room, projects)}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {detail.user_members.length} people · {detail.agent_members.length} agents
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {boundFolderName ?? 'No project folder'}
                </p>
              </div>
              <div className="space-y-1 border-t border-border pt-2">
                <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Rooms</p>
                {rooms.map(room => (
                  <button
                    key={room.id}
                    className={`w-full rounded px-2 py-1.5 text-left text-sm ${room.id === roomId ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
                    onClick={() => setSearch({ room: room.id })}
                  >
                    {displayRoomTitle(room, projects)}
                  </button>
                ))}
              </div>
              <details className="border-t border-border pt-2">
                <summary className="flex h-8 cursor-pointer list-none items-center justify-center gap-1.5 rounded-md border border-border text-sm font-medium text-foreground hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
                  <Plus className="size-3.5" />New Room
                </summary>
                <div className="mt-3 space-y-2">
                  <div className="space-y-1"><Label>Title</Label><Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></div>
                  {!isProjectScoped && (
                    <div className="space-y-1">
                      <Label>Project</Label>
                      <Select
                        value={draft.project_id}
                        onChange={project_id => setDraft({ ...draft, project_id, project_folder_id: '' })}
                        options={[{ value: '', label: 'Choose Project' }, ...projects.map(project => ({ value: project.id, label: project.name }))]}
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label>Project Folder</Label>
                    <Select
                      value={draft.project_folder_id}
                      onChange={project_folder_id => setDraft({ ...draft, project_folder_id })}
                      options={[{ value: '', label: 'No folder' }, ...projectFolders.map(folder => ({ value: folder.id, label: folder.name }))]}
                    />
                  </div>
                  <Button className="w-full" size="sm" disabled={creating || !draft.title.trim() || !draft.project_id} onClick={createRoom}>
                    {creating ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Plus className="size-3.5 mr-1" />}Create Room
                  </Button>
                </div>
              </details>
            </Card>

            <Card className="p-2">
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Conversations</CardTitle>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={createConversation} aria-label="New conversation">
                  <MessageSquarePlus className="size-3.5 mr-1" />New
                </Button>
              </div>
              <nav aria-label="Conversations" className="mt-1 space-y-1">
                {conversations.map(conversation => (
                  <button
                    key={conversation.id}
                    className={`w-full rounded-md px-2.5 py-2 text-left text-sm leading-snug ${conversation.id === conversationId ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}`}
                    onClick={() => setSearch({ room: detail.room.id, conversation: conversation.id })}
                  >
                    {conversation.title || 'Conversation'}
                  </button>
                ))}
              </nav>
            </Card>

            {userId && (
              <details className="rounded-lg border border-border bg-card p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  People &amp; agents
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {detail.user_members.length + detail.agent_members.length}
                  </span>
                </summary>
                <div className="mt-4">
                  <RoomRosterPanel
                    detail={detail}
                    spaceMembers={spaceMembers}
                    userId={userId}
                    embedded
                    onChanged={async () => { await Promise.all([loadCatalog(), loadRoom()]) }}
                  />
                </div>
              </details>
            )}
          </aside>

          <main aria-label="Conversation" className="min-w-0">
            <Card className="flex h-[calc(100vh-10rem)] min-h-[640px] max-h-[900px] flex-col overflow-hidden">
              {!currentConversation ? (
                <div className="m-auto text-sm text-muted-foreground">Start or choose a conversation.</div>
              ) : (
                <>
                  <div className="border-b border-border px-5 py-3">
                    <CardTitle className="text-base">{currentConversation.title || 'Conversation'}</CardTitle>
                    <RoomSummaryFreshness summary={conversationSummary} isOwner={detail.user_members.some(member => member.user_id === userId && member.role === 'owner')} />
                  </div>
                  <div
                    ref={conversationScrollRef}
                    role="log"
                    aria-label="Conversation messages"
                    aria-live="polite"
                    className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4"
                    onScroll={event => {
                      const container = event.currentTarget
                      const distanceFromBottom = container.scrollHeight
                        - container.scrollTop
                        - container.clientHeight
                      followConversationRef.current = distanceFromBottom <= 80
                    }}
                  >
                    {messagesLoading && (
                      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />Loading conversation…
                      </div>
                    )}
                    {hasOlderMessages && (
                      <div className="text-center">
                        <Button variant="outline" size="sm" onClick={() => void loadOlderMessages()}>
                          Load older
                        </Button>
                      </div>
                    )}
                    {!messagesLoading && messages.length === 0 && <p className="text-sm text-muted-foreground text-center py-12">No messages yet.</p>}
                    {messages.map(message => (
                      <RoomMessageView
                        key={message.id}
                        message={message}
                        agents={[
                          ...roomAgents,
                          ...agents.filter(agent => !roomAgents.some(roomAgent => roomAgent.id === agent.id)),
                        ]}
                        humans={spaceMembers}
                        runs={runs}
                        progress={runProgress}
                        deltas={runDeltas}
                        onActionDecision={continueAfterProposalDecision}
                      />
                    ))}
                    {pendingProposalContinuation && (
                      <ProposalContinuationStatus
                        continuation={pendingProposalContinuation}
                        progress={runProgress}
                      />
                    )}
                  </div>
                  <div className="border-t border-border bg-card px-5 py-3 space-y-3">
                    <details>
                      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Run settings</summary>
                      <div className="mt-3 space-y-3 rounded-md bg-muted/30 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Label htmlFor="routing">Routing</Label>
                          <Select
                            className="w-48"
                            ariaLabel="Routing"
                            value={routingMode}
                            onChange={value => setRoutingMode(value as RoutingMode)}
                            options={[
                              { value: 'direct', label: 'Direct mentions' },
                              { value: 'agent_coordination', label: 'Agent coordination' },
                            ]}
                          />
                          <Badge variant="secondary">own backend</Badge>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {roomAgents.filter(agent => agent.kind !== 'system_assistant').map(agent => {
                            const catalog = backendCatalogs[agent.id]
                            const choices = backendChoices(catalog)
                            const selection = backendSelections[agent.id]
                            return (
                              <div key={agent.id} className="space-y-1">
                                <Label>{agent.name} backend</Label>
                                <Select
                                  value={selection ? backendSelectionValue(selection) : ''}
                                  onChange={value => setBackendSelections(current => ({
                                    ...current,
                                    [agent.id]: parseBackendSelection(value),
                                  }))}
                                  options={choices}
                                  disabled={choices.length === 0}
                                />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </details>
                    <RoomMessageComposer
                      value={composer}
                      onChange={setComposer}
                      agents={roomAgents}
                      members={detail.agent_members}
                      disabled={sending}
                      resetToken={resetToken}
                      onSubmit={sendMessage}
                    />
                    <div className="flex justify-end">
                      <Button disabled={sending || !composer.text.trim()} onClick={sendMessage}>
                        {sending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Send className="size-4 mr-1" />}Send
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </Card>
          </main>

          <aside aria-label="Project state" className="lg:col-start-2 xl:col-start-auto xl:sticky xl:top-4">
            <RoomProjectStatePanel overview={overview} />
          </aside>
        </section>
      )}
    </div>
  )
}

/**
 * Ambient "what's going on in this Project right now" beside the Room
 * conversation (plan Phase B): renders the same generic mode-projection +
 * attention contract the Project Overview page renders, so a Mode/domain
 * that already reports into that contract shows up here with no Room-side
 * change. Every row deep-links into the Area that owns it — this panel is
 * awareness, not a second command surface.
 */
function RoomProjectStatePanel({ overview }: { overview: ProjectOverview | null }) {
  if (!overview) {
    return <Card className="p-3 text-xs text-muted-foreground">Project state unavailable.</Card>
  }
  const { current_state_summary, next_actions } = overview.mode_projection
  const attention = overview.attention
  const initialized = overview.definition_status?.status === 'initialized'
    || (!overview.definition_status && Boolean(overview.brief?.goal))

  return (
    <Card className="p-3 space-y-4 overflow-auto max-h-[620px]">
      <div>
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Project state</CardTitle>
        <p className="mt-1 text-sm font-medium">
          {initialized ? 'Project initialized' : 'Project needs a goal or core problem'}
        </p>
        <p className="mt-1 text-sm">{current_state_summary}</p>
      </div>
      {next_actions.length > 0 && (
        <div>
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Next</CardTitle>
          <ul className="mt-1 space-y-1">
            {next_actions.map(action => (
              <li key={action.id}>
                <Link to={action.href} className="text-sm hover:underline">{action.label}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {attention.length > 0 && (
        <div>
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Needs attention</CardTitle>
          <ul className="mt-1 space-y-1">
            {attention.map(item => (
              <li key={item.id}>
                <Link to={item.href} className="text-sm hover:underline">{item.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {next_actions.length === 0 && attention.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing pending right now.</p>
      )}
    </Card>
  )
}

function ProposalContinuationStatus({
  continuation,
  progress,
}: {
  continuation: PendingProposalContinuation
  progress: Record<string, RunProgress>
}) {
  const activeProgress = continuation.runIds.reduce<RunProgress | undefined>(
    (latest, runId) => progress[runId] ?? latest,
    undefined,
  )
  const actionLabel = continuation.action === 'accept' ? '已接受' : '已拒绝'
  const statusText = continuation.phase === 'failed'
    ? `后续处理未能启动：${continuation.error || '未知错误'}`
    : continuation.phase === 'submitting'
      ? `${actionLabel}，正在启动下一步…`
      : activeProgress?.summary
        || (activeProgress ? lifecycleLabel(activeProgress.event_type) : `${actionLabel}，助手正在处理…`)

  return (
    <div className="flex justify-start" role="status" aria-live="polite">
      <div className={`max-w-[82%] rounded-lg border px-3 py-2 ${continuation.phase === 'failed'
        ? 'border-destructive/40 bg-destructive/5'
        : 'border-border bg-muted/30'}`}>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          {continuation.phase === 'failed'
            ? <Bot className="size-3.5" />
            : <Loader2 className="size-3.5 animate-spin" />}
          <span>系统状态</span>
        </div>
        <p className="text-sm">{statusText}</p>
      </div>
    </div>
  )
}

function RoomSummaryFreshness({
  summary,
  isOwner,
}: {
  summary: RoomConversationSummaryResponse | null
  isOwner: boolean
}) {
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
    <div className="mt-1 text-xs text-muted-foreground" role="status">
      <span>{label}</span>
      {state.status === 'waiting_provider' && isOwner && (
        <Link to="/providers" className="ml-2 underline">Configure provider</Link>
      )}
    </div>
  )
}

function RoomMessageView({
  message,
  agents,
  humans,
  runs,
  progress,
  deltas,
  onActionDecision,
}: {
  message: RoomMessage
  agents: Array<{ id: string; name: string; kind?: string }>
  humans: SpaceMember[]
  runs: Record<string, Run>
  progress: Record<string, RunProgress>
  deltas: Record<string, string>
  onActionDecision: (preview: ChatActionPreview, action: RoomActionDecision) => Promise<void>
}) {
  const runIds = metadataRunIds(message.metadata_json)
  const label = message.role === 'user'
    ? humans.find(member => member.user_id === message.user_id)?.display_name
      ?? humans.find(member => member.user_id === message.user_id)?.email
      ?? 'Person'
    : agents.find(agent => agent.id === message.sender_agent_id)?.name ?? 'Agent'
  return (
    <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[82%] rounded-lg border px-3 py-2 ${message.role === 'user' ? 'bg-primary/5 border-primary/20' : 'bg-card border-border'}`}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          {message.role === 'assistant' && <Bot className="size-3.5" />}
          <span>{label}</span>
          <span>{new Date(message.created_at).toLocaleTimeString()}</span>
        </div>
        <MarkdownMessage content={message.content} />
        {metadataActionPreviews(message.metadata_json).length > 0 && (
          <div className="mt-2 space-y-2">
            {metadataActionPreviews(message.metadata_json).map((preview, index) => (
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
                  <span className="max-w-md whitespace-pre-wrap text-xs text-muted-foreground">
                    {deltas[runId]}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function lifecycleLabel(eventType: string): string {
  return eventType.replace(/_/g, ' ')
}

function RoomRunStatusBadge({ run, fallbackStatus }: { run?: Run; fallbackStatus: string }) {
  const status = run?.status ?? fallbackStatus
  const authorization = status === 'waiting_for_review'
    && run?.error_json?.supervisor_review !== true
  const supervisorHold = status === 'waiting_for_review'
    && run?.error_json?.supervisor_review === true
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
  if (status === 'waiting_for_review') {
    return run?.error_json?.supervisor_review !== true
      ? 'Review request'
      : 'Resolve Run'
  }
  return 'Run details'
}

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

function uniqueMessages(messages: RoomMessage[]): RoomMessage[] {
  const seen = new Set<string>()
  return messages.filter(message => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

function compareCreatedNewestFirst(
  left: Pick<Room | RoomConversation, 'id' | 'created_at'>,
  right: Pick<Room | RoomConversation, 'id' | 'created_at'>,
): number {
  return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id)
}

function sortConversationsNewestFirst(conversations: RoomConversation[]): RoomConversation[] {
  return [...conversations].sort(compareCreatedNewestFirst)
}

function defaultRoomTitle(project: Pick<Project, 'name'> | undefined): string {
  return `${project?.name?.trim() || 'Project'} Room`
}

function displayRoomTitle(room: Room, projects: Project[]): string {
  if (room.title.trim().toLocaleLowerCase() !== 'project conversation') return room.title
  return defaultRoomTitle(projects.find(project => project.id === room.project_id))
}

function metadataRunIds(metadata: Record<string, unknown> | null | undefined): string[] {
  const value = metadata?.run_ids
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string')
  const runId = metadata?.run_id
  return typeof runId === 'string' ? [runId] : []
}

function metadataActionPreviews(metadata: Record<string, unknown> | null | undefined): ChatActionPreview[] {
  const value = metadata?.action_previews
  return Array.isArray(value) ? value as ChatActionPreview[] : []
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

async function loadAllPages<T>(
  fetchPage: (
    limit: number,
    offset: number,
  ) => Promise<{ items: T[] }>,
): Promise<T[]> {
  const items: T[] = []
  for (;;) {
    const page = await fetchPage(LIST_PAGE_SIZE, items.length)
    items.push(...page.items)
    if (page.items.length < LIST_PAGE_SIZE) return items
  }
}

function selectedBackend(catalog: ConversationBackendCatalog): BackendSelection | null {
  if (catalog.binding) {
    return {
      runtime_profile_id: catalog.binding.runtime_profile_id,
      credential_profile_id: catalog.binding.credential_profile_id ?? null,
    }
  }
  const option = catalog.options[0]
  if (!option) return null
  return {
    runtime_profile_id: option.runtime_profile_id,
    credential_profile_id: option.requires_cli_credential
      ? option.credential_profiles.find(profile => profile.is_default)?.id
        ?? option.credential_profiles[0]?.id
        ?? null
      : null,
  }
}

function newRoomCreationIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `room-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function backendChoices(catalog: ConversationBackendCatalog | undefined) {
  if (!catalog) return []
  return catalog.options.flatMap(option => {
    if (!option.requires_cli_credential) {
      const selection = {
        runtime_profile_id: option.runtime_profile_id,
        credential_profile_id: null,
      }
      return [{
        value: backendSelectionValue(selection),
        label: option.model_name ? `${option.name} · ${option.model_name}` : option.name,
      }]
    }
    return option.credential_profiles.map(profile => {
      const selection = {
        runtime_profile_id: option.runtime_profile_id,
        credential_profile_id: profile.id,
      }
      return {
        value: backendSelectionValue(selection),
        label: `${option.name} · ${profile.name}`,
      }
    })
  })
}

function backendSelectionValue(selection: BackendSelection): string {
  return `${selection.runtime_profile_id}|${selection.credential_profile_id ?? ''}`
}

function parseBackendSelection(value: string): BackendSelection {
  const [runtime_profile_id = '', credential = ''] = value.split('|', 2)
  return {
    runtime_profile_id,
    credential_profile_id: credential || null,
  }
}
