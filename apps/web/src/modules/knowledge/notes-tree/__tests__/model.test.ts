import { describe, expect, it } from 'vitest'
import type { NoteCollection, NoteSummary } from '../../../../types/api'
import {
  applyCollectionMoves, applyNoteMoves, buildCollectionTree, hoistedCollectionIds,
  nextCollectionSortOrder, placementKey, planCollectionMove, planNoteMove, removeCollection,
  resolveTreeDrop, upsertCollection,
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
    project_role: null,
    role_project_id: null,
    placements: [{ collection_id: 'col-1', sort_order: 0 }],
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

function placedNote(id: string, collectionId: string, sortOrder: number, overrides: Partial<NoteSummary> = {}) {
  return makeNote({ id, placements: [{ collection_id: collectionId, sort_order: sortOrder }], ...overrides })
}

const move = (noteId: string, fromCollectionId: string, collectionId: string, sortOrder: number) =>
  ({ noteId, fromCollectionId, collectionId, sortOrder })

/** The tree row for one of a note's placements — what a drag actually carries. */
function placementOf(note: NoteSummary, collectionId: string) {
  const placement = note.placements.find(entry => entry.collection_id === collectionId)!
  return { note, collectionId, sortOrder: placement.sort_order, key: placementKey(collectionId, note.id) }
}

describe('planNoteMove', () => {
  it('appends to the end of the target folder, sorted by existing sort_order', () => {
    const a = placedNote('a', 'target', 0)
    const b = placedNote('b', 'target', 1)
    const dragged = placedNote('dragged', 'elsewhere', 0)

    const updates = planNoteMove('dragged', 'elsewhere', 'target', null, [a, b, dragged])

    expect(updates).toEqual([
      move('a', 'target', 'target', 0),
      move('b', 'target', 'target', 1),
      move('dragged', 'elsewhere', 'target', 2),
    ])
  })

  it('inserts before a specific sibling', () => {
    const a = placedNote('a', 'target', 0)
    const b = placedNote('b', 'target', 1)
    const dragged = placedNote('dragged', 'target', 2)

    const updates = planNoteMove('dragged', 'target', 'target', 'a', [a, b, dragged])

    expect(updates).toEqual([
      move('dragged', 'target', 'target', 0),
      move('a', 'target', 'target', 1),
      move('b', 'target', 'target', 2),
    ])
  })

  it('compacts the source notes when moving to another folder', () => {
    const sourceA = placedNote('source-a', 'source', 0)
    const dragged = placedNote('dragged', 'source', 1)
    const sourceB = placedNote('source-b', 'source', 2)
    const target = placedNote('target-a', 'target', 0)

    expect(planNoteMove('dragged', 'source', 'target', null, [sourceA, dragged, sourceB, target])).toEqual([
      move('source-a', 'source', 'source', 0),
      move('source-b', 'source', 'source', 1),
      move('target-a', 'target', 'target', 0),
      move('dragged', 'source', 'target', 1),
    ])
  })

  it('keeps the current order when dropped into its own leading gap', () => {
    const a = placedNote('a', 'target', 0)
    const b = placedNote('b', 'target', 1)
    const c = placedNote('c', 'target', 2)

    expect(planNoteMove('b', 'target', 'target', 'b', [a, b, c])).toEqual([
      move('a', 'target', 'target', 0),
      move('b', 'target', 'target', 1),
      move('c', 'target', 'target', 2),
    ])
  })

  /** The defect this phase exists for: a note in two folders, reordered in one. */
  it('plans only the placement being dragged, leaving the note\'s others alone', () => {
    const shared = makeNote({
      id: 'shared',
      placements: [
        { collection_id: 'first', sort_order: 0 },
        { collection_id: 'second', sort_order: 0 },
      ],
    })
    const other = placedNote('other', 'first', 1)

    const updates = planNoteMove('shared', 'first', 'first', null, [shared, other])

    expect(updates).toEqual([
      move('other', 'first', 'first', 0),
      move('shared', 'first', 'first', 1),
    ])
    expect(updates.every(update => update.fromCollectionId === 'first')).toBe(true)
  })
})

describe('applyNoteMoves', () => {
  it('updates collection and order locally without changing unrelated note data', () => {
    const a = placedNote('a', 'source', 0, { title: 'A' })
    const b = placedNote('b', 'source', 1, { title: 'B' })

    const result = applyNoteMoves([a, b], [
      move('b', 'source', 'target', 0),
      move('a', 'source', 'source', 0),
    ])

    expect(result).toEqual([
      expect.objectContaining({ id: 'a', title: 'A', placements: [{ collection_id: 'source', sort_order: 0 }] }),
      expect.objectContaining({ id: 'b', title: 'B', placements: [{ collection_id: 'target', sort_order: 0 }] }),
    ])
    expect(result[0]).not.toBe(a)
    expect(result[1]).not.toBe(b)
  })

  it('moves one placement and leaves the note\'s other placements untouched', () => {
    const shared = makeNote({
      id: 'shared',
      placements: [
        { collection_id: 'first', sort_order: 3 },
        { collection_id: 'second', sort_order: 7 },
      ],
    })

    const [result] = applyNoteMoves([shared], [move('shared', 'first', 'moved', 0)])

    expect(result!.placements).toEqual([
      { collection_id: 'moved', sort_order: 0 },
      { collection_id: 'second', sort_order: 7 },
    ])
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
    const note = placedNote('note-1', 'col-a', 0)

    expect(resolveTreeDrop({ type: 'note', placed: placementOf(note, 'col-a') }, { kind: 'into-root' }, [], [], [note])).toBeNull()
  })

  it('rejects a folder dropped on a note-gap target', () => {
    const dragged = makeCollection({ id: 'dragged' })
    const all = [dragged]

    expect(resolveTreeDrop({ type: 'collection', collection: dragged }, { kind: 'note-gap', collectionId: 'col-a', beforeId: null }, buildCollectionTree(all), all, [])).toBeNull()
  })

  it('rejects a note dropped on a collection-gap target', () => {
    const note = placedNote('note-1', 'col-a', 0)

    expect(resolveTreeDrop({ type: 'note', placed: placementOf(note, 'col-a') }, { kind: 'collection-gap', parentId: null, beforeId: null }, [], [], [note])).toBeNull()
  })

  it('moves a note into a different folder (drop onto its row)', () => {
    const note = placedNote('note-1', 'col-a', 0)

    const result = resolveTreeDrop({ type: 'note', placed: placementOf(note, 'col-a') }, { kind: 'into-collection', collectionId: 'col-b' }, [], [], [note])

    expect(result).toEqual({ kind: 'move-notes', updates: [move('note-1', 'col-a', 'col-b', 0)] })
  })

  it('reorders a note within its own folder via a note-gap target', () => {
    const a = placedNote('a', 'col-a', 0)
    const b = placedNote('b', 'col-a', 1)
    const all = [a, b]

    const result = resolveTreeDrop({ type: 'note', placed: placementOf(b, 'col-a') }, { kind: 'note-gap', collectionId: 'col-a', beforeId: 'a' }, [], [], all)

    expect(result).toEqual({ kind: 'move-notes', updates: [move('b', 'col-a', 'col-a', 0), move('a', 'col-a', 'col-a', 1)] })
  })

  it('adds a placement instead of moving when the drop is additive', () => {
    const note = placedNote('note-1', 'col-a', 0)

    const result = resolveTreeDrop(
      { type: 'note', placed: placementOf(note, 'col-a') },
      { kind: 'into-collection', collectionId: 'col-b' },
      [], [], [note], true,
    )

    expect(result).toEqual({ kind: 'place-note', noteId: 'note-1', collectionId: 'col-b' })
  })

  it('refuses to place a note in a folder it is already in, either way', () => {
    const note = makeNote({
      id: 'note-1',
      placements: [
        { collection_id: 'col-a', sort_order: 0 },
        { collection_id: 'col-b', sort_order: 0 },
      ],
    })
    const dragged = { type: 'note' as const, placed: placementOf(note, 'col-a') }
    const ontoColB = { kind: 'into-collection' as const, collectionId: 'col-b' }

    expect(resolveTreeDrop(dragged, ontoColB, [], [], [note], true)).toBeNull()
    expect(resolveTreeDrop(dragged, ontoColB, [], [], [note])).toBeNull()
  })
})

describe('hoistedCollectionIds', () => {
  const collections = [
    makeCollection({ id: 'root-a', name: 'A' }),
    makeCollection({ id: 'child-a1', name: 'A1', parent_id: 'root-a' }),
    makeCollection({ id: 'grandchild-a1', name: 'A1a', parent_id: 'child-a1' }),
    makeCollection({ id: 'root-b', name: 'B' }),
  ]

  it('spans every collection when nothing is hoisted', () => {
    // Null is not "the empty set": the note query reads the two differently.
    expect(hoistedCollectionIds(collections, null)).toBeNull()
  })

  it('collects the hoist root and everything beneath it', () => {
    expect(hoistedCollectionIds(collections, 'root-a')).toEqual(
      new Set(['root-a', 'child-a1', 'grandchild-a1']),
    )
  })

  it('excludes siblings and ancestors of the hoist root', () => {
    const ids = hoistedCollectionIds(collections, 'child-a1')!
    expect(ids).toEqual(new Set(['child-a1', 'grandchild-a1']))
    expect(ids.has('root-a')).toBe(false)
    expect(ids.has('root-b')).toBe(false)
  })

  it('returns an empty scope when the hoist root no longer exists', () => {
    expect(hoistedCollectionIds(collections, 'deleted')).toEqual(new Set())
  })

  it('terminates on a parent cycle rather than looping', () => {
    const cyclic = [
      makeCollection({ id: 'x', parent_id: 'y' }),
      makeCollection({ id: 'y', parent_id: 'x' }),
    ]
    expect(hoistedCollectionIds(cyclic, 'x')).toEqual(new Set(['x', 'y']))
  })
})
