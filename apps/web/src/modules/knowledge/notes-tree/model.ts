import type { NoteCollection, NoteSummary } from '../../../types/api'

export interface CollectionNode extends NoteCollection {
  children: CollectionNode[]
}

export function buildCollectionTree(collections: NoteCollection[]): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>()
  collections.forEach(collection => nodes.set(collection.id, { ...collection, children: [] }))

  const roots: CollectionNode[] = []
  nodes.forEach(node => {
    const parent = node.parent_id ? nodes.get(node.parent_id) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  })

  const sortNodes = (items: CollectionNode[]) => {
    items.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    items.forEach(item => sortNodes(item.children))
  }
  sortNodes(roots)

  return roots
}

export function groupNotesByCollection(notes: NoteSummary[]) {
  const map = new Map<string, NoteSummary[]>()

  for (const note of notes) {
    if (!note.collection_id) continue
    const bucket = map.get(note.collection_id)
    if (bucket) bucket.push(note)
    else map.set(note.collection_id, [note])
  }

  for (const bucket of map.values()) {
    // sort_order is only meaningful once a note has been created into or
    // dragged within a folder at least once (see repository.ts's
    // addNoteToCollection) — notes that still tie at the same value (e.g.
    // both never moved) fall back to newest-updated-first, matching the
    // prior behavior before manual ordering existed.
    bucket.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  }

  return map
}

export function flattenVisibleNotes(
  nodes: CollectionNode[],
  notesByCollection: Map<string, NoteSummary[]>,
  collapsedCollectionIds: Set<string>,
) {
  const out: NoteSummary[] = []

  function visit(items: CollectionNode[]) {
    for (const node of items) {
      const childNotes = notesByCollection.get(node.id) ?? []
      const expanded = (node.children.length > 0 || childNotes.length > 0) && !collapsedCollectionIds.has(node.id)
      if (!expanded) continue
      visit(node.children)
      out.push(...childNotes)
    }
  }

  visit(nodes)
  return out
}

export function collectionPath(collection: NoteCollection, byId: Map<string, NoteCollection>) {
  const names = [collection.name]
  let current = collection
  const seen = new Set<string>([collection.id])

  while (current.parent_id) {
    const parent = byId.get(current.parent_id)
    if (!parent || seen.has(parent.id)) break
    names.unshift(parent.name)
    seen.add(parent.id)
    current = parent
  }

  return names.join(' / ')
}

export function isProtectedCollection(collection: NoteCollection) {
  return collection.is_system || collection.system_role !== 'normal'
}

/** Project-backed folders retain protected actions but may be freely placed
 * in the tree; only fixed workspace roots remain immovable. */
export function isDraggableCollection(collection: NoteCollection) {
  return collection.system_role === 'project'
    || (collection.system_role === 'normal' && !collection.is_system)
}

export function findCollectionNode(nodes: CollectionNode[], id: string): CollectionNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findCollectionNode(node.children, id)
    if (found) return found
  }
  return null
}

/** A folder can never be dropped onto itself or one of its own descendants —
 * that would either no-op or orphan the subtree into a cycle. */
export function collectionAndDescendantIds(node: CollectionNode): Set<string> {
  const ids = new Set<string>([node.id])
  const visit = (children: CollectionNode[]) => {
    for (const child of children) {
      ids.add(child.id)
      visit(child.children)
    }
  }
  visit(node.children)
  return ids
}

export type DragSourceData =
  | { type: 'collection'; collection: NoteCollection }
  | { type: 'note'; note: NoteSummary }

/** A drop target is either a folder row (drop into, appended at the end),
 * the top-level root strip (folders only — a rootless note would vanish
 * from the tree, since the tree only ever renders notes grouped under a
 * folder), or a gap between two siblings (reorder, and/or move into a
 * different parent/folder positioned exactly there). */
export type DropTargetData =
  | { kind: 'into-collection'; collectionId: string }
  | { kind: 'into-root' }
  | { kind: 'collection-gap'; parentId: string | null; beforeId: string | null }
  | { kind: 'note-gap'; collectionId: string; beforeId: string | null }

