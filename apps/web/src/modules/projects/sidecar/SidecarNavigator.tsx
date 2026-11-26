import { ConversationStatusIndicator } from '../../conversation/ConversationUnreadDot'
import { useMemo, useState } from 'react'
import { Check, Lock, Search } from 'lucide-react'
import type { ProjectRoomSummary, RoomConversation as RoomConversationRecord } from '../../../types/api'
import { useAppTranslation } from '../../../i18n'
import { Input } from '../../../components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs'
import { roomVisibilityLabel } from '../../agent_groups/audience'
import { displayRoomTitle } from '../../agent_groups/roomTitle'

export type SidecarTab = 'conversations' | 'rooms'

/**
 * The sidecar's one picker: two fixed tabs, the current Room's conversations
 * (the default) and the viewer's Rooms. Choosing a Room only changes which
 * Room the panel is in; the panel then restores the last conversation the
 * viewer opened there, if they can still read it.
 */
export function SidecarNavigator({
  projectName,
  currentRoomId,
  conversations,
  selectedConversationId,
  unread,
  rooms,
  roomsFailure,
  tab,
  onTabChange,
  onSelectConversation,
  onSelectRoom,
}: {
  projectName: string | null
  currentRoomId: string | null
  conversations: RoomConversationRecord[]
  selectedConversationId: string
  unread: ReadonlySet<string>
  rooms: ProjectRoomSummary[] | null
  roomsFailure: string | null
  tab: SidecarTab
  onTabChange: (tab: SidecarTab) => void
  onSelectConversation: (id: string) => void
  onSelectRoom: (roomId: string) => void
}) {
  const { t } = useAppTranslation()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const shownConversations = useMemo(() => conversations.filter(item =>
    !needle || (item.title ?? '').toLocaleLowerCase().includes(needle)), [conversations, needle])
  const shownRooms = useMemo(() => (rooms ?? []).filter(item => {
    if (!needle) return true
    const title = sidecarRoomName(item.room, projectName, t).toLocaleLowerCase()
    return title.includes(needle) || item.other_member_names.some(name => name.toLocaleLowerCase().includes(needle))
  }), [rooms, needle, projectName, t])

  return (
    <Tabs
      value={tab}
      onValueChange={value => { setQuery(''); onTabChange(value as SidecarTab) }}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="sidecar-navigator"
    >
      <div className="shrink-0 space-y-2 border-b border-border p-2">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="conversations">{t('collab_ui.sidecar.tab_conversations')}</TabsTrigger>
          <TabsTrigger value="rooms">{t('collab_ui.sidecar.tab_rooms')}</TabsTrigger>
        </TabsList>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={tab === 'rooms' ? t('collab_ui.sidecar.search_rooms') : t('collab_ui.sidecar.search_conversations')}
            aria-label={tab === 'rooms' ? t('collab_ui.sidecar.search_rooms') : t('collab_ui.sidecar.search_conversations')}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>
      <TabsContent value="conversations" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        {shownConversations.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {needle ? t('collab_ui.sidecar.no_match') : t('collab_ui.sidecar.no_conversations')}
          </p>
        ) : (
          <ul className="divide-y divide-border" aria-label={t('collab_ui.sidecar.tab_conversations')}>
            {shownConversations.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  aria-current={item.id === selectedConversationId ? 'true' : undefined}
                  onClick={() => onSelectConversation(item.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.title || t('collab_ui.conversation.new')}</span>
                    {item.audience?.restricted && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock className="size-3" />{t('collab_ui.sidecar.earlier_audience')}
                      </span>
                    )}
                  </span>
                  {item.id === selectedConversationId && <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <ConversationStatusIndicator running={item.is_running} unread={unread.has(item.id)} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>
      <TabsContent value="rooms" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        {roomsFailure ? (
          <p className="p-3 text-xs text-destructive">{roomsFailure}</p>
        ) : rooms === null ? (
          <p className="p-3 text-xs text-muted-foreground">{t('collab_ui.sidecar.loading_rooms')}</p>
        ) : shownRooms.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('collab_ui.sidecar.no_match')}</p>
        ) : (
          <ul className="divide-y divide-border" aria-label={t('collab_ui.sidecar.tab_rooms')}>
            {shownRooms.map(item => (
              <li key={item.room.id}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  aria-current={item.room.id === currentRoomId ? 'true' : undefined}
                  onClick={() => onSelectRoom(item.room.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{sidecarRoomName(item.room, projectName, t)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {roomVisibilityLabel({ isMainline: item.room.is_mainline, otherMemberNames: item.other_member_names }, t)}
                      {' · '}{t('collab_ui.sidecar.conversation_count', { count: item.conversation_count })}
                    </span>
                  </span>
                  {item.room.id === currentRoomId && <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </TabsContent>
    </Tabs>
  )
}

/** How the panel names a Room: the mainline as the default Room, others by title. */
export function sidecarRoomName(
  room: { title: string; is_mainline?: boolean },
  projectName: string | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return room.is_mainline ? t('collab_ui.rooms.default_room') : displayRoomTitle(room, projectName)
}
