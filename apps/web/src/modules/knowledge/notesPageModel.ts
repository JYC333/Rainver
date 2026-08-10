import type { ReactNode } from 'react'
import type { EntityLink, NoteStatus, NoteSummary } from '../../types/api'

export const ROOT_PARENT = '__root__'

/**
 * Where a notes surface lives.
 *
 * `NotesPage` used to hardcode `/knowledge/notes` at four `navigate` sites and
 * this module at two more. That was the whole of its coupling to a route — the
 * other ~850 lines take no position on where the surface is mounted. Naming the
 * scope makes a second entry point (a Project's notes) a caller decision rather
 * than a second implementation, which is what let the two note surfaces diverge
 * before.
 */
export interface NotesSurfaceScope {
  /** Space-relative base path of the surface, e.g. `/knowledge/notes`. */
  readonly basePath: string
  /**
   * Distinguishes this surface's open-note tabs from every other surface's, so
   * one Project's tabs do not follow the user into another.
   */
  readonly tabsScopeKey: string
  /** The surface's own header, wrapped around the shared note actions. */
  readonly renderHeader: (actions: ReactNode) => ReactNode
  /**
   * A folder this surface exists *because of* — a Project's notes folder. The
   * surface is permanently hoisted to it: the user may focus deeper, but
   * leaving returns here rather than to the whole Space, because outside it
   * this surface has no meaning.
   */
  readonly pinnedRootCollectionId?: string | null
  /** An optional panel beside the editor. The Project surface puts its notebook
   * chat here, which needs to know the notes it may name and to say when it has
   * changed them. */
  readonly renderAside?: (context: NotesSurfaceAsideContext) => ReactNode
}

export interface NotesSurfaceAsideContext {
  /** Titles of the notes in scope, for naming what an action touched. */
  readonly noteTitleById: Map<string, string>
  /** Say the notes changed underneath the page, so it reloads them. */
  readonly onNotesChanged: () => void
}

export function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

/**
 * The open note id, if the path addresses one directly under `basePath`.
 * Segment matching rather than a regex, so a base path never has to be escaped.
 */
export function activeNoteIdFromPath(basePath: string, logicalPath: string): string | undefined {
  const prefix = `${basePath}/`
  if (!logicalPath.startsWith(prefix)) return undefined
  const rest = logicalPath.slice(prefix.length)
  return rest && !rest.includes('/') ? rest : undefined
}

function tabsKey(scopeKey: string) {
  return `agent-space:notes-tabs:${scopeKey}`
}

function hoistKey(scopeKey: string) {
  return `agent-space:notes-hoist:${scopeKey}`
}

/**
 * Hoisting is a working posture, not a durable preference: it is where you are
 * looking right now, in the same way the open tabs are what you are working on
 * right now. So it persists exactly as far as the tabs do — one browser session,
 * per surface — rather than following the account across devices.
 */
export function readHoistRoot(scopeKey: string): string | null {
  try {
    return sessionStorage.getItem(hoistKey(scopeKey))
  } catch {
    return null
  }
}

export function writeHoistRoot(scopeKey: string, collectionId: string | null) {
  try {
    if (collectionId) sessionStorage.setItem(hoistKey(scopeKey), collectionId)
    else sessionStorage.removeItem(hoistKey(scopeKey))
  } catch { /* ignore */ }
}

export function readTabs(scopeKey: string): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(tabsKey(scopeKey)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function writeTabs(scopeKey: string, ids: string[]) {
  try { sessionStorage.setItem(tabsKey(scopeKey), JSON.stringify(ids)) } catch { /* ignore */ }
}

export function hideArchivedOrDeletedNotes(notes: NoteSummary[]) {
  return notes.filter(note => note.status !== 'archived' && note.status !== 'deleted')
}

export function isNoteToNoteLink(link: EntityLink) {
  return link.source_type === 'note' && link.target_type === 'note'
}

export function restoreStatus(status: NoteStatus | undefined) {
  return status && status !== 'archived' && status !== 'deleted' ? status : 'active'
}
