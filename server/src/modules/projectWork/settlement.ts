import type { RunSettlementReason, WorkLoopStageKey } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { resolveServiceActorId } from "../../db/actorResolver.js";
import { appendProjectWorkEvent } from "./eventWriter.js";
import { recordStageChange } from "./loopState.js";

/**
 * What a finished Run means for the Task it was run for.
 *
 * The rule this replaces was `bool_and(terminal) AND NOT bool_or(failure)` over
 * **every Run the Task ever had**, which had two defects that pulled in
 * opposite directions:
 *
 * - `bool_or` never expired. One failed Run poisoned the Task permanently: any
 *   number of later successful re-runs still saw a historical failure and the
 *   Task could never reach `done` again.
 * - Three of the four statuses it counted as failure are not failures.
 *   `cancelled` is a person changing their mind, `degraded` publishes real
 *   output with a warning, and `orphaned` is a crash the Supervisor is already
 *   recovering from.
 *
 * And the status it should have counted, it could not see at all:
 * `waiting_for_review` is what the Supervisor writes when it stops retrying,
 * and it was absent from the terminal set, so a Run parked for a human decision
 * left its Task sitting in `in_progress` indefinitely with nothing anywhere
 * saying a person was needed.
 *
 * The replacement reads the **latest** Run rather than the whole history, and
 * dispatches on what that Run actually was.
 *
 * Two more things the first version of this file got wrong, found in review:
 *
 * - It ran at the terminal status write, which is **before** finalization —
 *   and finalization is what writes the evaluation and lets the Supervisor
 *   decide retry-or-hold. Settling then meant every successful Run held its
 *   Task as `evaluation_missing`, and a failed Run held it while the
 *   Supervisor was about to retry. So a settled Run must carry a
 *   `run_finalizations` row before it counts, except `cancelled` (a person's
 *   decision, nothing to evaluate), and the finalization reconciler is the
 *   trigger that re-runs settlement once that row exists.
 * - It counted every `task_runs` row. A `planning` Run (Ask Agent to plan) and
 *   a `review` Run do not advance the work, and a successful plan closing its
 *   Task as done is precisely the wrong answer.
 */

/** `task_runs.role` values that do not advance the Task's own work. */
const NON_EXECUTION_TASK_RUN_ROLES = ["planning", "review"] as const;

/** Statuses that mean this Run is no longer advancing on its own. */
export const SETTLED_RUN_STATUSES = [
  "succeeded",
  "degraded",
  "failed",
  "cancelled",
  "waiting_for_review",
] as const;

/**
 * `orphaned` is deliberately absent. Crash recovery terminalises the orphaned
 * attempt and the Supervisor creates the next one, so the Run is still moving
 * and settling on it would be settling mid-recovery.
 */

interface LatestRunRow {
  task_id: string;
  project_id: string | null;
  task_status: string;
  required_outputs_json: unknown;
  run_id: string;
  run_status: string;
  evaluation_id: string | null;
  recommendation: string | null;
}

export interface Outcome {
  flow: "done" | "waiting_for_review";
  reason: RunSettlementReason;
  /**
   * Null leaves the stage alone. A Run that produced no result has nothing to
   * verify, so failure and cancellation do not move a Task's Loop stage — only
   * a person or an agent deciding what to do next can.
   */
  stage: WorkLoopStageKey | null;
  missingOutputs: string[];
}

/** Declared required outputs, normalised to comparable artifact type tokens. */
export function declaredRequiredOutputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tokens: string[] = [];
  for (const entry of value) {
    const raw = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? String(
            (entry as Record<string, unknown>).artifact_type
              ?? (entry as Record<string, unknown>).type
              ?? (entry as Record<string, unknown>).name
              ?? "",
          )
        : "";
    const token = raw.trim().toLowerCase();
    if (token) tokens.push(token);
  }
  return [...new Set(tokens)];
}

/**
 * Declared outputs with nothing attached, as `required_output:<token>` reasons.
 *
 * Shared with the Board and the flow-change gate so "why can this not close"
 * has one answer wherever it is asked.
 */
export async function missingRequiredOutputs(
  db: Queryable,
  spaceId: string,
  taskId: string,
  declared: readonly string[],
): Promise<string[]> {
  if (declared.length === 0) return [];
  const present = await db.query<{ artifact_type: string }>(
    `SELECT DISTINCT lower(a.artifact_type) AS artifact_type
       FROM task_artifacts ta
       JOIN artifacts a ON a.id = ta.artifact_id AND a.space_id = ta.space_id
      WHERE ta.space_id = $1 AND ta.task_id = $2 AND ta.role = 'output'`,
    [spaceId, taskId],
  );
  const have = new Set(present.rows.map((row) => row.artifact_type));
  return declared.filter((token) => !have.has(token));
}

