import type { ReadingItem, ReadingQuery } from '@rainver/protocol'

/**
 * The Reading list a person opened a document from, kept for this tab so the
 * Reader can offer the previous and next item and the list can come back to
 * where they were. It holds only what the server listed for them (ids, keys,
 * an opaque cursor), never text; sessionStorage is cleared on logout.
 *
 * The Reader re-checks every document it opens; an entry here grants nothing.
 */
const KEY = 'rainver:reading-sequence'
const RETURN_KEY = 'rainver:reading-return'
/** Entries kept per list: enough for a session of reading, small in storage. */
const MAX_ENTRIES = 300

export interface SequenceEntry { source_item_id: string; key: string; reader_origin: ReadingItem['reader_origin']; full: boolean; topic_change_id: string | null; unread: boolean }

export interface ReadingSequence {
  spaceId: string
  projectId: string | null
  /** The list's own address (validated by readingReturnTo when used). */
  returnTo: string
  query: Pick<ReadingQuery, 'view' | 'q' | 'topic' | 'topic_selection' | 'sort'>
  entries: SequenceEntry[]
  next_cursor: string | null
}

export function sequenceEntry(item: ReadingItem): SequenceEntry {
  return {
    source_item_id: item.source_item_id, key: item.key, reader_origin: item.reader_origin, full: item.access_level === 'full',
    topic_change_id: item.topic_change?.id ?? null, unread: item.read_status !== 'read' && item.read_status !== 'discussed',
  }
}

function read<T>(key: string): T | null {
  try { return JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as T | null } catch { return null }
}
function write(key: string, value: unknown): void {
  try { window.sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* full or private mode: no sequence */ }
}

export function saveReadingSequence(sequence: ReadingSequence): void {
  write(KEY, { ...sequence, entries: sequence.entries.slice(0, MAX_ENTRIES) })
}

/**
 * Which list row a Reader shows: the item and, for a topic update, the change
 * (the Reader's `change` parameter). The same item can be listed once as
 * material and again for each update, so the item alone does not name a row.
 */
export interface SequencePlace { itemId: string; changeId: string | null }
const isPlace = (entry: SequenceEntry, place: SequencePlace) => entry.source_item_id === place.itemId && (entry.topic_change_id ?? null) === place.changeId

/** The sequence for this list, Space and Project, if the row is in it. */
export function readingSequenceFor(spaceId: string, returnTo: string, place: SequencePlace): ReadingSequence | null {
  const sequence = read<ReadingSequence>(KEY)
  if (!sequence || sequence.spaceId !== spaceId || sequence.returnTo !== returnTo || !Array.isArray(sequence.entries)) return null
  return sequence.entries.some(entry => isPlace(entry, place)) ? sequence : null
}

/** The neighbours of a row that can be opened (summary-only entries are skipped). */
export function neighbours(sequence: ReadingSequence, place: SequencePlace): { previous: SequenceEntry | null; next: SequenceEntry | null; index: number } {
  const index = sequence.entries.findIndex(entry => isPlace(entry, place))
  const previous = sequence.entries.slice(0, Math.max(0, index)).reverse().find(entry => entry.full) ?? null
  const next = index < 0 ? null : sequence.entries.slice(index + 1).find(entry => entry.full) ?? null
  return { previous, next, index }
}

/** Where the list was left: the item opened from it and how many rows were loaded. */
export interface ReadingReturnState { spaceId: string; returnTo: string; key: string; loaded: number; at?: number }
/** A return later than this is a new visit to the list, not a way back. */
const RETURN_TTL_MS = 30 * 60_000

export function saveReadingReturn(state: ReadingReturnState): void { write(RETURN_KEY, { ...state, at: Date.now() }) }

export function readingReturnFor(spaceId: string, returnTo: string): ReadingReturnState | null {
  const state = read<ReadingReturnState>(RETURN_KEY)
  if (!state || state.spaceId !== spaceId || state.returnTo !== returnTo || typeof state.key !== 'string') return null
  return typeof state.at === 'number' && Date.now() - state.at < RETURN_TTL_MS ? state : null
}

export function clearReadingReturn(): void {
  try { window.sessionStorage.removeItem(RETURN_KEY) } catch { /* private mode */ }
}
