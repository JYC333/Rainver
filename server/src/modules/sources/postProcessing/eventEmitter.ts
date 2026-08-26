import { PgJobQueueRepository } from "../../jobs/repository.js";
import type { Queryable } from "../../routeUtils/common.js";
import { PgSourcePostProcessingRepository, SOURCE_POST_PROCESSING_EVENT_JOB_TYPE } from "./repository.js";

/**
 * Best-effort source post-processing signal after source materializes new
 * items. A failed enqueue must not fail the scan that produced the items.
 */
export async function emitSourcePostProcessingEvent(
  db: Queryable,
  input: { spaceId: string; sourceChannelId?: string | null; sourceConnectionId?: string | null; newItemCount: number },
): Promise<void> {
  const sourceChannelId = input.sourceChannelId ?? input.sourceConnectionId ?? null;
  if (!sourceChannelId || input.newItemCount < 1) return;
  try {
    await new PgJobQueueRepository(db).enqueue({
      job_type: SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
      payload: {
        source_channel_id: sourceChannelId,
        new_item_count: input.newItemCount,
        trigger_type: "items_materialized",
      },
      space_id: input.spaceId,
      user_id: null,
    });
  } catch {
    // Scheduled post-processing rules keep their own cursor and can recover on
    // their next sweep.
  }
}

export async function emitSourcePostProcessingDeepAnalysisEvent(
  db: Queryable,
  input: {
    spaceId: string;
    sourceChannelId?: string | null;
    sourceConnectionId?: string | null;
    sourceItemId: string | null;
    metadata: Record<string, unknown> | null;
  },
): Promise<void> {
  const sourceChannelId = input.sourceChannelId ?? input.sourceConnectionId ?? null;
  if (!sourceChannelId || !input.sourceItemId) return;
  const metadata = input.metadata ?? {};
  const followups = sourcePostProcessingFollowups(metadata);
  if (!followups.length) return;
  const queuedBySourceRun = new Map<string, string[]>();
  try {
    const jobs = new PgJobQueueRepository(db);
    const seen = new Set<string>();
    for (const followup of followups) {
      const ruleId = stringValue(followup.source_post_processing_rule_id);
      if (!ruleId) continue;
      const sourceRunId = stringValue(followup.source_post_processing_run_id);
      const key = `${ruleId}:${sourceRunId ?? ""}:${input.sourceItemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const job = await jobs.enqueue({
        job_type: SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
        payload: {
          phase: "deep_analysis",
          trigger_type: "manual",
          source_channel_id: sourceChannelId,
          rule_id: ruleId,
          source_item_ids: [input.sourceItemId],
          source_post_processing_run_id: sourceRunId,
        },
        space_id: input.spaceId,
        user_id: stringValue(followup.triggered_by_user_id),
      });
      if (sourceRunId) {
        const current = queuedBySourceRun.get(sourceRunId) ?? [];
        current.push(job.id);
        queuedBySourceRun.set(sourceRunId, current);
      }
    }
    const repo = new PgSourcePostProcessingRepository(db);
    for (const [sourceRunId, jobIds] of queuedBySourceRun) {
      await repo.appendRunOutputJobIds(input.spaceId, sourceRunId, jobIds);
    }
  } catch {
    // The review surface can re-run deep analysis manually; extraction success
    // must not be rolled back because the follow-up signal failed.
  }
}

function sourcePostProcessingFollowups(metadata: Record<string, unknown>): Record<string, unknown>[] {
  const value = metadata.source_post_processing_followups;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item) && item.phase === "deep_analysis"));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