/**
 * The settlement decision table, kept pure so every branch is testable
 * without staging a Run.
 */
export function outcomeForRun(
  runStatus: string,
  recommendation: string | null,
  hasEvaluation: boolean,
  missingOutputs: readonly string[],
): Outcome {
  if (runStatus === "failed") {
    return { flow: "waiting_for_review", reason: "run_failed", stage: null, missingOutputs: [] };
  }
  if (runStatus === "cancelled") {
    return { flow: "waiting_for_review", reason: "run_cancelled", stage: null, missingOutputs: [] };
  }
  if (runStatus === "waiting_for_review") {
    return { flow: "waiting_for_review", reason: "supervisor_review", stage: null, missingOutputs: [] };
  }

  // succeeded or degraded: there is a result, so the Task is being judged.
  if (!hasEvaluation) {
    return {
      flow: "waiting_for_review",
      reason: "evaluation_missing",
      stage: "verify",
      missingOutputs: [],
    };
  }
  if (recommendation !== "accept") {
    return {
      flow: "waiting_for_review",
      reason: "evaluation_not_accepted",
      stage: "verify",
      missingOutputs: [],
    };
  }
  if (missingOutputs.length > 0) {
    return {
      flow: "waiting_for_review",
      reason: "required_outputs_missing",
      stage: "verify",
      missingOutputs: [...missingOutputs],
    };
  }
  return { flow: "done", reason: "accepted", stage: "conclude", missingOutputs: [] };
}

/**
 * Settle every Task linked to this Run, if nothing else is still running for
 * them.
 *
 * Runs inside the caller's transaction. A terminal transition cannot race a
 * new Run in behind the decision, because this writes the Task row and the
 * dispatch admission takes `SELECT … FOR UPDATE` on that same row — under
 * READ COMMITTED the two serialize. (It used to say the caller held a
 * host-thread queue lock; that queue is gone, and the invariant now rests on
 * the Task row alone.)
 */
