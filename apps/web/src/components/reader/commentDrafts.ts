import { registerInMemoryResidue } from '../../lib/sessionResidue'

/**
 * Unsent Reader comments, kept outside the component lifecycle so leaving the
 * Reader by any route (Shell navigation, browser history, programmatic
 * navigation, switching documents) does not lose them and returning restores
 * them — together with whether one is being sent right now.
 *
 * Privacy: the text lives only in this tab's memory — never localStorage,
 * sessionStorage or the network — so a reload or closed tab ends it (the
 * browser asks first while any live draft exists). Drafts are keyed by Space,
 * document and annotation, and are dropped on logout/401/another tab's logout,
 * when the document or its annotations become unreadable, when their
 * annotation is no longer listed with its full body, after 24 hours, and
 * beyond 20 documents.
 *
 * Every removal is a store change that subscribers hear about; reads never
 * modify the store. Expiry runs on a timer, and again whenever the tab becomes
 * visible or focused (timers do not run in a sleeping tab); between those,
 * reads already treat an expired draft as gone, so what is shown, counted and
 * warned about on unload agree.
 */
export interface ReaderDraftScope { spaceId: string; documentType: string; documentId: string }

export const COMMENT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const COMMENT_DRAFT_MAX_DOCUMENTS = 20

interface StoredDraft { text: string; updatedAt: number }
interface Sending { body: string; epoch: number; token: number }

const store = new Map<string, Map<string, StoredDraft>>()
/** Comments whose POST is in flight, by scope key + annotation id. */
const sending = new Map<string, Sending>()
const listeners = new Set<() => void>()
let version = 0
/** Advances when the signed-in session ends; replies from an older session change nothing. */
let epoch = 0
let tokens = 0
let expiryTimer: ReturnType<typeof setTimeout> | null = null

function changed() {
  version += 1
  for (const listener of listeners) listener()
}

const live = (draft: StoredDraft, now: number) => now - draft.updatedAt <= COMMENT_DRAFT_MAX_AGE_MS
const sendKey = (scopeKey: string, annotationId: string) => `${scopeKey}#${annotationId}`

function scheduleExpiry() {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
  let oldest = Infinity
  for (const drafts of store.values()) for (const draft of drafts.values()) oldest = Math.min(oldest, draft.updatedAt)
  if (oldest === Infinity) return
  const delay = Math.max(0, oldest + COMMENT_DRAFT_MAX_AGE_MS - Date.now() + 1)
  // Browsers cap timers at ~24.8 days; the 24-hour bound is well inside it.
  expiryTimer = setTimeout(() => { expiryTimer = null; sweepExpiredCommentDrafts() }, delay)
}

/** Removes expired drafts and the oldest documents beyond the cap; notifies if anything went. */
export function sweepExpiredCommentDrafts(now = Date.now()): void {
  let removed = false
  for (const [key, drafts] of store) {
    for (const [annotationId, draft] of drafts) if (!live(draft, now)) { drafts.delete(annotationId); removed = true }
    if (drafts.size === 0) store.delete(key)
  }
  while (store.size > COMMENT_DRAFT_MAX_DOCUMENTS) {
    const oldest = [...store].sort((a, b) => newest(a[1]) - newest(b[1]))[0]
    store.delete(oldest[0]); removed = true
  }
  scheduleExpiry()
  if (removed) changed()
}

function newest(drafts: Map<string, StoredDraft>): number {
  let latest = 0
  for (const draft of drafts.values()) latest = Math.max(latest, draft.updatedAt)
  return latest
}

function hasLiveDraft(now = Date.now()): boolean {
  for (const drafts of store.values()) for (const draft of drafts.values()) if (live(draft, now)) return true
  return false
}

registerInMemoryResidue(() => {
  store.clear(); sending.clear(); epoch += 1
  scheduleExpiry(); changed()
})

if (typeof window !== 'undefined') {
  // A sleeping tab's timer may not have fired: catch up when the person returns.
  const catchUp = () => { if (document.visibilityState !== 'hidden') sweepExpiredCommentDrafts() }
  window.addEventListener('focus', catchUp)
  document.addEventListener('visibilitychange', catchUp)
  // Drafts live only in memory, so a reload or closed tab would end them.
  window.addEventListener('beforeunload', event => {
    if (!hasLiveDraft()) return
    event.preventDefault()
    event.returnValue = ''
  })
}

export function subscribeCommentDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Changes whenever any draft or send state changes; pair with the reads below. */
export function commentDraftsVersion(): number {
  return version
}

