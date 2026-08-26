import type { ServerConfig } from "../../../config.js";
import { getDbPool } from "../../../db/pool.js";
import type { JobEnvelopeForHandler, JobHandlerRegistry } from "../../jobs/handlerRegistry.js";
import type { JobHandlerResult } from "../../jobs/handlerRegistry.js";
import { SourcePostProcessingService } from "./service.js";
import { ProjectResearchPipelineService } from "../../projectResearch/index.js";
import {
  isRetryableSourcePostProcessingFailure,
  sourcePostProcessingFailureCode,
} from "./recoveryService.js";
import {
  PgSourcePostProcessingRepository,
  SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
  type SourcePostProcessingTriggerType,
} from "./repository.js";

export function registerSourcePostProcessingHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  registry.register(SOURCE_POST_PROCESSING_EVENT_JOB_TYPE, async (job) =>
    handleSourcePostProcessingJob(job, config),
  );
}

async function handleSourcePostProcessingJob(
  job: JobEnvelopeForHandler,
  config: ServerConfig,
): Promise<JobHandlerResult> {
  const db = getDbPool(config.databaseUrl!);
  const service = new SourcePostProcessingService(db, config);
  const phase = stringValue(job.payload.phase);
  const triggerType = stringValue(job.payload.trigger_type) as SourcePostProcessingTriggerType | null;
  const ruleId = stringValue(job.payload.rule_id);
  if (phase === "research_recovery" && ruleId) {
    const orchestrator = new ProjectResearchPipelineService(db, config);
    const operationId = stringValue(job.payload.recovery_for_operation_id);
    try {
      if (operationId) {
        await orchestrator.onPostProcessingRecoveryStarted({
          spaceId: job.space_id,
          operationId,
        });
      }
      const run = await service.runRuleForItems({
        spaceId: job.space_id,
        ruleId,
        itemIds: arrayValue(job.payload.source_item_ids),
      });
      if (run?.status === "succeeded") {
        await orchestrator.onPostProcessingSucceeded({
          spaceId: job.space_id,
          projectId: run.project_id,
          sourcePostProcessingRunId: run.id,
          userId: run.triggered_by_user_id,
        });
      } else if (
        run?.status === "failed"
        && isRetryableSourcePostProcessingFailure(run)
        && job.attempts < job.max_attempts
      ) {
        const code = sourcePostProcessingFailureCode(run) ?? "transient_provider_error";
        throw new Error(
          `Transient source post-processing failure (${code}); retrying attempt ${job.attempts + 1} of ${job.max_attempts}`,
        );
      } else if (operationId) {
        await orchestrator.onPostProcessingRecoveryFinished({
          spaceId: job.space_id,
          operationId,
        });
      }
      return {
        source_post_processing_run_id: run?.id ?? null,
        status: run?.status ?? "skipped",
        rule_id: ruleId,
        phase,
      };
    } catch (error) {
      if (operationId && job.attempts >= job.max_attempts) {
        await orchestrator.onPostProcessingRecoveryFinished({
          spaceId: job.space_id,
          operationId,
        });
      }
      throw error;
    }
  }
  if (phase === "deep_analysis" && ruleId) {
    const itemIds = arrayValue(job.payload.source_item_ids);
    const run = await service.runDeepAnalysisForItems({
      spaceId: job.space_id,
      ruleId,
      itemIds,
      actorUserId: job.user_id,
      sourceRunId: stringValue(job.payload.source_post_processing_run_id),
    });
    return {
      source_post_processing_run_id: run?.id ?? null,
      status: run?.status ?? "skipped",
      rule_id: ruleId,
      phase,
    };
  }
  if (triggerType === "schedule" && ruleId) {
    const repo = new PgSourcePostProcessingRepository(db);
    const rule = await repo.getRule(job.space_id, ruleId);
    if (!rule) throw new Error("source_post_processing_event schedule payload references missing rule");
    const run = await service.fireScheduledRule(rule);
    if (run.status === "succeeded") {
      await new ProjectResearchPipelineService(db, config).onPostProcessingSucceeded({
        spaceId: job.space_id,
        projectId: run.project_id,
        sourcePostProcessingRunId: run.id,
        userId: run.triggered_by_user_id,
      });
    }
    return {
      source_post_processing_run_id: run.id,
      status: run.status,
      rule_id: rule.id,
    };
  }
  const sourceChannelId = stringValue(job.payload.source_channel_id);
  if (!sourceChannelId) {
    throw new Error("source_post_processing_event payload requires source_channel_id");
  }
  const result = await service.fireSourceEvent({
    spaceId: job.space_id,
    sourceChannelId,
    newItemCount: numberValue(job.payload.new_item_count) ?? 0,
  });
  for (const run of result.successful_runs) {
    await new ProjectResearchPipelineService(db, config).onPostProcessingSucceeded({
      spaceId: job.space_id,
      projectId: run.project_id,
      sourcePostProcessingRunId: run.run_id,
      userId: run.user_id,
    });
  }
  return result;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
