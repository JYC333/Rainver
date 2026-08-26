import { PgJobQueueRepository } from "../../jobs/repository.js";
import { objectValue, optionalString, type Queryable } from "../../routeUtils/common.js";
import type { SourcePostProcessingRunOut } from "./repository.js";
import {
  PgSourcePostProcessingRecoveryRepository,
  type SourcePostProcessingRecoveryScope,
} from "./recoveryRepository.js";
import { SOURCE_POST_PROCESSING_LIMITS } from "./config.js";

const RECOVERY_SETTLE_WINDOW_MS = 30_000;

export type SourcePostProcessingPreparation =
  | {
      status: "ready";
    }
  | {
      status: "waiting";
      requestedAt: string;
    }
  | {
      status: "failed";
      message: string;
    };

export function sourcePostProcessingFailureMessage(
  run: SourcePostProcessingRunOut | null,
): string | null {
  if (!run) return null;
  const error = run.error_json && typeof run.error_json === "object" && !Array.isArray(run.error_json)
    ? run.error_json as Record<string, unknown>
    : {};
  return optionalString(error.error_message)
    ?? optionalString(error.agent_run_error_code)
    ?? optionalString(error.error_code)
    ?? optionalString(run.summary)
    ?? null;
}

const RETRYABLE_SOURCE_POST_PROCESSING_FAILURES = new Set([
  "provider_network_error",
  "provider_rate_limit",
  "provider_timeout",
  "adapter_timeout",
]);

export function sourcePostProcessingFailureCode(
  run: SourcePostProcessingRunOut | null,
): string | null {
  if (!run) return null;
  const error = run.error_json && typeof run.error_json === "object" && !Array.isArray(run.error_json)
    ? run.error_json as Record<string, unknown>
    : {};
  return optionalString(error.agent_run_error_code)
    ?? optionalString(error.error_code)
    ?? null;
}

export function isRetryableSourcePostProcessingFailure(
  run: SourcePostProcessingRunOut | null,
): boolean {
  if (!run || run.status !== "failed") return false;
  const error = run.error_json && typeof run.error_json === "object" && !Array.isArray(run.error_json)
    ? run.error_json as Record<string, unknown>
    : {};
  return error.retryable === true || RETRYABLE_SOURCE_POST_PROCESSING_FAILURES.has(sourcePostProcessingFailureCode(run) ?? "");
}

/**
 * Owns the source-side readiness check for a Project Research screening
 * batch. Research supplies the scope and owns the operation state; Sources
 * owns classification coverage, recovery queueing, and processing failures.
 */
export class SourcePostProcessingRecoveryService {
  private readonly recoveryRepository: PgSourcePostProcessingRecoveryRepository;
  private readonly jobs: PgJobQueueRepository;

  constructor(db: Queryable) {
    this.recoveryRepository = new PgSourcePostProcessingRecoveryRepository(db);
    this.jobs = new PgJobQueueRepository(db);
  }

  async channelScopedItemIds(
    spaceId: string,
    channelIds: string[],
    sourceItemIds: string[],
  ): Promise<string[]> {
    const items = unique(sourceItemIds);
    if (items.length === 0 || channelIds.length === 0) return items;
    const linked = await this.recoveryRepository.channelItemIds(spaceId, channelIds, items);
    return linked.length === 0 ? items : unique(linked);
  }

