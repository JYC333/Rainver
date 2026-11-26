import type { RoomMessage } from '../types/api'
import { registerInMemoryResidue, sessionEpoch } from './sessionResidue'

/**
 * The latest message page of a few recently read Room conversations, held in
 * this tab's memory only — never in browser storage — so a revisit can paint
 * before the full page read returns.
 *
 * An entry is a display hint, never authority. A cached page is shown only
 * after a fresh, scoped server read of the same conversation succeeded and
 * reported the same newest message (`ConversationSurface`). It is replaced
 * by the authoritative page, and dropped on an access refusal, a known
 * access change, logout, a 401 or another tab's logout.
 */

export const CONVERSATION_PAGE_CACHE_MAX_ENTRIES = 3
export const CONVERSATION_PAGE_CACHE_MAX_BYTES = 256 * 1024
/** One entry may use at most half the budget, so one long thread cannot evict all others. */
export const CONVERSATION_PAGE_CACHE_MAX_ENTRY_BYTES = CONVERSATION_PAGE_CACHE_MAX_BYTES / 2
export const CONVERSATION_PAGE_CACHE_MAX_AGE_MS = 60 * 60 * 1000

export type ConversationPageScope = {
  userId: string
  spaceId: string
  role: string
  roomId: string
  conversationId: string
  readOnly: boolean
}

export type CachedConversationPage = { items: RoomMessage[]; hasOlder: boolean; newest: string | null }

/** Taken when a read starts; a store or display after any later invalidation is refused. */
export type ConversationPageTicket = { epoch: number; generation: number }

type Entry = { key: string; roomId: string; conversationId: string; json: string; bytes: number; storedAt: number }

const entries = new Map<string, Entry>()
let totalBytes = 0
let generation = 0
let cleanupTimer: ReturnType<typeof setTimeout> | null = null
const encoder = new TextEncoder()

registerInMemoryResidue(() => clearConversationPageCache())

function keyOf(scope: ConversationPageScope): string {
  return JSON.stringify([scope.userId, scope.spaceId, scope.role, scope.roomId, scope.conversationId, scope.readOnly])
}

/** A stable identity of one message, so a changed copy never matches its cached one. */
export function messageFingerprint(message: RoomMessage | undefined): string | null {
  return message ? JSON.stringify(message) : null
}

function bearsAttachments(message: RoomMessage): boolean {
  if (message.input_parts?.length) return true
  const metadata = message.metadata_json as Record<string, unknown> | null | undefined
  return ['artifact_refs', 'attachments', 'input_parts'].some(field => {
    const value = metadata?.[field]
    return Array.isArray(value) && value.length > 0
  })
}

function remove(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  totalBytes -= entry.bytes
}

function scheduleCleanup(now: number): void {
  if (cleanupTimer !== null) clearTimeout(cleanupTimer)
  cleanupTimer = null
  let oldest = Infinity
  for (const entry of entries.values()) oldest = Math.min(oldest, entry.storedAt)
  if (oldest === Infinity) return
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null
    pruneExpired(Date.now())
  }, Math.max(0, oldest + CONVERSATION_PAGE_CACHE_MAX_AGE_MS - now))
}

function pruneExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.storedAt >= CONVERSATION_PAGE_CACHE_MAX_AGE_MS) remove(key)
  }
  scheduleCleanup(now)
}

export function conversationPageTicket(): ConversationPageTicket {
  return { epoch: sessionEpoch(), generation }
}

export function isCurrentConversationPageTicket(ticket: ConversationPageTicket): boolean {
  return ticket.epoch === sessionEpoch() && ticket.generation === generation
}

/** A fresh copy of the cached latest page, or null when absent, expired or from an earlier sign-in. */
export function readConversationPage(scope: ConversationPageScope, now = Date.now()): CachedConversationPage | null {
  pruneExpired(now)
  const key = keyOf(scope)
  const entry = entries.get(key)
  if (!entry) return null
  // Most recently used last, so eviction takes the least recently read.
  entries.delete(key)
  entries.set(key, entry)
  const page = JSON.parse(entry.json) as Omit<CachedConversationPage, 'newest'>
  return { ...page, newest: messageFingerprint(page.items[page.items.length - 1]) }
}

/**
 * Hold the latest page read by `ticket`. Refused, and any older copy dropped,
 * when the read started before an invalidation or sign-out, or when the page
 * is attachment-bearing or too large to hold.
 */
export function storeConversationPage(
  scope: ConversationPageScope,
  page: { items: readonly RoomMessage[]; hasOlder: boolean },
  ticket: ConversationPageTicket,
  now = Date.now(),
): boolean {
  if (!isCurrentConversationPageTicket(ticket)) return false
  const key = keyOf(scope)
  remove(key)
  if (page.items.some(message => message.session_id !== scope.conversationId || bearsAttachments(message))) {
    scheduleCleanup(now)
    return false
  }
  const json = JSON.stringify({ items: page.items, hasOlder: page.hasOlder })
  const bytes = encoder.encode(json).byteLength
  if (bytes > CONVERSATION_PAGE_CACHE_MAX_ENTRY_BYTES) {
    scheduleCleanup(now)
    return false
  }
  entries.set(key, { key, roomId: scope.roomId, conversationId: scope.conversationId, json, bytes, storedAt: now })
  totalBytes += bytes
  for (const oldest of entries.keys()) {
    if (entries.size <= CONVERSATION_PAGE_CACHE_MAX_ENTRIES && totalBytes <= CONVERSATION_PAGE_CACHE_MAX_BYTES) break
    remove(oldest)
  }
  scheduleCleanup(now)
  return true
}

/**
 * Drop every cached page of a Room, or of one of its conversations, for every
 * viewer, and refuse stores and displays from reads already in flight.
 */
export function invalidateConversationPages(target: { roomId: string; conversationId?: string }): void {
  generation += 1
  for (const [key, entry] of entries) {
    if (entry.roomId === target.roomId && (!target.conversationId || entry.conversationId === target.conversationId)) remove(key)
  }
  scheduleCleanup(Date.now())
}

export function clearConversationPageCache(): void {
  generation += 1
  entries.clear()
  totalBytes = 0
  if (cleanupTimer !== null) clearTimeout(cleanupTimer)
  cleanupTimer = null
}

/** Status codes meaning the viewer may no longer read this conversation. */
export function isConversationAccessRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return status === 401 || status === 403 || status === 404
}

/** Exported for tests. */
export function conversationPageCacheStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes }
}
