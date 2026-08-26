import { PgJobQueueRepository } from "../jobs/repository.js";
import type { Queryable } from "../routeUtils/common.js";
import { PgSourceAnnotationRepository, SOURCE_ANNOTATION_JOB_TYPE } from "./repository.js";

/**
 * How far back a scan may reach when queueing its items for annotation.
 *
 * Wide enough to cover a scan that ran long or a source republishing items with
 * older `first_seen_at`, narrow enough that the first scan after deployment
 * does not turn into an unbudgeted backfill of the instance's history.
 */
export const ANNOTATION_ENQUEUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Queues newly materialized items for annotation, best effort throughout.
 *
 * Neither write may fail the scan that called it. Capture is the valuable part
 * and it already succeeded; annotation is a derived convenience.
 *
 * Losing a call is recoverable rather than permanent, which is the second thing
 * the window buys: the next scan of the same source covers the same window
 * again, and `ON CONFLICT DO NOTHING` makes that overlap free. An item is only
 * lost for good if its source is never scanned again — at which point nothing
 * downstream was going to run anyway.
 */
export async function enqueueItemsForAnnotation(
  db: Queryable,
  input: {
    spaceId: string;
    sourceChannelId?: string | null;
    sourceConnectionId?: string | null;
    newItemCount: number;
  },
): Promise<void> {
  if (input.newItemCount < 1) return;
  const sourceChannelId = input.sourceChannelId ?? null;
  const sourceConnectionId = input.sourceConnectionId ?? null;
  if (!sourceChannelId && !sourceConnectionId) return;
  const since = new Date(Date.now() - ANNOTATION_ENQUEUE_WINDOW_MS).toISOString();
  let queued = 0;
  try {
    queued = await new PgSourceAnnotationRepository(db).enqueueRecentItems(
      input.spaceId,
      { sourceChannelId, sourceConnectionId },
      since,
    );
  } catch {
    // A scan that successfully captured material must not be failed because a
    // downstream convenience write did not land — and inside the caller's
    // transaction, an uncaught error here would abort the transaction and take
    // the completed extraction job down with it.
    return;
  }
  if (queued < 1) return;
  try {
    await new PgJobQueueRepository(db).enqueue({
      job_type: SOURCE_ANNOTATION_JOB_TYPE,
      payload: { source_channel_id: sourceChannelId, queued_item_count: queued },
      space_id: input.spaceId,
      user_id: null,
    });
  } catch {
    // Pending rows remain; the annotation sweep drains them on its next tick.
  }
}
