import { useCallback, useEffect, useRef, useState } from 'react'
import { roomsApi, type RequestOptions } from '../../api/client'
import { usePeriodicRefresh } from '../../hooks/usePeriodicRefresh'
import { registerInMemoryResidue, sessionEpoch } from '../../lib/sessionResidue'
import type { RoomConversationQuota } from '../../types/api'

/**
 * How often a visible conversation re-reads its quota line. The read is a
 * cache read (`GET …/quota` never probes a provider); the server refreshes
 * that cache by itself every 15 minutes per login, shared by every
 * conversation on it, and a finished Run's live reading lands in it at once.
 */
export const CONVERSATION_QUOTA_READ_INTERVAL_MS = 5 * 60_000

/** Who is looking, in which Space: a line read for one person is never shown to another. */
export type ConversationQuotaViewer = { userId?: string | null; spaceId?: string | null }

/**
 * The composer's subscription line (`modules/rooms.md`, "Subscription quota
 * gate"). Read when the transcript grows, a Run settles, or a shown
 * discussion's record changes — when a window can have moved or a hold
 * started or lifted — and every five minutes while the page is visible.
 * A hidden page reads nothing; becoming visible reads once.
 *
 * Every answer belongs to one *lifetime*: this room and conversation, this
 * viewer and Space, the panel's request lifetime (`ConversationScope`'s
 * signal) and the browser session (`sessionEpoch`). Any change starts a new
 * lifetime during render, so the old reading is gone before the next effect,
 * and a read or "continue anyway" answer begun in an earlier lifetime never
 * lands — not even after coming back to the same conversation (A → B → A).
 * Within one lifetime the latest request wins. Logout and unmount end it too.
 */
export function useConversationQuota(
  roomId: string,
  conversationId: string | null | undefined,
  scope: RequestOptions & { actionUserId?: string },
  viewer: ConversationQuotaViewer,
  changeSignals: ReadonlyArray<unknown>,
): { quota: RoomConversationQuota | null; adopt: (next: RoomConversationQuota) => void; refresh:()=>void } {
  const [held, setHeld] = useState<{ generation: number; quota: RoomConversationQuota } | null>(null)
  const sequence = useRef(0)
  const epoch = sessionEpoch()
  const identity = [roomId, conversationId ?? '', viewer.userId ?? '', viewer.spaceId ?? scope.spaceId ?? '', scope.actionUserId ?? '', String(epoch)].join('\u0000')
  const life = useRef({ identity, signal: scope.signal, generation: 0 })
  if (life.current.identity !== identity || life.current.signal !== scope.signal) {
    life.current = { identity, signal: scope.signal, generation: life.current.generation + 1 }
    sequence.current += 1
  }
  const generation = life.current.generation
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    // A logout clears this tab's residue: the line goes with it, and late answers find a new epoch.
    const drop = registerInMemoryResidue(() => { sequence.current += 1; setHeld(null) })
    return () => { mounted.current = false; drop() }
  }, [])
  /** True only while the lifetime an answer was started in is still the one on screen. */
  const current = useCallback(() => mounted.current && life.current.generation === generation && sessionEpoch() === epoch,
    [epoch, generation])

  const refresh = useCallback(() => {
    if (!conversationId) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (!current()) return
    const request = ++sequence.current
    void roomsApi.conversationQuota(roomId, conversationId, scope)
      .then(next => { if (request === sequence.current && current()) setHeld({ generation, quota: next }) })
      .catch(() => { /* the line is a courtesy; sending does not depend on it */ })
  }, [conversationId, current, generation, roomId, scope])

  /** A fresher answer from an action ("continue anyway"); supersedes reads in flight. */
  const adopt = useCallback((next: RoomConversationQuota) => {
    // An action that finished after the lifetime ended belongs to the old one, even on the same conversation.
    if (!current()) return
    sequence.current += 1
    setHeld({ generation, quota: next })
  }, [current, generation])

  useEffect(() => { refresh() }, [refresh, ...changeSignals])
  usePeriodicRefresh(refresh, CONVERSATION_QUOTA_READ_INTERVAL_MS, Boolean(conversationId))
  // Never another lifetime's line, not even for the render before a new read lands.
  return { quota: held?.generation === generation ? held.quota : null, adopt, refresh }
}
