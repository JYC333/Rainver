import {registerSourceGoalJob} from '../sources/goals/worker.js';
import { registerMonitoringJob } from "../projects/monitoring/worker.js";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { JobDeferredError, JobHandlerRegistry } from "./handlerRegistry.js";
import { PgJobQueueRepository } from "./repository.js";
import { JobWorker } from "./worker.js";
import { runJobWorkerPool } from "./workerPool.js";
import { RunRecoveryLoop } from "./runRecoveryLoop.js";
import { RunRecoveryService } from "../runs/recovery.js";
import { wakeJobWorkers } from "./wakeSignal.js";
import { registerAgentRunHandler } from "../runs/agentRunHandler.js";
import { registerProviderTaskRunHandler } from "../runs/providerTaskRunHandler.js";
import { registerMemoryConsolidationHandler } from "../activity/consolidationJob.js";
import { registerDailyCaptureReportHandler } from "../dailyReports/jobHandler.js";
import { registerSourceExtractionHandler } from "../sources/extractionJob.js";
import { registerSourcePostProcessingHandler } from "../sources/postProcessing/job.js";
import { registerSourceAnnotationHandler } from "../sourceAnnotation/index.js";
import { registerRetrievalEmbeddingHandler } from "../retrieval/embedding/job.js";
import type { PluginHost } from "../plugins/host/index.js";
import {
  INSTANCE_UPDATE_PENDING,
  instanceUpdatePending,
  UNATTENDED_RUN_JOB_TYPES,
} from "../deployment/drainAdmission.js";
import { OperationalAlertService } from "../notifications/operationalAlerts.js";
import { registerEvaluationHarnessHandler } from "../evolution/evaluationJob.js";
import { registerProjectResearchHandler } from "../projectResearch/index.js";
import { registerKnowledgeExtractionHandler } from "../knowledgePromotion/extractionJob.js";
import { registerInquiryAdviceHandler } from "../inquiry/adviceJob.js";
import { registerExperimentReconcileHandler } from "../experiments/reconcileJob.js";
import { registerTaskBranchJobHandlers } from "../hosts/taskBranchJobs.js";
import { registerTaskMergeHandler } from "../hosts/taskMerges.js";
import { TaskMergeResolutionDispatcher } from "../tasks/mergeResolution.js";
import { registerRoomConversationTitleHandler } from "../rooms/conversationTitleJob.js";
import { registerRoomDelegationCompletionRetryHandler } from "../agentGroups/delegationCompletionRetryJob.js";
import { registerRoomDiscussionAdvanceRetryHandler } from "../rooms/discussionAdvanceRetryJob.js";
import { registerRoomQueuedMessageReleaseHandler } from "../rooms/queuedMessageReleaseJob.js";
import { registerResearchAcquisitionPipelineHandler } from "../projectResearch/pipeline/researchAcquisitionPipelineJob.js";
import { registerResearchOperationFailureNotifyHandler } from "../projectResearch/pipeline/researchOperationFailureNotifyJob.js";
import { registerResearchOperationCancelHandler } from "../projectResearch/pipeline/researchOperationCancelJob.js";

const POLL_INTERVAL_MS = 1_000;
/**
 * An enqueue inside a caller's transaction wakes this loop before its `COMMIT`
 * makes the row visible, so a woken claim can still come back idle. Re-check
 * once after a short wait instead of dropping straight back to the full poll
 * interval — the commit lands within microseconds of the insert in every
 * current call path. It doubles as the floor on how often a wake can drive a
 * claim query, so a burst of enqueues cannot spin this loop.
 */
const POST_WAKE_RECHECK_MS = 25;
const RECLAIM_INTERVAL_MS = 120_000;
/** A recovery pass running this long is reported (not abandoned): a hung step would otherwise be silent. */
const RECOVERY_STALL_MS = 10 * 60_000;
// Keep the shared worker lease conservative for every job family. Individual
// adapters own their execution deadlines and cancellation; a Research-specific
// latency requirement must not shorten the global orphan-reclaim boundary.
const STUCK_AFTER_SECONDS = 600;

interface JobsWorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface JobsWorkerHandle {
  worker_id: string;
  registry: JobHandlerRegistry;
  queue: PgJobQueueRepository;
  stop(): Promise<void>;
}

/**
 * ADR 0020 section 4: while an instance update is queued or draining, a job
 * family that would start an unattended Run waits instead. `deferJob` returns
 * the attempt, so nothing fails for this and the work runs after the update.
 */
