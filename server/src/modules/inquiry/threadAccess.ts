import { contentReadSql } from "../access/contentAccessSql.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";

/**
 * Why a Thread is being reached. `read` counts Space oversight, which is
 * audit (`architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`). `change` is the
 * person's own reach, since oversight never changes a record. `publish` feeds
 * something the whole Project sees, such as a Delta Brief, so it is the
 * person's own reach over Threads shared with the Space.
 */
export type ThreadAccessPurpose = "read" | "change" | "publish";

/**
 * Who can reach a Thread: its ontology root's content predicate. Project
 * membership is necessary but not sufficient — a private Thread is its
 * owner's — so no Thread path may rest on the Project gate alone.
 */
export function threadReadableSql(rootAlias: string, userExpr: string, purpose: ThreadAccessPurpose): string {
  const reach = contentReadSql("space_object", rootAlias, userExpr, { includeOversight: purpose === "read" });
  return purpose === "publish" ? `(${reach} AND ${rootAlias}.visibility = 'space_shared')` : reach;
}

/**
 * The gate on every Thread path: the Thread is in this Project and reachable
 * by this person for this purpose. Refuses as "not found", so a Thread's
 * existence is not confirmed to someone who cannot read it.
 */
export async function assertThreadReadable(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  threadId: string,
  purpose: ThreadAccessPurpose,
): Promise<void> {
  const row = await db.query<{ id: string }>(
    `SELECT t.object_id AS id
       FROM inquiry_threads t
       JOIN space_objects so ON so.id = t.object_id AND so.space_id = t.space_id
      WHERE t.object_id = $1 AND t.space_id = $2 AND t.project_id = $3
        AND ${threadReadableSql("so", "$4", purpose)}`,
    [threadId, identity.spaceId, projectId, identity.userId],
  );
  if (!row.rows[0]) throw new HttpError(404, "Thread not found");
}

/** The subset of these Threads this person can reach for this purpose. */
export async function readableThreadIds(
  db: Queryable,
  identity: SpaceUserIdentity,
  threadIds: readonly string[],
  purpose: ThreadAccessPurpose,
): Promise<Set<string>> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.query<{ id: string }>(
    `SELECT so.id
       FROM space_objects so
      WHERE so.space_id = $1 AND so.id = ANY($2::varchar[]) AND so.object_type = 'inquiry_thread'
        AND ${threadReadableSql("so", "$3", purpose)}`,
    [identity.spaceId, ids, identity.userId],
  );
  return new Set(rows.rows.map((row) => row.id));
}
