import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, Check, ChevronDown, ChevronUp, FileCode2, MessageSquare, PanelRightClose, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { CONVERSATION_MAX_FILE_SNAPSHOT_BYTES } from '@rainver/protocol'
import { projectsApi, roomsApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import { useAppTranslation } from '../../../i18n'
import { SpaceLink as Link } from '../../../core/spaceNav'
import type { ConversationExecutionSummary, ProjectOverview, ProjectRoomSummary, Room, RoomConversation as RoomConversationRecord } from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { DialogClose } from '../../../components/ui/dialog'
import { conversationAudienceLabel, roomVisibilityLabel } from '../../agent_groups/audience'
import { SidecarNavigator, sidecarRoomName, type SidecarTab } from './SidecarNavigator'
import { PROJECT_CHAT_OPEN_EVENT, type ProjectChatOpenDetail } from './projectChatOpen'
import { sortRoomConversations, useRoomConversationRefresh } from '../../conversation/useRoomConversationRefresh'
import { useUnreadConversations } from '../../conversation/useUnreadConversations'
import { Skeleton } from '../../../components/ui/skeleton'
import { useProjectFolderConversation, type CurrentFileAttachment } from '../ProjectFolderConversationContext'

/**
 * Talking to the Project's Agent without leaving what you are looking at.
 * The sidecar carries the current focus — see `focusRefsFor`.
 *
 * It opens on the Project's **mainline** Room — the one every Project member
 * belongs to — unless the viewer chose another of their Rooms here (the Rooms
 * tab), which is remembered per Project. Nothing else switches the Room under
 * them: a stored Room they can no longer read falls back to the mainline.
 * It renders the Room's
 * own conversation, not a private one: a teammate opening the full Room sees
 * what was said here. The rich Room surface (run progress,
 * action previews, roster, invitations) stays on that page; this is the daily
 * exchange, and putting the whole apparatus in a side panel would make it a
 * worse Room rather than a better sidecar.
 */

import { inProjectHref } from '../taskHref'
import { useMobileBreakpoint, useMobileConversation } from '../../conversation/mobile/useMobileConversation'
import { MobileConversationNavigation, MobileConversationBack } from '../../conversation/mobile/MobileConversationNavigation'

import { useConversationOverlay } from '../../conversation/mobile/useConversationOverlay'

const STORAGE_PREFIX = 'project.sidecar'

// The conversation stack (composer editor, message rendering, highlighting)
// is the heaviest part of the Project shell. A static import made every
// Project page wait for it before its first paint. The panel shows a skeleton
// until its Room reads resolve anyway, so the module loads in parallel with
// them. It is held in state rather than behind <Suspense>: React throttles
// every Suspense reveal for 300 ms after any fallback commits, so a fallback
// here would also hold back the Project page beside the panel.
type SidecarConversation = typeof import('./ProjectSidecarConversation').default
let loadedConversation: SidecarConversation | null = null
let conversationLoad: Promise<SidecarConversation> | null = null
function loadConversation(): Promise<SidecarConversation> {
  conversationLoad ??= import('./ProjectSidecarConversation').then(module => (loadedConversation = module.default))
  // A failed chunk can be retried on the next open.
  conversationLoad.catch(() => { conversationLoad = null })
  return conversationLoad
}
// From `lg` up the panel opens beside the page by default, so start the load
// with this module rather than after the layout's first commit: it then
// overlaps React's reveal of the Project page instead of following it.
if (typeof window !== 'undefined' && !window.matchMedia?.('(max-width: 1023px)').matches) {
  void loadConversation().catch(() => { /* retried when the panel opens */ })
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function defaultOpen(key: string): boolean {
  const stored = readStored(key)
  if (stored !== null) return stored === 'true'
  return true
}
/** Width bounds, in px: narrower than this the composer wraps into uselessness, wider it eats the page. */
const MIN_WIDTH = 288
const MAX_WIDTH = 640
const DEFAULT_WIDTH = 352
const WIDTH_KEY = `${STORAGE_PREFIX}.width`

function storedWidth(): number {
  const value = Number(readStored(WIDTH_KEY))
  return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : DEFAULT_WIDTH
}

function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

/**
 * What the person is looking at, from the route alone.
 *
 * A Task page focuses that Task; anywhere else focuses nothing, because the
 * Room is already bound to the Project and saying so again adds no
 * information. It is a hint the server states in the turn, never a filter —
 * the Agent's retrieval keeps its Project scope either way.
 */
export function focusRefsFor(pathname: string): Array<{ type: 'task'; id: string }> {
  const task = /\/tasks\/([^/?#]+)/.exec(pathname)
  return task?.[1] ? [{ type: 'task', id: task[1] }] : []
}

export default function ProjectChatSidecar({ attention = [] }: { attention?: ProjectOverview['attention'] }) {
  const { t } = useAppTranslation()
  const { projectId = '', spaceId } = useParams()
  const requestScope = useMemo(() => ({ spaceId }), [spaceId])
  const { pathname, search } = useLocation()
  // The Rooms Area is already a Room, usually this one. Do not show two live
  // views of the same conversation side by side.
  const onRoomsArea = /\/rooms(\/|$)/.test(pathname)
  const onFilesArea = /\/files(\/|$)/.test(pathname)

  const openKey = `${STORAGE_PREFIX}.${projectId}.open`
  const roomKey = `${STORAGE_PREFIX}.${projectId}.room`
  const conversationKey = (roomId: string) => `${STORAGE_PREFIX}.room.${roomId}.conversation`
  // Open unless this person closed it for this Project: conversation is the
  // way in, so the panel is there on first arrival rather than a button —
  // where it sits *beside* the page. Below `lg` it overlays the page, and an
  // overlay that opens itself on a phone covers the Pulse someone came for.
  const mobileChat = useConversationOverlay('projectChat')
  const [desktopOpen, setDesktopOpen] = useState(() => defaultOpen(openKey))
  const mobile = useMobileBreakpoint()
  // The page (pathname) on which a phone chat the person opened was carried
  // beside the page by widening. Narrowed again on that page, the chat is
  // still the one they opened: it stays open, without a history entry, and
  // closes in place. Closing it at either width, or leaving the page, ends it.
  const [carried, setCarried] = useState<string | null>(null)
  const carriedOpen = carried === pathname
  const open = mobile ? mobileChat.open || carriedOpen : desktopOpen
  const setOpen = (value: boolean) => {
    if (!value) setCarried(null)
    if (!mobile) setDesktopOpen(value)
    else if (value) mobileChat.show()
    else if (mobileChat.open) mobileChat.close()
  }
  useEffect(() => { if (carried && carried !== pathname) setCarried(null) }, [carried, pathname])
  // Widened past the phone breakpoint while the phone chat is open: the panel
  // carries on beside the page and the overlay's `?projectChat=1` entry goes,
  // together with the phone conversation drawer's `?conversationDrawer=1` if
  // it was open over it (the drawer unmounts with the phone layout, so it
  // cannot close its own). No overlay entry is left for Back or Forward to land on.
  // A carried chat has no entry of its own, but a drawer opened over it does.
  // The drawer exists only in the phone layout, so a wide screen that reaches
  // a drawer entry any other way (Forward, a link) closes it too.
  const drawerOpen = new URLSearchParams(search).get('conversationDrawer') === '1'
  useEffect(() => {
    if (mobile) return
    if (mobileChat.open) {
      writeStored(openKey, 'true')
      setDesktopOpen(true)
      setCarried(pathname)
      mobileChat.close(undefined, { with: ['conversationDrawer'] })
    } else if (drawerOpen) mobileChat.close(undefined, { with: ['conversationDrawer'] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, mobileChat.open, openKey, drawerOpen])
  // Remembered per browser, not per Project: how wide you like the panel is
  // about your screen, not about the work.
  useMobileConversation(open && !onRoomsArea)
  const [width, setWidth] = useState(storedWidth)
  useEffect(() => { writeStored(WIDTH_KEY, String(width)) }, [width])
  const asideRef = useRef<HTMLElement | null>(null)
  // The panel must never lengthen the page. The app's scroll container is the
  // shell's <main>, which sits under a header of unknown height, so the only
  // honest way to give the panel a bounded height is to measure that
  // container and stick the panel to its top; the message list then scrolls
  // inside it. Measured, not assumed, and re-measured as the window changes.
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    const scroller = asideRef.current?.closest('main')
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const measure = () => setHeight(scroller.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [open, onRoomsArea])

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (moveEvent: PointerEvent) => {
      // The handle is on the panel's left edge, so dragging left widens it.
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - moveEvent.clientX))))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
  }, [width])
  const [room, setRoom] = useState<Room | null>(null)
  // The Room the viewer chose in the Rooms tab; null is the mainline.
  const [chosenRoomId, setChosenRoomId] = useState<string | null>(() => readStored(roomKey))
  // A conversation a caller asked to open (`openProjectChat`), consumed once.
  const pendingConversation = useRef<string | null>(null)
  const [roomOtherMembers, setRoomOtherMembers] = useState<string[]>([])
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  // Bumped by `openProjectChat` naming the Room already shown: its roster or
  // conversations may just have changed (a plugin setup added an Agent), and
  // an unchanged Room id alone would not read them again.
  const [reloadToken, setReloadToken] = useState(0)
  const [navigatorTab, setNavigatorTab] = useState<SidecarTab>('conversations')
  const [rooms, setRooms] = useState<ProjectRoomSummary[] | null>(null)
  const [roomsFailure, setRoomsFailure] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [conversations, setConversations] = useState<RoomConversationRecord[]>([])
  const unreadConversations = useUnreadConversations(spaceId, projectId, open && !onRoomsArea)
  useRoomConversationRefresh(open && !onRoomsArea ? room?.id ?? null : null, setConversations, requestScope)
  const [sessionId, setSessionId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [ProjectSidecarConversation, setConversationComponent] = useState<SidecarConversation | null>(() => loadedConversation)
  const [executionReady, setExecutionReady] = useState(false)
  const [executionSummary, setExecutionSummary] = useState<ConversationExecutionSummary | null>(null)
  const { selectedFolderId, setConversationFolderIds, currentFileAttachment } = useProjectFolderConversation()
  const [currentFileIncluded, setCurrentFileIncluded] = useState(true)

  useEffect(() => {
    setCurrentFileIncluded(true)
  }, [currentFileAttachment?.sourceKey])

  const conversationFolderIds = useMemo(() => {
    if (executionSummary?.state !== 'initialized') return null
    const ids: string[] = []
    if (executionSummary.primary?.kind === 'location') ids.push(executionSummary.primary.project_folder_id)
    ids.push(...executionSummary.attachments
      .filter(attachment => attachment.status === 'active')
      .map(attachment => attachment.project_folder_id))
    return Array.from(new Set(ids))
  }, [executionSummary])

  useEffect(() => {
    setConversationFolderIds(conversationFolderIds)
  }, [conversationFolderIds, setConversationFolderIds])

  // Per Project: whether you want the Agent alongside one Project says nothing
  // about whether you want it alongside another.
  useEffect(() => { setDesktopOpen(defaultOpen(openKey)); setCarried(null) }, [openKey])
  useEffect(() => { setChosenRoomId(readStored(roomKey)) }, [roomKey])

  // A setup elsewhere (a plugin page) may open the panel on a Room it just
  // authorized. It names the Room; the panel still reads it as the viewer.
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ProjectChatOpenDetail>).detail
      if (!detail || detail.projectId !== projectId) return
      pendingConversation.current = detail.conversationId ?? null
      writeStored(roomKey, detail.roomId)
      setChosenRoomId(detail.roomId)
      setReloadToken(value => value + 1)
      setNavigatorOpen(false)
      if (!mobile) setDesktopOpen(true)
      else mobileChat.show()
    }
    window.addEventListener(PROJECT_CHAT_OPEN_EVENT, listener)
    return () => window.removeEventListener(PROJECT_CHAT_OPEN_EVENT, listener)
  }, [projectId, roomKey, mobile, mobileChat])

  // The Rooms tab's list, read when the navigator opens on it.
  useEffect(() => {
    if (!projectId || !open || onRoomsArea || !navigatorOpen) return
    let active = true
    setRoomsFailure(null)
    projectsApi.rooms(projectId, { limit: 100 }, requestScope).then(page => {
      if (active) setRooms(page.items)
    }, error => {
      if (active) setRoomsFailure(errMsg(error))
    })
    return () => { active = false }
  }, [projectId, requestScope, open, onRoomsArea, navigatorOpen])
  useEffect(() => { if (!mobile) writeStored(openKey, String(desktopOpen)) }, [openKey, desktopOpen, mobile])

  useEffect(() => {
    if (!projectId || !open || onRoomsArea) return
    let active = true
    loadConversation().then(component => { if (active) setConversationComponent(() => component) }, error => {
      if (!active) return
      setFailure(errMsg(error))
      toast.error(errMsg(error))
    })
    setLoading(true)
    setExecutionReady(false)
    setExecutionSummary(null)
    void (async () => {
      try {
        setFailure(null)
        const mainline = await projectsApi.mainlineRoom(projectId, requestScope)
        if (!active) return
        // Opening the Project enrols the viewer in its mainline if they were
        // not yet; the server does that, so a member who joined the Project
        // after the Room was started is not looking at an empty panel.
        let current: Room = mainline.room
        let otherMembers: string[] = []
        if (chosenRoomId && chosenRoomId !== mainline.room.id) {
          // A chosen Room is read as the viewer; one they left, or that was
          // archived, falls back to the mainline rather than failing.
          const detail = await roomsApi.get(chosenRoomId, requestScope).catch(() => null)
          if (!active) return
          if (detail && detail.room.project_id === projectId) {
            current = detail.room
            otherMembers = detail.other_member_names ?? []
          } else {
            writeStored(roomKey, '')
          }
        }
        setRoom(current)
        setRoomOtherMembers(otherMembers)
        setConversations([])
        setSessionId('')
        const page = await roomsApi.conversations(current.id, { limit: 50 }, requestScope)
        if (!active) return
        setConversations(sortRoomConversations(page.items))
        // Remembered per Room, not per Project: the id names a conversation
        // *in* a Room. A remembered id the viewer can no longer see matches
        // nothing in their list, and the newest visible one is shown instead.
        const requested = pendingConversation.current
        pendingConversation.current = null
        const remembered = requested ?? readStored(conversationKey(current.id))
        const chosen = page.items.find(item => item.id === remembered) ?? page.items[0]
        setSessionId(chosen?.id ?? '')
      } catch (error) {
        if (!active) return
        // Distinguished from "no conversation yet": the mainline read can now
        // fail outright (a Project without one is a broken invariant the
        // server reports as 500), and rendering that as an empty state with a
        // disabled button would show a dead end instead of what went wrong.
        setFailure(errMsg(error))
        toast.error(errMsg(error))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [projectId, requestScope, open, onRoomsArea, chosenRoomId, roomKey, reloadToken])

  const selectConversation = useCallback((id: string) => {
    setExecutionReady(false)
    setSessionId(id)
    setNavigatorOpen(false)
    if (room) writeStored(conversationKey(room.id), id)
  }, [room])

  const selectRoom = useCallback((roomId: string) => {
    setNavigatorOpen(false)
    setNavigatorTab('conversations')
    if (roomId === room?.id) return
    writeStored(roomKey, roomId)
    setChosenRoomId(roomId)
  }, [room, roomKey])

  const selectedConversation = conversations.find(item => item.id === sessionId) ?? null
  const audienceText = room ? conversationAudienceLabel({
    isMainline: room.is_mainline,
    roomOtherMemberNames: roomOtherMembers,
    audience: selectedConversation?.audience ?? null,
  }, t) : ''
  // The phone drawer lists the Room's conversations, so it names the Room's
  // audience; its header names the open conversation's (narrower once frozen).
  const roomAudienceText = room ? roomVisibilityLabel({ isMainline: room.is_mainline, otherMemberNames: roomOtherMembers }, t) : ''

  const focusRefs = useMemo(() => focusRefsFor(pathname), [pathname])

  const currentFileAvailability = useMemo(() => {
    if (!currentFileAttachment) return { allowed: false, reason: '' }
    if (currentFileAttachment.status === 'conflict') return { allowed: false, reason: 'Resolve the current file conflict before attaching it.' }
    if (currentFileAttachment.status === 'offline') return { allowed: false, reason: 'The Folder host is offline.' }
    if (currentFileAttachment.status === 'unsupported') return { allowed: false, reason: 'This file is not an attachable text file.' }
    if (currentFileAttachment.byteSize > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) {
      return { allowed: false, reason: `This file is ${formatBytes(currentFileAttachment.byteSize)}; the message limit is ${formatBytes(CONVERSATION_MAX_FILE_SNAPSHOT_BYTES)}.` }
    }
    if (conversationFolderIds === null) return { allowed: false, reason: 'Attach or initialize this Folder in the conversation first.' }
    if (!conversationFolderIds.includes(currentFileAttachment.projectFolderId)) {
      return { allowed: false, reason: 'This Folder is outside the conversation execution context. Attach it explicitly or start a new conversation.' }
    }
    return { allowed: true, reason: '' }
  }, [conversationFolderIds, currentFileAttachment])

  const implicitInputResource = onFilesArea && currentFileAttachment && currentFileIncluded && currentFileAvailability.allowed
    ? currentFileAttachment
    : null

  /**
   * Leave the composer bound to no conversation until the user explicitly
   * opens a draft and reviews its execution context.
   */
  const startThread = useCallback(() => {
    if (!room) return
    // A new conversation is shown at once, not behind the open switcher.
    setNavigatorOpen(false)
    setSessionId('')
    setExecutionReady(false)
  }, [room])

  if (onRoomsArea) return null

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        // From md up the Shell's quick capture holds the content's lower-right
        // corner (1.25rem in, 3rem wide); this sits beside it, centred on its row.
        className="fixed bottom-[calc(4.5rem+var(--app-safe-bottom))] left-4 z-40 shadow md:bottom-[1.875rem] md:left-auto md:right-[5rem]"
        onClick={() => setOpen(true)}
        aria-label={t('collab_ui.sidecar.open_label')}
      >
        <MessageSquare className="size-4" />
        {t('collab_ui.sidecar.open')}
      </Button>
    )
  }

  const navigator = room && (
    <SidecarNavigator
      projectName={null}
      currentRoomId={room.id}
      conversations={conversations}
      selectedConversationId={sessionId}
      unread={unreadConversations}
      rooms={rooms}
      roomsFailure={roomsFailure}
      tab={navigatorTab}
      onTabChange={setNavigatorTab}
      onSelectConversation={selectConversation}
      onSelectRoom={selectRoom}
    />
  )

  return (
    <aside
      ref={asideRef}
      className={
        // Below `lg` the shell is a single column, so a panel that takes part
        // of the row would halve the page it is meant to sit beside. There it
        // overlays instead. At `lg` it sits beside the page, stuck to the top
        // of the scroll container at that container's height.
        // The Shell's quick capture floats beside this panel (useProjectContentEdge),
        // so the panel keeps no empty band for it under its footer.
        'project-chat-safe-overlay fixed right-0 z-40 flex min-h-0 w-[min(22rem,100vw)] flex-col overflow-hidden overscroll-none '
        + 'border-l border-border bg-card shadow-xl '
        + 'lg:relative lg:sticky lg:top-0 lg:z-auto lg:self-start lg:w-[var(--sidecar-w)] lg:h-[var(--sidecar-h,100dvh)] lg:shadow-none'
      }
      style={{
        ['--sidecar-w' as string]: `${width}px`,
        ...(height ? { ['--sidecar-h' as string]: `${height}px` } : {}),
      } as React.CSSProperties}
      data-testid="project-chat-sidecar"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Project chat"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-primary/30 focus-visible:bg-primary/40 lg:block"
        onPointerDown={startResize}
        onKeyDown={event => {
          // Left widens, matching the drag: the edge moves left.
          if (event.key === 'ArrowLeft') setWidth(current => Math.min(MAX_WIDTH, current + 16))
          if (event.key === 'ArrowRight') setWidth(current => Math.max(MIN_WIDTH, current - 16))
        }}
      />
      {mobile && <MobileConversationNavigation
        title={conversations.find(item => item.id === sessionId)?.title || t('collab_ui.conversation.new')}
        room={room?.is_mainline ? t('collab_ui.rooms.default_room') : room?.title ?? t('collab_ui.sidecar.title')}
        audience={roomAudienceText} conversationAudience={audienceText}
        conversations={conversations} selected={sessionId} unread={unreadConversations}
        onSelect={selectConversation} onNew={startThread}
        back={<MobileConversationBack label={t('collab_ui.mobile.back')} onClick={() => setOpen(false)} />}
      >
        <DialogClose asChild>
          <Button variant="ghost" size="sm" disabled={!room} onClick={() => { setNavigatorTab('rooms'); setNavigatorOpen(true) }} data-testid="sidecar-mobile-rooms">{t('collab_ui.sidecar.tab_rooms')}</Button>
        </DialogClose>
        <Button asChild variant="ghost" size="sm"><Link to={room ? `/projects/${projectId}/rooms?room=${room.id}&view=members` : `/projects/${projectId}/rooms`}>{t('collab_ui.conversation.members_link')}</Link></Button>
      </MobileConversationNavigation>}
      {mobile && attention.length > 0 && <div className="max-h-[20dvh] shrink-0 overflow-y-auto border-b border-border px-3 py-2">
        <p className="text-xs font-medium">{t('collab_ui.nav.needs_attention')}</p>
        {attention.map(item => {
          const href = inProjectHref(projectId, item.href)
          return href
            ? <Button key={item.id} asChild variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal text-left"><Link to={href}>{item.title}</Link></Button>
            : <p key={item.id} className="text-xs">{item.title}</p>
        })}
      </div>}
      {!mobile && (
        <Popover open={navigatorOpen && Boolean(room)} onOpenChange={value => {
          if (value) setNavigatorTab('conversations')
          setNavigatorOpen(value)
        }}>
          <PopoverAnchor asChild>
            <div className="hidden shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2.5 lg:flex" data-testid="sidecar-desktop-header">
              <div className="flex h-8 min-w-0 flex-1 flex-col">
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-[1.125rem] w-full shrink-0 justify-start gap-1.5 px-0 text-left text-base font-semibold leading-none text-foreground hover:bg-transparent hover:text-foreground"
                    aria-label={navigatorOpen ? t('collab_ui.sidecar.hide_switcher') : t('collab_ui.sidecar.switch')}
                    disabled={!room}
                    data-testid="sidecar-switcher"
                  >
                    <span className="min-w-0 truncate">{selectedConversation?.title || t('collab_ui.conversation.new')}</span>
                    {navigatorOpen ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                  </Button>
                </PopoverTrigger>
                <p className="h-3.5 shrink-0 truncate text-[11px] leading-[0.875rem] text-muted-foreground" data-testid="sidecar-audience">
                  {room && <>
                    {sidecarRoomName(room, null, t)} · {t('collab_ui.sidecar.visible_to', { audience: audienceText })}
                  </>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="icon-sm" variant="ghost" disabled={!room} onClick={startThread} aria-label={t('collab_ui.sidecar.new_thread')}>
                  <Plus className="size-4" />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setOpen(false)} aria-label={t('collab_ui.sidecar.close_label')}>
                  <PanelRightClose className="size-4" />
                </Button>
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            sideOffset={8}
            collisionPadding={8}
            aria-label={t('collab_ui.sidecar.switch')}
            className="flex w-[calc(var(--radix-popover-trigger-width)-16px)] max-w-[calc(100vw-16px)] max-h-[min(32rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden p-0"
          >
            {navigator}
          </PopoverContent>
        </Popover>
      )}

      {/* The phone switcher is reached from the conversation menu. */}
      {mobile && navigatorOpen && room && (
        <div className="shrink-0 border-b border-border px-2 py-1">
          <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setNavigatorOpen(false)} data-testid="sidecar-mobile-back-to-conversation">
            <ArrowLeft className="size-4" />{t('collab_ui.sidecar.hide_switcher')}
          </Button>
        </div>
      )}
      {mobile && navigatorOpen && navigator}

      {loading || (!ProjectSidecarConversation && !failure) ? (
        <div className="p-3"><Skeleton className="h-24 w-full" /></div>
      ) : failure ? (
        <p className="p-3 text-xs text-destructive">{failure}</p>
      ) : !room || !ProjectSidecarConversation ? null : (
        // Kept mounted under the switcher, so a draft and the scroll position
        // survive a look at the other conversations.
        <div className={mobile && navigatorOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
          {/* The same conversation module the full Room page renders: one
              implementation of what a conversation is, two places it is read. */}
          <ProjectSidecarConversation
              spaceId={spaceId}
              projectId={projectId}
              roomId={room.id}
              sessionId={sessionId}
              conversations={conversations}
              executionReady={executionReady}
              executionSummary={executionSummary}
              selectedFolderId={selectedFolderId}
              implicitInputResource={implicitInputResource}
              composerAttachments={onFilesArea && currentFileAttachment && (
                <CurrentFileBar
                  attachment={currentFileAttachment}
                  included={currentFileIncluded}
                  availability={currentFileAvailability}
                  onToggle={() => setCurrentFileIncluded(value => !value)}
                />
              )}
              focusRefs={focusRefs}
              onConversationCreated={conversation => {
                setSessionId(conversation.id)
                setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)])
                writeStored(conversationKey(room.id), conversation.id)
              }}
              onNewConversation={startThread}
              onReadyChange={setExecutionReady}
              onSummaryChange={setExecutionSummary}
              onConversationUpdated={conversation => {
                // Keep the selected Conversation's server metadata current
                // after a send or an explicit setup action.
                setSessionId(current => (current === conversation.id ? current : conversation.id))
                setConversations(current => sortRoomConversations(current.some(item => item.id === conversation.id)
                  ? current.map(item => (item.id === conversation.id ? { ...item, ...conversation } : item))
                  : [conversation, ...current]))
                writeStored(conversationKey(room.id), conversation.id)
              }}
            />
        </div>
      )}
      <div className="flex items-center justify-start border-t border-border px-3 py-1.5">
        <Link
          // Always naming the Room and the conversation: the Room page opens
          // exactly what the link names, and the panel's Room is the mainline.
          to={room
            ? (sessionId
              ? `/projects/${projectId}/rooms?room=${room.id}&conversation=${sessionId}`
              : `/projects/${projectId}/rooms?room=${room.id}&new=1`)
            : `/projects/${projectId}/rooms`}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:underline"
        >
          <X className="size-3 rotate-45" />
          {t('collab_ui.sidecar.open_room')}
        </Link>
      </div>
    </aside>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function CurrentFileBar({
  attachment,
  included,
  availability,
  onToggle,
}: {
  attachment: CurrentFileAttachment
  included: boolean
  availability: { allowed: boolean; reason: string }
  onToggle: () => void
}) {
  const stateLabel = attachment.sourceState === 'draft' ? 'Draft' : 'Saved'
  const statusLabel = attachment.status === 'saving' ? 'saving…' : attachment.status === 'conflict' ? 'conflict' : null
  const disabled = !availability.allowed
  return (
    <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-2" data-testid="current-file-bar">
      <div className="flex items-start gap-2">
        <FileCode2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span>Current file</span>
            <span className="rounded border px-1 text-[9px] font-normal text-muted-foreground">{stateLabel}</span>
            {statusLabel && <span className="text-[10px] text-amber-600 dark:text-amber-400">{statusLabel}</span>}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground" title={attachment.relativePath}>
            {attachment.relativePath} · {formatBytes(attachment.byteSize)}
          </div>
          {attachment.selection && (
            <div className="text-[10px] text-muted-foreground">
              Selection L{attachment.selection.start_line}:C{attachment.selection.start_column}–L{attachment.selection.end_line}:C{attachment.selection.end_column}
            </div>
          )}
          {disabled && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{availability.reason}</p>}
        </div>
        <Button
          type="button"
          size="sm"
          variant={included && !disabled ? 'secondary' : 'ghost'}
          className="h-6 shrink-0 gap-1 px-2 text-[10px]"
          disabled={disabled}
          onClick={onToggle}
          aria-label={included ? 'Remove current file' : 'Add current file'}
          title={disabled ? availability.reason : undefined}
        >
          {included ? <><Check className="size-3" /> Included</> : 'Add'}
        </Button>
      </div>
    </div>
  )
}
