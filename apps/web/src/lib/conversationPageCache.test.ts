// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomMessage } from '../types/api'
import {
  CONVERSATION_PAGE_CACHE_MAX_AGE_MS,
  CONVERSATION_PAGE_CACHE_MAX_BYTES,
  CONVERSATION_PAGE_CACHE_MAX_ENTRY_BYTES,
  clearConversationPageCache,
  conversationPageCacheStats,
  conversationPageTicket,
  invalidateConversationPages,
  isConversationAccessRefusal,
  messageFingerprint,
  readConversationPage,
  storeConversationPage,
  type ConversationPageScope,
} from './conversationPageCache'
import { clearSessionResidue } from './sessionResidue'

const base: ConversationPageScope = { userId: 'user-a', spaceId: 'space-a', role: 'member', roomId: 'room-a', conversationId: 'c1', readOnly: false }
const scopeFor = (conversationId: string, extra: Partial<ConversationPageScope> = {}) => ({ ...base, conversationId, ...extra })
const message = (sessionId: string, content = 'hello', extra: Partial<RoomMessage> = {}): RoomMessage => ({
  id: `${sessionId}-m`, space_id: 'space-a', session_id: sessionId, user_id: 'user-a', role: 'user', content, metadata_json: {}, created_at: '2026-11-25T00:00:00Z', ...extra,
})
const store = (scope: ConversationPageScope, items: RoomMessage[], now = Date.now()) =>
  storeConversationPage(scope, { items, hasOlder: false }, conversationPageTicket(), now)

beforeEach(() => { clearConversationPageCache() })
afterEach(() => { vi.useRealTimers() })

describe('conversation page cache', () => {
  it('returns a fresh copy of the held latest page with its newest fingerprint', () => {
    const items = [message('c1')]
    expect(store(base, items)).toBe(true)
    const first = readConversationPage(base)!
    expect(first.items).toEqual(items)
    expect(first.newest).toBe(messageFingerprint(items[0]))
    first.items[0]!.content = 'mutated'
    expect(readConversationPage(base)!.items[0]!.content).toBe('hello')
  })

  it('holds at most three conversations, evicting the least recently read', () => {
    for (const id of ['c1', 'c2', 'c3']) store(scopeFor(id), [message(id)])
    readConversationPage(scopeFor('c1'))
    store(scopeFor('c4'), [message('c4')])
    expect(conversationPageCacheStats().entries).toBe(3)
    expect(readConversationPage(scopeFor('c2'))).toBeNull()
    for (const id of ['c1', 'c3', 'c4']) expect(readConversationPage(scopeFor(id))).not.toBeNull()
  })

  it('keeps the serialized total within 256 KiB and skips an oversized page', () => {
    const near = 'x'.repeat(CONVERSATION_PAGE_CACHE_MAX_ENTRY_BYTES - 1024)
    expect(store(scopeFor('c1'), [message('c1', near)])).toBe(true)
    expect(store(scopeFor('c2'), [message('c2', near)])).toBe(true)
    expect(store(scopeFor('c3'), [message('c3', near)])).toBe(true)
    expect(conversationPageCacheStats().bytes).toBeLessThanOrEqual(CONVERSATION_PAGE_CACHE_MAX_BYTES)
    expect(readConversationPage(scopeFor('c1'))).toBeNull()
    expect(store(scopeFor('c2'), [message('c2', 'x'.repeat(CONVERSATION_PAGE_CACHE_MAX_ENTRY_BYTES))])).toBe(false)
    // The older copy of a page that no longer fits is dropped, never left to be shown.
    expect(readConversationPage(scopeFor('c2'))).toBeNull()
  })

  it('skips pages carrying attachments or another conversation\'s messages', () => {
    const image = { kind: 'image' } as unknown as NonNullable<RoomMessage['input_parts']>[number]
    expect(store(base, [message('c1', 'see', { input_parts: [image] })])).toBe(false)
    expect(store(base, [message('c1', 'see', { metadata_json: { artifact_refs: ['artifact-1'] } as RoomMessage['metadata_json'] })])).toBe(false)
    expect(store(base, [message('c2')])).toBe(false)
    expect(readConversationPage(base)).toBeNull()
  })

  it('expires an entry after one hour and cleans it up without a read', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-25T00:00:00Z'))
    store(scopeFor('c1'), [message('c1')])
    vi.advanceTimersByTime(30 * 60 * 1000)
    store(scopeFor('c2'), [message('c2')])
    vi.advanceTimersByTime(CONVERSATION_PAGE_CACHE_MAX_AGE_MS - 30 * 60 * 1000)
    expect(conversationPageCacheStats().entries).toBe(1)
    expect(readConversationPage(scopeFor('c1'))).toBeNull()
    expect(readConversationPage(scopeFor('c2'))).not.toBeNull()
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(conversationPageCacheStats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('isolates entries by user, Space, role, Room, conversation and read-only reading', () => {
    store(base, [message('c1')])
    for (const other of [
      { userId: 'user-b' }, { spaceId: 'space-b' }, { role: 'owner' }, { roomId: 'room-b' }, { conversationId: 'c2' }, { readOnly: true },
    ]) expect(readConversationPage({ ...base, ...other })).toBeNull()
    expect(readConversationPage(base)).not.toBeNull()
  })

  it('drops a Room\'s pages on a known access change and refuses stores from reads already in flight', () => {
    store(scopeFor('c1'), [message('c1')])
    store(scopeFor('c2', { roomId: 'room-b' }), [message('c2')])
    const inFlight = conversationPageTicket()
    invalidateConversationPages({ roomId: 'room-a' })
    expect(readConversationPage(scopeFor('c1'))).toBeNull()
    expect(readConversationPage(scopeFor('c2', { roomId: 'room-b' }))).not.toBeNull()
    expect(storeConversationPage(scopeFor('c1'), { items: [message('c1')], hasOlder: false }, inFlight)).toBe(false)
    expect(readConversationPage(scopeFor('c1'))).toBeNull()
  })

  it('is cleared by logout residue cleanup, including reads started before it', () => {
    store(base, [message('c1')])
    const inFlight = conversationPageTicket()
    clearSessionResidue()
    expect(readConversationPage(base)).toBeNull()
    expect(storeConversationPage(base, { items: [message('c1')], hasOlder: false }, inFlight)).toBe(false)
    expect(conversationPageCacheStats().entries).toBe(0)
  })

  it('treats 401, 403 and 404 as access refusals only', () => {
    for (const status of [401, 403, 404]) expect(isConversationAccessRefusal({ status })).toBe(true)
    for (const error of [{ status: 500 }, new Error('network'), null]) expect(isConversationAccessRefusal(error)).toBe(false)
  })
})
