/**
 * "Someone wrote to a note" — announced once, when it happens.
 *
 * A note can be written from somewhere other than the editor showing it: quick
 * capture appends marginalia to a note that may be open in a tab right now. The
 * two cheap answers are both wrong here. Polling pays its cost on every tick
 * whether or not anything changed, and refetch-on-focus misses precisely the
 * case that prompted this — composer and note visible at the same time, focus
 * never leaving the page.
 *
 * So nothing runs until a write actually lands, and then exactly one message
 * goes out. Same tab travels over an EventTarget; other tabs of the same origin
 * over a BroadcastChannel, which the browser already maintains, so the fan-out
 * is free and there is no server involvement at all.
 *
 * The message carries no content on purpose. It says which note moved, and the
 * receiver decides whether it cares and re-reads through its own normal path —
 * which is what keeps a stale or out-of-order message from ever overwriting an
 * editor's unsaved text.
 *
 * Writes made *by the server* (an agent editing a note) are out of scope: those
 * need a server→client stream, which this deliberately is not.
 */

export type NoteChangedReason = 'capture'

export interface NoteChangedDetail {
  /** The note that changed, when the write landed in one. */
  noteId: string | null
  /** The Project it belongs to, for surfaces scoped to one. */
  projectId: string | null
  reason: NoteChangedReason
}

const TOPIC = 'aspace:note-changed'

const bus = new EventTarget()

let channel: BroadcastChannel | null = null
let channelTried = false

/** Opened on first use, never closed: one per app lifetime, idle until posted to. */
function ensureChannel(): BroadcastChannel | null {
  if (channelTried) return channel
  channelTried = true
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(TOPIC)
  // A BroadcastChannel does not echo to its own sender, so a message arriving
  // here always came from another tab and is dispatched locally unchanged.
  channel.onmessage = (event: MessageEvent<NoteChangedDetail>) => {
    bus.dispatchEvent(new CustomEvent<NoteChangedDetail>(TOPIC, { detail: event.data }))
  }
  return channel
}

export function publishNoteChanged(detail: NoteChangedDetail): void {
  bus.dispatchEvent(new CustomEvent<NoteChangedDetail>(TOPIC, { detail }))
  try {
    ensureChannel()?.postMessage(detail)
  } catch {
    // Cross-tab delivery is a nicety; this tab has already been told.
  }
}

export function subscribeNoteChanged(handler: (detail: NoteChangedDetail) => void): () => void {
  ensureChannel()
  const listener = (event: Event) => handler((event as CustomEvent<NoteChangedDetail>).detail)
  bus.addEventListener(TOPIC, listener)
  return () => bus.removeEventListener(TOPIC, listener)
}
