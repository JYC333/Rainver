import { useEffect, useRef } from 'react'
import { roomsApi } from '../../api/client'
import type { RoomConversation } from '../../types/api'

/** Mirrors the server's message-activity order, including stable empty-thread ties. */
export function sortRoomConversations(items: RoomConversation[]): RoomConversation[] {
  return [...items].sort((a, b) =>
    Date.parse(b.last_message_at ?? b.created_at) - Date.parse(a.last_message_at ?? a.created_at)
    || b.id.localeCompare(a.id))
}

/** Refresh list metadata for every thread, including those not currently open. */
export function useRoomConversationRefresh(
  roomId: string | null,
  onRefresh: (items: RoomConversation[]) => void,
  scope?: Parameters<typeof roomsApi.conversations>[2],
) {
  const callback = useRef(onRefresh)
  callback.current = onRefresh
  useEffect(() => {
    if (!roomId) return
    let active = true
    let pending = false
    const timer = window.setInterval(async () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const items: RoomConversation[] = []
        for (let offset = 0; active; offset += 100) {
          const page = await roomsApi.conversations(roomId, { limit: 100, offset }, scope)
          items.push(...page.items)
          if (page.items.length < 100 || items.length >= page.total) break
        }
        if (active) callback.current(sortRoomConversations(items))
      } catch {
        // Keep the last successful view on a transient poll failure.
      } finally {
        pending = false
      }
    }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [roomId, scope])
}
