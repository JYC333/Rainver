import { useCallback, useEffect, useRef, useState } from 'react'
import { History, Loader2, Lock, MessageSquare, Plus, RefreshCw, Users } from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { SpaceLink as Link } from '../../core/spaceNav'
import { formatRelativeTime } from '../../i18n/format'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import type { ProjectConversation, ProjectRoomSummary, Room } from '../../types/api'
import { LimitedRoomDialog } from './LimitedRoomDialog'
import { rosterCountsLabel, roomVisibilityLabel } from './audience'
import { displayRoomTitle } from './roomTitle'
import { usePageGeneration } from '../projects/agents/usePagedSearch'
import { useSpace } from '../../contexts/SpaceContext'
import { useUnreadConversations } from '../conversation/useUnreadConversations'
import { ConversationStatusIndicator } from '../conversation/ConversationUnreadDot'

const PAGE_SIZE = 50

/**
 * The Project's Rooms, as the viewer may see them.
 *
 * Each Room is named with who can see it and how many people and Agents are
 * in it, because a Room is a visibility boundary
 * ([ADR 0018](../../../../.agent/decisions/0018-room-as-visibility-boundary.md)).
 * The list comes from the server's membership join: a limited Room the viewer
 * is not in is absent and uncounted, so nothing here says it exists. Opening a
 * Room lands on its conversation list, never inside its newest conversation;
 * recent conversations are a separate shortcut.
 */
export function RoomsIndex({ projectId, projectName, onRoomOpened }: {
  projectId: string
  projectName: string | undefined
  onRoomOpened: (room: Room) => void
}) {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const unreadConversations = useUnreadConversations(activeSpaceId ?? undefined, projectId)
  const [items, setItems] = useState<ProjectRoomSummary[]>([])
  const [total, setTotal] = useState(0)
  const [canWrite, setCanWrite] = useState(false)
  const [recent, setRecent] = useState<ProjectConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  // Every page — the first and each "load more" — belongs to one Project's list.
  const pages = usePageGeneration(projectId)
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const load = useCallback(async () => {
    const current = pagesRef.current.begin()
    setLoading(true)
    setFailed(false)
    try {
      const page = await projectsApi.rooms(projectId, { limit: PAGE_SIZE })
      const conversations = await projectsApi.conversations(projectId, { limit: 3 }).catch(() => null)
      if (!pagesRef.current.isCurrent(current)) return
      pagesRef.current.loadedFor('')
      setItems(page.items)
      setTotal(page.total)
      setCanWrite(page.viewer_can_write)
      setRecent(conversations?.items ?? [])
    } catch (error) {
      if (!pagesRef.current.isCurrent(current)) return
      setFailed(true)
      toast.error(errMsg(error))
    } finally {
      if (pagesRef.current.isCurrent(current)) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [projectId])

  // Another Project: nothing of the previous one stays on screen or in flight.
  useEffect(() => {
    pagesRef.current.reset()
    setItems([])
    setTotal(0)
    setRecent([])
    setCanWrite(false)
    setFailed(false)
    setLoadingMore(false)
    void load()
  }, [load])

  async function loadMore() {
    // Continues only the rows on screen, for the Project they were loaded for.
    if (loadingMore || pagesRef.current.loadedQuery() === null) return
    const token = pagesRef.current.current()
    setLoadingMore(true)
    try {
      const page = await projectsApi.rooms(projectId, { limit: PAGE_SIZE, offset: items.length })
      if (!pagesRef.current.isCurrent(token)) return
      setItems(current => [...current, ...page.items.filter(item => !current.some(existing => existing.room.id === item.room.id))])
      setTotal(page.total)
    } catch (error) {
      if (pagesRef.current.isCurrent(token)) toast.error(errMsg(error))
    } finally {
      if (pagesRef.current.isCurrent(token)) setLoadingMore(false)
    }
  }

  const roomHref = (roomId: string, view?: 'members') =>
    `/projects/${projectId}/rooms?${new URLSearchParams({ room: roomId, ...(view ? { view } : {}) }).toString()}`

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Users className="size-5" />{t('collab_ui.rooms.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('collab_ui.rooms.subtitle')}</p>
        </div>
        {canWrite && (
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />{t('collab_ui.rooms.new_room')}</Button>
        )}
      </header>

      {loading && items.length === 0 ? (
        <div className="space-y-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
      ) : failed ? (
        // Every Project is created with its mainline, so an empty answer here
        // is a failed load: offer a retry, never a Room creation.
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t('collab_ui.rooms.load_failed')}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />{t('collab_ui.common.retry')}</Button>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2" aria-busy={loading}>
          {items.map(item => (
            <Card key={item.room.id} className="flex flex-col gap-3 p-4" data-testid={`room-card-${item.room.id}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{displayRoomTitle(item.room, projectName)}</h2>
                  {item.room.is_mainline
                    ? <Badge variant="secondary">{t('collab_ui.rooms.default_badge')}</Badge>
                    : <Badge variant="outline"><Lock className="mr-1 size-3" />{t('collab_ui.rooms.limited_badge')}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('collab_ui.rooms.visible_to', { who: roomVisibilityLabel({ isMainline: item.room.is_mainline, otherMemberNames: item.other_member_names }, t) })}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rosterCountsLabel({ people: item.person_count, agents: item.agent_count }, t)}
                  {' · '}
                  {item.conversation_count > 0
                    ? t('collab_ui.rooms.conversations', { count: item.conversation_count })
                    : t('collab_ui.rooms.no_activity')}
                  {item.last_activity_at && <> · {t('collab_ui.rooms.last_activity', { when: formatRelativeTime(item.last_activity_at) })}</>}
                </p>
              </div>
              <div className="mt-auto flex flex-wrap gap-2">
                <Button asChild size="sm"><Link to={roomHref(item.room.id)}>{t('collab_ui.rooms.open')}</Link></Button>
                <Button asChild size="sm" variant="outline"><Link to={roomHref(item.room.id, 'members')}><Users className="size-3.5" />{t('collab_ui.rooms.manage_members')}</Link></Button>
              </div>
            </Card>
          ))}
          {items.length < total && (
            <Button size="sm" variant="ghost" className="md:col-span-2" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}{t('collab_ui.common.load_more')}
            </Button>
          )}
        </div>
      )}

      {!failed && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('collab_ui.rooms.recent')}</h2>
          {recent.map(item => (
            <Link
              key={item.id}
              to={`/projects/${projectId}/rooms?${new URLSearchParams({ room: item.room_id, conversation: item.id }).toString()}`}
              className="block"
            >
              <Card className="flex items-center gap-3 p-3 hover:bg-muted/40">
                <MessageSquare className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title ?? t('collab_ui.room.untitled')}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t('collab_ui.conversation.in_room', { room: displayRoomTitle({ title: item.room_title }, projectName) })}
                    {item.last_message_at && <> · {formatRelativeTime(item.last_message_at)}</>}
                  </p>
                </div>
                <ConversationStatusIndicator running={item.is_running} unread={unreadConversations.has(item.id)} />
              </Card>
            </Link>
          ))}
          <Button asChild size="sm" variant="ghost">
            <Link to={`/projects/${projectId}/conversations`}><History className="size-3.5" />{t('collab_ui.rooms.all_conversations')}</Link>
          </Button>
        </section>
      )}

      <LimitedRoomDialog
        open={creating}
        projectId={projectId}
        onClose={() => setCreating(false)}
        onOpened={room => { setCreating(false); onRoomOpened(room) }}
      />
    </div>
  )
}
