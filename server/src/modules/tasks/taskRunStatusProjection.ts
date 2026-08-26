import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";

const HOST_THREAD_QUEUE_LOCK_PREFIX = "host_thread_queue:";

/**
 * Lock every queue that can contain a still-queued admission for these Tasks.
 * Queue advancement and explicit withdrawal use the same advisory-lock
 * namespace, so a terminal Task transition cannot race a message into a Run.
 * Callers that already hold a transaction keep the lock until their own
 * mutation commits; callers with a Pool are wrapped by the public projector.
 */
export async function lockTaskQueueForTerminalMutation(
  db: Queryable,
  spaceId: string,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  const threads = await db.query<{ thread_id: string }>(
    `SELECT DISTINCT m.host_task_thread_id AS thread_id
       FROM host_thread_messages m
       JOIN host_task_threads t ON t.id = m.host_task_thread_id
       JOIN workspace_locations wl ON wl.id = t.workspace_location_id
       JOIN project_folders pf ON pf.id = wl.project_folder_id
      WHERE m.task_id = ANY($2::varchar[])
        AND pf.space_id = $1
        AND m.status = 'queued'`,
    [spaceId, taskIds],
  );
  for (const threadId of threads.rows.map((row) => row.thread_id).sort()) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${HOST_THREAD_QUEUE_LOCK_PREFIX}${threadId}`]);
  }
}

export async function withdrawQueuedTaskMessages(
  db: Queryable,
  spaceId: string,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await db.query(
    `UPDATE host_thread_messages m
        SET status = 'withdrawn', updated_at = now()
       FROM host_task_threads t
       JOIN workspace_locations wl ON wl.id = t.workspace_location_id
       JOIN project_folders pf ON pf.id = wl.project_folder_id
      WHERE m.host_task_thread_id = t.id
        AND m.task_id = ANY($2::varchar[])
        AND pf.space_id = $1
        AND m.status = 'queued'`,
    [spaceId, taskIds],
  );
}

/** Reconciles queued admissions after a direct terminal Task mutation. */
export async function reconcileTerminalTaskQueue(
  db: Queryable,
  spaceId: string,
  taskIds: readonly string[],
): Promise<void> {
  await lockTaskQueueForTerminalMutation(db, spaceId, taskIds);
  await withdrawQueuedTaskMessages(db, spaceId, taskIds);
}

/**
 * The single Run-terminal -> Task-status projection used by both the local
 * server executor and remote-host queue runs. It settles only after every Run
 * linked to the Task is hard-terminal, so a retry or a parallel child cannot
 * prematurely mark the Task done.
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
    const taskIds = linked.rows.map((row) => row.task_id);
    await lockTaskQueueForTerminalMutation(tx, spaceId, taskIds);

    const projected = await tx.query<{ task_id: string; status: string }>(
    `WITH linked_tasks AS (
       SELECT DISTINCT task_id, space_id
         FROM task_runs
        WHERE space_id = $1 AND run_id = $2
     ), task_state AS (
       SELECT linked.task_id,
              linked.space_id,
              bool_and(r.status IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')) AS all_terminal,
              bool_or(r.status IN ('failed', 'degraded', 'cancelled', 'orphaned')) AS has_failure
         FROM linked_tasks linked
         JOIN task_runs tr ON tr.task_id = linked.task_id AND tr.space_id = linked.space_id
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        GROUP BY linked.task_id, linked.space_id
     )
     UPDATE tasks t
        SET status = CASE WHEN s.has_failure THEN 'blocked' ELSE 'done' END,
            completed_at = CASE WHEN s.has_failure THEN NULL ELSE COALESCE(t.completed_at, now()) END,
            cancelled_at = CASE WHEN s.has_failure AND EXISTS (
              SELECT 1 FROM task_runs tr2 JOIN runs r2 ON r2.id = tr2.run_id AND r2.space_id = tr2.space_id
               WHERE tr2.task_id = s.task_id AND tr2.space_id = s.space_id AND r2.status = 'cancelled'
            ) THEN COALESCE(t.cancelled_at, now()) ELSE t.cancelled_at END,
            blocked_reason = CASE WHEN s.has_failure THEN COALESCE(t.blocked_reason, 'A linked Run ended unsuccessfully') ELSE NULL END,
            updated_at = now()
       FROM task_state s
      WHERE t.id = s.task_id
        AND t.space_id = s.space_id
        AND s.all_terminal
        AND t.status NOT IN ('done', 'cancelled')
      RETURNING t.id AS task_id, t.status`,
      [spaceId, runId],
    );
    const terminalTaskIds = projected.rows
      .filter((row) => row.status === "done" || row.status === "blocked" || row.status === "cancelled")
      .map((row) => row.task_id);
    await withdrawQueuedTaskMessages(tx, spaceId, terminalTaskIds);
  });
}

/**
 * A remote admission marks its Task `in_progress` before the queued message
 * necessarily becomes a Run. If that message is withdrawn, settle the
 * no-longer-running Task back to `ready` once there is no other queued,
 * dispatched, or active Run work for it. This runs in the same transaction as
 * the withdrawal and under the thread queue lock, so queue advancement cannot
 * dispatch the message between the two decisions.
 */
export async function settleTaskAfterQueuedMessageWithdrawal(
  db: Queryable,
  spaceId: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  await db.query(
    `WITH withdrawn AS (
       SELECT task_id
         FROM host_thread_messages
        WHERE id = $2 AND host_task_thread_id = $3 AND status = 'withdrawn'
     ), active_work AS (
       SELECT 1
         FROM host_thread_messages m
        WHERE m.task_id = (SELECT task_id FROM withdrawn)
          AND (
            m.status = 'queued'
            OR (
              m.status = 'dispatched'
              AND EXISTS (
                SELECT 1 FROM runs r
                 WHERE r.id = m.run_id
                   AND r.space_id = $1
                   AND r.status NOT IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
              )
            )
          )
       UNION ALL
       SELECT 1
         FROM task_runs tr
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        WHERE tr.space_id = $1
          AND tr.task_id = (SELECT task_id FROM withdrawn)
          AND r.status NOT IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
     )
     UPDATE tasks t
        SET status = 'ready', completed_at = NULL, cancelled_at = NULL,
            blocked_reason = NULL, updated_at = now()
       FROM withdrawn w
      WHERE t.id = w.task_id
        AND t.space_id = $1
        AND t.status = 'in_progress'
        AND NOT EXISTS (SELECT 1 FROM active_work)`,
    [spaceId, messageId, threadId],
  );
}
