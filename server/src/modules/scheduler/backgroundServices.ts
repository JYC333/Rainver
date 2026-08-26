import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { startSchedulerRegistry, type ScheduledTask } from "./registry.js";
import { scanDailyReportsAndEnqueue } from "../dailyReports/scheduler.js";
import { scanAutomationsAndFire } from "../automations/scheduler.js";
import { runScheduledBackup } from "../backups/service.js";
import { pruneSupersededCustomSourceHandlerArtifacts } from "../sources/customSources/customSourceArtifactRetention.js";
import { runDueMemoryMaintenanceJobs } from "../memory/maintenanceJobs.js";
import { withDbTransaction } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { startJobsWorker, type JobsWorkerHandle } from "../jobs/workerRuntime.js";
import type { PluginHost } from "../plugins/host/index.js";
import { buildSourceSchedulerTasks } from "./sourceTasks.js";
import { OperationalAlertService } from "../notifications/operationalAlerts.js";
import { ExecutionGraphRecoveryService } from "../execution/executionGraphRecoveryService.js";
import { ProjectResearchPipelineService } from "../projectResearch/index.js";
import { enqueueDueResearchIntegrityChecks } from "../projectResearch/integrityMonitorService.js";
import { processAllUnclaimedDomainChangeEvents } from "../knowledgePromotion/revalidationService.js";
import { sweepConversationRuntimeState } from "../runs/conversationRuntimeState.js";
import { CliCredentialBroker } from "../providers/cli/credentialBroker.js";
import { createCliUsageRefreshTask } from "../providers/cli/usageScheduler.js";
import { setBackgroundServicesStatusSource } from "./runtimeStatus.js";
import { AutonomyRecoveryService } from "../autonomy/recoveryService.js";
import { reconcileInformationDigestAutomations } from "../informationDigest/automationProvisioning.js";
import { RoomConversationSummaryService } from "../rooms/conversationSummaryService.js";
import { RoomConversationTitleService } from "../rooms/conversationTitleService.js";

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
    {
      name: "conversation_runtime_state_retention",
      intervalSeconds: 3600,
      runOnStart: false,
      run: async () => {
        const protectedRows = config.databaseUrl
          ? await getDbPool(config.databaseUrl).query<{ runtime_state_key: string }>(
              `SELECT runtime_state_key
                 FROM session_conversation_backends
               UNION
               SELECT model_override_json->'conversation_runtime'->>'runtime_state_key'
                 FROM runs
                WHERE status IN (
                  'queued', 'running', 'cancelling',
                  'waiting_for_review', 'waiting_for_dependency'
                )
                  AND model_override_json->'conversation_runtime'->>'schema_version'
                      = 'conversation_runtime.v1'`,
            )
          : { rows: [] };
        const removed = await sweepConversationRuntimeState({
          rainver_home: config.rainverHome,
          sandbox_root: config.sandboxRoot,
          protected_state_keys: new Set(
            protectedRows.rows.map((row) => row.runtime_state_key),
          ),
        });
        if (removed > 0) {
          log?.info(`[scheduler] conversation runtime state pruned ${removed} session(s)`);
        }
      },
    },
  ];

  if (config.databaseUrl) {
    tasks.push({
      name: "information_digest_automation_provisioning",
      intervalSeconds: 3600,
      runOnStart: true,
      awaitRunOnStart: false,
      run: async () => {
        const created = await reconcileInformationDigestAutomations(getDbPool(config.databaseUrl!));
        if (created > 0) log?.info(`[scheduler] information digest provisioned ${created} automation(s)`);
      },
    });

    tasks.push({
      name: "autonomous_review_timeout_recovery",
      intervalSeconds: 300,
      runOnStart: true,
      awaitRunOnStart: false,
      run: async () => {
        const result = await new AutonomyRecoveryService(
          getDbPool(config.databaseUrl!),
        ).cancelStaleWaitingForReview({ maxAgeSeconds: 3_600 });
        if (result.cancelled > 0) {
          log?.warn(`[scheduler] autonomous review timeout cancelled ${result.cancelled} Run(s)`);
        }
      },
    });

    tasks.push({
      name: "execution_graph_recovery",
      intervalSeconds: 60,
      runOnStart: true,
      awaitRunOnStart: false,
      run: async () => {
        const result = await new ExecutionGraphRecoveryService(
          getDbPool(config.databaseUrl!),
          config,
          OperationalAlertService.fromConfig(config),
          log,
        ).reconcileActive();
        if (result.plans + result.workflows > 0 || result.failures > 0) {
          log?.info(`[scheduler] execution graph recovery plans=${result.plans} workflows=${result.workflows} failures=${result.failures}`);
        }
      },
    });

    tasks.push({
      name: "project_research_execution_nudger",
      intervalSeconds: Math.max(5, Math.min(15, config.sourceExtractionSchedulerIntervalSeconds)),
      runOnStart: true,
      run: async () => {
        await reconcileProjectResearch(getDbPool(config.databaseUrl!), config);
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

    tasks.push({
      name: "knowledge_promotion_revalidation",
      intervalSeconds: 30,
      runOnStart: true,
      run: async () => {
        const processed = await processAllUnclaimedDomainChangeEvents(getDbPool(config.databaseUrl!));
        if (processed > 0) log?.info(`[scheduler] knowledge promotion revalidation processed ${processed} domain change event(s)`);
      },
    });

    tasks.push({
      name: "room_conversation_title_reconciliation",
      intervalSeconds: 60,
      runOnStart: true,
      awaitRunOnStart: false,
      run: async () => {
        const renamed = await new RoomConversationTitleService(
          config,
          getDbPool(config.databaseUrl!),
        ).reconcilePending();
        if (renamed > 0) log?.info(`[scheduler] room conversation titles queued=${renamed}`);
      },
    });

    tasks.push({
      name: "room_conversation_summary_scheduler",
      intervalSeconds: 60,
      runOnStart: true,
      awaitRunOnStart: false,
      run: async () => {
        const service = new RoomConversationSummaryService(config, getDbPool(config.databaseUrl!));
        const reconciled = await service.reconcileMissingStates();
        const recovered = await service.recoverExpiredLeases();
        const enqueued = await service.enqueueDueJobs();
        if (reconciled > 0 || recovered > 0 || enqueued > 0) {
          log?.info(`[scheduler] room conversation summaries reconciled=${reconciled} recovered=${recovered} enqueued=${enqueued}`);
        }
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

  if (config.contentAccessLogRetentionEnabled && config.databaseUrl) {
    tasks.push({
      name: "content_access_log_retention",
      intervalSeconds: config.contentAccessLogPruneIntervalSeconds,
      run: async () => {
        const deleted = await pruneContentAccessLogs(config);
        if (deleted > 0) log?.info(`[scheduler] content_access_log pruned ${deleted} row(s)`);
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

  tasks.push(...buildSourceSchedulerTasks(config, { queue: worker?.queue ?? null, log }));

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

  if (config.databaseUrl) {
    // Previously a detached setInterval started from the provider routes, so it
    // survived shutdown and never reported a failure or a liveness record.
    const broker = new CliCredentialBroker(config);
    tasks.push(
      createCliUsageRefreshTask(broker, {
        isEnabled: () => broker.isCliUsageAutoRefreshEnabled(),
      }),
    );
  }

  if (config.backupEnabled) {
    tasks.push({
      name: "backup_scheduler",
      intervalSeconds: config.backupIntervalHours * 3600,
      // A dump legitimately runs far longer than the default reporting
      // deadline; without this a normal backup would be reported as a stall.
      timeoutSeconds: Math.max(3600, config.backupIntervalHours * 3600),
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

  setBackgroundServicesStatusSource({
    schedulerStatuses: (now) => scheduler.statuses(now),
    workerId: () => worker?.worker_id ?? null,
    queueDepth: async () => (worker ? worker.queue.countQueueDepth() : null),
  });

  return { worker, scheduler };
}

export async function reconcileProjectResearch(db: ReturnType<typeof getDbPool>, config: ServerConfig): Promise<void> {
  const orchestrator = new ProjectResearchPipelineService(db, config);
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

export async function pruneContentAccessLogs(config: ServerConfig): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const cutoff = new Date(
    Date.now() - config.contentAccessLogRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await db.query(
    `DELETE FROM content_access_logs WHERE accessed_at < $1`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}

// Re-export for tests that need queue without full worker.
export { PgJobQueueRepository };
