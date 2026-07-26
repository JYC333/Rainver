import {
  HttpError,
  type Queryable,
} from "../routeUtils/common";
import { isSpaceOwnerOrAdmin } from "../access/roles";

export async function assertProjectInSpace(
  db: Queryable,
  spaceId: string,
  projectId: string | null | undefined,
  options: { statusCode?: number; message?: string } = {},
): Promise<void> {
  if (!projectId) return;
  const result = await db.query<{ id: string }>(
    `SELECT id
       FROM projects
      WHERE id = $1
        AND space_id = $2
        AND deleted_at IS NULL`,
    [projectId, spaceId],
  );
  if ((result.rowCount ?? result.rows.length) === 0) {
    throw new HttpError(options.statusCode ?? 422, options.message ?? "Project not found");
  }
}

/**
 * Concrete project read gate used by project-scoped private data.
 *
 * Public project metadata and approved public summaries have their own broader
 * space-scoped read surfaces. This gate is for content that should follow the
 * project_members ACL: personal-space projects are readable by the sole member;
 * shared-space projects are readable by the project owner or an active project
 * member, including viewer.
 */
export async function canReadProject(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const project = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id
       FROM projects
      WHERE id = $1
        AND space_id = $2
        AND deleted_at IS NULL`,
    [projectId, spaceId],
  );
  const row = project.rows[0];
  if (!row) return false;

  const space = await db.query<{ type: string }>(
    `SELECT type FROM spaces WHERE id = $1`,
    [spaceId],
  );
  if (space.rows[0]?.type === "personal") return true;

  if (row.owner_user_id && row.owner_user_id === userId) return true;

  const member = await db.query<{ one: number }>(
    `SELECT 1 AS one
       FROM project_members
      WHERE space_id = $1
        AND project_id = $2
        AND user_id = $3
        AND status = 'active'
      LIMIT 1`,
    [spaceId, projectId, userId],
  );
  return member.rows.length > 0;
}

export async function assertProjectReadable(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  if (!(await canReadProject(db, spaceId, projectId, userId))) {
    throw new HttpError(404, "Project not found");
  }
}

/**
 * Batched form of {@link canReadProject} for filtering rows that carry
 * `project_id`. Returns the accessible subset in a fixed number of queries.
 */
export async function accessibleProjectIds(
  db: Queryable,
  spaceId: string,
  userId: string,
  projectIds: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const ids = [...new Set(projectIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Set();

  const liveProjects = await db.query<{ id: string; owner_user_id: string | null }>(
    `SELECT id, owner_user_id
       FROM projects
      WHERE space_id = $1
        AND id = ANY($2::varchar[])
        AND deleted_at IS NULL`,
    [spaceId, ids],
  );
  const liveIds = liveProjects.rows.map((row) => row.id);
  if (liveIds.length === 0) return new Set();

  const space = await db.query<{ type: string }>(`SELECT type FROM spaces WHERE id = $1`, [spaceId]);
  if (space.rows[0]?.type === "personal") return new Set(liveIds);

  const member = await db.query<{ project_id: string }>(
    `SELECT pm.project_id
       FROM project_members pm
       JOIN projects p
         ON p.id = pm.project_id
        AND p.space_id = pm.space_id
        AND p.deleted_at IS NULL
      WHERE pm.space_id = $1
        AND pm.project_id = ANY($2::varchar[])
        AND pm.user_id = $3
        AND pm.status = 'active'`,
    [spaceId, liveIds, userId],
  );
  const accessible = new Set<string>();
  for (const row of liveProjects.rows) {
    if (row.owner_user_id === userId) accessible.add(row.id);
  }
  for (const row of member.rows) accessible.add(row.project_id);
  return accessible;
}

export async function canWriteProject(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const project = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id
       FROM projects
      WHERE id = $1
        AND space_id = $2
        AND deleted_at IS NULL`,
    [projectId, spaceId],
  );
  const row = project.rows[0];
  if (!row) return false;
  if (row.owner_user_id && row.owner_user_id === userId) return true;

  const spaceRole = await db.query<{ role: string }>(
    `SELECT role
       FROM space_memberships
      WHERE space_id = $1
        AND user_id = $2
        AND status = 'active'
      LIMIT 1`,
    [spaceId, userId],
  );
  const role = spaceRole.rows[0]?.role;
  if (isSpaceOwnerOrAdmin(role)) return true;

  const projectRole = await db.query<{ role: string }>(
    `SELECT role
       FROM project_members
      WHERE space_id = $1
        AND project_id = $2
        AND user_id = $3
        AND status = 'active'
      LIMIT 1`,
    [spaceId, projectId, userId],
  );
  const memberRole = projectRole.rows[0]?.role;
  return memberRole === "owner" || memberRole === "member";
}

