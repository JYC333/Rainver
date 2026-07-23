import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { startSchedulerRegistry, type ScheduledTask } from "./registry";
import { scanDailyReportsAndEnqueue } from "../dailyReports/scheduler";
import { scanAutomationsAndFire } from "../automations/scheduler";
import { runScheduledBackup } from "../backups/service";
import { SourceExtractionWorker } from "../sources/extractionWorker";
import { enqueueDueSourceChannelScans } from "../sources/scanSchedule";
import { enqueueDueSourcePostProcessingRules } from "../sources/postProcessing/scheduler";
import {
  enqueueDueCustomSourceHandlerRuns,
  reclaimStuckCustomSourceHandlerRuns,
} from "../sources/customSources/customSourceScanSchedule";
import { runPendingCustomSourceHandlerRuns } from "../sources/customSources/customSourceScanWorker";
import {
  enqueueDueSourceRecipeScans,
  runPendingSourceRecipeScans,
} from "../sources/sourceRecipes/recipeScanWorker";
import { pruneSupersededCustomSourceHandlerArtifacts } from "../sources/customSources/customSourceArtifactRetention";
import { runDueMemoryMaintenanceJobs } from "../memory/maintenanceJobs";
import { withDbTransaction } from "../routeUtils/common";
import { PgJobQueueRepository } from "../jobs/repository";
import { startJobsWorker, type JobsWorkerHandle } from "../jobs/workerRuntime";
import type { PluginHost } from "../plugins/host";
import { SourceBackfillExecutionService } from "../sources/sourceBackfillExecutionService";
import { OperationalAlertService } from "../notifications/operationalAlerts";
import { ExecutionGraphRecoveryService } from "../execution/executionGraphRecoveryService";
import { ProjectResearchPipelineService } from "../projectResearch";
import { enqueueDueResearchIntegrityChecks } from "../projectResearch/integrityMonitorService";

export interface BackgroundServicesHandle {
  worker: JobsWorkerHandle | null;
  scheduler: { stop(): Promise<void> };
}

