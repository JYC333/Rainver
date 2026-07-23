import { describe, expect, it } from 'vitest'
import type { NoteCollection, NoteSummary } from '../../../../types/api'
import {
  applyCollectionMoves, applyNoteMoves, buildCollectionTree, nextCollectionSortOrder,
  planCollectionMove, planNoteMove, removeCollection, resolveTreeDrop, upsertCollection,
} from '../model'

function makeCollection(overrides: Partial<NoteCollection> = {}): NoteCollection {
  return {
    id: 'col-1',
    space_id: 'personal-1',
    parent_id: null,
    name: 'Folder',
    system_role: 'normal',
    sort_order: 0,
    is_system: false,
    is_hidden: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function makeNote(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'note-1',
    space_id: 'personal-1',
    title: 'Untitled note',
    excerpt: null,
    status: 'active',
    content_format: 'prosemirror_json',
    primary_project_id: null,
    collection_id: 'col-1',
    sort_order: 0,
    version: 1,
    content_hash: null,
    updated_by_user_id: null,
    updated_by_run_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

describe('planCollectionMove', () => {
  it('appends to the end of the target parent when beforeId is null', () => {
    const a = makeCollection({ id: 'a', parent_id: 'target', sort_order: 0 })
    const b = makeCollection({ id: 'b', parent_id: 'target', sort_order: 1 })
    const dragged = makeCollection({ id: 'dragged', parent_id: 'elsewhere' })

    const updates = planCollectionMove('dragged', 'target', null, [a, b, dragged])

    expect(updates).toEqual([
      { id: 'a', parentId: 'target', sortOrder: 0 },
      { id: 'b', parentId: 'target', sortOrder: 1 },
      { id: 'dragged', parentId: 'target', sortOrder: 2 },
    ])
  })

  it('inserts before a specific sibling, shifting the rest down', () => {
    const a = makeCollection({ id: 'a', parent_id: 'target', sort_order: 0 })
    const b = makeCollection({ id: 'b', parent_id: 'target', sort_order: 1 })
    const dragged = makeCollection({ id: 'dragged', parent_id: 'target', sort_order: 2 })

    const updates = planCollectionMove('dragged', 'target', 'b', [a, b, dragged])

    expect(updates).toEqual([
      { id: 'a', parentId: 'target', sortOrder: 0 },
      { id: 'dragged', parentId: 'target', sortOrder: 1 },
      { id: 'b', parentId: 'target', sortOrder: 2 },
    ])
  })

  it('moves to the top level when targetParentId is null', () => {
    const dragged = makeCollection({ id: 'dragged', parent_id: 'parent' })
    const root = makeCollection({ id: 'root', parent_id: null, sort_order: 0 })

    const updates = planCollectionMove('dragged', null, null, [root, dragged])

    expect(updates).toEqual([
      { id: 'root', parentId: null, sortOrder: 0 },
      { id: 'dragged', parentId: null, sortOrder: 1 },
    ])
  })

  it('compacts the source siblings when moving to another parent', () => {
    const sourceA = makeCollection({ id: 'source-a', parent_id: 'source', sort_order: 0 })
    const dragged = makeCollection({ id: 'dragged', parent_id: 'source', sort_order: 1 })
    const sourceB = makeCollection({ id: 'source-b', parent_id: 'source', sort_order: 2 })
    const target = makeCollection({ id: 'target-a', parent_id: 'target', sort_order: 0 })

    expect(planCollectionMove('dragged', 'target', null, [sourceA, dragged, sourceB, target])).toEqual([
      { id: 'source-a', parentId: 'source', sortOrder: 0 },
      { id: 'source-b', parentId: 'source', sortOrder: 1 },
      { id: 'target-a', parentId: 'target', sortOrder: 0 },
      { id: 'dragged', parentId: 'target', sortOrder: 1 },
    ])
  })

  it('keeps the current order when dropped into its own leading gap', () => {
    const a = makeCollection({ id: 'a', parent_id: 'target', sort_order: 0 })
    const b = makeCollection({ id: 'b', parent_id: 'target', sort_order: 1 })
    const c = makeCollection({ id: 'c', parent_id: 'target', sort_order: 2 })

    expect(planCollectionMove('b', 'target', 'b', [a, b, c])).toEqual([
      { id: 'a', parentId: 'target', sortOrder: 0 },
      { id: 'b', parentId: 'target', sortOrder: 1 },
      { id: 'c', parentId: 'target', sortOrder: 2 },
    ])
  })
})

describe('planNoteMove', () => {
  it('appends to the end of the target folder, sorted by existing sort_order', () => {
    const a = makeNote({ id: 'a', collection_id: 'target', sort_order: 0 })
    const b = makeNote({ id: 'b', collection_id: 'target', sort_order: 1 })
    const dragged = makeNote({ id: 'dragged', collection_id: 'elsewhere' })

    const updates = planNoteMove('dragged', 'target', null, [a, b, dragged])

    expect(updates).toEqual([
      { id: 'a', collectionId: 'target', sortOrder: 0 },
      { id: 'b', collectionId: 'target', sortOrder: 1 },
      { id: 'dragged', collectionId: 'target', sortOrder: 2 },
    ])
  })

  it('inserts before a specific sibling', () => {
    const a = makeNote({ id: 'a', collection_id: 'target', sort_order: 0 })
    const b = makeNote({ id: 'b', collection_id: 'target', sort_order: 1 })
    const dragged = makeNote({ id: 'dragged', collection_id: 'target', sort_order: 2 })

    const updates = planNoteMove('dragged', 'target', 'a', [a, b, dragged])

    expect(updates).toEqual([
      { id: 'dragged', collectionId: 'target', sortOrder: 0 },
      { id: 'a', collectionId: 'target', sortOrder: 1 },
      { id: 'b', collectionId: 'target', sortOrder: 2 },
    ])
  })

  it('compacts the source notes when moving to another folder', () => {
    const sourceA = makeNote({ id: 'source-a', collection_id: 'source', sort_order: 0 })
    const dragged = makeNote({ id: 'dragged', collection_id: 'source', sort_order: 1 })
    const sourceB = makeNote({ id: 'source-b', collection_id: 'source', sort_order: 2 })
    const target = makeNote({ id: 'target-a', collection_id: 'target', sort_order: 0 })

    expect(planNoteMove('dragged', 'target', null, [sourceA, dragged, sourceB, target])).toEqual([
      { id: 'source-a', collectionId: 'source', sortOrder: 0 },
      { id: 'source-b', collectionId: 'source', sortOrder: 1 },
      { id: 'target-a', collectionId: 'target', sortOrder: 0 },
      { id: 'dragged', collectionId: 'target', sortOrder: 1 },
    ])
  })

  it('keeps the current order when dropped into its own leading gap', () => {
    const a = makeNote({ id: 'a', collection_id: 'target', sort_order: 0 })
    const b = makeNote({ id: 'b', collection_id: 'target', sort_order: 1 })
    const c = makeNote({ id: 'c', collection_id: 'target', sort_order: 2 })

    expect(planNoteMove('b', 'target', 'b', [a, b, c])).toEqual([
      { id: 'a', collectionId: 'target', sortOrder: 0 },
      { id: 'b', collectionId: 'target', sortOrder: 1 },
      { id: 'c', collectionId: 'target', sortOrder: 2 },
    ])
  })
})

describe('applyNoteMoves', () => {
  it('updates collection and order locally without changing unrelated note data', () => {
    const a = makeNote({ id: 'a', collection_id: 'source', sort_order: 0, title: 'A' })
    const b = makeNote({ id: 'b', collection_id: 'source', sort_order: 1, title: 'B' })

    const result = applyNoteMoves([a, b], [
      { id: 'b', collectionId: 'target', sortOrder: 0 },
      { id: 'a', collectionId: 'source', sortOrder: 0 },
    ])

    expect(result).toEqual([
      expect.objectContaining({ id: 'a', title: 'A', collection_id: 'source', sort_order: 0 }),
      expect.objectContaining({ id: 'b', title: 'B', collection_id: 'target', sort_order: 0 }),
    ])
    expect(result[0]).not.toBe(a)
    expect(result[1]).not.toBe(b)
  })
})

describe('applyCollectionMoves', () => {
  it('updates parent and order locally without changing unrelated folder data', () => {
    const a = makeCollection({ id: 'a', parent_id: null, sort_order: 0, name: 'A' })
    const b = makeCollection({ id: 'b', parent_id: null, sort_order: 1, name: 'B' })

    const result = applyCollectionMoves([a, b], [
      { id: 'b', parentId: 'a', sortOrder: 0 },
    ])

    expect(result).toEqual([
      a,
      expect.objectContaining({ id: 'b', name: 'B', parent_id: 'a', sort_order: 0 }),
    ])
    expect(result[0]).toBe(a)
    expect(result[1]).not.toBe(b)
  })
})

describe('collection CRUD projections', () => {
  it('appends a new folder after its siblings regardless of its name', () => {
    const parent = makeCollection({ id: 'parent' })
    const zulu = makeCollection({ id: 'zulu', parent_id: 'parent', name: 'Zulu', sort_order: 3 })
    const alpha = makeCollection({ id: 'alpha', parent_id: 'parent', name: 'Alpha', sort_order: 7 })

    expect(nextCollectionSortOrder([parent, zulu, alpha], 'parent')).toBe(8)
    expect(nextCollectionSortOrder([parent, zulu, alpha], null)).toBe(1)
  })

  it('upserts an optimistic folder without duplicating its stable id', () => {
    const optimistic = makeCollection({ id: 'new', name: 'Draft' })
    const persisted = makeCollection({ id: 'new', name: 'Persisted' })

    expect(upsertCollection(upsertCollection([], optimistic), persisted)).toEqual([persisted])
  })

  it('removes a folder and projects direct children to root like the database', () => {
    const parent = makeCollection({ id: 'parent' })
    const child = makeCollection({ id: 'child', parent_id: 'parent' })
    const grandchild = makeCollection({ id: 'grandchild', parent_id: 'child' })

    expect(removeCollection([parent, child, grandchild], 'parent')).toEqual([
      expect.objectContaining({ id: 'child', parent_id: null }),
      grandchild,
    ])
  })
})

describe('resolveTreeDrop', () => {
  it('moves a folder into a different, non-descendant folder (drop onto its row)', () => {
    const parent = makeCollection({ id: 'parent', name: 'Parent' })
    const target = makeCollection({ id: 'target', name: 'Target' })
    const dragged = makeCollection({ id: 'dragged', name: 'Dragged', parent_id: 'parent' })
    const all = [parent, target, dragged]
    const tree = buildCollectionTree(all)

    const result = resolveTreeDrop({ type: 'collection', collection: dragged }, { kind: 'into-collection', collectionId: 'target' }, tree, all, [])

    expect(result).toEqual({ kind: 'move-collections', updates: [{ id: 'dragged', parentId: 'target', sortOrder: 0 }] })
  })

  it('rejects dropping a folder onto itself', () => {
    const dragged = makeCollection({ id: 'dragged' })
    const all = [dragged]
    const tree = buildCollectionTree(all)

    expect(resolveTreeDrop({ type: 'collection', collection: dragged }, { kind: 'into-collection', collectionId: 'dragged' }, tree, all, [])).toBeNull()
  })

  it('rejects dropping a folder onto one of its own descendants (would create a cycle)', () => {
    const grandparent = makeCollection({ id: 'grandparent' })
    const parent = makeCollection({ id: 'parent', parent_id: 'grandparent' })
    const child = makeCollection({ id: 'child', parent_id: 'parent' })
    const all = [grandparent, parent, child]
    const tree = buildCollectionTree(all)

    // Dragging "grandparent" onto its own grandchild "child" must be rejected.
    expect(resolveTreeDrop({ type: 'collection', collection: grandparent }, { kind: 'into-collection', collectionId: 'child' }, tree, all, [])).toBeNull()
    // Dropping onto a direct child is rejected the same way.
    expect(resolveTreeDrop({ type: 'collection', collection: grandparent }, { kind: 'into-collection', collectionId: 'parent' }, tree, all, [])).toBeNull()
  })

  it('moves a folder back to the top level via the root drop zone', () => {
    const dragged = makeCollection({ id: 'dragged', parent_id: 'parent' })
    const all = [dragged]
    const tree = buildCollectionTree(all)

    const result = resolveTreeDrop({ type: 'collection', collection: dragged }, { kind: 'into-root' }, tree, all, [])

    expect(result).toEqual({ kind: 'move-collections', updates: [{ id: 'dragged', parentId: null, sortOrder: 0 }] })
  })

  it('rejects a note dropped on the root zone (it would vanish from the tree)', () => {
    const note = makeNote({ collection_id: 'col-a' })

    expect(resolveTreeDrop({ type: 'note', note }, { kind: 'into-root' }, [], [], [note])).toBeNull()
  })

  it('rejects a folder dropped on a note-gap target', () => {
    const dragged = makeCollection({ id: 'dragged' })
    const all = [dragged]

    expect(resolveTreeDrop({ type: 'collection', collection: dragged }, { kind: 'note-gap', collectionId: 'col-a', beforeId: null }, buildCollectionTree(all), all, [])).toBeNull()
  })

  it('rejects a note dropped on a collection-gap target', () => {
    const note = makeNote({ collection_id: 'col-a' })

    expect(resolveTreeDrop({ type: 'note', note }, { kind: 'collection-gap', parentId: null, beforeId: null }, [], [], [note])).toBeNull()
  })

  it('moves a note into a different folder (drop onto its row)', () => {
    const note = makeNote({ collection_id: 'col-a' })

    const result = resolveTreeDrop({ type: 'note', note }, { kind: 'into-collection', collectionId: 'col-b' }, [], [], [note])

    expect(result).toEqual({ kind: 'move-notes', updates: [{ id: 'note-1', collectionId: 'col-b', sortOrder: 0 }] })
  })

  it('reorders a note within its own folder via a note-gap target', () => {
    const a = makeNote({ id: 'a', collection_id: 'col-a', sort_order: 0 })
    const b = makeNote({ id: 'b', collection_id: 'col-a', sort_order: 1 })
    const all = [a, b]

    const result = resolveTreeDrop({ type: 'note', note: b }, { kind: 'note-gap', collectionId: 'col-a', beforeId: 'a' }, [], [], all)

    expect(result).toEqual({ kind: 'move-notes', updates: [{ id: 'b', collectionId: 'col-a', sortOrder: 0 }, { id: 'a', collectionId: 'col-a', sortOrder: 1 }] })
  })
})
