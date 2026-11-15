import { HttpError, type Queryable } from "../routeUtils/common.js";

/** Global persona has no Project provenance field: isolated work cannot write it,
 * even with owner approval. Read canonical Run scope, never model payload scope.
 * Call inside the writer transaction; the Agent lock fences retention changes. */
export async function assertPersonaRunNotIsolated(
  db: Queryable, spaceId: string, agentId: string, runIds: readonly string[],
): Promise<void> {
  const agent = await db.query<{ access_project_id: string | null }>(
    `SELECT access_project_id FROM agents WHERE space_id=$1 AND id=$2 FOR SHARE`, [spaceId, agentId],
  );
  const retained = agent.rows[0]?.access_project_id;
  if (!retained || !runIds.length) return;
  const runs = await db.query<{ project_id: string | null; session_project_id: string | null; room_project_id: string | null }>(
    `SELECT run.project_id, session.project_id AS session_project_id, room.project_id AS room_project_id
       FROM runs run LEFT JOIN sessions session ON session.space_id=run.space_id AND session.id=run.session_id
       LEFT JOIN rooms room ON room.space_id=session.space_id AND room.id=session.room_id
      WHERE run.space_id=$1 AND run.id=ANY($2::varchar[])`, [spaceId, [...runIds]],
  );
  if (runs.rows.length !== new Set(runIds).size || runs.rows.some(run =>
    [run.project_id, run.session_project_id, run.room_project_id].some(project => project !== null && project !== retained))) {
    throw new HttpError(422, "Isolated Project work cannot create or revise this Agent's global persona, including through a proposal");
  }
}

/** A revision must not launder a quarantined version by dropping its sources.
 * Check without loading its body, at both tool admission and canonical apply. */
export async function assertPersonaMemoryNotIsolated(
  db: Queryable, spaceId: string, agentId: string, memoryId: string,
): Promise<void> {
  const sources = await db.query<{ source_id: string }>(
    `SELECT source_id FROM provenance_links WHERE space_id=$1 AND target_type='memory'
      AND target_id=$2 AND source_type='run'`, [spaceId, memoryId],
  );
  await assertPersonaRunNotIsolated(db, spaceId, agentId, sources.rows.map(row => row.source_id));
}