export function startBackgroundServices(
  config: ServerConfig,
  log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  },
  pluginHost?: PluginHost,
): BackgroundServicesHandle {
  const worker = startJobsWorker(config, log, pluginHost);
  const tasks: ScheduledTask[] = [
    // Plugin-contributed scheduler tasks (fan out to enabled users internally).
    ...(pluginHost?.getSchedulerTasks() ?? []),
  ];

  if (config.databaseUrl) {
    tasks.push({
      name: "execution_graph_recovery",
      intervalSeconds: 60,
      runOnStart: true,
      awaitRunOnStart: false,
      run: async () => {
        const result = await new ExecutionGraphRecoveryService(
          getDbPool(config.databaseUrl!),
          OperationalAlertService.fromConfig(config),
          log,
        ).reconcileActive();
        if (result.plans + result.workflows > 0 || result.failures > 0) {
          log?.info(`[scheduler] execution graph recovery plans=${result.plans} workflows=${result.workflows} failures=${result.failures}`);
        }
      },
    });

    tasks.push({
      name: "project_research_reconciler",
      intervalSeconds: Math.max(5, Math.min(15, config.sourceExtractionSchedulerIntervalSeconds)),
      runOnStart: true,
      run: async () => {
        await reconcileProjectResearch(getDbPool(config.databaseUrl!));
      },
    });

    tasks.push({
      name: "project_research_integrity_scheduler",
      intervalSeconds: 3600,
      runOnStart: false,
      run: async () => {
        const enqueued = await enqueueDueResearchIntegrityChecks(getDbPool(config.databaseUrl!));
        if (enqueued > 0) log?.info(`[scheduler] project research integrity enqueued ${enqueued} job(s)`);
      },
    });
  }

  if (config.dailyReportSchedulerEnabled && worker) {
    tasks.push({
      name: "daily_report_scheduler",
      intervalSeconds: config.dailyReportSchedulerIntervalSeconds,
      run: async () => {
        const enqueued = await scanDailyReportsAndEnqueue(config, worker.queue);
        if (enqueued > 0) log?.info(`[scheduler] daily_report enqueued ${enqueued} job(s)`);
      },
      runOnStart: true,
    });
  }

  if (config.automationSchedulerEnabled) {
    tasks.push({
      name: "automation_scheduler",
      intervalSeconds: config.automationSchedulerIntervalSeconds,
      run: async () => {
        const fired = await scanAutomationsAndFire(config);
        if (fired > 0) log?.info(`[scheduler] automation fired ${fired} automation(s)`);
      },
      runOnStart: true,
    });
  }

  if (config.memoryAccessLogRetentionEnabled && config.databaseUrl) {
    tasks.push({
      name: "memory_access_log_retention",
      intervalSeconds: config.memoryAccessLogPruneIntervalSeconds,
      run: async () => {
        const deleted = await pruneMemoryAccessLogs(config);
        if (deleted > 0) log?.info(`[scheduler] memory_access_log pruned ${deleted} row(s)`);
      },
      runOnStart: false,
    });
  }

  if (config.memoryMaintenanceSchedulerEnabled && config.databaseUrl) {
    tasks.push({
      name: "memory_maintenance_scheduler",
      intervalSeconds: config.memoryMaintenanceSchedulerIntervalSeconds,
      run: async () => {
        const processed = await withDbTransaction(getDbPool(config.databaseUrl!), (client) =>
          runDueMemoryMaintenanceJobs(client, config.memoryMaintenanceSchedulerBatchLimit));
        if (processed > 0) log?.info(`[scheduler] memory_maintenance advanced ${processed} job(s)`);
      },
      runOnStart: false,
    });
  }

  if (config.sourceExtractionSchedulerEnabled && config.databaseUrl) {
    tasks.push({
      name: "source_extraction_scheduler",
      intervalSeconds: config.sourceExtractionSchedulerIntervalSeconds,
      run: async () => {
        const enqueued = await enqueueDueSourceChannelScansForConfig(config);
        if (enqueued > 0) log?.info(`[scheduler] source enqueued ${enqueued} source scan job(s)`);
        const processed = await processPendingSourceJobs(config, log);
        if (processed > 0) log?.info(`[scheduler] source processed ${processed} extraction job(s)`);
        await reconcileSourceBackfills(getDbPool(config.databaseUrl!));
        const customDb = getDbPool(config.databaseUrl!);
        const reclaimed = await reclaimStuckCustomSourceHandlerRuns(customDb);
        if (reclaimed > 0) log?.warn(`[scheduler] custom source reclaimed ${reclaimed} stuck run(s)`);
        const customEnqueued = await enqueueDueCustomSourceHandlerRuns(customDb);
        if (customEnqueued > 0) log?.info(`[scheduler] custom source enqueued ${customEnqueued} handler run(s)`);
        const customProcessed = await runPendingCustomSourceHandlerRuns(customDb, config);
        if (customProcessed > 0) log?.info(`[scheduler] custom source processed ${customProcessed} handler run(s)`);
        const recipeEnqueued = await enqueueDueSourceRecipeScans(customDb);
        if (recipeEnqueued > 0) log?.info(`[scheduler] source recipe enqueued ${recipeEnqueued} scan job(s)`);
        const recipeProcessed = await runPendingSourceRecipeScans(customDb, config);
        if (recipeProcessed > 0) log?.info(`[scheduler] source recipe processed ${recipeProcessed} scan job(s)`);
        if (worker) {
          const postProcessingEnqueued = await enqueueDueSourcePostProcessingRules(config, worker.queue);
          if (postProcessingEnqueued > 0) {
            log?.info(`[scheduler] source enqueued ${postProcessingEnqueued} post-processing job(s)`);
          }
        }
      },
      runOnStart: true,
    });
  }

  if (config.customSourceArtifactRetentionEnabled && config.databaseUrl) {
    tasks.push({
      name: "custom_source_artifact_retention",
      intervalSeconds: config.customSourceArtifactRetentionIntervalSeconds,
      run: async () => {
        const pruned = await pruneSupersededCustomSourceHandlerArtifacts(getDbPool(config.databaseUrl!), config);
        if (pruned > 0) log?.info(`[scheduler] custom_source_artifact_retention pruned ${pruned} artifact(s)`);
      },
      runOnStart: false,
    });
  }

  if (config.backupEnabled) {
    tasks.push({
      name: "backup_scheduler",
      intervalSeconds: config.backupIntervalHours * 3600,
      run: async () => {
        await runScheduledBackup(config);
        log?.info("[scheduler] backup_scheduler completed tick");
      },
      runOnStart: config.backupOnStartup,
      awaitRunOnStart: false,
    });
  }

  const operationalAlerts = OperationalAlertService.fromConfig(config);
  const scheduler = startSchedulerRegistry(tasks, log, async (taskName, error) => {
    if (!operationalAlerts) return;
    await operationalAlerts.emitInstance({
      kind: "scheduler_task_failed",
      title: `Scheduler task failed: ${taskName}`,
      message: `Scheduler task ${taskName} raised an exception: ${
        error instanceof Error ? error.message : String(error)
      }`,
      dedupeKey: `scheduler_task_failed:${taskName}`,
      payload: { task_name: taskName },
    });
  });
  return { worker, scheduler };
}

