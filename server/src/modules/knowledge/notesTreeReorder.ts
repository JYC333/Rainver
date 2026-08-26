import {
  HttpError,
  optionalString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import {
  assertNoteCollectionProjectWriter,
  bindNoteToPlacementProject,
} from "./noteWriter.js";
import { assertProjectWriter } from "../projects/access.js";
import { contentReadSql } from "../access/contentAccessSql.js";

/**
 * A note reorder addresses a **placement**, not a note.
 *
 * `note_collection_items` is unique on `(collection_id, note_id, space_id)`, so
 * one note may sit in several folders. The previous payload carried only the
 * note id and the destination, and the UPDATE matched on `note_id` alone —
 * moving one placement silently rewrote every other placement of the same note
 * to the same folder. That is not a sort-order glitch: it destroys a placement.
 *
 * `fromCollectionId` is what identifies the row being moved. Rows that only
 * shift position within their folder repeat their own folder there.
 */
export interface NotesTreeReorderNotePlan {
  kind: "notes";
  updates: Array<{
    noteId: string;
    fromCollectionId: string;
    collectionId: string;
    sortOrder: number;
  }>;
}

export type NotesTreeReorderPlan =
  | NotesTreeReorderNotePlan
  | {
      kind: "collections";
      updates: Array<{ id: string; parentId: string | null; sortOrder: number }>;
    };

export function parseNotesTreeReorder(body: Record<string, unknown>): NotesTreeReorderPlan {
  const kind = optionalString(body.kind);
  if (kind !== "notes" && kind !== "collections") {
    throw new HttpError(422, "kind must be notes or collections");
  }
  const rows = parseReorderRows(body);
  const ids = new Set<string>();
  const positions = new Set<string>();

  if (kind === "notes") {
    const updates = rows.map((row, index) => {
      const noteId = optionalString(row.note_id);
      const fromCollectionId = optionalString(row.from_collection_id);
      const collectionId = optionalString(row.collection_id);
      const sortOrder = row.sort_order;
      if (!noteId) throw new HttpError(422, `updates.${index}.note_id is required`);
      if (!fromCollectionId) throw new HttpError(422, `updates.${index}.from_collection_id is required`);
      if (!collectionId) throw new HttpError(422, `updates.${index}.collection_id is required`);
      validateTreeOrderPosition(
        ids,
        positions,
        `${fromCollectionId}\u0000${noteId}`,
        `collection:${collectionId}`,
        sortOrder,
        index,
      );
      return { noteId, fromCollectionId, collectionId, sortOrder: sortOrder as number };
    });
    return { kind, updates };
  }

  const updates = rows.map((row, index) => {
    const id = optionalString(row.id);
    const sortOrder = row.sort_order;
    if (!id) throw new HttpError(422, `updates.${index}.id is required`);
    if (!Object.hasOwn(row, "parent_id") || (row.parent_id !== null && typeof row.parent_id !== "string")) {
      throw new HttpError(422, `updates.${index}.parent_id must be a string or null`);
    }
    const parentId = optionalString(row.parent_id);
    if (typeof row.parent_id === "string" && !parentId) {
      throw new HttpError(422, `updates.${index}.parent_id must not be empty`);
    }
    validateTreeOrderPosition(ids, positions, id, `parent:${parentId ?? "root"}`, sortOrder, index);
    return { id, parentId, sortOrder: sortOrder as number };
  });
  return { kind, updates };
}

export async function persistNotesTreeReorder(
  db: Queryable,
  identity: SpaceUserIdentity,
  plan: NotesTreeReorderPlan,
): Promise<{ kind: NotesTreeReorderPlan["kind"]; updated: number }> {
  const updated = plan.kind === "notes"
    ? await reorderNoteItems(db, identity, plan.updates)
    : await reorderNoteCollections(db, identity, plan.updates);
  return { kind: plan.kind, updated };
}

function parseReorderRows(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawUpdates = body.updates;
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    throw new HttpError(422, "updates must be a non-empty array");
  }
  if (rawUpdates.length > 500) {
    throw new HttpError(422, "updates must contain at most 500 tree items");
  }
  return rawUpdates.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(422, `updates.${index} must be an object`);
    }
    return raw as Record<string, unknown>;
  });
}

