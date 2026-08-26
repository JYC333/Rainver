import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Queryable } from "../../routeUtils/common.js";
import { PgCustomSourceHandlerRepository } from "../customSources/customSourceHandlerRepository.js";
import { CustomSourceCredentialService } from "../customSources/customSourceCredentialService.js";
import { CustomSourceMaterializationService } from "../customSources/customSourceMaterializer.js";
import { emitSourcePostProcessingEvent } from "../postProcessing/eventEmitter.js";
import { enqueueItemsForAnnotation } from "../../sourceAnnotation/index.js";
import { fetchCustomSourceEndpointHtml } from "../customSources/customSourceEndpointFetch.js";
import { cleanupSandbox } from "../customSources/customSourceRunner.js";
import { computeNextCheckAt } from "../sourceScanCadence.js";
import {
  getSourceChannelScanTask,
  listDueSourceChannelScanTasks,
  upsertSourceChannelScanTask,
} from "../sourceConnectionScheduler.js";
import { runSourceRecipe } from "./recipeInterpreter.js";

/**
 * Live scan path for Level 2 recipe sources. Mirrors the built-in
 * (`scanSchedule.ts`) and Custom Source (`customSourceScanSchedule.ts` /
 * `customSourceScanWorker.ts`) split: an enqueue pass turns due
 * `handler_kind = 'recipe'` connections into `extraction_jobs` rows tagged
 * `metadata_json.implementation = 'recipe'` and the active
 * `recipe_version_id`, and a worker pass claims those jobs, executes that
 * recipe version in scan mode, and materializes validated output through the
 * shared Source materializer (no
 * `source_handler_runs` row — recipes are not handlers; run history surfaces
 * through `extraction_jobs` in the source_runs read model).
 */

export const RECIPE_SCAN_JOB_IMPLEMENTATION = "recipe";

export async function enqueueDueSourceRecipeScans(db: Queryable, batchLimit = 25): Promise<number> {
  const now = new Date().toISOString();
  const tasks = await listDueSourceChannelScanTasks(db, now, batchLimit);
  let enqueued = 0;
  for (const task of tasks) {
    if (!task.space_id) continue;
    const due = await db.query<{ id: string; channel_id: string; space_id: string; active_recipe_version_id: string }>(
      `SELECT sc.id, ch.id AS channel_id, sc.space_id, sc.active_recipe_version_id
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id
        WHERE ch.status = 'active' AND sc.status = 'active'
          AND sc.deleted_at IS NULL
          AND sc.space_id = $1
          AND ch.id = $2
          AND sc.handler_kind = 'recipe'
          AND sc.active_recipe_version_id IS NOT NULL
          AND sc.repair_status <> 'disabled'
          AND ch.fetch_frequency <> 'manual'
          AND NOT EXISTS (
            SELECT 1
              FROM extraction_jobs ej
             WHERE ej.space_id = ch.space_id
               AND ej.metadata_json->>'source_channel_id' = ch.id
               AND ej.job_type = 'connection_scan'
               AND ej.status IN ('pending', 'running')
          )
        LIMIT 1`,
      [task.space_id, task.task_key],
    );
    const row = due.rows[0];
    if (!row) continue;
    await db.query(
      `INSERT INTO extraction_jobs (
         id, space_id, connection_id, job_type, status, metadata_json, created_at
       ) VALUES ($1, $2, $3, 'connection_scan', 'pending', $4::jsonb, $5)`,
      [
        randomUUID(),
        row.space_id,
        row.id,
        JSON.stringify({
          created_by: "source_recipe_scheduler",
          source_channel_id: row.channel_id,
          implementation: RECIPE_SCAN_JOB_IMPLEMENTATION,
          recipe_version_id: row.active_recipe_version_id,
        }),
        now,
      ],
    );
    enqueued += 1;
  }
  return enqueued;
}

interface PendingRecipeJobRow {
  id: string;
  space_id: string;
  connection_id: string;
  metadata_json: unknown;
  source_channel_id: string;
}