async function reconcileSourceBackfills(db: ReturnType<typeof getDbPool>):Promise<void>{
  const plans=await db.query<{id:string;space_id:string}>(`SELECT id,space_id FROM source_backfill_plans WHERE status IN ('approved','running') OR (status='paused' AND next_eligible_at<=now()) ORDER BY updated_at LIMIT 25`);
  for(const plan of plans.rows){
    await db.query(`UPDATE source_backfill_plans SET status='approved',next_eligible_at=NULL,updated_at=now() WHERE id=$1 AND space_id=$2 AND status='paused' AND next_eligible_at<=now()`,[plan.id,plan.space_id]);
    await new SourceBackfillExecutionService(db).reconcile(plan.space_id,plan.id);
  }
}

export async function reconcileProjectResearch(db: ReturnType<typeof getDbPool>): Promise<void> {
  const orchestrator = new ProjectResearchPipelineService(db);
  const unreconciledRuns = await db.query<{ id: string; space_id: string }>(
    `SELECT id, space_id
       FROM source_post_processing_runs
      WHERE status='succeeded'
        AND project_id IS NOT NULL
        AND research_reconciled_at IS NULL
        AND jsonb_typeof(input_item_ids_json)='array'
        AND jsonb_array_length(input_item_ids_json)>0
      ORDER BY COALESCE(completed_at, created_at) ASC, id ASC
      LIMIT 100`,
  );
  for (const run of unreconciledRuns.rows) {
    await orchestrator.reconcilePostProcessingRun(run.space_id, run.id);
  }

  const spaces = await db.query<{ space_id: string }>(
    `SELECT DISTINCT space_id
       FROM project_operations
      WHERE kind='research' AND status IN ('active','waiting_review')
      ORDER BY space_id`,
  );
  for (const row of spaces.rows) await orchestrator.reconcileAll(row.space_id);
}

export async function pruneMemoryAccessLogs(config: ServerConfig): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const cutoff = new Date(
    Date.now() - config.memoryAccessLogRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await db.query(
    `DELETE FROM memory_access_logs WHERE accessed_at < $1`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}

export async function enqueueDueSourceChannelScansForConfig(config: ServerConfig): Promise<number> {
  if (!config.databaseUrl) return 0;
  return enqueueDueSourceChannelScans(getDbPool(config.databaseUrl), 25);
}

async function processPendingSourceJobs(
  config: ServerConfig,
  log?: { warn(message: string): void },
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

// Re-export for tests that need queue without full worker.
export { PgJobQueueRepository };
