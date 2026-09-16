import { ConversationMessageInputSchema, type ConversationInputPart } from '@rainver/protocol'

export const CONVERSATION_DRAFT_VERSION = 1
export const CONVERSATION_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DRAFT_PREFIX = 'rainver:conversation-draft:v1:'

export interface ConversationDraft {
  version: typeof CONVERSATION_DRAFT_VERSION
  destination: string
  text: string
  input_parts: ConversationInputPart[]
  saved_at: string
}

function storageKey(destination: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(destination)}`
}

/**
 * Drafts contain only server-issued ids and logical references. The browser
 * must never persist image bytes, snapshots, tokens, or Host paths here.
 */
export function readConversationDraft(destination: string, storage: Storage | null = safeSessionStorage()): ConversationDraft | null {
  if (!storage || !destination.trim()) return null
  try {
    const raw = storage.getItem(storageKey(destination))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (record.version !== CONVERSATION_DRAFT_VERSION || record.destination !== destination) return null
    if (typeof record.text !== 'string' || typeof record.saved_at !== 'string' || !Array.isArray(record.input_parts)) return null
    const savedAt = Date.parse(record.saved_at)
    const age = Date.now() - savedAt
    if (!Number.isFinite(savedAt) || age > CONVERSATION_DRAFT_MAX_AGE_MS || age < -5 * 60 * 1000) return null
    const input = ConversationMessageInputSchema.safeParse({ text: record.text, input_parts: record.input_parts })
    // An empty draft is not useful, and parsing it through the same input
    // contract also rejects unknown/old part kinds before they reach a send.
    if (!input.success) return null
    return {
      version: CONVERSATION_DRAFT_VERSION,
      destination,
      text: input.data.text,
      input_parts: input.data.input_parts,
      saved_at: record.saved_at,
    }
  } catch {
    return null
  }
}

export function writeConversationDraft(
  draft: Omit<ConversationDraft, 'version' | 'saved_at'>,
  storage: Storage | null = safeSessionStorage(),
): void {
  if (!storage || !draft.destination.trim()) return
  const input = ConversationMessageInputSchema.safeParse({ text: draft.text, input_parts: draft.input_parts })
  if (!input.success || (!input.data.text && input.data.input_parts.length === 0)) {
    clearConversationDraft(draft.destination, storage)
    return
  }
  try {
    storage.setItem(storageKey(draft.destination), JSON.stringify({
      version: CONVERSATION_DRAFT_VERSION,
      destination: draft.destination,
      text: input.data.text,
      input_parts: input.data.input_parts,
      saved_at: new Date().toISOString(),
    } satisfies ConversationDraft))
  } catch {
    // sessionStorage may be unavailable or full. Draft persistence is a
    // convenience and must never make sending fail.
  }
}

export function clearConversationDraft(destination: string, storage: Storage | null = safeSessionStorage()): void {
  if (!storage || !destination.trim()) return
  try {
    storage.removeItem(storageKey(destination))
  } catch {
    // See writeConversationDraft: storage failures are non-fatal.
  }
}

export function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}
