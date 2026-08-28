import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { JobHandlerRegistry } from "./handlerRegistry.js";
import { PgJobQueueRepository } from "./repository.js";
import { JobWorker } from "./worker.js";
import { waitForJobWake, wakeJobWorkers } from "./wakeSignal.js";
import { registerAgentRunHandler } from "../runs/agentRunHandler.js";
import { registerMemoryConsolidationHandler } from "../activity/consolidationJob.js";
import { registerDailyCaptureReportHandler } from "../dailyReports/jobHandler.js";
import { registerSourceExtractionHandler } from "../sources/extractionJob.js";
import { registerSourcePostProcessingHandler } from "../sources/postProcessing/job.js";
import { registerSourceAnnotationHandler } from "../sourceAnnotation/index.js";
import { registerRetrievalEmbeddingHandler } from "../retrieval/embedding/job.js";
import type { PluginHost } from "../plugins/host/index.js";
import { PgRunRepository } from "../runs/repository.js";
import { RunMaterializationService } from "../runs/materializationService.js";
import { OperationalAlertService } from "../notifications/operationalAlerts.js";
import { registerEvaluationHarnessHandler } from "../evolution/evaluationJob.js";
import { registerProjectResearchHandler } from "../projectResearch/index.js";
import { registerKnowledgeExtractionHandler } from "../knowledgePromotion/extractionJob.js";
import { registerInquiryAdviceHandler } from "../inquiry/adviceJob.js";
import { registerExperimentReconcileHandler } from "../experiments/reconcileJob.js";
import type { RuntimeHostLogger } from "../runtimeHost/index.js";
import { finalizeChatTurn } from "../runs/chatTurnFinalizer.js";
import type { ChatTurnFinalizerDeps } from "../runs/chatTurnFinalizer.js";
import { isHardTerminalRunStatus } from "../runs/orchestrationResults.js";
import { registerRuntimeContextCheckpointHandler } from "../runtimeContext/continuity/job.js";
import { registerRoomConversationSummaryHandler } from "../rooms/conversationSummaryJob.js";
import { registerRoomConversationTitleHandler } from "../rooms/conversationTitleJob.js";
import { registerRoomDelegationCompletionRetryHandler } from "../agentGroups/delegationCompletionRetryJob.js";
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
// Keep the shared worker lease conservative for every job family. Individual
// adapters own their execution deadlines and cancellation; a Research-specific
// latency requirement must not shorten the global orphan-reclaim boundary.
const STUCK_AFTER_SECONDS = 600;

