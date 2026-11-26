import { useCallback, useEffect, useRef, useState } from 'react'
import { takeReferences } from './pendingReferences'
import { useParams, useSearchParams } from 'react-router-dom'
import { Archive, ArchiveRestore, Trash2, ArrowLeft, Loader2, MessageSquare, MessageSquarePlus, RefreshCw, Users } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, projectFoldersApi, projectsApi, roomsApi, spacesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'
import { errMsg } from '../../lib/utils'
import type {
  ThreadReferencePick,
  AgentOut,
  ConversationExecutionSummary,
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
import { ConfirmDialog } from '../../components/ui/dialog'
import { EmptyState } from '../../components/ui/empty-state'
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { RoomRosterPanel } from './RoomRosterPanel'
import { RoomsIndex } from './RoomsIndex'
import { RoomConversationTrash } from './RoomConversationTrash'
import { LIST_PAGE_SIZE, loadAllPages } from './loadAllPages'
import { audienceLabel, conversationAudienceLabel, rosterCountsLabel, roomVisibilityLabel } from './audience'
import { displayRoomTitle as roomTitle } from './roomTitle'
import { CREATED_AGENT_PARAM } from '../projects/agentCreationReturn'
import { ConversationSurface } from '../conversation/ConversationSurface'
import { sortRoomConversations, useRoomConversationRefresh } from '../conversation/useRoomConversationRefresh'
import { useUnreadConversations } from '../conversation/useUnreadConversations'
import { ConversationStatusIndicator } from '../conversation/ConversationUnreadDot'
import { ConversationExecutionPreflight } from '../conversation/ConversationExecutionPreflight'
import { conversationInputSourcesFromExecutionSummary } from '../conversation/ConversationInputComposer'

import { useMobileBreakpoint, useMobileConversation } from '../conversation/mobile/useMobileConversation'
import { MobileConversationNavigation } from '../conversation/mobile/MobileConversationNavigation'

/**
 * A Project's Rooms, one Room, and one Room conversation.
 *
 * Three levels, each with its own URL so a link opens exactly what it names:
 *
 * - no `room` — the Rooms index: every Room the viewer is a member of, with
 *   who can see it and who is in it.
 * - `room` — that Room's conversation list, or its members with
 *   `view=members`. Entering a Room never jumps into its newest conversation.
 * - `room` + `conversation` (or `new=1`) — one conversation, naming its Room,
 *   with the way back to that Room's list. An existing deep link to a
 *   conversation keeps opening it directly.
 *
 * A Room is a visibility boundary (ADR 0018): its members are who can see; the
 * recipients a message names are who is asked, chosen in the composer.
 */
export default function AgentGroupsPage() {
  const { t } = useAppTranslation()
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
  const membersView = search.get('view') === 'members'
  const archivedView = search.get('view') === 'archived'
  const trashView = search.get('view') === 'trash'
  const createdAgentId = search.get(CREATED_AGENT_PARAM)
  /**
   * Deliberately composing a new conversation rather than simply having none
   * selected. "Nothing selected" is the Room's conversation list.
   */
  const startingNew = search.get('new') === '1'
  const inConversation = Boolean(roomId && (conversationId || startingNew))
  const mobile = useMobileBreakpoint()
  useMobileConversation(inConversation)
  // Read inside callbacks that must not depend on the current query string.
  const searchRef = useRef(search)
  useEffect(() => { searchRef.current = search }, [search])
  const projectFilter = projectRouteId || search.get('project') || undefined
  const unreadConversations = useUnreadConversations(activeSpaceId ?? undefined, projectFilter, Boolean(roomId))
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [spaceMembers, setSpaceMembers] = useState<SpaceMember[]>([])
  /**
   * Who may be invited into a Room here. Project-scoped, so it is loaded with
   * the Project rather than the Space catalog, and empty until then — the
   * roster panel simply offers nobody rather than offering the wrong people.
   */
  const [projectReaders, setProjectReaders] = useState<ProjectReader[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<RoomPendingApproval[]>([])
  const [detail, setDetail] = useState<RoomDetail | null>(null)
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [boundFolderName, setBoundFolderName] = useState<string | null>(null)
  const [conversationToDelete, setConversationToDelete] = useState<RoomConversationRecord | null>(null)
  const [archivedConversations, setArchivedConversations] = useState<RoomConversationRecord[]>([])
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [changingArchive, setChangingArchive] = useState<string | null>(null)
  const [conversations, setConversations] = useState<RoomConversationRecord[]>([])
  useRoomConversationRefresh(roomId, setConversations)
  const [draftConversationId, setDraftConversationId] = useState<string | null>(null)
  const locallyCommittedConversations = useRef(new Map<string, RoomConversationRecord>())
  const [executionReady, setExecutionReady] = useState(false)
  const [executionSummary, setExecutionSummary] = useState<ConversationExecutionSummary | null>(null)
  const catalogRequestSequence = useRef(0)
  const roomRequestSequence = useRef(0)
  const [roomLoading, setRoomLoading] = useState(false)
  const [roomLoadError, setRoomLoadError] = useState<string | null>(null)
  const loadCatalog = useCallback(async () => {
    if (!activeSpaceId) return
    const requestSequence = ++catalogRequestSequence.current
    const pendingApprovalsRequest: Promise<RoomPendingApprovalListResponse> = typeof roomsApi.pendingApprovals === 'function'
      ? roomsApi.pendingApprovals({ limit: 100 })
      : Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 })
    const [projectPage, agentList, members, approvalPage, readerPage] = await Promise.all([
      projectsApi.list({ status: 'active', limit: 100 }),
      agentsApi.list({ status: 'active' }),
      spacesApi.members(activeSpaceId),
      pendingApprovalsRequest,
      // Only meaningful inside a Project. Failure is not fatal: an empty
      // candidate list hides the invite control, which is the safe direction.
      projectFilter ? projectsApi.readers(projectFilter).catch(() => ({ readers: [] })) : Promise.resolve({ readers: [] }),
    ])
    if (requestSequence !== catalogRequestSequence.current) return
    const selectableAgents = agentList.filter(agent => agent.agent_kind !== 'system_assistant')
    setProjects(projectPage.items)
    setAgents(selectableAgents)
    setSpaceMembers(members)
    setProjectReaders(readerPage.readers)
    setPendingApprovals(approvalPage.items)
  }, [activeSpaceId, projectFilter])

  async function decidePendingApproval(item: RoomPendingApproval, decision: 'approved' | 'rejected') {
    try {
      await roomsApi.decideInvitation(item.room_id, item.invitation_id, {
        agent_id: item.agent_id,
        decision,
      })
      await loadCatalog()
      toast.success(decision === 'approved' ? t('collab_ui.room.approved') : t('collab_ui.room.rejected'))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  const loadRoom = useCallback(async () => {
    // A callback kept from an earlier Room (a roster change finishing after a
    // switch) must not load that Room over the one now selected.
    if (roomId !== searchRef.current.get('room')) return
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
      // Ambient Project state beside the conversation: the
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
          ?? t('collab_ui.conversation.folder_unavailable')
        : null,
    )
  }, [roomId, t])

  useEffect(() => {
    loadCatalog().catch(error => toast.error(errMsg(error)))
  }, [loadCatalog])

  /** Loads the Room, reporting a failure on the page and as a toast; a retry goes through here too. */
  const loadRoomReporting = useCallback(async (isCurrent: () => boolean = () => true) => {
    setRoomLoading(true)
    setRoomLoadError(null)
    try {
      await loadRoom()
    } catch (error) {
      if (!isCurrent()) return
      const message = errMsg(error)
      setRoomLoadError(message)
      toast.error(message)
    } finally {
      if (isCurrent()) setRoomLoading(false)
    }
  }, [loadRoom])

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setConversations([])
    setBoundFolderName(null)
    setOverview(null)
    setExecutionReady(false)
    setDraftConversationId(null)
    void loadRoomReporting(() => !cancelled)
    return () => { cancelled = true }
  }, [loadRoomReporting])

  useEffect(() => {
    if (!archivedView || !roomId) return
    let cancelled = false
    setArchivedConversations([])
    setArchiveError(null)
    setArchiveLoading(true)
    void loadAllPages((limit, offset) => roomsApi.conversations(roomId, { limit, offset, status: 'archived' }))
      .then(items => { if (!cancelled) setArchivedConversations(items) })
      .catch(error => { if (!cancelled) setArchiveError(errMsg(error)) })
      .finally(() => { if (!cancelled) setArchiveLoading(false) })
    return () => { cancelled = true }
  }, [archivedView, roomId])

  async function setConversationArchived(conversation: RoomConversationRecord, archive: boolean) {
    setChangingArchive(conversation.id)
    try {
      await roomsApi.setConversationArchived(conversation.room_id, conversation.id, archive, { spaceId: conversation.space_id })
      locallyCommittedConversations.current.delete(conversation.id)
      if (archive) setConversations(current => current.filter(item => item.id !== conversation.id))
      else setArchivedConversations(current => current.filter(item => item.id !== conversation.id))
      await loadRoom()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setChangingArchive(null)
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

  async function deleteConversation(conversation: RoomConversationRecord) {
    try {
      await roomsApi.deleteConversation(conversation.room_id, conversation.id, { spaceId: conversation.space_id })
      locallyCommittedConversations.current.delete(conversation.id)
      setConversations(current => current.filter(item => item.id !== conversation.id))
      setArchivedConversations(current => current.filter(item => item.id !== conversation.id))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  function deleteConversationButton(conversation: RoomConversationRecord) {
    const label = t('collab_ui.room.delete_conversation')
    return (
      <Button size="icon" variant="ghost" className="text-destructive" aria-label={label} title={label}
        disabled={conversation.is_running || changingArchive !== null} onClick={() => setConversationToDelete(conversation)}>
        <Trash2 className="size-4" />
      </Button>
    )
  }

  function openConversation(id: string) {
    if (!roomId) return
    setExecutionReady(false)
    setDraftConversationId(null)
    setSearch({ room: roomId, conversation: id })
  }

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
    // A send or draft that finishes after a switch belongs to the Room it was
    // made in: loadRoom restores it there, and it must not bind to this one.
    if (conversation.room_id !== searchRef.current.get('room')) return
    setConversations(current => sortConversationsNewestFirst(current.some(item => item.id === conversation.id)
      ? current.map(item => item.id === conversation.id ? { ...item, ...conversation } : item)
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

  const projectName = projects.find(project => project.id === (detail?.room.project_id ?? projectFilter))?.name
  const titleOf = (target: Pick<Room, 'title'>) => roomTitle(target, projectName)
  const rosterLine = detail
    ? rosterCountsLabel({ people: detail.user_members.filter(member => member.status === 'active').length, agents: detail.agent_members.length }, t)
    : ''
  const visibility = detail
    ? roomVisibilityLabel({ isMainline: detail.room.is_mainline, otherMemberNames: detail.other_member_names }, t)
    : ''
  const projectBase = `/projects/${detail?.room.project_id ?? projectFilter ?? ''}/rooms`
  const roomListHref = (view?: 'members') =>
    `${projectBase}?${new URLSearchParams({ room: roomId ?? '', ...(view ? { view } : {}) }).toString()}`

  const approvalsCard = pendingApprovals.length > 0 && (
    <Card className="border-warning/40 bg-warning/5 p-4">
      <CardTitle className="text-sm">{t('collab_ui.room.approvals')}</CardTitle>
      <div className="mt-2 space-y-2">
        {pendingApprovals.map(item => (
          <div key={`${item.invitation_id}:${item.agent_id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
            <div>
              <p>{t('collab_ui.room.approval_line', { agent: item.agent_name, room: item.room_title })}</p>
              <p className="text-xs text-muted-foreground">{t('collab_ui.room.approval_detail', { project: item.project_name, person: item.invitee_display_name || item.invitee_email || item.invitee_user_id })}</p>
              <p className="text-xs text-muted-foreground">{t(item.share_history ? 'collab_ui.room.approval_history_shared' : 'collab_ui.room.approval_history_kept')}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void decidePendingApproval(item, 'approved')}>{t('collab_ui.room.approve')}</Button>
              <Button size="sm" variant="outline" onClick={() => void decidePendingApproval(item, 'rejected')}>{t('collab_ui.room.reject')}</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )

  // ── Rooms index ─────────────────────────────────────────────────────────
  if (!roomId) {
    return (
      <div className="mx-auto max-w-[1600px] space-y-5 p-4 md:p-6">
        {approvalsCard}
        {projectFilter ? (
          <RoomsIndex
            projectId={projectFilter}
            projectName={projectName}
            onRoomOpened={room => setSearch({ room: room.id })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('collab_ui.rooms.load_failed')}</p>
        )}
      </div>
    )
  }

  if (!detail) {
    if (roomLoadError) {
      return (
        <div className="mx-auto max-w-[1600px] space-y-3 p-4 md:p-6">
          <BackToRooms href={projectBase} label={t('collab_ui.room.back')} />
          <p className="text-sm text-destructive">{t('collab_ui.room.load_failed', { error: roomLoadError })}</p>
          <Button variant="outline" size="sm" onClick={() => void loadRoomReporting()}>{t('collab_ui.common.retry')}</Button>
        </div>
      )
    }
    return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('collab_ui.room.loading')}</div>
  }

  const roomHeader = (
    <header className="space-y-3 border-b border-border pb-4">
      <BackToRooms href={projectBase} label={t('collab_ui.room.back')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            <Users className="size-5 shrink-0" />
            <span className="min-w-0 break-words">{titleOf(detail.room)}</span>
            {detail.room.is_mainline
              ? <Badge variant="secondary">{t('collab_ui.rooms.default_badge')}</Badge>
              : <Badge variant="outline">{t('collab_ui.rooms.limited_badge')}</Badge>}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('collab_ui.rooms.visible_to', { who: visibility })}
            {' · '}{rosterLine}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void Promise.all([loadCatalog(), loadRoom()]).catch(error => toast.error(errMsg(error)))}>
          <RefreshCw className="size-3.5" />{t('collab_ui.room.refresh')}
        </Button>
      </div>
    </header>
  )

  // ── One Room: its conversations, or its members ─────────────────────────
  if (!inConversation) {
    // Only someone who can delete here sees the bin; the server refuses others too.
    const showTrash = trashView && detail.viewer_can_write
    return (
      <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
        {approvalsCard}
        {roomHeader}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={membersView ? 'members' : archivedView ? 'archived' : showTrash ? 'trash' : 'conversations'} onValueChange={value => setSearch({ room: detail.room.id, ...(value === 'conversations' ? {} : { view: value }) })}>
            <TabsList
              aria-label={t('collab_ui.room.tabs')}
              className={detail.viewer_can_write ? 'max-sm:grid max-sm:h-auto max-sm:grid-cols-2 max-sm:gap-1' : undefined}
            >
              <TabsTrigger value="conversations">{t('collab_ui.room.tab_conversations')}</TabsTrigger>
              <TabsTrigger value="archived">{t('collab_ui.room.tab_archived')}</TabsTrigger>
              {detail.viewer_can_write && <TabsTrigger value="trash">{t('collab_ui.room.tab_trash')}</TabsTrigger>}
              <TabsTrigger value="members">{t('collab_ui.room.tab_members')}</TabsTrigger>
            </TabsList>
          </Tabs>
          {!membersView && !archivedView && !showTrash && (
            <Button size="sm" onClick={() => startConversation()}><MessageSquarePlus className="size-4" />{t('collab_ui.room.new_conversation')}</Button>
          )}
        </div>
        {membersView ? (
          userId && (
            <RoomRosterPanel
              detail={detail}
              spaceMembers={spaceMembers}
              projectReaders={projectReaders}
              userId={userId}
              createdAgentId={createdAgentId}
              onCreatedAgentHandled={() => setSearch({ room: detail.room.id, view: 'members' }, { replace: true })}
              onChanged={async () => { await Promise.all([loadCatalog(), loadRoom()]) }}
            />
          )
        ) : showTrash ? (
          <RoomConversationTrash roomId={detail.room.id} onRestored={loadRoom} />
        ) : archivedView ? (
          archiveLoading ? <p className="text-sm text-muted-foreground">{t('collab_ui.common.loading')}</p>
          : archiveError ? <p role="alert" className="text-sm text-destructive">{archiveError}</p>
          : archivedConversations.length === 0 ? <p className="text-sm text-muted-foreground">{t('collab_ui.room.no_archived_conversations')}</p>
          : <ul className="space-y-2">
            {archivedConversations.filter(item => item.room_id === detail.room.id).map(conversation => (
              <li key={conversation.id}>
                <Card className="mb-0 flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="truncate text-sm">{conversation.title || t('collab_ui.room.untitled')}</span>
                  {detail.viewer_can_write && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="icon" variant="ghost" aria-label={t('collab_ui.room.restore_conversation')} title={t('collab_ui.room.restore_conversation')} disabled={changingArchive !== null} onClick={() => void setConversationArchived(conversation, false)}>
                        <ArchiveRestore className="size-4" />
                      </Button>
                      {deleteConversationButton(conversation)}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        ) : roomLoading && conversations.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('collab_ui.common.loading')}</div>
        ) : conversations.length === 0 ? (
          <Card>
            <EmptyState
              title={t('collab_ui.room.empty_title')}
              description={t('collab_ui.room.empty_text')}
              action={<Button size="sm" onClick={() => startConversation()}><MessageSquarePlus className="size-4" />{t('collab_ui.room.new_conversation')}</Button>}
            />
          </Card>
        ) : (
          <nav aria-label={t('collab_ui.room.tab_conversations')} className="flex flex-col gap-3">
            {conversations.map(conversation => (
              <Card key={conversation.id} className="mb-0 flex items-center gap-1 py-0 pl-0 pr-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => openConversation(conversation.id)}
                >
                  <MessageSquare className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{conversation.title || t('collab_ui.room.untitled')}</p>
                    <p className="text-xs text-muted-foreground">{t(conversation.last_message_at ? 'collab_ui.room.last_message' : 'collab_ui.room.started', { when: formatDateTime(conversation.last_message_at ?? conversation.created_at) })}</p>
                  </div>
                  <ConversationStatusIndicator running={conversation.is_running} unread={unreadConversations.has(conversation.id)} />
                </button>
                {detail.viewer_can_write && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="icon" variant="ghost" aria-label={t('collab_ui.room.archive_conversation')} title={t('collab_ui.room.archive_conversation')} disabled={conversation.is_running || changingArchive !== null} onClick={() => void setConversationArchived(conversation, true)}>
                      <Archive className="size-4" />
                    </Button>
                    {deleteConversationButton(conversation)}
                  </div>
                )}
              </Card>
            ))}
          </nav>
        )}
        <ConfirmDialog
          open={conversationToDelete?.room_id === detail.room.id}
          onOpenChange={open => { if (!open) setConversationToDelete(null) }}
          title={t('collab_ui.room.delete_conversation')}
          description={t('collab_ui.room.delete_conversation_confirm')}
          confirmLabel={t('collab_ui.room.delete_conversation')}
          onConfirm={() => { if (conversationToDelete) void deleteConversation(conversationToDelete) }}
        />
      </div>
    )
  }

  // ── One conversation ─────────────────────────────────────────────────────
  // The server computes the audience once, with the definition the Project's
  // conversation list uses; this only words it.
  const roomAudience = audienceLabel({ otherMemberNames: detail.other_member_names, agentCount: detail.agent_count }, t)
  // Who reads the open conversation — narrower than the Room when it was
  // frozen — said the same way in the mobile header and the desktop heading.
  const conversationAudience = currentConversation?.audience?.restricted
    ? conversationAudienceLabel({ isMainline: detail.room.is_mainline, roomOtherMemberNames: detail.other_member_names, audience: currentConversation.audience }, t)
    : detail.room.is_mainline ? visibility : roomAudience
  return (
    <div className="project-room-conversation flex min-w-0 flex-col gap-4 p-4 md:p-6 lg:h-full lg:min-h-0 lg:overflow-hidden">
      {mobile && <MobileConversationNavigation
        title={currentConversation?.title || t('collab_ui.conversation.new')}
        room={titleOf(detail.room)} audience={visibility} conversationAudience={conversationAudience}
        conversations={conversations} selected={conversationId} unread={unreadConversations}
        onSelect={openConversation} onNew={() => startConversation()}
        onCarry={currentConversation ? () => startConversation([{ kind: 'thread', id: currentConversation.id }]) : undefined}
        carryLabel={t('collab_ui.conversation.carry')}
        back={<Button asChild size="sm" variant="ghost" className="min-h-11 min-w-11"><Link to={projectBase}><ArrowLeft className="size-5" /><span className="sr-only">{t('collab_ui.room.back')}</span></Link></Button>}
      >
        <Button asChild size="sm" variant="ghost"><Link to={roomListHref()}>{t('collab_ui.room.tab_conversations')}</Link></Button>
        <Button asChild size="sm" variant="ghost"><Link to={roomListHref('members')}><Users className="size-4" />{t('collab_ui.conversation.members_link')}</Link></Button>
        <RoomProjectStatePanel overview={overview} />
      </MobileConversationNavigation>}
      {(overview?.attention.length ?? 0) > 0 && <div className="conversation-mobile-attention max-h-[20dvh] shrink-0 overflow-y-auto px-2 lg:hidden"><RoomProjectStatePanel overview={overview} /></div>}
      {approvalsCard && <div className="conversation-approvals">{approvalsCard}</div>}
      <section className="grid min-w-0 grid-cols-1 items-start gap-4 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)_240px]">
        <aside aria-label={t('collab_ui.conversation.navigation')} className="conversation-desktop-navigation flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-hidden">
          <Card className="mb-0 shrink-0 space-y-3 p-3">
            <div className="space-y-1">
              <Link to={roomListHref()} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
                <ArrowLeft className="size-3.5" />{t('collab_ui.conversation.back', { room: titleOf(detail.room) })}
              </Link>
              <CardTitle>{titleOf(detail.room)}</CardTitle>
              <p className="text-xs text-muted-foreground">{visibility}</p>
              <p className="text-xs text-muted-foreground">{rosterLine}</p>
              <p className="truncate text-xs text-muted-foreground">{boundFolderName ?? t('collab_ui.conversation.no_folder')}</p>
              <Button asChild size="sm" variant="ghost" className="-ml-2">
                <Link to={roomListHref('members')}><Users className="size-3.5" />{t('collab_ui.conversation.members_link')}</Link>
              </Button>
            </div>
          </Card>

          <Card className="mb-0 flex min-h-0 flex-col p-2 lg:flex-1 lg:overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">{t('collab_ui.room.tab_conversations')}</CardTitle>
              <Button variant="ghost" size="sm" className="px-2" onClick={() => startConversation()} aria-label={t('collab_ui.room.new_conversation')}>
                <MessageSquarePlus className="size-3.5" />{t('collab_ui.conversation.new_short')}
              </Button>
            </div>
            <nav aria-label="Conversations" className="mt-1 min-h-0 max-h-[40dvh] space-y-1 overflow-y-auto overscroll-y-contain lg:max-h-none lg:flex-1">
              {conversations.map(conversation => (
                <button
                  type="button"
                  key={conversation.id}
                  className={`w-full rounded-md px-2.5 py-2 text-left text-sm leading-snug ${conversation.id === conversationId ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}`}
                  onClick={() => openConversation(conversation.id)}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{conversation.title || t('collab_ui.room.untitled')}</span>
                    <ConversationStatusIndicator running={conversation.is_running} unread={unreadConversations.has(conversation.id)} />
                  </span>
                </button>
              ))}
            </nav>
          </Card>
          <aside aria-label={t('collab_ui.conversation.project_state')} className="hidden max-h-[20dvh] shrink-0 overflow-y-auto overscroll-y-contain lg:block xl:hidden">
            <RoomProjectStatePanel overview={overview} />
          </aside>
        </aside>

        <main aria-label="Conversation" className="conversation-main min-w-0 lg:min-h-0 lg:overflow-hidden">
          <Card className="conversation-card mb-0 flex h-[calc(100dvh-12rem)] min-h-[280px] flex-col overflow-hidden lg:h-full lg:min-h-0">
            {!currentConversation && conversations.length > 0 && !startingNew ? (
              <div className="m-auto text-sm text-muted-foreground">{t('collab_ui.conversation.choose')}</div>
            ) : (
              <>
                <div className="conversation-desktop-heading shrink-0 border-b border-border px-4 py-3 md:px-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-base">
                        {currentConversation?.title || t('collab_ui.conversation.new')}
                      </CardTitle>
                      {/* Which Room this is, and who can see it — the fact a
                          reader needs before saying anything here. Who is
                          asked is a separate, per-message choice below. */}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('collab_ui.conversation.in_room', { room: titleOf(detail.room) })}
                        {' · '}{conversationAudience}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{t('collab_ui.conversation.recipients_hint')}</p>
                    </div>
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
                        <MessageSquarePlus className="size-3.5" />{t('collab_ui.conversation.carry')}
                      </Button>
                    )}
                  </div>
                </div>
                {/* The conversation itself is the shared module the Project
                    chat panel also renders; this page adds only what is the
                    page's — run settings and per-agent backends. Where a
                    message goes is shown and chosen in the composer. */}
                <ConversationSurface
                  spaceId={detail?.room.space_id}
                  roomId={detail.room.id}
                  // Null while the user is choosing the execution context
                  // for a new Conversation. The explicit setup action binds
                  // the draft before the first message is allowed to run.
                  conversationId={currentConversation?.id ?? null}
                  executionReady={executionReady}
                  participantAgentIds={executionSummary?.state==='initialized'?(executionSummary.runtimes?.length?executionSummary.runtimes:(executionSummary.runtime?[executionSummary.runtime]:[])).map(pin=>pin.agent_id):executionSummary?.participant_agent_ids}
                  inputFileSources={conversationInputSourcesFromExecutionSummary(executionSummary)}
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
                      onSummaryChange={setExecutionSummary}
                    />
                  )}
                  detail={detail}
                  variant="full"
                  agents={agents}
                  humans={spaceMembers}
                  isOwner={detail.user_members.some(member => member.user_id === userId && member.role === 'owner')}
                  references={referencesForThisThread}
                  onReferencesRejected={() => setPendingReferences(null)}
                  onConversationUpdated={upsertConversation}
                  siblingConversations={conversations}
                  // The same handoff import continuation uses: the picks
                  // remain in the Room-keyed draft until the user sends or
                  // discards them. Abandoning an unstarted draft leaves no
                  // message or execution run behind.
                  onUseInNewThread={startConversation}
                  onSent={() => {
                    // Consumed. Do not leave the pick on the draft. Pressing "New" puts
                    // `currentConversation` back to null and the same reference
                    // silently attaches to a second thread nobody picked it for.
                    if (referencesForThisThread) setPendingReferences(null)
                    if (referencesForThisThread) setDraftConversationId(null)
                  }}
                  onBeforeContinue={async () => {
                    const refreshed = await projectsApi.getOverview(detail.room.project_id).catch(() => null)
                    if (refreshed) setOverview(refreshed)
                  }}

                />
              </>
            )}
          </Card>
        </main>

        <aside aria-label={t('collab_ui.conversation.project_state')} className="conversation-desktop-state lg:hidden xl:col-start-auto xl:block xl:min-h-0 xl:overflow-y-auto xl:overscroll-y-contain">
          <RoomProjectStatePanel overview={overview} />
        </aside>
      </section>
    </div>
  )
}

function BackToRooms({ href, label }: { href: string; label: string }) {
  return (
    <Link to={href} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
      <ArrowLeft className="size-3.5" />{label}
    </Link>
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
  const { t } = useAppTranslation()
  if (!overview) {
    return <Card className="p-3 text-xs text-muted-foreground">{t('collab_ui.conversation.project_state_unavailable')}</Card>
  }
  const attention = overview.attention
  const initialized = overview.definition_status?.status === 'initialized'
    || (!overview.definition_status && Boolean(overview.brief?.goal))

  return (
    <Card className="max-h-[620px] space-y-4 overflow-auto p-3">
      <div>
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">{t('collab_ui.conversation.project_state')}</CardTitle>
        <p className="mt-1 text-sm font-medium">
          {initialized ? t('collab_ui.conversation.initialized') : t('collab_ui.conversation.needs_goal')}
        </p>
      </div>
      {attention.length > 0 && (
        <div>
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">{t('collab_ui.nav.needs_attention')}</CardTitle>
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
        <p className="text-xs text-muted-foreground">{t('collab_ui.conversation.nothing_pending')}</p>
      )}
    </Card>
  )
}

function sortConversationsNewestFirst(conversations: RoomConversationRecord[]): RoomConversationRecord[] {
  return sortRoomConversations(conversations)
}
