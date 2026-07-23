import {
  HttpError,
  optionalString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";

export type NotesTreeReorderPlan =
  | {
      kind: "notes";
      updates: Array<{ id: string; collectionId: string; sortOrder: number }>;
    }
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
      const id = optionalString(row.id);
      const collectionId = optionalString(row.collection_id);
      const sortOrder = row.sort_order;
      if (!id) throw new HttpError(422, `updates.${index}.id is required`);
      if (!collectionId) throw new HttpError(422, `updates.${index}.collection_id is required`);
      validateTreeOrderPosition(ids, positions, id, `collection:${collectionId}`, sortOrder, index);
      return { id, collectionId, sortOrder: sortOrder as number };
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
  if (ids.has(id)) throw new HttpError(422, `updates contains duplicate id ${id}`);
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
  updates: Array<{ id: string; collectionId: string; sortOrder: number }>,
): Promise<number> {
  const noteIds = updates.map((update) => update.id);
  const collectionIds = [...new Set(updates.map((update) => update.collectionId))];
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

  const memberships = await db.query<{ note_id: string }>(
    `SELECT note_id
       FROM note_collection_items
      WHERE space_id = $1
        AND note_id = ANY($2::varchar[])
      FOR UPDATE`,
    [identity.spaceId, noteIds],
  );
  const membershipIds = new Set(memberships.rows.map((row) => row.note_id));
  if (membershipIds.size !== noteIds.length || memberships.rows.length !== noteIds.length) {
    throw new HttpError(404, "One or more notes were not found in a collection");
  }

  const result = await db.query(
    `UPDATE note_collection_items AS item
        SET collection_id = ordering.collection_id,
            sort_order = ordering.sort_order
       FROM unnest($2::varchar[], $3::varchar[], $4::integer[])
            AS ordering(note_id, collection_id, sort_order)
      WHERE item.space_id = $1
        AND item.note_id = ordering.note_id`,
    [
      identity.spaceId,
      noteIds,
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
    system_role: string;
    is_system: boolean;
  }>(
    `SELECT id, parent_id, system_role, is_system
       FROM note_collections
      WHERE space_id = $1
      FOR UPDATE`,
    [identity.spaceId],
  );
  const collectionById = new Map(rows.rows.map((row) => [row.id, row]));
  const updateById = new Map(updates.map((update) => [update.id, update]));

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
