import type {
  CustomSourceHandlerInput,
  CustomSourcePolicyEnvelope,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../../config";
import type { Queryable } from "../../routeUtils/common";
import {
  HANDLER_VERSION_COLUMNS,
  PgCustomSourceHandlerRepository,
  type HandlerVersionRow,
} from "./customSourceHandlerRepository";
import { cleanupSandbox, evaluateCustomSourceRunnerBlockReason } from "./customSourceRunner";
import { executeCustomSourceHandler } from "./customSourceHandlerExecution";
import { CustomSourceMaterializationService } from "./customSourceMaterializer";
import { emitSourcePostProcessingEvent } from "../postProcessing/eventEmitter";
import { fetchCustomSourceEndpointHtml } from "./customSourceEndpointFetch";
import { CustomSourceCredentialService } from "./customSourceCredentialService";
import { computeNextCheckAt } from "../sourceScanCadence";
import {
  getSourceChannelScanTask,
  upsertSourceChannelScanTask,
} from "../sourceConnectionScheduler";

interface QueuedRunRow {
  id: string;
  space_id: string;
  source_connection_id: string;
  source_channel_id: string;
  handler_version_id: string;
  extraction_job_id: string | null;
}

/**
 * Mirrors `processPendingSourceJobs` (scheduler/backgroundServices.ts) for
 * `source_handler_runs` rows queued by `enqueueDueCustomSourceHandlerRuns`.
 * The handler process itself never calls `fetch` (the sandbox bootstrap
 * blocks it unconditionally) — this worker fetches `endpoint_url` in
 * trusted server code and hands the HTML to the handler through
 * `input.json.source.config.fetched_html`, then runs the sandboxed handler
 * and materializes validated output via `CustomSourceMaterializationService`.
 */
export async function runPendingCustomSourceHandlerRuns(
  db: Queryable,
  config: ServerConfig,
  batchLimit = 10,
): Promise<number> {
  const pending = await db.query<QueuedRunRow>(
    `SELECT shr.id, shr.space_id, shr.source_connection_id, shr.handler_version_id, shr.extraction_job_id,
            ej.metadata_json->>'source_channel_id' AS source_channel_id
       FROM source_handler_runs shr
       LEFT JOIN extraction_jobs ej ON ej.id = shr.extraction_job_id
      WHERE shr.status = 'queued'
      ORDER BY shr.created_at ASC
      LIMIT $1`,
    [batchLimit],
  );

  let processed = 0;
  for (const run of pending.rows) {
    let didProcess = false;
    try {
      didProcess = await runOne(db, config, run);
    } catch (error) {
      await recordRunFailure(db, run, error);
      didProcess = true;
    }
    if (didProcess) processed += 1;
  }
  return processed;
}

export async function runCustomSourceHandlerScanJob(
  db: Queryable,
  config: ServerConfig,
  jobId: string,
  spaceId: string,
): Promise<boolean> {
  const result = await db.query<QueuedRunRow>(
    `SELECT shr.id, shr.space_id, shr.source_connection_id, shr.handler_version_id, shr.extraction_job_id,
            ej.metadata_json->>'source_channel_id' AS source_channel_id
       FROM source_handler_runs shr
       LEFT JOIN extraction_jobs ej ON ej.id = shr.extraction_job_id
      WHERE shr.extraction_job_id = $1
        AND shr.space_id = $2
        AND shr.status = 'queued'
      LIMIT 1`,
    [jobId, spaceId],
  );
  const run = result.rows[0];
  if (!run) return false;
  return runOne(db, config, run);
}

async function runOne(db: Queryable, config: ServerConfig, run: QueuedRunRow): Promise<boolean> {
  const now = new Date().toISOString();
  const claimed = await db.query(
    `UPDATE source_handler_runs
        SET status = 'running', started_at = $2
      WHERE id = $1 AND status = 'queued'`,
    [run.id, now],
  );
  if ((claimed.rowCount ?? 0) === 0) return false;

  if (run.extraction_job_id) {
    await db.query(
      `UPDATE extraction_jobs SET status = 'running', started_at = $2 WHERE id = $1 AND status = 'pending'`,
      [run.extraction_job_id, now],
    );
  }

  const connectionResult = await db.query<{
    id: string;
    space_id: string;
    owner_user_id: string;
    channel_id: string;
    endpoint_url: string | null;
    fetch_frequency: string;
    schedule_rule_json: unknown;
    status: string;
  }>(
    `SELECT sc.id, sc.space_id, sc.owner_user_id, ch.id AS channel_id,
            ch.endpoint_url, ch.fetch_frequency, ch.schedule_rule_json, ch.status
       FROM source_connections sc
       JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.id = $3
      WHERE sc.id = $1 AND sc.space_id = $2`,
    [run.source_connection_id, run.space_id, run.source_channel_id],
  );
  const connection = connectionResult.rows[0];
  if (!connection) throw new Error(`Custom Source connection ${run.source_connection_id} not found`);
  const scheduleTask = await getSourceChannelScanTask(db, connection.channel_id);

  const versionResult = await db.query<HandlerVersionRow>(
    `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions WHERE id = $1 AND space_id = $2`,
    [run.handler_version_id, run.space_id],
  );
  const version = versionResult.rows[0];
  if (!version) throw new Error(`Handler version ${run.handler_version_id} not found`);
  const policyEnvelope = version.policy_envelope_json as CustomSourcePolicyEnvelope;
  const settings = await new PgCustomSourceHandlerRepository(db, config).getRunnerSettingsForSpace(run.space_id);
  const blockReason = evaluateCustomSourceRunnerBlockReason(settings, policyEnvelope);
  const credential = await new CustomSourceCredentialService(db, config).resolveCredentialHeader(
    run.space_id,
    policyEnvelope.credential_ref,
  );

  try {
    const fetchedHtml = blockReason
      ? ""
      : await fetchCustomSourceEndpointHtml(connection.endpoint_url, settings, policyEnvelope, credential);

    const handlerInput: CustomSourceHandlerInput = {
      contract_version: "custom_source.handler_input.v1",
      run: {
        mode: "scan",
        job_id: run.extraction_job_id ?? run.id,
        connection_id: connection.id,
        handler_version_id: version.id,
        started_at: now,
      },
      source: {
        name: connection.id,
        endpoint_url: connection.endpoint_url,
        config: { fetched_html: fetchedHtml },
        cursor: null,
      },
      policy: {
        allowed_network_origins: policyEnvelope.allowed_network_origins,
        capture_policy: policyEnvelope.capture_policy,
        retention_policy: policyEnvelope.retention_policy,
        credential_ref: policyEnvelope.credential_ref ?? null,
        limits: policyEnvelope.limits,
      },
    };

    const runnerResult = blockReason
      ? ({ status: "blocked", reason: blockReason } as const)
      : await executeCustomSourceHandler(db, config, settings, { version, policyEnvelope, handlerInput, credential });

    if (runnerResult.status === "blocked") {
      await db.query(
        `UPDATE source_handler_runs SET status = 'blocked', failure_class = $2, completed_at = $3 WHERE id = $1`,
        [run.id, runnerResult.reason, new Date().toISOString()],
      );
      await failExtractionJob(db, run, runnerResult.reason);
      return true;
    }

    try {
      if (runnerResult.exit_code !== 0 || runnerResult.raw_output_json === null) {
        const failureClass = runnerResult.timed_out
          ? "timeout"
          : runnerResult.output_too_large
            ? "output_too_large"
            : "nonzero_exit";
        await db.query(
          `UPDATE source_handler_runs SET status = 'failed', failure_class = $2, completed_at = $3 WHERE id = $1`,
          [run.id, failureClass, new Date().toISOString()],
        );
        await failExtractionJob(db, run, failureClass);
        return true;
      }

      const materializer = new CustomSourceMaterializationService(db, config, settings);
      const result = await materializer.materialize({
        run: {
          runId: run.id,
          spaceId: run.space_id,
      sourceConnectionId: run.source_connection_id,
          handlerVersionId: run.handler_version_id,
        },
        policyEnvelope,
        sandboxFilesRoot: runnerResult.sandbox_files_root,
        rawOutputJson: JSON.parse(runnerResult.raw_output_json),
      });

      await completeExtractionJob(db, run, result);
      if (result.status === "succeeded" && result.itemsCreated > 0) {
        await emitSourcePostProcessingEvent(db, {
          spaceId: run.space_id,
          sourceChannelId: run.source_channel_id,
          sourceConnectionId: run.source_connection_id,
          newItemCount: result.itemsCreated,
        });
      }
    } finally {
      await cleanupSandbox(runnerResult.sandbox_files_root).catch(() => undefined);
    }
  } catch (error) {
    await db.query(
      `UPDATE source_handler_runs SET status = 'failed', failure_class = 'worker_error', completed_at = $2 WHERE id = $1`,
      [run.id, new Date().toISOString()],
    );
    await failExtractionJob(db, run, error instanceof Error ? error.message : String(error));
  } finally {
    // Always advance the schedule, even on fetch/blocked/failed runs —
    // otherwise a permanently broken source would be re-enqueued on every
    // scheduler tick.
    const completedAt = new Date().toISOString();
    await db.query(
      `UPDATE source_connections
          SET last_handler_run_id = $3,
              updated_at = $4
        WHERE id = $1 AND space_id = $2`,
      [
        run.source_connection_id,
        run.space_id,
        run.id,
        completedAt,
      ],
    );
    await updateRepairStatusAfterRun(db, run);
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

async function failExtractionJob(db: Queryable, run: QueuedRunRow, errorCode: string): Promise<void> {
  if (!run.extraction_job_id) return;
  await db.query(
    `UPDATE extraction_jobs SET status = 'failed', completed_at = $2, error_code = $3 WHERE id = $1`,
    [run.extraction_job_id, new Date().toISOString(), errorCode.slice(0, 64)],
  );
}

async function completeExtractionJob(
  db: Queryable,
  run: QueuedRunRow,
  result: { status: string; itemsCreated: number; itemsUpdated: number; errors: string[] },
): Promise<void> {
  if (!run.extraction_job_id) return;
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
      run.extraction_job_id,
      result.status === "succeeded" ? "succeeded" : "failed",
      new Date().toISOString(),
      result.itemsCreated + result.itemsUpdated,
      result.itemsCreated,
      result.itemsUpdated,
      result.errors.length > 0 ? result.errors.join("; ").slice(0, 512) : null,
    ],
  );
}

async function recordRunFailure(db: Queryable, run: QueuedRunRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `UPDATE source_handler_runs SET status = 'failed', failure_class = 'worker_error', completed_at = $2 WHERE id = $1`,
    [run.id, new Date().toISOString()],
  );
  await failExtractionJob(db, run, message.slice(0, 64));
  await db.query(
    `UPDATE source_connections SET last_handler_run_id = $1 WHERE id = $2 AND space_id = $3`,
    [run.id, run.source_connection_id, run.space_id],
  );
  await updateRepairStatusAfterRun(db, run);
}