export interface CollectionMove { id: string; parentId: string | null; sortOrder: number }
export interface NoteMove { id: string; collectionId: string; sortOrder: number }

export type ResolvedTreeDrop =
  | { kind: 'move-collections'; updates: CollectionMove[] }
  | { kind: 'move-notes'; updates: NoteMove[] }

function applyMoves<T extends { id: string }, U extends { id: string }>(
  items: T[],
  updates: U[],
  merge: (item: T, update: U) => T,
): T[] {
  const updateById = new Map(updates.map(update => [update.id, update]))
  return items.map(item => {
    const update = updateById.get(item.id)
    return update ? merge(item, update) : item
  })
}

export function applyCollectionMoves(collections: NoteCollection[], updates: CollectionMove[]): NoteCollection[] {
  return applyMoves(collections, updates, (collection, update) => ({
    ...collection,
    parent_id: update.parentId,
    sort_order: update.sortOrder,
  }))
}

export function nextCollectionSortOrder(
  collections: NoteCollection[],
  parentId: string | null,
): number {
  return collections.reduce(
    (next, collection) => (collection.parent_id ?? null) === parentId
      ? Math.max(next, collection.sort_order + 1)
      : next,
    0,
  )
}

export function upsertCollection(
  collections: NoteCollection[],
  collection: NoteCollection,
): NoteCollection[] {
  const existingIndex = collections.findIndex(item => item.id === collection.id)
  if (existingIndex === -1) return [...collections, collection]
  return collections.map(item => item.id === collection.id ? collection : item)
}

/** Mirrors the database's ON DELETE SET NULL relationship for direct child
 * folders, while removing the deleted folder itself. */
export function removeCollection(
  collections: NoteCollection[],
  collectionId: string,
): NoteCollection[] {
  return collections
    .filter(collection => collection.id !== collectionId)
    .map(collection => collection.parent_id === collectionId
      ? { ...collection, parent_id: null }
      : collection)
}

/** Applies a server-shaped reorder plan to local note summaries. Used for the
 * immediate optimistic tree update while the atomic reorder is persisted. */
export function applyNoteMoves(notes: NoteSummary[], updates: NoteMove[]): NoteSummary[] {
  return applyMoves(notes, updates, (note, update) => ({
    ...note,
    collection_id: update.collectionId,
    sort_order: update.sortOrder,
  }))
}

function reorderedSiblingIds(siblingIds: string[], draggedId: string, beforeId: string | null): string[] {
  const draggedIndex = siblingIds.indexOf(draggedId)
  const withoutDragged = siblingIds.filter(id => id !== draggedId)
  // A gap immediately before the dragged item represents its current
  // position. Once the item is removed from the list, that position is
  // immediately before its former next sibling (or at the end).
  const effectiveBeforeId = beforeId === draggedId
    ? (draggedIndex >= 0 ? siblingIds[draggedIndex + 1] ?? null : null)
    : beforeId
  const insertAt = effectiveBeforeId ? withoutDragged.indexOf(effectiveBeforeId) : -1
  return insertAt === -1
    ? [...withoutDragged, draggedId]
    : [...withoutDragged.slice(0, insertAt), draggedId, ...withoutDragged.slice(insertAt)]
}

/** Computes the full re-sequenced sibling list for a folder move into
 * `targetParentId`, positioned immediately before `beforeId` (or appended
 * at the end when null/omitted, e.g. a plain drop onto a folder row). */
