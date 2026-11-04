import { dateIso, type Queryable } from "../routeUtils/common.js";
import { threadReadableSql } from "./threadAccess.js";

type StepStatus = "in_progress" | "done" | "abandoned";

interface StepRow {
  id: string;
  space_id: string;
  project_id: string;
  thread_id: string;
  kind: string;
  status: string;
  slot: string;
  note: string | null;
  target_ref_kind: string | null;
  target_ref_id: string | null;
  iteration_id: string | null;
  round_number:number|null;
  origin: string;
  started_at: unknown;
  completed_at: unknown;
  created_at: unknown;
}

export function stepToOut(row: StepRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    thread_id: row.thread_id,
    kind: row.kind,
    status: row.status,
    slot: row.slot,
    note: row.note,
    target_ref_kind: row.target_ref_kind,
    target_ref_id: row.target_ref_id,
    iteration_id: row.iteration_id,
    round_number:row.round_number,
    origin: row.origin,
    started_at: dateIso(row.started_at),
    completed_at: dateIso(row.completed_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Ends the Thread's open steps. `reason` separates a step the user walked away
 * from (`abandoned`) from one that ran its course (`done`); only the latter is
 * part of a round's history.
 *
 * Background steps are left alone unless `includeBackground` is set: a search
 * does not stop because the user picked something else to do. That is what
 * the background slot is.
 *
 * Touches step rows only. The caller owns the projection write — see
 * The problem command owns its transaction.
 */
export async function closeOpenSteps(
  db: Queryable,
  input: {
    spaceId: string;
    threadId: string;
    reason: Exclude<StepStatus, "in_progress">;
    at: string;
    iterationId?: string | null;
    includeBackground?: boolean;
  },
): Promise<void> {
  await db.query(
    `UPDATE inquiry_thread_steps
        SET status = $1, completed_at = $2, iteration_id = COALESCE($3, iteration_id)
      WHERE thread_id = $4 AND space_id = $5 AND status = 'in_progress'
        AND ($6::boolean OR slot = 'primary')
        AND NOT(slot='background' AND EXISTS(SELECT 1 FROM project_operations op WHERE op.space_id=inquiry_thread_steps.space_id AND op.research_step_id=inquiry_thread_steps.id))`,
    [input.reason, input.at, input.iterationId ?? null, input.threadId, input.spaceId, input.includeBackground ?? false],
  );
}

export async function listOpenSteps(
  db: Queryable,
  input: { spaceId: string; threadId: string },
): Promise<StepRow[]> {
  const rows = await db.query<StepRow>(
    `SELECT * FROM inquiry_thread_steps
      WHERE thread_id = $1 AND space_id = $2 AND status = 'in_progress'
      ORDER BY created_at ASC, id ASC`,
    [input.threadId, input.spaceId],
  );
  return rows.rows;
}

/**
 * The Project's open steps with their Thread statements, newest first.
 *
 * This is what carries context across Areas: a user who followed a call to
 * action into Operations or Notes arrives with the step still open, so the
 * destination can say which Thread sent them and offer the way back. Do not
 * carry this in a URL parameter. It dies on refresh, on a second navigation,
 * and on another device, which is when a person has lost the thread.
 *
 * The row carries a Thread's statement, so Project membership is necessary but
 * not sufficient: the ontology root's visibility decides who sees it, exactly
 * as it does for every other Inquiry read.
 */
export async function listOpenProjectSteps(
  db: Queryable,
  input: { spaceId: string; projectId: string; userId: string },
): Promise<Array<StepRow & { statement: string }>> {
  const rows = await db.query<StepRow & { statement: string }>(
    `SELECT s.*, t.statement
       FROM inquiry_thread_steps s
       JOIN inquiry_threads t ON t.object_id = s.thread_id AND t.space_id = s.space_id
       JOIN space_objects so ON so.id = t.object_id AND so.space_id = t.space_id
      WHERE s.space_id = $1 AND s.project_id = $2 AND s.status = 'in_progress'
        AND t.lifecycle_status = 'active'
        AND ${threadReadableSql("so", "$3", "read_content")}
      ORDER BY s.created_at DESC, s.id DESC`,
    [input.spaceId, input.projectId, input.userId],
  );
  return rows.rows;
}

export async function listSteps(
  db: Queryable,
  input: { spaceId: string; projectId: string; threadId: string },
): Promise<StepRow[]> {
  const rows = await db.query<StepRow>(
    `SELECT s.* FROM inquiry_thread_steps s
      WHERE thread_id = $1 AND space_id = $2 AND project_id = $3
      ORDER BY created_at DESC, id DESC`,
    [input.threadId, input.spaceId, input.projectId],
  );
  return rows.rows;
}