function validateTreeOrderPosition(
  ids: Set<string>,
  positions: Set<string>,
  id: string,
  parentKey: string,
  sortOrder: unknown,
  index: number,
): void {
  if (!Number.isInteger(sortOrder) || (sortOrder as number) < 0) {
    throw new HttpError(422, `updates.${index}.sort_order must be a non-negative integer`);
  }
  if (ids.has(id)) throw new HttpError(422, `updates contains duplicate entry ${id}`);
  const position = `${parentKey}\u0000${sortOrder}`;
  if (positions.has(position)) {
    throw new HttpError(422, `updates contains duplicate sort_order ${sortOrder} under the same parent`);
  }
  ids.add(id);
  positions.add(position);
}

async function reorderNoteItems(
  db: Queryable,
  identity: SpaceUserIdentity,
  updates: NotesTreeReorderNotePlan["updates"],
): Promise<number> {
  const collectionIds = [
    ...new Set(updates.flatMap((update) => [update.fromCollectionId, update.collectionId])),
  ];
  const collections = await db.query<{ id: string }>(
    `SELECT id
       FROM note_collections
      WHERE space_id = $1
        AND id = ANY($2::varchar[])
      FOR SHARE`,
    [identity.spaceId, collectionIds],
  );
  if (collections.rows.length !== collectionIds.length) {
    throw new HttpError(404, "One or more note collections were not found");
  }

  // Every addressed row must exist as a placement *in the folder it is being
  // moved out of*, and the note behind it must be one this user can read.
  //
  // Checking only the note id would accept a request that names a folder the
  // note was never in, and then move whichever placement the UPDATE happened to
  // match. Checking no visibility at all would let any Space member rearrange
  // notes they cannot open — the placement rows carry no access of their own,
  // so the gate has to come from the note's `space_objects` row. A note that is
  // invisible is reported as a missing placement rather than a refusal, because
  // the two are indistinguishable to someone who may not know it exists.
  const placements = await db.query<{ note_id: string; collection_id: string }>(
    `SELECT item.note_id, item.collection_id
       FROM note_collection_items item
       JOIN space_objects so
         ON so.id = item.note_id
        AND so.space_id = item.space_id
        AND so.object_type = 'note'
      WHERE item.space_id = $1
        AND (item.note_id, item.collection_id) IN (
          SELECT * FROM unnest($2::varchar[], $3::varchar[])
        )
        AND ${contentReadSql("space_object", "so", "$4")}
      FOR UPDATE OF item`,
    [
      identity.spaceId,
      updates.map((update) => update.noteId),
      updates.map((update) => update.fromCollectionId),
      identity.userId,
    ],
  );
  if (placements.rows.length !== updates.length) {
    throw new HttpError(404, "One or more note placements were not found");
  }

  // Taking a placement *out of* a Project's subtree changes that Project's
  // notes tree, so it needs the same write access as putting one in. The
  // destination side is checked below, inside the binding.
  for (const update of updates) {
    await assertNoteCollectionProjectWriter(
      db, identity.spaceId, update.fromCollectionId, { userId: identity.userId },
    );
  }

  // A drag into a Project's subtree is a placement, and placement is what binds
  // a note to a Project (U7) — so the same rule the explicit placement actions
  // run has to run here. Before this it did not, and a drag could carry a note's
  // baseline role out of the Project the role is scoped to.
  for (const update of updates) {
    if (update.collectionId === update.fromCollectionId) continue;
    await bindNoteToPlacementProject(db, {
      spaceId: identity.spaceId,
      noteId: update.noteId,
      collectionId: update.collectionId,
      actor: { userId: identity.userId },
    });
  }

  const result = await db.query(
    `UPDATE note_collection_items AS item
        SET collection_id = ordering.to_collection_id,
            sort_order = ordering.sort_order
       FROM unnest($2::varchar[], $3::varchar[], $4::varchar[], $5::integer[])
            AS ordering(note_id, from_collection_id, to_collection_id, sort_order)
      WHERE item.space_id = $1
        AND item.note_id = ordering.note_id
        AND item.collection_id = ordering.from_collection_id`,
    [
      identity.spaceId,
      updates.map((update) => update.noteId),
      updates.map((update) => update.fromCollectionId),
      updates.map((update) => update.collectionId),
      updates.map((update) => update.sortOrder),
    ],
  );
  if ((result.rowCount ?? 0) !== updates.length) {
    throw new HttpError(409, "Note ordering changed concurrently; retry the reorder");
  }
  return updates.length;
}