export async function settleTasksForRun(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<readonly string[]> {
  const candidates = await db.query<LatestRunRow>(
    `WITH linked AS (
       SELECT DISTINCT tr.task_id
         FROM task_runs tr
        WHERE tr.space_id = $1 AND tr.run_id = $2
          AND tr.role <> ALL ($4::text[])
     ), settleable AS (
       -- Every execution Run of the Task has stopped advancing. A Run still
       -- queued, running, or recovering from a crash means the Task is not
       -- finished being worked on, whatever this particular Run did.
       SELECT l.task_id
         FROM linked l
        WHERE NOT EXISTS (
          SELECT 1
            FROM task_runs tr
            JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
           WHERE tr.task_id = l.task_id AND tr.space_id = $1
             AND tr.role <> ALL ($4::text[])
             AND r.status <> ALL ($3::text[])
        )
     ), latest AS (
       SELECT DISTINCT ON (tr.task_id)
              tr.task_id, r.id AS run_id, r.status AS run_status, r.created_at AS run_created_at
         FROM settleable s
         JOIN task_runs tr ON tr.task_id = s.task_id AND tr.space_id = $1
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
        WHERE tr.role <> ALL ($4::text[])
        ORDER BY tr.task_id, r.created_at DESC, r.id DESC
     ), decided AS (
       -- The latest Run has been finalized: its evaluation exists and the
       -- Supervisor has had its say. A policy pause is also
       -- waiting_for_review but is not finalized, and correctly stays out:
       -- the same attempt resumes after approval, so the work is still moving.
       SELECT latest.*
         FROM latest
        WHERE latest.run_status = 'cancelled'
           OR EXISTS (
             SELECT 1 FROM run_finalizations f
              WHERE f.space_id = $1 AND f.run_id = latest.run_id
           )
     )
     SELECT t.id AS task_id,
            t.project_id,
            t.status AS task_status,
            t.required_outputs_json,
            latest.run_id,
            latest.run_status,
            ev.id AS evaluation_id,
            ev.recommendation
       FROM decided AS latest
       JOIN tasks t ON t.id = latest.task_id AND t.space_id = $1
       LEFT JOIN LATERAL (
         SELECT e.id, e.recommendation
           FROM task_evaluations e
          WHERE e.space_id = $1 AND e.task_id = latest.task_id
            AND e.run_id = latest.run_id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ) ev ON true
      WHERE t.deleted_at IS NULL
        -- blocked is a person's deliberate hold and is never written by a
        -- Run; it is not erased by one either.
        AND t.status NOT IN ('done', 'cancelled', 'blocked')
        -- A Task parked on a decision stays parked for the Run that was in
        -- flight when it was parked: an Agent that handed a decision back
        -- must not watch settlement close the Task under it. A Run started
        -- *after* the hold is the person's answer, and its result counts —
        -- otherwise a retry from waiting_for_review is discarded and the Task
        -- waits forever. The guard is causal, not by status.
        -- A Task outside a Project has no stream to anchor that on, so for it
        -- the hold stays a hold, as it always did.
        AND (t.status <> 'waiting_for_review'
             OR (t.project_id IS NOT NULL AND latest.run_created_at > COALESCE((
               SELECT max(e.occurred_at)
                 FROM project_work_events e
                WHERE e.space_id = $1 AND e.subject_type = 'task' AND e.subject_id = t.id
                  AND e.event_kind = 'task.flow_changed'
                  AND e.data_json->>'to' = 'waiting_for_review'
             ), '-infinity'::timestamptz)))`,
    [spaceId, runId, SETTLED_RUN_STATUSES, NON_EXECUTION_TASK_RUN_ROLES],
  );

  if (candidates.rows.length === 0) return [];
  const actorId = await resolveServiceActorId(db, spaceId, "project_work_settlement");
  const settled: string[] = [];

  for (const row of candidates.rows) {
    const declared = declaredRequiredOutputs(row.required_outputs_json);
    const missing = await missingRequiredOutputs(db, spaceId, row.task_id, declared);
    const outcome = outcomeForRun(
      row.run_status,
      row.recommendation,
      row.evaluation_id !== null,
      missing,
    );

    const settlementEvent = row.project_id
      ? await appendProjectWorkEvent(db, {
          spaceId,
          projectId: row.project_id,
          eventKind: "task.run_settled",
          subjectType: "task",
          subjectId: row.task_id,
          actorId,
          correlationId: row.run_id,
          // The same Run can settle the same Task more than once with different
          // facts — held for a missing output, then closed once it is attached.
          // A key without the outcome would swallow the second settlement and
          // leave the status changed with no event saying so.
          idempotencyKey: `task.run_settled:${row.task_id}:${row.run_id}:${outcome.reason}`,
          data: {
            run_id: row.run_id,
            run_status: row.run_status,
            from_flow: row.task_status,
            to_flow: outcome.flow,
            reason: outcome.reason,
            task_evaluation_id: row.evaluation_id,
            missing_required_outputs: outcome.missingOutputs,
          },
        })
      : null;

    const updated = await db.query<{ id: string }>(
      `UPDATE tasks
          SET status = $3::varchar,
              completed_at = CASE WHEN $3::varchar = 'done' THEN COALESCE(completed_at, now()) ELSE completed_at END,
              updated_at = now()
        WHERE id = $2 AND space_id = $1
          AND status NOT IN ('done', 'cancelled')
        RETURNING id`,
      [spaceId, row.task_id, outcome.flow],
    );
    if (updated.rows.length === 0) continue;
    settled.push(row.task_id);

    if (!row.project_id) continue;

    if (outcome.flow === "done") {
      // Acceptance is its own durable fact, separate from the evaluation that
      // recommended it: an evaluation is an opinion about a result, acceptance
      // is the decision to stop. Recording only the first loses who decided,
      // and recording only the second loses what they decided on.
      await appendProjectWorkEvent(db, {
        spaceId,
        projectId: row.project_id,
        eventKind: "task.accepted",
        subjectType: "task",
        subjectId: row.task_id,
        actorId,
        correlationId: row.run_id,
        causationId: settlementEvent?.id ?? null,
        idempotencyKey: `task.accepted:${row.task_id}:${row.run_id}`,
        data: {
          decided_by: "automatic",
          basis: "evaluation_accepted_and_required_outputs_present",
          task_evaluation_id: row.evaluation_id,
          run_id: row.run_id,
          required_outputs: declared,
        },
      });
    }

    if (outcome.stage) {
      await recordStageChange(db, {
        spaceId,
        projectId: row.project_id,
        taskId: row.task_id,
        toStage: outcome.stage,
        actorId,
        reason: outcome.reason,
        correlationId: row.run_id,
        causationId: settlementEvent?.id ?? null,
        idempotencyKey: `task.stage_changed:${row.task_id}:${row.run_id}:${outcome.stage}`,
        data: { run_id: row.run_id },
      });
    }
  }

  return settled;
}
