import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { JobHandlerRegistry } from "./handlerRegistry";
import { PgJobQueueRepository } from "./repository";
import { JobWorker } from "./worker";
import { registerAgentRunHandler } from "../runs/agentRunHandler";
import { registerMemoryConsolidationHandler } from "../activity/consolidationJob";
import { registerDailyCaptureReportHandler } from "../dailyReports/jobHandler";
import { registerSourceExtractionHandler } from "../sources/extractionJob";
import { registerSourcePostProcessingHandler } from "../sources/postProcessing/job";
import { registerSourceAnnotationHandler } from "../sourceAnnotation";
import { registerRetrievalEmbeddingHandler } from "../retrieval/embedding/job";
import type { PluginHost } from "../plugins/host";
import { PgRunRepository } from "../runs/repository";
import { RunMaterializationService } from "../runs/materializationService";
import { OperationalAlertService } from "../notifications/operationalAlerts";
import { registerEvaluationHarnessHandler } from "../evolution/evaluationJob";
import { registerProjectResearchHandler } from "../projectResearch";
import { registerKnowledgeExtractionHandler } from "../knowledgePromotion/extractionJob";
import { registerInquiryAdviceHandler } from "../inquiry/adviceJob";
import { registerExperimentReconcileHandler } from "../experiments/reconcileJob";
import type { RuntimeHostLogger } from "../runtimeHost";
import { finalizeChatTurn } from "../runs/chatTurnFinalizer";
import type { ChatTurnFinalizerDeps } from "../runs/chatTurnFinalizer";
import { isHardTerminalRunStatus } from "../runs/orchestrationResults";
import { registerRuntimeContextCheckpointHandler } from "../runtimeContext/continuity/job";
import { registerRoomConversationSummaryHandler } from "../rooms/conversationSummaryJob";
import { registerRoomConversationTitleHandler } from "../rooms/conversationTitleJob";
import { registerRoomDelegationCompletionRetryHandler } from "../agentGroups/delegationCompletionRetryJob";
import { registerResearchAcquisitionPipelineHandler } from "../projectResearch/pipeline/researchAcquisitionPipelineJob";
import { registerResearchOperationFailureNotifyHandler } from "../projectResearch/pipeline/researchOperationFailureNotifyJob";
import { registerResearchOperationCancelHandler } from "../projectResearch/pipeline/researchOperationCancelJob";

const POLL_INTERVAL_MS = 1_000;
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
          await sleep(POLL_INTERVAL_MS);
        } else if (result.status === "failed") {
          log?.warn(`[jobs-worker] job ${result.job_id} failed: ${result.error}`);
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
