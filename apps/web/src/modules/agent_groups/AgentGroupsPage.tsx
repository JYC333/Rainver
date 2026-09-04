import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { takeReferences } from './pendingReferences'
import { useParams, useSearchParams } from 'react-router-dom'
import { Loader2, MessageSquarePlus, Plus, RefreshCw, Users } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, projectFoldersApi, projectsApi, roomsApi, spacesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  ThreadReferencePick,
  AgentOut,
  ConversationBackendCatalog,
  Project,
  ProjectFolder,
  ProjectOverview,
  ProjectReader,
  Room,
  RoomConversation as RoomConversationRecord,
  RoomDetail,
  RoomPendingApproval,
  RoomPendingApprovalListResponse,
  SpaceMember,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { LimitedRoomDialog } from './LimitedRoomDialog'
import { RoomRosterPanel } from './RoomRosterPanel'
import { audienceLabel } from './audience'
import { ConversationSurface, type ConversationBackendSelection, type RoutingMode } from '../conversation/ConversationSurface'
import { ConversationBackendSetupCard } from './conversation/ConversationBackendSetupCard'
import { ConversationExecutionPreflight } from '../conversation/ConversationExecutionPreflight'

type BackendSelection = {
  runtime_profile_id: string
  credential_profile_id: string | null
}
const LIST_PAGE_SIZE = 100