export interface JobsWorkerLogger {
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

export function buildJobHandlerRegistry(
  config: ServerConfig,
  pluginHost?: PluginHost,
  runtimeHostLogger?: RuntimeHostLogger,
): JobHandlerRegistry {
  const registry = new JobHandlerRegistry();
  registerAgentRunHandler(registry, config, runtimeHostLogger);
  registerMemoryConsolidationHandler(registry, config);
  registerDailyCaptureReportHandler(registry, config);
  registerSourceExtractionHandler(registry, config);
  registerSourcePostProcessingHandler(registry, config);
  registerSourceAnnotationHandler(registry, config);
  registerRetrievalEmbeddingHandler(registry, config);
  registerEvaluationHarnessHandler(registry, config);
  registerProjectResearchHandler(registry, config);
  registerKnowledgeExtractionHandler(registry, config);
  registerExperimentReconcileHandler(registry, config);
  registerInquiryAdviceHandler(registry, config);
  registerRuntimeContextCheckpointHandler(registry, config);
  registerRoomConversationSummaryHandler(registry, config);
  registerRoomConversationTitleHandler(registry, config);
  registerRoomDelegationCompletionRetryHandler(registry, config);
  registerResearchAcquisitionPipelineHandler(registry, config);
  registerResearchOperationFailureNotifyHandler(registry, config);
  registerResearchOperationCancelHandler(registry, config);
  // Plugin-contributed job handlers (enablement-gated by the host context).
  pluginHost?.applyJobHandlers(registry);
  return registry;
}

export function startJobsWorker(
  config: ServerConfig,
  log?: JobsWorkerLogger,
  pluginHost?: PluginHost,
): JobsWorkerHandle | null {
  if (!config.databaseUrl) return null;

  const queue = PgJobQueueRepository.fromConfig(config);
  const runs = PgRunRepository.fromConfig(config);
  const runtimeHostLogger: RuntimeHostLogger | undefined = log
    ? {
        error(details, message) {
          log.error(`${message} ${JSON.stringify(details)}`);
        },
      }
    : undefined;
  const registry = buildJobHandlerRegistry(config, pluginHost, runtimeHostLogger);
  const claimableJobTypes = registry.registeredJobTypes();
  if (claimableJobTypes.length === 0) {
    throw new Error("Job worker started with zero registered handlers");
  }

  const workerId = `ts-job-worker:${randomUUID()}`;
  const worker = new JobWorker(
    queue,
    registry,
    workerId,
    claimableJobTypes,
    undefined,
    OperationalAlertService.fromConfig(config),
  );

  let stopped = false;
  let lastReclaim = 0;
  let idleWaitMs = POLL_INTERVAL_MS;

  const loop = (async () => {
    log?.info(`[jobs-worker] started (${workerId}) types=${claimableJobTypes.join(",")}`);
    try {
      const recovered = await runs.recoverStaleRuns(3600);
      if (recovered > 0) log?.warn(`[jobs-worker] recovered ${recovered} stale run(s)`);
      const orphaned = await runs.listOrphanedRunIds();
      if (orphaned.length > 0) {
        const materializer = RunMaterializationService.fromConfig(config);
        for (const item of orphaned) {
          const run = await runs.getRun(item.space_id, item.id);
          if (!run) continue;
          try {
            await materializer.finalizeRun(run);
          } catch (error) {
            log?.warn(
              `[jobs-worker] orphaned run ${item.id} finalization deferred: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      await reconcileTerminalChatRuns(config, runs, log);
    } catch (error) {
      log?.error(
        `[jobs-worker] stale run recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    while (!stopped) {
      try {
        const now = Date.now();
        if (now - lastReclaim >= RECLAIM_INTERVAL_MS) {
          const reclaimed = await worker.reclaimStuckJobs(STUCK_AFTER_SECONDS);
          if (reclaimed > 0) log?.warn(`[jobs-worker] reclaimed ${reclaimed} stuck job(s)`);
          await reconcileTerminalChatRuns(config, runs, log);
          lastReclaim = now;
        }
        const result = await worker.processOne();
        if (result.status === "idle") {
          const wake = await waitForJobWake(idleWaitMs);
          idleWaitMs = wake === "signalled" ? POST_WAKE_RECHECK_MS : POLL_INTERVAL_MS;
        } else {
          idleWaitMs = POLL_INTERVAL_MS;
          if (result.status === "failed") {
            log?.warn(`[jobs-worker] job ${result.job_id} failed: ${result.error}`);
          }
        }
      } catch (error) {
        log?.error(
          `[jobs-worker] loop error: ${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(POLL_INTERVAL_MS);
      }
    }
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
    },
  };
}

export async function reconcileTerminalChatRuns(
  config: ServerConfig,
  runs: PgRunRepository,
  log?: JobsWorkerLogger,
  materializer: Pick<RunMaterializationService, "finalizeRun"> =
    RunMaterializationService.fromConfig(config),
  finalizerDeps: ChatTurnFinalizerDeps = {},
): Promise<void> {
  const pending = await runs.listTerminalChatRunsAwaitingCompletion();
  for (const item of pending) {
    const run = await runs.getRun(item.space_id, item.id);
    if (!run) continue;
    try {
      const finalization = await materializer.finalizeRun(run);
      if (finalization.status !== "succeeded") {
        throw new Error(
          finalization.error_message ?? "Run finalization reconciliation failed.",
        );
      }
      const current = await runs.getRun(item.space_id, item.id);
      if (current && isHardTerminalRunStatus(current.status)) {
        await finalizeChatTurn(config, runs, current, finalizerDeps);
      }
    } catch (error) {
      log?.warn(
        `[jobs-worker] chat Run ${item.id} completion deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const waitingForReview = await runs.listWaitingRoomChatRunsAwaitingReply();
  for (const item of waitingForReview) {
    const run = await runs.getRun(item.space_id, item.id);
    if (!run || run.status !== "waiting_for_review") continue;
    try {
      await finalizeChatTurn(config, runs, run, finalizerDeps);
    } catch (error) {
      log?.warn(
        `[jobs-worker] waiting Room Run ${item.id} reply deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}