async function reorderNoteCollections(
  db: Queryable,
  identity: SpaceUserIdentity,
  updates: Array<{ id: string; parentId: string | null; sortOrder: number }>,
): Promise<number> {
  const rows = await db.query<{
    id: string;
    parent_id: string | null;
    project_id: string | null;
    system_role: string;
    is_system: boolean;
  }>(
    `SELECT id, parent_id, project_id, system_role, is_system
       FROM note_collections
      WHERE space_id = $1
      FOR UPDATE`,
    [identity.spaceId],
  );
  const collectionById = new Map(rows.rows.map((row) => [row.id, row]));
  const updateById = new Map(updates.map((update) => [update.id, update]));

  const owningProject = (collectionId: string, proposed: boolean): string | null => {
    const visited = new Set<string>();
    let currentId: string | null = collectionId;
    while (currentId) {
      if (visited.has(currentId)) throw new HttpError(422, "Folder reorder would create a cycle");
      visited.add(currentId);
      const current = collectionById.get(currentId);
      if (!current) throw new HttpError(404, "Note collection not found");
      if (current.project_id) return current.project_id;
      currentId = proposed
        ? (updateById.get(currentId)?.parentId ?? current.parent_id)
        : current.parent_id;
    }
    return null;
  };

  for (const update of updates) {
    const current = collectionById.get(update.id);
    if (!current) throw new HttpError(404, "One or more note collections were not found");
    if (update.parentId && !collectionById.has(update.parentId)) {
      throw new HttpError(404, "One or more parent note collections were not found");
    }
    const movableCollection = current.system_role === "project"
      || (current.system_role === "normal" && !current.is_system);
    if (!movableCollection && update.parentId !== current.parent_id) {
      throw new HttpError(422, "System folders cannot be moved");
    }
  }

  for (const update of updates) {
    const visited = new Set<string>([update.id]);
    let parentId = update.parentId;
    while (parentId) {
      if (visited.has(parentId)) throw new HttpError(422, "Folder reorder would create a cycle");
      visited.add(parentId);
      const parent = collectionById.get(parentId);
      if (!parent) throw new HttpError(404, "Parent note collection not found");
      parentId = updateById.get(parentId)?.parentId ?? parent.parent_id;
    }
  }

  // A folder reparent changes every placement below it at once. Until S6 adds
  // an explicit share operation, that must not be a back door around the
  // per-placement Project binding/cross-Project guard. Keep Project boundaries
  // stable here; users can create/move folders within a Project and can move
  // notes into it through the guarded note path.
  const checkedProjects = new Set<string>();
  for (const update of updates) {
    const current = collectionById.get(update.id)!;
    if (update.parentId === current.parent_id) continue;
    const before = owningProject(update.id, false);
    const after = owningProject(update.id, true);
    if (before !== after) {
      throw new HttpError(422, "Folders cannot be moved into or out of a Project notes workspace");
    }
    if (after && !checkedProjects.has(after)) {
      await assertProjectWriter(db, identity.spaceId, after, identity.userId);
      checkedProjects.add(after);
    }
  }

  const result = await db.query(
    `UPDATE note_collections AS collection
        SET parent_id = ordering.parent_id,
            sort_order = ordering.sort_order
       FROM unnest($2::varchar[], $3::varchar[], $4::integer[])
            AS ordering(id, parent_id, sort_order)
      WHERE collection.space_id = $1
        AND collection.id = ordering.id`,
    [
      identity.spaceId,
      updates.map((update) => update.id),
      updates.map((update) => update.parentId),
      updates.map((update) => update.sortOrder),
    ],
  );
  if ((result.rowCount ?? 0) !== updates.length) {
    throw new HttpError(409, "Folder ordering changed concurrently; retry the reorder");
  }
  return updates.length;
}