export default function AgentGroupsPage() {
  const { activeSpaceId, userId } = useSpace()
  const { projectId: projectRouteId } = useParams()
  const [search, setSearch] = useSearchParams()
  /**
   * References handed over by another page — an imported session's "Continue
   * in Rainver" — for the Conversation draft the user will explicitly open.
   *
   * Passed through session storage rather than the URL because it is a list,
   * not an id, and read once so a reload does not resurrect a pick the person
   * abandoned. Keyed by **Room** until the user explicitly opens a draft;
   * keying it at all is what stops this
   * state — which outlives every conversation switch on the page — from
   * attaching to the next Room someone opens.
   */
  const [pendingReferences, setPendingReferences] = useState<{ roomId: string; picks: ThreadReferencePick[] } | null>(() => {
    const referencedRoomId = search.get('room')
    if (search.get('reference') !== '1' || !referencedRoomId) return null
    const picks = takeReferences(referencedRoomId)
    return picks ? { roomId: referencedRoomId, picks } : null
  })
  const roomId = search.get('room')
  const conversationId = search.get('conversation')
  /**
   * Deliberately composing a new conversation rather than simply having none
   * selected. Without this the auto-select below would immediately re-open the
   * newest one, because "nothing selected" is also what a fresh arrival looks
   * like.
   */
  const startingNew = search.get('new') === '1'
  // Read inside callbacks that must not depend on the current query string.
  const searchRef = useRef(search)
  useEffect(() => { searchRef.current = search }, [search])
  const projectFilter = projectRouteId || search.get('project') || undefined
  const isProjectScoped = Boolean(projectRouteId)
  const [rooms, setRooms] = useState<Room[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [spaceMembers, setSpaceMembers] = useState<SpaceMember[]>([])
  /**
   * Who may be invited into a Room here. Project-scoped, so it is loaded with
   * the Project rather than the Space catalog, and empty until then — the
   * roster panel simply offers nobody rather than offering the wrong people.
   */
  const [projectReaders, setProjectReaders] = useState<ProjectReader[]>([])
  const [openingLimitedRoom, setOpeningLimitedRoom] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState<RoomPendingApproval[]>([])
  const [detail, setDetail] = useState<RoomDetail | null>(null)
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [boundFolderName, setBoundFolderName] = useState<string | null>(null)
  const [conversations, setConversations] = useState<RoomConversationRecord[]>([])
  const [draftConversationId, setDraftConversationId] = useState<string | null>(null)
  const locallyCommittedConversations = useRef(new Map<string, RoomConversationRecord>())
  const [executionReady, setExecutionReady] = useState(false)
  const locallyCommittedRooms = useRef(new Map<string, Room>())
  const catalogRequestSequence = useRef(0)
  const roomRequestSequence = useRef(0)
  const [backendCatalogs, setBackendCatalogs] = useState<Record<string, ConversationBackendCatalog>>({})
  const [backendSelections, setBackendSelections] = useState<Record<string, BackendSelection>>({})
  const [loading, setLoading] = useState(true)
  const [roomLoading, setRoomLoading] = useState(false)
  const [roomLoadError, setRoomLoadError] = useState<string | null>(null)
  /** A retry of the catalog load is in flight; the empty state's button waits on it. */
  const [retrying, setRetrying] = useState(false)
  const [roomSetupTargets, setRoomSetupTargets] = useState<string[]>([])
  const [routingMode, setRoutingMode] = useState<RoutingMode>('direct')
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
      // Only meaningful inside a Project. Failure is not fatal: an empty
      // candidate list hides the invite control, which is the safe direction.
      projectFilter ? projectsApi.readers(projectFilter).catch(() => ({ readers: [] })) : Promise.resolve({ readers: [] }),
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

    const [projectPage, agentList, members, approvalPage, readerPage] = await supportingCatalogRequest
    if (requestSequence !== catalogRequestSequence.current) return
    const selectableAgents = agentList.filter(agent => agent.agent_kind !== 'system_assistant')
    setProjects(projectPage.items)
    setAgents(selectableAgents)
    setSpaceMembers(members)
    setProjectReaders(readerPage.readers)
    setPendingApprovals(approvalPage.items)
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
      locallyCommittedConversations.current.clear()
      setBoundFolderName(null)
      setOverview(null)
      setExecutionReady(false)
      setDraftConversationId(null)
      return
    }
    const conversationsRequest = loadAllPages((limit, offset) =>
      roomsApi.conversations(roomId, { limit, offset }))
    const nextDetail = await roomsApi.get(roomId)
    const allConversations = await conversationsRequest
    if (requestSequence !== roomRequestSequence.current) return
    setDetail(nextDetail)
    const observedConversationIds = new Set(allConversations.map(conversation => conversation.id))
    for (const conversationId of observedConversationIds) locallyCommittedConversations.current.delete(conversationId)
    const pendingConversations = [...locallyCommittedConversations.current.values()].filter(conversation => conversation.room_id === roomId)
    const mergedConversations = [...allConversations, ...pendingConversations.filter(conversation => !observedConversationIds.has(conversation.id))]
    setConversations(current => sortConversationsNewestFirst(mergedConversations.map(conversation => {
      const locallyUpdated = current.find(item => item.id === conversation.id)
      return locallyUpdated
        && Date.parse(locallyUpdated.updated_at) > Date.parse(conversation.updated_at)
        ? locallyUpdated
        : conversation
    })))

    const [folderPage, nextOverview] = await Promise.all([
      nextDetail.room.project_folder_id
        ? projectFoldersApi.listExecutionReady(nextDetail.room.project_id, {
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
    setExecutionReady(false)
    setDraftConversationId(null)
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
      || startingNew
      || detail?.room.id !== roomId
      || conversations.length === 0
    ) return
    setSearch(current => {
      const next = new URLSearchParams(current)
      next.set('room', roomId)
      next.set('conversation', conversations[0]!.id)
      return next
    }, { replace: true })
  }, [conversationId, conversations, detail, roomId, setSearch, startingNew])

  useEffect(() => {
    if (!detail) {
      setBackendCatalogs({})
      setBackendSelections({})
      return
    }
    let cancelled = false
    Promise.all(detail.agent_members
      .filter(member => member.agent_kind !== 'system_assistant')
      .map(async member => ({
        agentId: member.agent_id,
        // Without a session id the server returns the options with no stored
        // binding, which is exactly right while the user is reviewing a new
        // Conversation draft. Once opened, the draft's pinned selection is
        // fetched by the execution preflight.
        catalog: await agentsApi.conversationBackends(member.agent_id, {
          ...(conversationId ? { sessionId: conversationId } : {}),
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

  /**
   * Take up a Room the dialog just created.
   *
   * The retention matters and is why this is not just a navigation: the Room
   * is already committed, so it is held locally before any follow-up read. A
   * lagging detail load or a failed catalog refresh would otherwise restore
   * the empty state and invite somebody to create a second one.
   */
  async function takeUpRoom(room: Room): Promise<void> {
    setRoomSetupTargets([])
    locallyCommittedRooms.current.set(room.id, room)
    setRooms(current => current.some(item => item.id === room.id) ? current : [...current, room])
    setSearch({ room: room.id })
    try {
      await loadCatalog()
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  /**
   * Start a thread, optionally carrying picked content into it.
   *
   * Deselect, rather than create: the explicit preflight opens a draft only
   * after the user asks for it, so this only clears the composer and setup
   * state; `upsertConversation` still binds any server-created conversation.
   *
   * Starting one *without* picks drops any that were held — they were made
   * for a thread the person then abandoned, and re-arming them later would
   * attach content to a thread nobody chose it for. Except when the unstarted
   * thread they were made for is the one already open: pressing "New" there
   * is a no-op, and a no-op must not destroy the draft it is looking at.
   */
  function startConversation(picks?: ThreadReferencePick[]) {
    if (!roomId) return
    setDraftConversationId(null)
    const alreadyOnTheirThread = !currentConversation && pendingReferences?.roomId === roomId
    if (picks?.length) setPendingReferences({ roomId, picks })
    else if (!alreadyOnTheirThread) setPendingReferences(null)
    setSearch({ room: roomId, new: '1' })
    setExecutionReady(false)
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
  /**
   * The picks this render hands to the composer, if any.
   *
   * Only into the unstarted conversation they were made for; never onto a
   * thread that already exists. One binding rather than two copies of the
   * condition, because the send handler has to know whether this render was
   * the one that used them before it may clear them.
   */
  const referencesForThisThread = detail && pendingReferences
    && pendingReferences.roomId === detail.room.id
    && (!currentConversation || draftConversationId === currentConversation.id)
    ? pendingReferences.picks
    : undefined
  const upsertConversation = useCallback((conversation: RoomConversationRecord) => {
    locallyCommittedConversations.current.set(conversation.id, conversation)
    setConversations(current => sortConversationsNewestFirst(current.some(item => item.id === conversation.id)
      ? current.map(item => item.id === conversation.id ? conversation : item)
      : [...current, conversation]))
    // Bind the server-returned Conversation so subsequent sends continue the
    // selected thread rather than changing the URL on every refresh.
    //
    // Guarded outside the updater: `setSearchParams` navigates unconditionally,
    // so returning `current` unchanged would still re-render every consumer of
    // the location — on every poll tick, for as long as a conversation is open.
    if (searchRef.current.get('conversation') === conversation.id) return
    setSearch(current => {
      const next = new URLSearchParams(current)
      next.set('conversation', conversation.id)
      next.delete('new')
      return next
    }, { replace: true })
  }, [setSearch])
  // The server computes the audience once, with the definition the Project's
  // conversation list uses; this only words it.
  const roomAudience = detail
    ? audienceLabel({ otherMemberNames: detail.other_member_names, agentCount: detail.agent_count })
    : ''
  const backendsFor = useCallback((recipientAgentIds: string[]): ConversationBackendSelection[] =>
    conversationId ? [] :
    recipientAgentIds.flatMap(agent_id => {
      const selection = backendSelections[agent_id]
      return selection ? [{ agent_id, ...selection }] : []
    }), [backendSelections, conversationId])

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
        <Button variant="outline" size="sm" onClick={() => Promise.all([loadCatalog(), loadRoom()])}>
          <RefreshCw className="size-3.5 mr-1" />Refresh
        </Button>
      </header>

      {roomSetupTargets.length > 0 && (
        <ConversationBackendSetupCard setupTargets={roomSetupTargets} />
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
            {roomLoading ? (
              <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />Loading Room…</span>
            ) : isProjectScoped && rooms.length === 0 ? (
              // Since every Project is created with its mainline (ADR 0018
              // decision 4), a Project showing none has failed to load them.
              // The button that used to be here created a Room, which would
              // now mean a second shared one beside the mainline it could not
              // see.
              <>
                <p className="text-sm">Could not load this Project's conversations.</p>
                <Button
                  variant="outline"
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true)
                    void loadCatalog().finally(() => setRetrying(false))
                  }}
                >
                  {retrying ? <Loader2 className="size-4 mr-1 animate-spin" /> : null}
                  Try again
                </Button>
              </>
            ) : (
              'Choose a Room.'
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
              {detail.viewer_can_write && (
                <Button
                  className="w-full"
                  size="sm"
                  variant="outline"
                  onClick={() => setOpeningLimitedRoom(true)}
                >
                  <Plus className="size-3.5 mr-1" />New Room
                </Button>
              )}
              <LimitedRoomDialog
                open={openingLimitedRoom}
                projectId={detail.room.project_id}
                onClose={() => setOpeningLimitedRoom(false)}
                onOpened={room => {
                  setOpeningLimitedRoom(false)
                  void takeUpRoom(room)
                }}
              />
            </Card>

            <Card className="p-2">
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Conversations</CardTitle>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => startConversation()} aria-label="New conversation">
                  <MessageSquarePlus className="size-3.5 mr-1" />New
                </Button>
              </div>
              <nav aria-label="Conversations" className="mt-1 space-y-1">
                {conversations.map(conversation => (
                  <button
                    key={conversation.id}
                    className={`w-full rounded-md px-2.5 py-2 text-left text-sm leading-snug ${conversation.id === conversationId ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}`}
                    onClick={() => {
                      setExecutionReady(false)
                      setDraftConversationId(null)
                      setSearch({ room: detail.room.id, conversation: conversation.id })
                    }}
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
                    projectReaders={projectReaders}
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
              {!currentConversation && conversations.length > 0 && !startingNew ? (
                <div className="m-auto text-sm text-muted-foreground">Choose a conversation.</div>
              ) : (
                <>
                  <div className="border-b border-border px-5 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">
                        {currentConversation?.title || 'New conversation'}
                      </CardTitle>
                      {currentConversation && (
                        // The whole thread, at the grain a whole thread has:
                        // its summary. Thousands of words of transcript have
                        // no other bounded form, and the per-message picker
                        // beside it is for when a few messages are what
                        // actually matters.
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0 text-xs"
                          onClick={() => {
                            startConversation([{ kind: 'thread', id: currentConversation.id }])
                          }}
                        >
                          <MessageSquarePlus className="size-3.5 mr-1" />Carry into a new thread
                        </Button>
                      )}
                    </div>
                    {/* A limited Room's header names its audience, because
                        that is the fact a reader needs before saying anything
                        in it. The mainline needs none: everyone in the Project
                        is in it, which is what makes it the mainline. */}
                    {!detail.room.is_mainline && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{roomAudience}</p>
                    )}
                  </div>
                  {/* The conversation itself is the shared module the Project
                      chat panel also renders; this page adds only what is the
                      page's — routing and per-agent backends. */}
                  <ConversationSurface
                    roomId={detail.room.id}
                    // Null while the user is choosing the execution context
                    // for a new Conversation. The explicit setup action binds
                    // the draft before the first message is allowed to run.
                    conversationId={currentConversation?.id ?? null}
                    executionReady={executionReady}
                    executionPreflight={(
                      <ConversationExecutionPreflight
                        projectId={detail.room.project_id}
                        roomId={detail.room.id}
                        sessionId={currentConversation?.id ?? null}
                        detail={detail}
                        onConversationCreated={conversation => {
                          setDraftConversationId(conversation.id)
                          upsertConversation(conversation)
                          setExecutionReady(false)
                        }}
                        onNewConversation={() => startConversation()}
                        onReadyChange={setExecutionReady}
                      />
                    )}
                    detail={detail}
                    variant="full"
                    agents={agents}
                    humans={spaceMembers}
                    routingMode={routingMode}
                    backendsFor={backendsFor}
                    backendCatalogs={backendCatalogs}
                    isOwner={detail.user_members.some(member => member.user_id === userId && member.role === 'owner')}
                    references={referencesForThisThread}
                    onReferencesRejected={() => setPendingReferences(null)}
                    onConversationUpdated={upsertConversation}
                    onBackendRequired={setRoomSetupTargets}
                    siblingConversations={conversations}
                    // The same handoff import continuation uses: the picks
                    // remain in the Room-keyed draft until the user sends or
                    // discards them. Abandoning an unstarted draft leaves no
                    // message or execution run behind.
                    onUseInNewThread={startConversation}
                    onSent={() => {
                      setRoomSetupTargets([])
                      // Consumed. Without this the pick outlives the thread it
                      // was made for: pressing "New" puts `currentConversation`
                      // back to null and the same reference silently attaches
                      // to a second thread nobody picked it for.
                      if (referencesForThisThread) setPendingReferences(null)
                      if (referencesForThisThread) setDraftConversationId(null)
                    }}
                    onBeforeContinue={async () => {
                      const refreshed = await projectsApi.getOverview(detail.room.project_id).catch(() => null)
                      if (refreshed) setOverview(refreshed)
                    }}
                    runSettings={(
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
                            {!currentConversation && roomAgents.filter(agent => agent.kind !== 'system_assistant').map(agent => {
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
                                    disabled={choices.length === 0 || Boolean(currentConversation)}
                                  />
                                  {currentConversation && <p className="text-[11px] text-muted-foreground">Pinned by this Conversation; start a new Conversation to change it.</p>}
                                </div>
                              )
                            })}
                            {currentConversation && (
                              <p className="text-[11px] text-muted-foreground sm:col-span-2">
                                Runtime pins are fixed for this Conversation and are shown in the execution context above.
                              </p>
                            )}
                          </div>
                        </div>
                      </details>
                    )}
                  />
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
 * conversation: whether the Project has a goal, and what needs attention —
 * the same list Pulse and the shell show, so it cannot disagree with them.
 * Every row deep-links into the Area that owns it; this panel is awareness,
 * not a second command surface.
 */
function RoomProjectStatePanel({ overview }: { overview: ProjectOverview | null }) {
  if (!overview) {
    return <Card className="p-3 text-xs text-muted-foreground">Project state unavailable.</Card>
  }
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
      </div>
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
      {attention.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing pending right now.</p>
      )}
    </Card>
  )
}

function compareCreatedNewestFirst(
  left: Pick<Room | RoomConversationRecord, 'id' | 'created_at'>,
  right: Pick<Room | RoomConversationRecord, 'id' | 'created_at'>,
): number {
  return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id)
}

function sortConversationsNewestFirst(conversations: RoomConversationRecord[]): RoomConversationRecord[] {
  return [...conversations].sort(compareCreatedNewestFirst)
}

function defaultRoomTitle(project: Pick<Project, 'name'> | undefined): string {
  return `${project?.name?.trim() || 'Project'} Room`
}

function displayRoomTitle(room: Room, projects: Project[]): string {
  if (room.title.trim().toLocaleLowerCase() !== 'project conversation') return room.title
  return defaultRoomTitle(projects.find(project => project.id === room.project_id))
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
  const option = catalog.options.find(candidate => candidate.usable !== false) ?? catalog.options[0]
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

function backendChoices(catalog: ConversationBackendCatalog | undefined) {
  if (!catalog) return []
  return catalog.options.flatMap(option => {
    const statusSuffix = option.host_bound && option.host_name
      ? ` · on ${option.host_name}`
      : ''
    const reasonSuffix = option.usable === false && option.reason
      ? ` — ${option.reason}`
      : ''
    const disabled = option.usable === false
    if (!option.requires_cli_credential) {
      const selection = {
        runtime_profile_id: option.runtime_profile_id,
        credential_profile_id: null,
      }
      return [{
        value: backendSelectionValue(selection),
        label: `${option.model_name ? `${option.name} · ${option.model_name}` : option.name}${statusSuffix}${reasonSuffix}`,
        disabled,
      }]
    }
    return option.credential_profiles.map(profile => {
      const selection = {
        runtime_profile_id: option.runtime_profile_id,
        credential_profile_id: profile.id,
      }
      return {
        value: backendSelectionValue(selection),
        label: `${option.name} · ${profile.name}${statusSuffix}${reasonSuffix}`,
        disabled,
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
