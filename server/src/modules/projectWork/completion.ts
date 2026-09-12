import type { Queryable } from "../routeUtils/common.js";
import { runReadSql } from "../access/contentAccessSql.js";
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
  /**
   * Whose view the gate is computed in. Required: an optional viewer meant a
   * caller that forgot it judged the Task against the whole ledger, so a close
   * that succeeded — or a `missing` list that came back shorter — told the
   * person that an evaluation or an output they cannot see exists. The system
   * settlement worker, which genuinely must judge the Task's real state, says
   * so by name (`missingRequiredOutputsForSettlement`).
   */
  viewerUserId: string,
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
             AND ${runReadSql("$3")}
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT 1
        )
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1`,
    [spaceId, taskId, viewerUserId],
  );
  const row = evaluation.rows[0];
  const missing = await missingRequiredOutputs(
    db,
    spaceId,
    taskId,
    declaredRequiredOutputs(requiredOutputsJson),
    viewerUserId,
  );
  return completionFrom(row?.recommendation ?? null, row !== undefined, missing);
}