export function readerDraftScopeKey(scope: ReaderDraftScope): string {
  return [scope.spaceId, scope.documentType, scope.documentId].map(part => encodeURIComponent(part)).join('|')
}

/** The document's live unsent comments by annotation id. Never modifies the store. */
export function readCommentDrafts(scope: ReaderDraftScope, now = Date.now()): Record<string, string> {
  const drafts = store.get(readerDraftScopeKey(scope))
  if (!drafts) return {}
  return Object.fromEntries([...drafts].filter(([, draft]) => live(draft, now)).map(([id, draft]) => [id, draft.text]))
}

/** Records the current text; whitespace-only text removes the draft. */
export function writeCommentDraft(scope: ReaderDraftScope, annotationId: string, text: string): void {
  const key = readerDraftScopeKey(scope)
  const drafts = store.get(key) ?? new Map<string, StoredDraft>()
  if (text.trim()) drafts.set(annotationId, { text, updatedAt: Date.now() })
  else drafts.delete(annotationId)
  if (drafts.size) store.set(key, drafts); else store.delete(key)
  sweepExpiredCommentDrafts()
  changed()
}

/** Keeps only drafts whose annotation is in the authorized list with its full body. */
export function retainCommentDrafts(scope: ReaderDraftScope, annotationIds: Iterable<string>): void {
  const key = readerDraftScopeKey(scope)
  const drafts = store.get(key)
  if (!drafts) return
  const keep = new Set(annotationIds)
  let removed = false
  for (const id of drafts.keys()) if (!keep.has(id)) { drafts.delete(id); removed = true }
  if (!drafts.size) store.delete(key)
  if (removed) { scheduleExpiry(); changed() }
}

/** The annotation is no longer the person's to comment on. */
export function clearCommentDraft(scope: ReaderDraftScope, annotationId: string): void {
  const key = readerDraftScopeKey(scope)
  const drafts = store.get(key)
  const removedDraft = drafts?.delete(annotationId) ?? false
  if (drafts && !drafts.size) store.delete(key)
  const removedSend = sending.delete(sendKey(key, annotationId))
  if (removedDraft || removedSend) { scheduleExpiry(); changed() }
}

/** The document became unreadable. */
export function clearDocumentCommentDrafts(scope: ReaderDraftScope): void {
  const key = readerDraftScopeKey(scope)
  let removed = store.delete(key)
  for (const id of [...sending.keys()]) if (id.startsWith(`${key}#`)) { sending.delete(id); removed = true }
  if (removed) { scheduleExpiry(); changed() }
}

/** Whether this annotation's comment is being sent, by this or an earlier Reader instance. */
export function commentSending(scope: ReaderDraftScope, annotationId: string): boolean {
  return sending.has(sendKey(readerDraftScopeKey(scope), annotationId))
}

export interface CommentSend { key: string; scope: ReaderDraftScope; annotationId: string; body: string; epoch: number; token: number }

/**
 * Claims the send of this annotation's comment. Null while another send for it
 * is in flight anywhere in this tab, so leaving and returning cannot post the
 * same comment twice. Leaving does not cancel a send; returning shows it pending.
 */
export function beginCommentSend(scope: ReaderDraftScope, annotationId: string, body: string): CommentSend | null {
  const key = sendKey(readerDraftScopeKey(scope), annotationId)
  if (sending.has(key)) return null
  const claim = { key, scope, annotationId, body, epoch, token: ++tokens }
  sending.set(key, { body, epoch, token: claim.token })
  changed()
  return claim
}

/**
 * Ends a send. Success removes the draft only if it still holds the text that
 * was sent; failure keeps it for a retry. A send from an earlier session, or
 * one whose claim was dropped (the document or annotation became unreadable),
 * changes nothing. Returns whether the claim was still current.
 */
export function finishCommentSend(claim: CommentSend, succeeded: boolean): boolean {
  const current = sending.get(claim.key)
  if (claim.epoch !== epoch || current?.token !== claim.token) return false
  sending.delete(claim.key)
  if (succeeded && (readCommentDrafts(claim.scope)[claim.annotationId] ?? '').trim() === claim.body) {
    const drafts = store.get(readerDraftScopeKey(claim.scope))
    drafts?.delete(claim.annotationId)
    if (drafts && !drafts.size) store.delete(readerDraftScopeKey(claim.scope))
    scheduleExpiry()
  }
  changed()
  return true
}

export function __commentDraftCountForTests(): number {
  let count = 0
  for (const drafts of store.values()) count += drafts.size
  return count
}

export function __clearCommentDraftsForTests(): void {
  store.clear(); sending.clear()
  scheduleExpiry(); changed()
}
