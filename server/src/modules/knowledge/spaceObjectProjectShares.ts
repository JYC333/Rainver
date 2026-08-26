import { randomUUID } from "node:crypto";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";

/**
 * Additional Project scopes for a `space_objects` row — the write side of the
 * `space_object_project_shares` declaration the content-access registry reads
 * (U8/U9).
 *
 * A share is deliberate and narrow. It widens the **scope** half of the read
 * gate for one object and one Project: members of that Project stop being
 * blocked by `primary_project_id`. It is not a grant — `visibility`,
 * `access_level` and `content_access_grants` are separate conjuncts, so a
 * `private` object stays private to its owner however many Projects it reaches.
 * That is why there is no access level on a share (the open question's answer:
 * read-only by construction).
 *
 * Both sides are writes. Opening an object to a Project changes what that
 * Project's members can see, and it changes what the owning Project has
 * exposed — so the actor must be able to write to both.
 */

export interface SpaceObjectProjectShareRow {
  project_id: string;
  shared_by_user_id: string;
  created_at: string;
  revoked_at: string | null;
}

/** The Projects an object is currently shared into, newest first. */
export async function listSpaceObjectProjectShares(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<SpaceObjectProjectShareRow[]> {
  const result = await db.query<SpaceObjectProjectShareRow>(
    `SELECT project_id, shared_by_user_id, created_at, revoked_at
       FROM space_object_project_shares
      WHERE space_id = $1 AND object_id = $2 AND revoked_at IS NULL
      ORDER BY created_at DESC, project_id ASC`,
    [spaceId, objectId],
  );
  return result.rows;
}

/**
 * Opens an object to a further Project.
 *
 * Re-shares reuse the row rather than adding a second one — the unique
 * constraint is on `(space_id, object_id, project_id)`, and keeping one row
 * means the history of who opened this object to that Project survives a
 * revoke/re-share cycle.
 */
export async function shareSpaceObjectWithProject(
  db: Queryable,
  input: {
    spaceId: string;
    objectId: string;
    projectId: string;
    ownerProjectId: string | null;
    userId: string;
  },
): Promise<void> {
  if (input.projectId === input.ownerProjectId) {
    throw new HttpError(422, "This is already the object's own project");
  }
  // Both directions are writes: to the Project gaining access, and to the one
  // giving it up. A member of B alone must not be able to pull A's note into B.
  if (input.ownerProjectId) {
    await assertProjectWriter(db, input.spaceId, input.ownerProjectId, input.userId);
  }
  await assertProjectWriter(db, input.spaceId, input.projectId, input.userId);
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO space_object_project_shares (
       id, space_id, object_id, project_id, shared_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (space_id, object_id, project_id) DO UPDATE SET
       shared_by_user_id = EXCLUDED.shared_by_user_id,
       updated_at = EXCLUDED.updated_at,
       revoked_at = NULL,
       revoked_by_user_id = NULL`,
    [randomUUID(), input.spaceId, input.objectId, input.projectId, input.userId, now],
  );
}

/**
 * Withdraws a share, and with it every placement the object holds inside that
 * Project's folder subtree.
 *
 * Dropping the placements is the point rather than a side effect: a placement
 * inside a Project's tree is what puts the object in that Project's view, so
 * leaving them behind after a revoke would show that Project's members a tree
 * with a hole in it — the silent absence U8 exists to prevent, just arrived at
 * from the other direction.
 */
export async function revokeSpaceObjectProjectShare(
  db: Queryable,
  input: {
    spaceId: string;
    objectId: string;
    projectId: string;
    ownerProjectId: string | null;
    userId: string;
  },
): Promise<void> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM space_object_project_shares
      WHERE space_id = $1 AND object_id = $2 AND project_id = $3 AND revoked_at IS NULL
      FOR UPDATE`,
    [input.spaceId, input.objectId, input.projectId],
  );
  if (!existing.rows[0]) throw new HttpError(404, "This object is not shared with that project");
  if (input.ownerProjectId) {
    await assertProjectWriter(db, input.spaceId, input.ownerProjectId, input.userId);
  } else {
    await assertProjectWriter(db, input.spaceId, input.projectId, input.userId);
  }
  const now = new Date().toISOString();
  await db.query(
    `UPDATE space_object_project_shares
        SET revoked_at = $4, revoked_by_user_id = $5, updated_at = $4
      WHERE space_id = $1 AND object_id = $2 AND project_id = $3`,
    [input.spaceId, input.objectId, input.projectId, now, input.userId],
  );
  await db.query(
    `DELETE FROM note_collection_items item
      WHERE item.space_id = $1
        AND item.note_id = $2
        AND item.collection_id IN (
          WITH RECURSIVE subtree AS (
            SELECT id FROM note_collections
             WHERE space_id = $1 AND project_id = $3
            UNION ALL
            SELECT child.id
              FROM note_collections child
              JOIN subtree ON child.parent_id = subtree.id
             WHERE child.space_id = $1
          )
          SELECT id FROM subtree
        )`,
    [input.spaceId, input.objectId, input.projectId],
  );
}
