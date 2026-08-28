import type { Queryable } from "../routeUtils/common.js";

/** An Operation in one of these has stopped; everything else is still work. */
const FINISHED_STATUSES = ["completed", "failed", "cancelled"];

export interface RunningProjectOperation {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  status: string;
  progress_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * The Project's unfinished Operations, for the front page.
 *
 * Only the fields the shared `researchOperationDetail`/`researchOperationPercent`
 * renderers read — the front page shows the same sentence the Research Area
 * does rather than a second, quieter version of it, and does so from its own
 * read model rather than by calling an Area's endpoint.
 */
export async function listRunningProjectOperations(
  db: Queryable,
  spaceId: string,
  projectId: string,
): Promise<RunningProjectOperation[]> {
  const rows = await db.query<{
    id: string; project_id: string; kind: string; title: string; status: string;
    progress_json: Record<string, unknown> | null; created_at: Date | string; updated_at: Date | string;
  }>(
    `SELECT id, project_id, kind, title, status, progress_json, created_at, updated_at
       FROM project_operations
      WHERE space_id = $1 AND project_id = $2 AND NOT (status = ANY ($3::varchar[]))
      ORDER BY updated_at DESC
      LIMIT 6`,
    [spaceId, projectId, FINISHED_STATUSES],
  );
  return rows.rows.map((row) => ({
    id: String(row.id),
    project_id: String(row.project_id),
    kind: row.kind,
    title: row.title,
    status: row.status,
    progress_json: row.progress_json ?? {},
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}