/**
 * Phase 9 automatic repair trigger ("repeated handler failures"). Only moves
 * `ok` -> `repair_required` (never touches `repair_pending`/`disabled` — those
 * require the explicit repair/proposal flow or admin action) and clears
 * `repair_required` back to `ok` the moment a run succeeds again.
 */
const REPAIR_FAILURE_THRESHOLD = 3;

async function updateRepairStatusAfterRun(db: Queryable, run: QueuedRunRow): Promise<void> {
  const connectionResult = await db.query<{ repair_status: string }>(
    `SELECT repair_status FROM source_connections WHERE id = $1 AND space_id = $2`,
    [run.source_connection_id, run.space_id],
  );
  const repairStatus = connectionResult.rows[0]?.repair_status;
  if (!repairStatus) return;

  const runStatusResult = await db.query<{ status: string }>(
    `SELECT status FROM source_handler_runs WHERE id = $1`,
    [run.id],
  );
  const runStatus = runStatusResult.rows[0]?.status;

  if (runStatus === "succeeded") {
    if (repairStatus === "repair_required") {
      await db.query(`UPDATE source_connections SET repair_status = 'ok' WHERE id = $1 AND space_id = $2`, [
        run.source_connection_id,
        run.space_id,
      ]);
    }
    return;
  }

  if (repairStatus !== "ok") return;
  const recentRuns = await db.query<{ status: string }>(
    `SELECT status FROM source_handler_runs
      WHERE space_id = $1 AND source_connection_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [run.space_id, run.source_connection_id, REPAIR_FAILURE_THRESHOLD],
  );
  if (recentRuns.rows.length < REPAIR_FAILURE_THRESHOLD) return;
  const allFailing = recentRuns.rows.every((row) => row.status !== "succeeded");
  if (allFailing) {
    await db.query(`UPDATE source_connections SET repair_status = 'repair_required' WHERE id = $1 AND space_id = $2`, [
      run.source_connection_id,
      run.space_id,
    ]);
  }
}
