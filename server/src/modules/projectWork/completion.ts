import type { Queryable } from "../routeUtils/common.js";
import { declaredRequiredOutputs, missingRequiredOutputs } from "./settlement.js";

/**
 * Whether a Task has met what it declared, and what is missing if not.
 *
 * The same question settlement asks automatically, asked on demand — so a card
 * can show "why can this not close" before anyone tries, and the flow-change
 * gate can refuse a manual close with the identical reasons. Two independent
 * implementations of "is it done" would let the Board promise something the
 * write path then denies.
 */

export interface TaskCompletionState {
  ok: boolean;
  missing: string[];
}

export function completionFrom(
  recommendation: string | null,
  hasEvaluation: boolean,
  missingOutputs: readonly string[],
): TaskCompletionState {
  const missing: string[] = [];
  if (!hasEvaluation || recommendation !== "accept") missing.push("evaluation");
  for (const token of missingOutputs) missing.push(`required_output:${token}`);
  return { ok: missing.length === 0, missing };
}

/**
 * Reads the evaluation of the Task's latest **execution** Run. A planning Run's
 * evaluation says the plan was good, which is not a claim about the work.
 */
export async function taskCompletionState(
  db: Queryable,
  spaceId: string,
  taskId: string,
  requiredOutputsJson: unknown,
): Promise<TaskCompletionState> {
  const evaluation = await db.query<{ recommendation: string | null }>(
    `SELECT e.recommendation
       FROM task_evaluations e
      WHERE e.space_id = $1 AND e.task_id = $2
        AND e.run_id = (
          SELECT tr.run_id
            FROM task_runs tr
            JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
           WHERE tr.task_id = $2 AND tr.space_id = $1
             AND tr.role NOT IN ('planning', 'review')
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT 1
        )
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1`,
    [spaceId, taskId],
  );
  const row = evaluation.rows[0];
  const missing = await missingRequiredOutputs(
    db,
    spaceId,
    taskId,
    declaredRequiredOutputs(requiredOutputsJson),
  );
  return completionFrom(row?.recommendation ?? null, row !== undefined, missing);
}
