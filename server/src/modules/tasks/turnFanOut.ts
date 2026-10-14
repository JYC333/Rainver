import type { Queryable } from "../routeUtils/common.js";

/**
 * How many Tasks one turn may create: ADR 0017 §2's decomposition ceiling,
 * the same five `inquiry.create_thread` holds Threads to. It counts every
 * Task the turn creates — the ones its `task.create` calls write and the
 * follow-ups applied for it once it succeeds (`followUpTaskReconciler.ts`) —
 * so neither route is a way past the other. Refusing costs a turn: the Agent
 * is told to continue in the next, and a follow-up past it stays a card.
 */
export const TASK_FAN_OUT_PER_TURN = 5;

/**
 * The lock both routes hold while they count and write, so two writers of
 * one turn cannot each see room for the last Task. `task.create` takes it for
 * its transaction (`pg_advisory_xact_lock`), the follow-up reconciler for its
 * session (`withDedicatedSessionAdvisoryLock`); both hash with
 * `hashtextextended(key, 0)`.
 */
export function turnFanOutLockKey(runId: string): string {
  return `task-fan-out:${runId}`;
}

export async function lockTurnFanOutForTransaction(db: Queryable, runId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [turnFanOutLockKey(runId)]);
}

/**
 * Counted from the Tasks the turn created rather than a counter, so a retried
 * or resumed Run cannot spend the budget twice. A follow-up a person accepts
 * by hand counts too: it is still a Task the turn asked for.
 */
export async function countTasksCreatedInTurn(db: Queryable, spaceId: string, runId: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total
       FROM tasks
      WHERE space_id = $1 AND source_run_id = $2`,
    [spaceId, runId],
  );
  return Number(result.rows[0]?.total ?? 0);
}
