import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { MessageSquare, PanelRightClose, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi, roomsApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import { SpaceLink as Link } from '../../../core/spaceNav'
import type { Room, RoomConversation as RoomConversationRecord } from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'
import { Skeleton } from '../../../components/ui/skeleton'
import { RoomConversation } from '../../agent_groups/conversation/RoomConversation'

/**
 * Talking to the Project's Agent without leaving what you are looking at.
 *
 * Before this, the Room was a separate page: discussing anything meant leaving
 * the thing you were discussing and then describing it again in words. The
 * sidecar carries that description for you — see `focusRefsFor` — which is the
 * highest-frequency friction in a system you use every day.
 *
 * It binds to the Project's **mainline** Room — the one every Project member
 * belongs to — rather than to whichever Room the viewer happened to be on the
 * roster of that was most recently active. That version switched Rooms under
 * people and was empty for anyone nobody had invited. It renders the Room's
 * own conversation, not a private one: a teammate opening the full Room sees
 * what was said here. The rich Room surface (run progress,
 * action previews, roster, invitations) stays on that page; this is the daily
 * exchange, and putting the whole apparatus in a side panel would make it a
 * worse Room rather than a better sidecar.
 */

const STORAGE_PREFIX = 'project.sidecar'

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function defaultOpen(key: string): boolean {
  const stored = readStored(key)
  if (stored !== null) return stored === 'true'
  try { return window.matchMedia('(min-width: 1024px)').matches } catch { return false }
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

export default function ProjectChatSidecar() {
  const { projectId = '' } = useParams()
  const { pathname } = useLocation()
  // The Rooms Area is already a Room, usually this one. Two live views of the
  // same conversation side by side is not a second opinion, it is a bug the
  // person has to reason about.
  const onRoomsArea = /\/rooms(\/|$)/.test(pathname)

  const openKey = `${STORAGE_PREFIX}.${projectId}.open`
  const conversationKey = (roomId: string) => `${STORAGE_PREFIX}.room.${roomId}.conversation`
  // Open unless this person closed it for this Project: conversation is the
  // way in, so the panel is there on first arrival rather than a button —
  // where it sits *beside* the page. Below `lg` it overlays the page, and an
  // overlay that opens itself on a phone covers the Pulse someone came for.
  const [open, setOpen] = useState(() => defaultOpen(openKey))
  // Remembered per browser, not per Project: how wide you like the panel is
  // about your screen, not about the work.
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
  const [failure, setFailure] = useState<string | null>(null)
  const [conversations, setConversations] = useState<RoomConversationRecord[]>([])
  const [sessionId, setSessionId] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // Per Project: whether you want the Agent alongside one Project says nothing
  // about whether you want it alongside another.
  useEffect(() => { setOpen(defaultOpen(openKey)) }, [openKey])
  useEffect(() => { writeStored(openKey, String(open)) }, [openKey, open])

  useEffect(() => {
    if (!projectId || !open || onRoomsArea) return
    let active = true
    setLoading(true)
    void (async () => {
      try {
        setFailure(null)
        const mainline = await projectsApi.mainlineRoom(projectId)
        if (!active) return
        // Opening the Project enrols the viewer in its mainline if they were
        // not yet; the server does that, so a member who joined the Project
        // after the Room was started is not looking at an empty panel.
        setRoom(mainline.room)
        setConversations([])
        setSessionId('')
        const page = await roomsApi.conversations(mainline.room.id, { limit: 50 })
        if (!active) return
        setConversations(page.items)
        // Remembered per Room, not per Project: the id names a conversation
        // *in* a Room, and a stale one matching nothing silently fell back.
        const remembered = readStored(conversationKey(mainline.room.id))
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
  }, [projectId, open, onRoomsArea])

  const focusRefs = useMemo(() => focusRefsFor(pathname), [pathname])

  /**
   * Leave the composer bound to no conversation. Sending is what creates one
   * (ADR 0018 decision 5), and the send reports it back through
   * `onConversationUpdated` — so a thread nobody writes in never exists.
   */
  const startThread = useCallback(() => {
    if (!room) return
    setSessionId('')
  }, [room])

  if (onRoomsArea) return null

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="fixed bottom-4 right-4 z-40 shadow"
        onClick={() => setOpen(true)}
        aria-label="Open Project chat"
      >
        <MessageSquare className="size-4" />
        Chat
      </Button>
    )
  }

  return (
    <aside
      ref={asideRef}
      className={
        // Below `lg` the shell is a single column, so a panel that takes part
        // of the row would halve the page it is meant to sit beside. There it
        // overlays instead. At `lg` it sits beside the page, stuck to the top
        // of the scroll container at that container's height.
        'fixed inset-y-0 right-0 z-40 flex w-[min(22rem,100vw)] flex-col '
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
        className="absolute inset-y-0 left-0 hidden w-1.5 cursor-col-resize hover:bg-primary/30 focus-visible:bg-primary/40 lg:block"
        onPointerDown={startResize}
        onKeyDown={event => {
          // Left widens, matching the drag: the edge moves left.
          if (event.key === 'ArrowLeft') setWidth(current => Math.min(MAX_WIDTH, current + 16))
          if (event.key === 'ArrowRight') setWidth(current => Math.max(MIN_WIDTH, current - 16))
        }}
      />
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <span className="text-sm font-medium">Project Agent</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!room} onClick={startThread} aria-label="Start a separate thread">
            <Plus className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} aria-label="Close Project chat">
            <PanelRightClose className="size-4" />
          </Button>
        </div>
      </div>

      {conversations.length > 1 && (
        <div className="border-b border-border p-2">
          <Select
            ariaLabel="Conversation"
            value={sessionId}
            onChange={value => {
              setSessionId(value)
              if (room) writeStored(conversationKey(room.id), value)
            }}
            options={conversations.map((item, index) => ({
              value: item.id,
              label: item.title ?? `Thread ${conversations.length - index}`,
            }))}
          />
        </div>
      )}

      {loading ? (
        <div className="p-3"><Skeleton className="h-24 w-full" /></div>
      ) : failure ? (
        <p className="p-3 text-xs text-destructive">{failure}</p>
      ) : !room ? null : (
        // The same conversation module the full Room page renders: one
        // implementation of what a conversation is, two places it is read.
        <RoomConversation
          // Picking works here too: the panel has the Room's other
          // threads, so a pick has somewhere to go. Starting a new thread is
          // not one of this surface's affordances, so that action is not
          // offered and the toolbar hides it.
          siblingConversations={conversations}
          key={`${room.id}:${sessionId}`}
          roomId={room.id}
          conversationId={sessionId || null}
          variant="panel"
          focusRefs={focusRefs}
          onConversationUpdated={conversation => {
            // The first message created it. Bind to it so the next send goes
            // to the same thread, and remember it like any other.
            setSessionId(current => (current === conversation.id ? current : conversation.id))
            setConversations(current => (current.some(item => item.id === conversation.id)
              ? current.map(item => (item.id === conversation.id ? conversation : item))
              : [conversation, ...current]))
            writeStored(conversationKey(room.id), conversation.id)
          }}
          emptyHint="Ask the Agent about what you are looking at — it already knows which Task that is."
        />
      )}
      <div className="flex items-center justify-end border-t border-border px-3 py-1.5">
        <Link
          // Always naming the Room: without it the Room page auto-selects the
          // newest one, so leaving the mainline panel while composing a new
          // thread could land the reader in a limited Room instead.
          to={room
            ? (sessionId
              ? `/projects/${projectId}/rooms?room=${room.id}&conversation=${sessionId}`
              : `/projects/${projectId}/rooms?room=${room.id}&new=1`)
            : `/projects/${projectId}/rooms`}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:underline"
        >
          <X className="size-3 rotate-45" />
          Full Room
        </Link>
      </div>
    </aside>
  )
}
