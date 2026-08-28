import { randomUUID } from "node:crypto";
import { stageTransitionKind, type WorkLoopStageKey } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { appendProjectWorkEvent } from "./eventWriter.js";

/**
 * The Loop stage fold.
 *
 * `task_loop_states` is a projection of `project_work_events`, so every change
 * here goes through an event first and the row records which event produced
 * it. That ordering is what makes "where is this Task now" answerable twice —
 * from the row for speed, and from the stream when the row is doubted.
 */

export interface TaskLoopStateRow {
  task_id: string;
  space_id: string;
  project_id: string;
  loop_instance_id: string;
  current_stage_key: WorkLoopStageKey;
  stage_entered_at: string;
  last_event_id: string | null;
  revision: number;
}

export async function currentLoopState(
  db: Queryable,
  spaceId: string,
  taskId: string,
): Promise<TaskLoopStateRow | null> {
  const result = await db.query<TaskLoopStateRow>(
    `SELECT task_id, space_id, project_id, loop_instance_id, current_stage_key,
            stage_entered_at, last_event_id, revision
       FROM task_loop_states
      WHERE space_id = $1 AND task_id = $2`,
    [spaceId, taskId],
  );
  return result.rows[0] ?? null;
}

export interface StageChangeInput {
  spaceId: string;
  projectId: string;
  taskId: string;
  toStage: WorkLoopStageKey;
  actorId: string;
  /** Why the stage moved, in the event payload rather than as free text. */
  reason: string;
  causationId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Move a Task to a stage, recording the move.
 *
 * A move to the stage it is already in is not written. Re-entering the same
 * stage is a real thing (`reopen`), but it has to be asked for explicitly by a
 * caller that means it — otherwise every settlement of an already-verified
 * Task would append another identical transition and the history would stop
 * being readable.
 */
export async function recordStageChange(
  db: Queryable,
  input: StageChangeInput,
): Promise<TaskLoopStateRow | null> {
  const existing = await currentLoopState(db, input.spaceId, input.taskId);
  if (existing && existing.current_stage_key === input.toStage) return existing;

  const fromStage = existing?.current_stage_key ?? null;
  const loopInstanceId = existing?.loop_instance_id ?? randomUUID();
  const now = new Date().toISOString();

  const event = await appendProjectWorkEvent(db, {
    spaceId: input.spaceId,
    projectId: input.projectId,
    eventKind: "task.stage_changed",
    subjectType: "task",
    subjectId: input.taskId,
    actorId: input.actorId,
    occurredAt: now,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    data: {
      ...(input.data ?? {}),
      loop_instance_id: loopInstanceId,
      from_stage: fromStage,
      to_stage: input.toStage,
      transition_kind: stageTransitionKind(fromStage, input.toStage),
      reason: input.reason,
    },
  });
  if (!event.inserted) return existing;

  const updated = await db.query<TaskLoopStateRow>(
    `INSERT INTO task_loop_states (
       task_id, space_id, project_id, loop_instance_id, current_stage_key,
       stage_entered_at, last_event_id, revision, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $6)
     ON CONFLICT (task_id) DO UPDATE
        SET current_stage_key = EXCLUDED.current_stage_key,
            stage_entered_at = EXCLUDED.stage_entered_at,
            last_event_id = EXCLUDED.last_event_id,
            project_id = EXCLUDED.project_id,
            revision = task_loop_states.revision + 1,
            updated_at = EXCLUDED.updated_at
     RETURNING task_id, space_id, project_id, loop_instance_id, current_stage_key,
               stage_entered_at, last_event_id, revision`,
    [input.taskId, input.spaceId, input.projectId, loopInstanceId, input.toStage, now, event.id],
  );
  return updated.rows[0] ?? null;
}
