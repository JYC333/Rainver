import {cleanGoalSamples} from '../goals/samples.js';
import { unlink } from "node:fs/promises";
import type { ServerConfig } from "../../../config.js";
import { withDbTransaction, type Pool } from "../../routeUtils/common.js";
import { resolveStoredArtifactPath } from "./artifactStoragePath.js";

/**
 * Prunes retained historical handler-code artifacts (file + artifact row),
 * keeping handler-version rows for audit. New versions are declarative and
 * have no code artifact. Retention still protects the most recently superseded
 * version's historical artifact; retaining it never enables code execution.
 */
export async function pruneSupersededCustomSourceHandlerArtifacts(
  db: Pool,
  config: ServerConfig,
  batchLimit = 100,
): Promise<number> {
  await cleanGoalSamples(db,config);
  if (!config.customSourceArtifactRetentionEnabled) return 0;
  const cutoff = new Date(
    Date.now() - config.customSourceArtifactRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const candidates = await db.query<{ version_id: string; artifact_id: string; storage_path: string }>(
    `SELECT v.id AS version_id, v.handler_artifact_id AS artifact_id, a.storage_path
       FROM source_handler_versions v
       JOIN artifacts a ON a.id = v.handler_artifact_id
      WHERE v.status = 'superseded'
        AND v.superseded_at IS NOT NULL
        AND v.superseded_at < $1
        AND v.handler_artifact_id IS NOT NULL
        AND v.id NOT IN (
          -- version_number is a deterministic tiebreaker: it is unique and
          -- monotonically increasing per connection, unlike superseded_at,
          -- which two versions could share (clock resolution, bulk ops).
          SELECT DISTINCT ON (source_connection_id) id
            FROM source_handler_versions
           WHERE status = 'superseded' AND superseded_at IS NOT NULL
           ORDER BY source_connection_id, superseded_at DESC, version_number DESC
        )
      ORDER BY v.superseded_at ASC
      LIMIT $2`,
    [cutoff, batchLimit],
  );

  let pruned = 0;
  for (const candidate of candidates.rows) {
    // Clear the FK reference before deleting the artifacts row it points
    // at — source_handler_versions_handler_artifact_id_fkey has no ON
    // DELETE clause, so deleting the artifacts row first would violate it
    // as long as any version still references it. Do the DB side before
    // unlinking the file: if the DB transaction fails, the still-referenced
    // artifact keeps its stored file instead of becoming a broken pointer.
    await withDbTransaction(db, async (client) => {
      await client.query(`UPDATE source_handler_versions SET handler_artifact_id = NULL WHERE id = $1`, [
        candidate.version_id,
      ]);
      await client.query(`DELETE FROM artifacts WHERE id = $1`, [candidate.artifact_id]);
    });
    const absolutePath = resolveStoredArtifactPath(config.artifactStorageRoot, candidate.storage_path);
    if (absolutePath) {
      await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    pruned += 1;
  }
  return pruned;
}
