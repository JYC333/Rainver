import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ServerConfig } from "../../../config.js";
import { withDbTransaction, type Pool } from "../../routeUtils/common.js";
import { cleanGoalSamples } from "../goals/samples.js";
import { resolveStoredArtifactPath } from "./artifactStoragePath.js";

interface ArtifactCleanup {
  storagePath: string;
  identity: string;
}

/** Refuse symlinked parents and qualify the intent with the original file generation. */
async function fileIdentity(root: string, path: string): Promise<string | null> {
  try {
    if (await realpath(dirname(path)) !== resolve(await realpath(root), relative(root, dirname(path)))) {
      // The root itself may be a mount alias, but descendants must be direct.
      return null;
    }
    const stat = await lstat(path, { bigint: true });
    return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function finishArtifactCleanup(
  db: Pool, root: string, versionId: string, removeFile: typeof unlink,
): Promise<{ finished: boolean; retiredWithoutUnlink?: boolean; failure?: { cause: unknown } }> {
  return withDbTransaction(db, async (client) => {
    const { rows: [row] } = await client.query<{ handler_artifact_cleanup_json: ArtifactCleanup }>(
      `SELECT handler_artifact_cleanup_json FROM source_handler_versions
        WHERE id = $1 AND handler_artifact_cleanup_json IS NOT NULL
        FOR UPDATE SKIP LOCKED`,
      [versionId],
    );
    if (!row) return { finished: false };

    const { storagePath, identity } = row.handler_artifact_cleanup_json;
    const path = resolveStoredArtifactPath(root, storagePath);
    const { rowCount: referenced } = await client.query(
      "SELECT 1 FROM artifacts WHERE storage_path = $1 LIMIT 1",
      [storagePath],
    );
    let removed = false;
    try {
      if (!referenced && path && await fileIdentity(root, path) === identity) {
        try {
          await removeFile(path);
          removed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (cause) {
      // Record the retry while the intent is locked, without exposing paths.
      await client.query(
        `UPDATE source_handler_versions
            SET handler_artifact_cleanup_json = jsonb_set(
              handler_artifact_cleanup_json, '{lastFailureAt}', to_jsonb(extract(epoch FROM clock_timestamp()))
            ) WHERE id = $1`,
        [versionId],
      );
      return { finished: false, failure: { cause } };
    }
    // A missing, replaced or referenced file no longer matches this intent.
    await client.query("UPDATE source_handler_versions SET handler_artifact_cleanup_json = NULL WHERE id = $1", [versionId]);
    return { finished: true, retiredWithoutUnlink: !removed };
  });
}

/**
 * Prunes historical handler-code artifacts, preserving version audit rows
 * and each connection's most recently superseded version.
 */
export async function pruneSupersededCustomSourceHandlerArtifacts(
  db: Pool,
  config: ServerConfig,
  batchLimit = 100,
  removeFile = unlink,
  reportRetiredWithoutUnlink?: (count: number) => void,
): Promise<number> {
  await cleanGoalSamples(db, config);
  if (!config.customSourceArtifactRetentionEnabled) return 0;
  const root = config.artifactStorageRoot;
  const cutoff = new Date(
    Date.now() - config.customSourceArtifactRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const pending = await db.query<{ id: string }>(
    `SELECT id FROM source_handler_versions WHERE handler_artifact_cleanup_json IS NOT NULL
      ORDER BY (handler_artifact_cleanup_json->>'lastFailureAt')::numeric NULLS FIRST, superseded_at, id
      LIMIT $1`,
    [batchLimit],
  );
  let pruned = 0;
  let retired = 0;
  const failures: unknown[] = [];
  const finish = async (id: string) => {
    try {
      const { finished, retiredWithoutUnlink, failure } = await finishArtifactCleanup(db, root, id, removeFile);
      if (finished) pruned += 1;
      if (retiredWithoutUnlink) retired += 1;
      if (failure) failures.push(failure.cause);
    } catch (error) {
      failures.push(error);
    }
  };
  for (const { id } of pending.rows) await finish(id);

  const staged = await withDbTransaction(db, async (client) => {
    const { rows } = await client.query<{ version_id: string; artifact_id: string; storage_path: string | null }>(
      `SELECT v.id AS version_id, a.id AS artifact_id, a.storage_path
         FROM source_handler_versions v
         JOIN artifacts a ON a.id = v.handler_artifact_id
        WHERE v.status = 'superseded'
          AND v.superseded_at < $1
          AND a.artifact_type = 'source_custom_source_handler_code'
          AND NOT EXISTS (
            SELECT 1 FROM source_handler_versions other
             WHERE other.handler_artifact_id = a.id AND other.id <> v.id
          )
          AND v.id NOT IN (
            SELECT DISTINCT ON (source_connection_id) id
              FROM source_handler_versions
             WHERE status = 'superseded' AND superseded_at IS NOT NULL
             ORDER BY source_connection_id, superseded_at DESC, version_number DESC
          )
        ORDER BY v.superseded_at, v.id
        LIMIT $2 FOR UPDATE OF v, a SKIP LOCKED`,
      [cutoff, batchLimit],
    );
    const intents: string[] = [];
    let skippedFiles = 0;
    for (const { version_id, artifact_id, storage_path } of rows) {
      const path = resolveStoredArtifactPath(root, storage_path);
      const identity = path && await fileIdentity(root, path);
      const intent = identity ? { storagePath: storage_path, identity } : null;
      await client.query(
        `UPDATE source_handler_versions
            SET handler_artifact_id = NULL, handler_artifact_cleanup_json = $2 WHERE id = $1`,
        [version_id, intent],
      );
      await client.query("DELETE FROM artifacts WHERE id = $1", [artifact_id]);
      if (intent) intents.push(version_id);
      else if (storage_path) skippedFiles += 1;
    }
    return { intents, finalized: rows.length - intents.length, skippedFiles };
  });

  // The transaction has committed before any physical removal. A restart
  // after either commit or unlink resumes from the same intent.
  pruned += staged.finalized;
  for (const id of staged.intents) await finish(id);
  retired += staged.skippedFiles;
  if (retired) reportRetiredWithoutUnlink?.(retired);
  if (failures.length) {
    throw new AggregateError(
      failures, `Custom Source Artifact cleanup could not finish (${failures.length} failed, ${pruned} completed)`,
    );
  }
  return pruned;
}
