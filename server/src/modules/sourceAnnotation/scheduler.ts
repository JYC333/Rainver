import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { PgJobQueueRepository } from "../jobs/repository.js";
import { PgSourceAnnotationRepository, SOURCE_ANNOTATION_JOB_TYPE } from "./repository.js";
import { SourceAnnotationService } from "./service.js";

/**
 * The annotation sweep: recovery first, then work.
 *
 * Scans enqueue their own job, so this is not the normal path — it is the
 * recovery one, and it covers what the scan path structurally cannot:
 *
 * - rows waiting on a condition (no annotator Provider, egress refused, consent
 *   missing) get the condition re-checked without a model call, and reopen
 *   when it holds; nothing is charged while it does not;
 * - a retry scheduled by the bounded backoff (`retryPolicy.ts`) becomes
 *   runnable at its `next_retry_at`, and only then is a job queued for it;
 * - the scan's best-effort job enqueue was lost, leaving runnable rows with no
 *   worker.
 *
 * Enqueueing for a space that already has a job running is harmless: the
 * handler runs one pass per space at a time and returns `no_work` when there
 * is nothing runnable.
 */
export async function enqueuePendingSourceAnnotationWork(
  config: ServerConfig,
  queue: PgJobQueueRepository,
  limit = 25,
): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const repo = new PgSourceAnnotationRepository(db);
  const service = new SourceAnnotationService(db, config);
  for (const spaceId of await repo.spacesWithWaitingConditions(limit)) {
    try {
      await service.recoverWaiting(spaceId);
    } catch {
      // The rows keep waiting; the next sweep checks again.
    }
  }
  const spaceIds = await repo.spacesWithPendingWork(limit);
  let enqueued = 0;
  for (const spaceId of spaceIds) {
    try {
      await queue.enqueue({
        job_type: SOURCE_ANNOTATION_JOB_TYPE,
        space_id: spaceId,
        user_id: null,
        payload: { trigger: "sweep" },
      });
      enqueued += 1;
    } catch {
      // The rows stay pending; the next sweep tries again.
    }
  }
  return enqueued;
}
