import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerConfig } from "../../../config.js";
import { withDbTransaction, type Pool } from "../../routeUtils/common.js";

/**
 * Phase 12 hardening: bounds unbounded growth of stored `typescript_node`
 * handler source artifacts (`artifact_type = 'source_custom_source_handler_code'`)
 * across repeated repair cycles. `declarative_pipeline_v1` versions never
 * have a `handler_artifact_id` (their pipeline definition lives in
 * `manifest_json`), so this only ever touches `typescript_node` rows.
 *
 * Deliberately excludes each connection's single most-recently-superseded
 * version — `rollbackHandler`'s default target (`customSourceRepairService.ts`)
 * — so a no-argument rollback is never broken by this job. An explicit
 * `target_version_id` pointing at an older, pruned version will still fail,
 * but with the same pre-existing, clear "Handler source artifact is missing
 * its stored file" error `executeCustomSourceHandler` already raises for a
 * version whose artifact went missing for any other reason — not a new
 * failure mode, just a new way to reach an existing one.
 *
 * Only prunes the artifact (file + row) and clears
 * `handler_artifact_id` — the `source_handler_versions` row itself is kept
 * for audit/history.
 */
export async function pruneSupersededCustomSourceHandlerArtifacts(
  db: Pool,
  config: ServerConfig,
  batchLimit = 100,
): Promise<number> {
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
    const absolutePath = resolve(config.artifactStorageRoot, candidate.storage_path);
    await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    pruned += 1;
  }
  return pruned;
}
