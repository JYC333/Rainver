/**
 * Source-domain scheduled tasks.
 *
 * These were one `source_extraction_scheduler` task whose `run()` performed
 * every source-side step in sequence with no per-step guard. A throw in one
 * domain therefore skipped every domain after it for that pass — backfill
 * reconciliation failing meant recipe scans and post-processing enqueue simply
 * stopped, while the only alert named the combined task. They are separate
 * tasks so each domain gets its own failure isolation, its own
 * `scheduler_task_failed` dedupe key, and its own liveness record.
 *
 * Steps within one task remain sequential on purpose: they are one domain's
 * pipeline, where reclaim-then-enqueue-then-run is the intended order.
 */

import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { ScheduledTask } from "./registry";
import type { PgJobQueueRepository } from "../jobs/repository";
import { SourceExtractionWorker } from "../sources/extractionWorker";
import { enqueueDueSourceChannelScans } from "../sources/scanSchedule";
import { enqueueDueSourcePostProcessingRules } from "../sources/postProcessing/scheduler";
import { enqueuePendingSourceAnnotationWork } from "../sourceAnnotation/scheduler";
import {
  enqueueDueCustomSourceHandlerRuns,
  reclaimStuckCustomSourceHandlerRuns,
} from "../sources/customSources/customSourceScanSchedule";
import { runPendingCustomSourceHandlerRuns } from "../sources/customSources/customSourceScanWorker";
import {
  enqueueDueSourceRecipeScans,
  runPendingSourceRecipeScans,
} from "../sources/sourceRecipes/recipeScanWorker";
import { SourceBackfillExecutionService } from "../sources/sourceBackfillExecutionService";

export interface SourceTaskLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function buildSourceSchedulerTasks(
  config: ServerConfig,
  options: { queue?: PgJobQueueRepository | null; log?: SourceTaskLogger } = {},
): ScheduledTask[] {
  if (!config.sourceExtractionSchedulerEnabled || !config.databaseUrl) return [];
  const log = options.log;
  const intervalSeconds = config.sourceExtractionSchedulerIntervalSeconds;
  const db = () => getDbPool(config.databaseUrl!);

  const tasks: ScheduledTask[] = [
    {
      name: "source_extraction_scheduler",
      intervalSeconds,
      runOnStart: true,
      run: async () => {
        const enqueued = await enqueueDueSourceChannelScans(db(), 25);
        if (enqueued > 0) log?.info(`[scheduler] source enqueued ${enqueued} source scan job(s)`);
        const processed = await processPendingSourceJobs(config, log);
        if (processed > 0) log?.info(`[scheduler] source processed ${processed} extraction job(s)`);
      },
    },
    {
      name: "source_backfill_reconciler",
      intervalSeconds,
      runOnStart: true,
      run: async () => {
        await reconcileSourceBackfills(db());
      },
    },
    {
      name: "custom_source_handler_scheduler",
      intervalSeconds,
      runOnStart: true,
      run: async () => {
        const pool = db();
        const reclaimed = await reclaimStuckCustomSourceHandlerRuns(pool);
        if (reclaimed > 0) log?.warn(`[scheduler] custom source reclaimed ${reclaimed} stuck run(s)`);
        const enqueued = await enqueueDueCustomSourceHandlerRuns(pool);
        if (enqueued > 0) log?.info(`[scheduler] custom source enqueued ${enqueued} handler run(s)`);
        const processed = await runPendingCustomSourceHandlerRuns(pool, config);
        if (processed > 0) log?.info(`[scheduler] custom source processed ${processed} handler run(s)`);
      },
    },
    {
      name: "source_recipe_scan_scheduler",
      intervalSeconds,
      runOnStart: true,
      run: async () => {
        const pool = db();
        const enqueued = await enqueueDueSourceRecipeScans(pool);
        if (enqueued > 0) log?.info(`[scheduler] source recipe enqueued ${enqueued} scan job(s)`);
        const processed = await runPendingSourceRecipeScans(pool, config);
        if (processed > 0) log?.info(`[scheduler] source recipe processed ${processed} scan job(s)`);
      },
    },
  ];

  const queue = options.queue;
  if (queue) {
    tasks.push({
      name: "source_post_processing_scheduler",
      intervalSeconds,
      runOnStart: true,
      run: async () => {
        const enqueued = await enqueueDueSourcePostProcessingRules(config, queue);
        if (enqueued > 0) {
          log?.info(`[scheduler] source enqueued ${enqueued} post-processing job(s)`);
        }
      },
    });
    tasks.push({
      name: "source_annotation_sweep",
      intervalSeconds,
      runOnStart: true,
      run: async () => {
        const enqueued = await enqueuePendingSourceAnnotationWork(config, queue);
        if (enqueued > 0) {
          log?.info(`[scheduler] source annotation swept ${enqueued} space(s)`);
        }
      },
    });
  }

  return tasks;
}

async function reconcileSourceBackfills(db: ReturnType<typeof getDbPool>): Promise<void> {
  const plans = await db.query<{ id: string; space_id: string }>(
    `SELECT id,space_id FROM source_backfill_plans
      WHERE status IN ('approved','running')
         OR (status='paused' AND next_eligible_at<=now())
      ORDER BY updated_at LIMIT 25`,
  );
  for (const plan of plans.rows) {
    await db.query(
      `UPDATE source_backfill_plans SET status='approved',next_eligible_at=NULL,updated_at=now()
        WHERE id=$1 AND space_id=$2 AND status='paused' AND next_eligible_at<=now()`,
      [plan.id, plan.space_id],
    );
    await new SourceBackfillExecutionService(db).reconcile(plan.space_id, plan.id);
  }
}

async function processPendingSourceJobs(
  config: ServerConfig,
  log?: Pick<SourceTaskLogger, "warn">,
): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const worker = new SourceExtractionWorker(db, config);
  const pending = await db.query<{ id: string; space_id: string }>(
    `SELECT id, space_id
       FROM extraction_jobs
      WHERE status = 'pending'
        AND COALESCE(metadata_json->>'implementation', '') <> 'recipe'
        AND NOT EXISTS (
          SELECT 1
            FROM source_handler_runs shr
           WHERE shr.extraction_job_id = extraction_jobs.id
        )
      ORDER BY created_at ASC
      LIMIT 10`,
  );
  let count = 0;
  for (const row of pending.rows) {
    try {
      // One unprocessable job must not abandon the rest of the batch.
      await worker.runPendingJob(row.id, row.space_id);
      count += 1;
    } catch (err) {
      log?.warn(
        `[source-extraction] job ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return count;
}