export async function assertProjectWriter(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
  options: { allowArchived?: boolean } = {},
): Promise<void> {
  const exists = await db.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM projects
      WHERE id = $1
        AND space_id = $2
        AND deleted_at IS NULL`,
    [projectId, spaceId],
  );
  if ((exists.rowCount ?? exists.rows.length) === 0) {
    throw new HttpError(404, "Project not found");
  }
  if (!(await canWriteProject(db, spaceId, projectId, userId))) {
    throw new HttpError(403, "Requires project writer, project owner, or space owner/admin role");
  }
  if (!options.allowArchived && exists.rows[0]?.status !== "active") {
    throw new HttpError(409, "Project is archived; reactivate it before making changes");
  }
}

/**
 * Aggregate write fence. Call inside the transaction that creates Project-owned
 * work, after authorization, so archive and producers serialize on one row.
 */
export async function lockActiveProjectForMutation(
  db: Queryable,
  spaceId: string,
  projectId: string,
): Promise<void> {
  const project = await db.query<{ status: string }>(
    `SELECT status FROM projects
      WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL
      FOR UPDATE`,
    [projectId, spaceId],
  );
  if (!project.rows[0]) throw new HttpError(404, "Project not found");
  if (project.rows[0].status !== "active") {
    throw new HttpError(409, "Project is archived; reactivate it before making changes");
  }
}

/**
 * A Project Folder belongs to exactly one Project via a direct, non-null FK
 * (set at Folder creation) — there is no separate link step to verify.
 */
export async function assertProjectFolderInProject(
  db: Queryable,
  spaceId: string,
  projectId: string,
  projectFolderId: string,
): Promise<void> {
  const folder = await db.query<{ id: string }>(
    `SELECT id
       FROM project_folders
      WHERE id = $1
        AND space_id = $2
        AND project_id = $3
        AND status = 'active'`,
    [projectFolderId, spaceId, projectId],
  );
  if ((folder.rowCount ?? folder.rows.length) === 0) {
    throw new HttpError(404, "Project Folder not found");
  }
}

/**
 * Owner-level authority: the project `owner_user_id` or a space `owner`/`admin`.
 * Unlike `canWriteProject`, an active project member role of `owner`/`member`
 * does NOT qualify — this is the gate for publishing a public summary
 * (`review_status` other than `draft`), so a project writer can only stage a
 * draft and the project owner / space admin performs the review/publish step.
 */
export async function isProjectOwnerLevel(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const project = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id
       FROM projects
      WHERE id = $1
        AND space_id = $2
        AND deleted_at IS NULL`,
    [projectId, spaceId],
  );
  const row = project.rows[0];
  if (!row) return false;
  if (row.owner_user_id && row.owner_user_id === userId) return true;

  const spaceRole = await db.query<{ role: string }>(
    `SELECT role
       FROM space_memberships
      WHERE space_id = $1
        AND user_id = $2
        AND status = 'active'
      LIMIT 1`,
    [spaceId, userId],
  );
  const role = spaceRole.rows[0]?.role;
  return isSpaceOwnerOrAdmin(role);
}

export async function assertProjectOwnerLevel(
  db: Queryable,
  spaceId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  if (!(await isProjectOwnerLevel(db, spaceId, projectId, userId))) {
    throw new HttpError(403, "Requires project owner or space owner/admin role to publish a public summary");
  }
}
