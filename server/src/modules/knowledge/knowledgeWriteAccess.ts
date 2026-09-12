import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { contentAccessLevelSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { canWriteProject } from "../projects/access.js";

/**
 * The one write check for a Knowledge space object — a note, a source, and
 * anything else that hangs off `space_objects`.
 *
 * Readable is not writable. A `selected_users` grant and the oversight branch
 * both hand out *reading*, so a repository that gated a mutation on the read
 * predicate alone let a grantee rewrite the owner's note and let an admin
 * rewrite a member's. Two terms decide it:
 *
 * - anything but `space_shared` belongs to its owner, who is the only person
 *   who may change it. `space_shared` stays collaboratively writable, which is
 *   the point of sharing it — and is why this keys on visibility rather than on
 *   `owner_user_id`, which a shared object may also carry;
 * - a Project-bound object additionally needs writer authority in that Project,
 *   because a Project share widens read scope only;
 * - a reader who is served this object at `summary` may not write it. Phase 2
 *   withholds the body from them; letting them replace it would be the same
 *   content boundary crossed from the other side. Oversight is excluded from
 *   that level: supervising a member's note is reading, and an admin computing
 *   `full` through oversight must not thereby become its writer.
 *
 * Deleted rows are deliberately *not* excluded: the read gate does not exclude
 * them either, and a write check that disagreed would make `deleteNote`
 * non-idempotent and refuse a rollback of a deleted note.
 *
 * The rule is one; how it is *spelled* depends on what the caller has already
 * told this person. A surface that refused before saying the object exists
 * answers 404, so a denial cannot be read as "it is there, you may not have
 * it". A surface that already returned the object to them — every placement
 * and relocation path reads it first — keeps the 403 it has always answered,
 * because hiding what they are looking at tells them nothing and loses the
 * reason.
 */
export async function assertWritableSpaceObject(
  db: Queryable,
  identity: SpaceUserIdentity,
  objectId: string,
  notFoundMessage: string,
  /** 403 only where the caller has already been shown the object. */
  refusalStatus: 403 | 404 = 404,
): Promise<void> {
  const definition = contentResourceDefinition("space_object");
  if (!definition) throw new Error("space_object content resource is not registered");
  const result = await db.query<{
    visibility: string;
    owner_user_id: string | null;
    primary_project_id: string | null;
    effective_access_level: string;
  }>(
    `SELECT so.visibility, so.owner_user_id, so.primary_project_id,
            ${contentAccessLevelSql({ definition, alias: "so", userExpr: "$3", includeOversight: false })} AS effective_access_level
       FROM space_objects so
      WHERE so.id = $1 AND so.space_id = $2
      LIMIT 1`,
    [objectId, identity.spaceId, identity.userId],
  );
  const object = result.rows[0];
  if (!object) throw new HttpError(404, notFoundMessage);
  const refuse = () => { throw new HttpError(refusalStatus, notFoundMessage); };
  if (object.visibility !== "space_shared" && object.owner_user_id !== identity.userId) refuse();
  if (object.effective_access_level !== "full" && object.owner_user_id !== identity.userId) refuse();
  if (object.primary_project_id && !(await canWriteProject(
    db,
    identity.spaceId,
    object.primary_project_id,
    identity.userId,
  ))) refuse();
}