export function planCollectionMove(
  draggedId: string,
  targetParentId: string | null,
  beforeId: string | null,
  allCollections: NoteCollection[],
): CollectionMove[] {
  const dragged = allCollections.find(collection => collection.id === draggedId)
  if (!dragged) return []
  const sourceParentId = dragged.parent_id ?? null
  const targetSiblings = allCollections
    .filter(c => c.id === draggedId || (c.id !== draggedId && (c.parent_id ?? null) === targetParentId))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  const orderedTargetIds = reorderedSiblingIds(targetSiblings.map(c => c.id), draggedId, beforeId)
  const targetUpdates = orderedTargetIds.map((id, sortOrder) => ({ id, parentId: targetParentId, sortOrder }))
  if (sourceParentId === targetParentId) return targetUpdates

  const sourceUpdates = allCollections
    .filter(c => c.id !== draggedId && (c.parent_id ?? null) === sourceParentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((collection, sortOrder) => ({ id: collection.id, parentId: sourceParentId, sortOrder }))
  return [...sourceUpdates, ...targetUpdates]
}

/** Same as planCollectionMove but for notes within a folder — notes sort by
 * sort_order (see groupNotesByCollection), not by name. */
export function planNoteMove(
  draggedId: string,
  targetCollectionId: string,
  beforeId: string | null,
  allNotes: NoteSummary[],
): NoteMove[] {
  const dragged = allNotes.find(note => note.id === draggedId)
  if (!dragged) return []
  const sourceCollectionId = dragged.collection_id
  const targetSiblings = allNotes
    .filter(n => n.id === draggedId || (n.id !== draggedId && n.collection_id === targetCollectionId))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  const orderedTargetIds = reorderedSiblingIds(targetSiblings.map(n => n.id), draggedId, beforeId)
  const targetUpdates = orderedTargetIds.map((id, sortOrder) => ({ id, collectionId: targetCollectionId, sortOrder }))
  if (sourceCollectionId === targetCollectionId || !sourceCollectionId) return targetUpdates

  const sourceUpdates = allNotes
    .filter(n => n.id !== draggedId && n.collection_id === sourceCollectionId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .map((note, sortOrder) => ({ id: note.id, collectionId: sourceCollectionId, sortOrder }))
  return [...sourceUpdates, ...targetUpdates]
}

/** Pure drag/drop-end resolution, kept independent of dnd-kit's event shape
 * so it's unit-testable without simulating real pointer gestures. Returns
 * null for every no-op or invalid drop: dropped on itself, a folder dropped
 * into itself or one of its own descendants, or a type mismatch (a note
 * dropped on a collection-only target, or a folder dropped on a note-only
 * target). */
export function resolveTreeDrop(
  source: DragSourceData,
  target: DropTargetData,
  collectionTree: CollectionNode[],
  allCollections: NoteCollection[],
  allNotes: NoteSummary[],
): ResolvedTreeDrop | null {
  if (source.type === 'collection') {
    const { collection } = source
    const targetParentId = targetParentIdForCollection(target)
    if (targetParentId === undefined) return null // note-only target
    if (targetParentId === collection.id) return null
    const node = findCollectionNode(collectionTree, collection.id)
    if (node && targetParentId !== null && collectionAndDescendantIds(node).has(targetParentId)) return null
    const beforeId = target.kind === 'collection-gap' ? target.beforeId : null
    const updates = planCollectionMove(collection.id, targetParentId, beforeId, allCollections)
    return updates.length > 0 ? { kind: 'move-collections', updates } : null
  }
  const { note } = source
  const targetCollectionId = targetCollectionIdForNote(target)
  if (!targetCollectionId) return null // root or collection-gap target, invalid for a note
  const beforeId = target.kind === 'note-gap' ? target.beforeId : null
  const updates = planNoteMove(note.id, targetCollectionId, beforeId, allNotes)
  return updates.length > 0 ? { kind: 'move-notes', updates } : null
}

function targetParentIdForCollection(target: DropTargetData): string | null | undefined {
  if (target.kind === 'into-collection') return target.collectionId
  if (target.kind === 'into-root') return null
  if (target.kind === 'collection-gap') return target.parentId
  return undefined
}

function targetCollectionIdForNote(target: DropTargetData): string | null {
  if (target.kind === 'into-collection') return target.collectionId
  if (target.kind === 'note-gap') return target.collectionId
  return null
}