  async ensureItemsProcessed(
    scope: SourcePostProcessingRecoveryScope,
  ): Promise<SourcePostProcessingPreparation> {
    const sourceItemIds = unique(scope.sourceItemIds);
    const totalCount = sourceItemIds.length;
    if (totalCount === 0) {
      return { status: "ready" };
    }
    if (scope.channelIds.length === 0 || scope.ruleIds.length === 0) {
      return {
        status: "failed",
        message: "Screening cannot start because no active channel processing rule is configured",
      };
    }

    const row = await this.recoveryRepository.coverage({
      ...scope,
      sourceItemIds,
    });
    const classifiedCount = Number(row?.classified ?? 0);
    if (classifiedCount >= totalCount) {
      return { status: "ready" };
    }

    const pendingRecoveryJobs = Number(row?.pending_recovery_jobs ?? 0);
    if (pendingRecoveryJobs > 0) {
      return {
        status: "waiting",
        requestedAt: scope.recoveryRequestedAt ?? new Date().toISOString(),
      };
    }

    const failedRuns = Number(row?.failed_runs ?? 0);
    const failedRecoveryJobs = Number(row?.failed_recovery_jobs ?? 0);
    if (failedRuns > 0 || failedRecoveryJobs > 0) {
      const detail = processingFailureDetail(
        row?.failed_run_summary,
        row?.failed_run_error,
        row?.failed_recovery_job_error,
      );
      return {
        status: "failed",
        message: `Screening failed before review: ${classifiedCount}/${totalCount} items classified${detail ? ` — ${detail}` : ""}`,
      };
    }

    const requestedAtMs = scope.recoveryRequestedAt ? Date.parse(scope.recoveryRequestedAt) : NaN;
    if (Number.isFinite(requestedAtMs) && Date.now() - requestedAtMs < RECOVERY_SETTLE_WINDOW_MS) {
      return {
        status: "waiting",
        requestedAt: scope.recoveryRequestedAt!,
      };
    }

    const rules = await this.recoveryRepository.activeRules(scope.spaceId, scope.ruleIds);
    if (rules.length === 0) {
      return {
        status: "failed",
        message: "Screening cannot start because the configured processing rules are not active",
      };
    }

    // Only the items still missing a decision need (re-)processing. Dispatching
    // the full scope here would resend already-classified items to the rule on
    // every recovery pass (e.g. a Rescan that adds even one new item), and
    // evidence extraction has no per-item idempotency guard — that duplicates
    // extracted_evidence rows for items that were already screened.
    const classifiedItemIds = new Set(await this.recoveryRepository.classifiedItemIds({ ...scope, sourceItemIds }));
    const unclassifiedItemIds = sourceItemIds.filter((id) => !classifiedItemIds.has(id));
    if (unclassifiedItemIds.length === 0) {
      // Everything was classified between the coverage count above and here
      // (e.g. a concurrent recovery pass just finished) — nothing left to queue.
      return { status: "ready" };
    }

    const batchRequestedAt = new Date().toISOString();
    let queuedJobCount = 0;
    for (const rule of rules) {
      const linkedItems = await this.recoveryRepository.channelItemIds(
        scope.spaceId,
        [rule.source_channel_id],
        unclassifiedItemIds,
      );
      if (linkedItems.length === 0) continue;
      for (const itemBatch of chunk(
        unique(linkedItems),
        SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize,
      )) {
        await this.jobs.enqueue({
          job_type: "source_post_processing_event",
          space_id: scope.spaceId,
          user_id: null,
          priority: SOURCE_POST_PROCESSING_LIMITS.researchRecoveryJobPriority,
          max_attempts: SOURCE_POST_PROCESSING_LIMITS.researchRecoveryJobMaxAttempts,
          payload: {
            phase: "research_recovery",
            rule_id: rule.id,
            source_channel_id: rule.source_channel_id,
            source_item_ids: itemBatch,
            recovery_for_operation_id: scope.operationId,
          },
        });
        queuedJobCount += 1;
      }
    }

    if (queuedJobCount === 0) {
      return {
        status: "failed",
        message: "Screening cannot start because no configured rule covers the imported source items",
      };
    }

    return {
      status: "waiting",
      requestedAt: batchRequestedAt,
    };
  }
}

function processingFailureDetail(
  summary: string | null | undefined,
  errorJson: unknown,
  jobError: string | null | undefined,
): string | null {
  const error = objectValue(errorJson);
  return optionalString(error.error_message)
    ?? optionalString(error.agent_run_error_code)
    ?? optionalString(error.error_code)
    ?? optionalString(jobError)
    ?? optionalString(summary)
    ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function chunk(values: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}