export async function runPendingSourceRecipeScans(
  db: Queryable,
  config: ServerConfig,
  batchLimit = 10,
): Promise<number> {
  const pending = await db.query<PendingRecipeJobRow>(
    `SELECT id, space_id, connection_id, metadata_json, metadata_json->>'source_channel_id' AS source_channel_id
       FROM extraction_jobs
      WHERE status = 'pending'
        AND job_type = 'connection_scan'
        AND COALESCE(metadata_json->>'implementation', '') = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [RECIPE_SCAN_JOB_IMPLEMENTATION, batchLimit],
  );

  let processed = 0;
  for (const job of pending.rows) {
    try {
      if (await runOne(db, config, job)) processed += 1;
    } catch (error) {
      await failJob(db, job, error instanceof Error ? error.message : String(error));
      processed += 1;
    }
  }
  return processed;
}

export async function runSourceRecipeScanJob(
  db: Queryable,
  config: ServerConfig,
  jobId: string,
  spaceId: string,
): Promise<boolean> {
  const result = await db.query<PendingRecipeJobRow>(
    `SELECT id, space_id, connection_id, metadata_json, metadata_json->>'source_channel_id' AS source_channel_id
       FROM extraction_jobs
      WHERE id = $1
        AND space_id = $2
        AND status = 'pending'
        AND job_type = 'connection_scan'
        AND COALESCE(metadata_json->>'implementation', '') = $3
      LIMIT 1`,
    [jobId, spaceId, RECIPE_SCAN_JOB_IMPLEMENTATION],
  );
  const job = result.rows[0];
  if (!job) return false;
  return runOne(db, config, job);
}

async function runOne(db: Queryable, config: ServerConfig, job: PendingRecipeJobRow): Promise<boolean> {
  const now = new Date().toISOString();
  const claimed = await db.query(
    `UPDATE extraction_jobs SET status = 'running', started_at = $2 WHERE id = $1 AND status = 'pending'`,
    [job.id, now],
  );
  if ((claimed.rowCount ?? 0) === 0) return false;

  const connectionResult = await db.query<{
    id: string;
    space_id: string;
    owner_user_id: string;
    name: string;
    endpoint_url: string | null;
    fetch_frequency: string;
    schedule_rule_json: unknown;
    status: string;
    active_recipe_version_id: string | null;
    channel_id: string;
  }>(
    `SELECT sc.id, sc.space_id, sc.owner_user_id, sc.name,
            ch.id AS channel_id, ch.endpoint_url, ch.fetch_frequency, ch.schedule_rule_json,
            ch.status, sc.active_recipe_version_id
       FROM source_connections sc
       JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.id = $3
      WHERE sc.id = $1 AND sc.space_id = $2`,
    [job.connection_id, job.space_id, job.source_channel_id],
  );
  const connection = connectionResult.rows[0];
  if (!connection) throw new Error(`Source connection ${job.connection_id} not found`);
  const scheduleTask = await getSourceChannelScanTask(db, connection.channel_id);

  try {
    const recipeVersionId = metadataString(job.metadata_json, "recipe_version_id") ?? connection.active_recipe_version_id;
    if (!recipeVersionId) throw new Error("connection has no active recipe version");
    const versionResult = await db.query<{ id: string; recipe_json: unknown; policy_envelope_json: unknown }>(
      `SELECT id, recipe_json, policy_envelope_json FROM source_recipe_versions WHERE id = $1 AND space_id = $2`,
      [recipeVersionId, job.space_id],
    );
    const versionRow = versionResult.rows[0];
    if (!versionRow) throw new Error(`Recipe version ${recipeVersionId} not found`);

    const recipe = protocol.SourceRecipeDefinitionSchema.parse(versionRow.recipe_json);
    const envelope = protocol.SourcePolicyEnvelopeSchema.parse(versionRow.policy_envelope_json);
    const settings = await new PgCustomSourceHandlerRepository(db, config).getRunnerSettingsForSpace(job.space_id);
    const credential = await new CustomSourceCredentialService(db, config).resolveCredentialHeader(
      job.space_id,
      envelope.credential_ref,
    );

    const primaryEndpointContent = await fetchCustomSourceEndpointHtml(
      connection.endpoint_url,
      settings,
      envelope,
      credential,
    );

    const runResult = await runSourceRecipe(settings, {
      policyEnvelope: envelope,
      recipe,
      mode: "scan",
      endpointUrl: connection.endpoint_url,
      sourceName: connection.name,
      primaryEndpointContent,
      credential,
    });

    try {
      if (runResult.status === "failed" || runResult.raw_output_json === null) {
        await failJob(
          db,
          job,
          runResult.timed_out
            ? "timeout"
            : runResult.output_too_large
              ? "output_too_large"
              : (runResult.error ?? "recipe_failed"),
        );
        return true;
      }

      const materializer = new CustomSourceMaterializationService(db, config, settings);
      const result = await materializer.materialize({
        run: {
          runId: job.id,
          spaceId: job.space_id,
          sourceConnectionId: job.connection_id,
          handlerVersionId: versionRow.id,
        },
        policyEnvelope: envelope,
        sandboxFilesRoot: runResult.sandbox_files_root,
        rawOutputJson: JSON.parse(runResult.raw_output_json),
        recordHandlerRun: false,
        sourceKind: "source_recipe",
      });

      await db.query(
        `UPDATE extraction_jobs
            SET status = $2,
                completed_at = $3,
                items_seen = $4,
                items_created = $5,
                items_updated = $6,
                error_message = $7
          WHERE id = $1`,
        [
          job.id,
          result.status === "succeeded" ? "succeeded" : "failed",
          new Date().toISOString(),
          result.itemsCreated + result.itemsUpdated,
          result.itemsCreated,
          result.itemsUpdated,
          result.errors.length > 0 ? result.errors.join("; ").slice(0, 512) : null,
        ],
      );
      if (result.status === "succeeded" && result.itemsCreated > 0) {
        await emitSourcePostProcessingEvent(db, {
          spaceId: job.space_id,
          sourceChannelId: job.source_channel_id,
          sourceConnectionId: job.connection_id,
          newItemCount: result.itemsCreated,
        });
        await enqueueItemsForAnnotation(db, {
          spaceId: job.space_id,
          sourceChannelId: job.source_channel_id,
          sourceConnectionId: job.connection_id,
          newItemCount: result.itemsCreated,
        });
      }
    } finally {
      await cleanupSandbox(runResult.sandbox_files_root).catch(() => undefined);
    }
  } catch (error) {
    await failJob(db, job, error instanceof Error ? error.message : String(error));
  } finally {
    // Always advance the schedule, even on failed runs — otherwise a
    // permanently broken source would be re-enqueued on every tick.
    const completedAt = new Date().toISOString();
    await upsertSourceChannelScanTask(db, {
      channel: {
        id: connection.channel_id,
        space_id: connection.space_id,
        owner_user_id: connection.owner_user_id,
        status: connection.status,
        fetch_frequency: connection.fetch_frequency,
      },
      nextRunAt: computeNextCheckAt(connection.fetch_frequency, completedAt, {
        existingNextCheckAt: scheduleTask?.next_run_at,
        scheduleRule: connection.schedule_rule_json,
      }),
      lastRunAt: completedAt,
      updatedAt: completedAt,
    });
  }
  return true;
}

async function failJob(db: Queryable, job: PendingRecipeJobRow, message: string): Promise<void> {
  await db.query(
    `UPDATE extraction_jobs
        SET status = 'failed', completed_at = $2, error_code = $3, error_message = $4
      WHERE id = $1 AND status IN ('pending', 'running')`,
    [job.id, new Date().toISOString(), message.slice(0, 64), message.slice(0, 512)],
  );
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}
