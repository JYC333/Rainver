import type { ThreadReferencePick } from '../../types/api'

/**
 * Picks held for a thread that does not exist yet.
 *
 * A Conversation draft is opened explicitly before its first message, so a
 * pick made for a new thread is held only across that setup navigation. It is
 * keyed by the Room it is for, taken once, and gone if the draft is abandoned.
 *
 * One module owns both halves so the key and the shape are a single contract
 * rather than a string agreed on across two pages.
 */
const key = (roomId: string) => `rainver.reference.room.${roomId}`

export function holdReferences(roomId: string, picks: readonly ThreadReferencePick[]): void {
  try {
    sessionStorage.setItem(key(roomId), JSON.stringify(picks))
  } catch { /* the reference can be attached again from where it was picked */ }
}

/**
 * The picks held for this Room, removed as they are read. The Room id comes
 * from the caller's own route, never from a URL parameter naming a key: a
 * crafted link could otherwise name any same-origin stored value and have it
 * attached.
 */
export function takeReferences(roomId: string): ThreadReferencePick[] | null {
  try {
    const raw = sessionStorage.getItem(key(roomId))
    sessionStorage.removeItem(key(roomId))
    if (!raw) return null
    const picks = JSON.parse(raw) as unknown
    return Array.isArray(picks) && picks.length > 0 ? picks as ThreadReferencePick[] : null
  } catch {
    return null
  }
}