function deferWhileInstanceUpdates(config: ServerConfig, registry: JobHandlerRegistry): void {
  // The wrapped handlers register only with a database, and so does the
  // predicate they consult. `wrap` throws on a job type nobody registered, so
  // the gate cannot silently fail to apply.
  if (!config.databaseUrl) return;
  for (const jobType of UNATTENDED_RUN_JOB_TYPES) {
    registry.wrap(jobType, (handler) => async (job) => {
      if (await instanceUpdatePending(config)) {
        throw new JobDeferredError(INSTANCE_UPDATE_PENDING, 30_000);
      }
      return handler(job);
    });
  }
}

export function buildJobHandlerRegistry(
  config: ServerConfig,
  pluginHost?: PluginHost,
): JobHandlerRegistry {
  const registry = new JobHandlerRegistry();
  registerSourceGoalJob(registry,config);
  registerAgentRunHandler(registry, config);
  registerProviderTaskRunHandler(registry, config);
  registerMemoryConsolidationHandler(registry, config);
  registerDailyCaptureReportHandler(registry, config);
  registerMonitoringJob(registry, config);
  registerSourceExtractionHandler(registry, config);
  registerSourcePostProcessingHandler(registry, config);
  registerSourceAnnotationHandler(registry, config);
  registerRetrievalEmbeddingHandler(registry, config);
  registerEvaluationHarnessHandler(registry, config);
  registerProjectResearchHandler(registry, config);
  registerKnowledgeExtractionHandler(registry, config);
  registerExperimentReconcileHandler(registry, config);
  registerTaskBranchJobHandlers(registry, config);
  registerTaskMergeHandler(registry, config, { resolver: new TaskMergeResolutionDispatcher(config) });
  registerInquiryAdviceHandler(registry, config);
  registerRoomConversationTitleHandler(registry, config);
  registerRoomDelegationCompletionRetryHandler(registry, config);
  registerRoomDiscussionAdvanceRetryHandler(registry, config);
  registerRoomQueuedMessageReleaseHandler(registry, config);
  registerResearchAcquisitionPipelineHandler(registry, config);
  registerResearchOperationFailureNotifyHandler(registry, config);
  registerResearchOperationCancelHandler(registry, config);
  // Plugin-contributed job handlers (enablement-gated by the host context).
  pluginHost?.applyJobHandlers(registry);
  deferWhileInstanceUpdates(config, registry);
  return registry;
}

export function startJobsWorker(
  config: ServerConfig,
  log?: JobsWorkerLogger,
  pluginHost?: PluginHost,
): JobsWorkerHandle | null {
  if (!config.databaseUrl) return null;

  const queue = PgJobQueueRepository.fromConfig(config);
  const registry = buildJobHandlerRegistry(config, pluginHost);
  const claimableJobTypes = registry.registeredJobTypes();
  if (claimableJobTypes.length === 0) {
    throw new Error("Job worker started with zero registered handlers");
  }

  const workerId = `ts-job-worker:${randomUUID()}`;
  const workers = Array.from({ length: config.jobsWorkerConcurrency }, (_, index) => new JobWorker(
    queue, registry, `${workerId}:${index}`, claimableJobTypes, undefined,
    OperationalAlertService.fromConfig(config),
  ));

  let stopped = false;
  const lifecycle = new RunRecoveryService(config);
  const recovery = new RunRecoveryLoop(async () => {
    // Reclaim and lifecycle replay are independent: a reclaim error still lets the replay run.
    try {
      const reclaimed = await workers[0]!.reclaimStuckJobs(STUCK_AFTER_SECONDS);
      if (reclaimed > 0) log?.warn(`[jobs-worker] reclaimed ${reclaimed} stuck job(s)`);
    } catch (error) {
      log?.error(`[jobs-worker] stuck job reclaim failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await lifecycle.recover(log);
  }, RECLAIM_INTERVAL_MS, error => log?.error(`[jobs-worker] recovery failed: ${error instanceof Error ? error.message : String(error)}`), {
    afterMs: RECOVERY_STALL_MS,
    report: elapsedMs => log?.error(`[jobs-worker] recovery pass still running after ${Math.round(elapsedMs / 1000)}s; next pass waits for it (last completed ${recovery.lastCompletedAt?.toISOString() ?? "never"})`),
  });

  const loop = (async () => {
    log?.info(`[jobs-worker] started (${workerId}) lanes=${workers.length} types=${claimableJobTypes.join(",")}`);
    recovery.start();
    await runJobWorkerPool(workers, {
      stopped: () => stopped,
      pollIntervalMs: POLL_INTERVAL_MS,
      postWakeRecheckMs: POST_WAKE_RECHECK_MS,
      log,
    });
    log?.info(`[jobs-worker] stopped (${workerId})`);
  })();

  return {
    worker_id: workerId,
    registry,
    queue,
    stop: async () => {
      stopped = true;
      // Break an idle wait instead of letting shutdown sit out its remainder.
      wakeJobWorkers();
      await loop;
      await recovery.stop();
    },
  };
}
