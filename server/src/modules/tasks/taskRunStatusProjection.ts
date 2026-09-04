import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { settleTasksForRun } from "../projectWork/settlement.js";

/**
 * Settles the Tasks a finished Run belongs to.
 *
 * This file used to reconcile a per-thread message queue as well: a terminal
 * Task had to lock every queue that might still hold an admission for it and
 * withdraw those messages, so a settled Task could not have a queued message
 * dispatch into a fresh Run behind the decision. A remote Task run is one Run
 * created at admission now, so there is no queued message to race and nothing
 * to withdraw.
 */
export async function projectTaskStatusFromRun(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<void> {
  await withQueryableTransaction(db, async (tx) => {
    const linked = await tx.query<{ task_id: string }>(
      `SELECT DISTINCT task_id
         FROM task_runs
        WHERE space_id = $1 AND run_id = $2`,
      [spaceId, runId],
    );
    if (linked.rows.length === 0) return;
    await settleTasksForRun(tx, spaceId, runId);
  });
}
