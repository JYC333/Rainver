import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { PgJobQueueRepository } from "../jobs/repository.js";
import { PgSourceAnnotationRepository, SOURCE_ANNOTATION_JOB_TYPE } from "./repository.js";

/**
 * Queues annotation work for spaces that have pending rows nobody is coming
 * back for.
 *
 * Scans enqueue their own job, so this is not the normal path — it is the
 * recovery one, and it covers the two cases the scan path structurally cannot:
 *
 * - the scan's best-effort job enqueue was lost, leaving rows with no worker.
 * - a batch was blocked on something outside the items, most often a space with
 *   no model provider configured yet. Those rows keep their retry budget and
 *   wait, and without a sweep they would wait until the next scan of the same
 *   source — which can be a day away from the moment the user finished setting
 *   up and expected to see the feature work.
 *
 * Enqueueing for a space that already has a job pending is harmless: the
 * handler drains whatever is pending and returns `no_work` when there is none.
 */
export async function enqueuePendingSourceAnnotationWork(
  config: ServerConfig,
  queue: PgJobQueueRepository,
  limit = 25,
): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const spaceIds = await new PgSourceAnnotationRepository(db).spacesWithPendingWork(limit);
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
