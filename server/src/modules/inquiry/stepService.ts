import { randomUUID } from "node:crypto";
import { dateIso, type Queryable } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { type NextFocusKind } from "./threadService.js";

/**
 * Steps: the durable record of what a Thread is actually doing.
 *
 * `inquiry_threads.next_focus_kind` remains as a projection of the current
 * primary step, so the Thread read shape is unchanged and the contradiction
 * CHECK against `blocked_reason` stays enforceable without a cross-table
 * reference. The step row is the authority; both are written in one
 * transaction, so the two can never disagree.
 *
 * This module owns no authorization and opens no transaction: callers are
 * already inside the work-state or Iteration command, which is what keeps a
 * single write authority over `next_focus_kind` (ADR 0012).
 */

/**
 * Actions with a system operation behind them. Once started they keep running
 * without the user, so they move out of the single primary slot and let the
 * next action take it — which is why "wait for monitoring" is no longer a step
 * a user can choose. It was never an action; it was this state.
 */
const BACKGROUND_STEP_KINDS: readonly NextFocusKind[] = ["search_acquisition", "design_run_experiment"];

export type StepSlot = "primary" | "background";
export type StepStatus = "in_progress" | "done" | "abandoned";
export type StepOrigin = "user" | "advice" | "system";

function slotForKind(kind: NextFocusKind): StepSlot {
  return BACKGROUND_STEP_KINDS.includes(kind) ? "background" : "primary";
}

export interface StepRow {
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
    origin: row.origin,
    started_at: dateIso(row.started_at),
    completed_at: dateIso(row.completed_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * The projection, expressed as correlated scalar subqueries so it can be
 * dropped into any `UPDATE inquiry_threads` without consuming a parameter
 * slot.
 *
 * It has to be composable rather than a separate statement because the
 * contradiction CHECK runs per statement: writing `blocked_reason` in one
 * statement and clearing the step projection in the next passes through a
 * moment where the Thread holds both, and PostgreSQL rejects it there. Callers
 * that touch other Thread columns must therefore fold this in, not follow up
 * with it. The single-primary-step unique index is what keeps `max(kind)`
 * unambiguous.
 */
export const STEP_PRIMARY_KIND_SQL =
  `(SELECT max(s.kind) FROM inquiry_thread_steps s
      WHERE s.thread_id = inquiry_threads.object_id AND s.space_id = inquiry_threads.space_id
        AND s.slot = 'primary' AND s.status = 'in_progress')`;

/** Assignment for the projection column. */
export const STEP_PROJECTION_SET_SQL = `next_focus_kind = ${STEP_PRIMARY_KIND_SQL}`;

/**
 * The Thread's note column is a projection of the primary step's note, the same
 * way `next_focus_kind` projects its kind. A note describes the step it was
 * written for, so it appears and disappears with that step rather than
 * outliving it and attaching stale wording to whatever comes next. The note
 * itself is written on the step, never here.
 */
export const STEP_PRIMARY_NOTE_SQL =
  `(SELECT max(s.note) FROM inquiry_thread_steps s
      WHERE s.thread_id = inquiry_threads.object_id AND s.space_id = inquiry_threads.space_id
        AND s.slot = 'primary' AND s.status = 'in_progress')`;

/** The note assignment, projected from the primary step that owns it. */
export const STEP_NOTE_SET_SQL = `next_focus_note = ${STEP_PRIMARY_NOTE_SQL}`;

/**
 * Stamps every finished-but-unassigned step with the round that just closed.
 *
 * Without this, `iteration_id IS NULL` does not mean "this round": a background
 * step that ended earlier keeps a null pointer forever and every later round
 * inherits it, so a round-1 search would make round 5 believe its evidence
 * gathering was already done.
 */
export async function assignSettledStepsToRound(
  db: Queryable,
  input: { spaceId: string; threadId: string; iterationId: string },
): Promise<void> {
  await db.query(
    `UPDATE inquiry_thread_steps
        SET iteration_id = $1
      WHERE thread_id = $2 AND space_id = $3
        AND status <> 'in_progress' AND iteration_id IS NULL`,
    [input.iterationId, input.threadId, input.spaceId],
  );
}

/**
 * Ends the Thread's open steps. `reason` separates a step the user walked away
 * from (`abandoned`) from one that ran its course (`done`); only the latter is
 * part of a round's history.
 *
 * Background steps are left alone unless `includeBackground` is set: a search
 * does not stop because the user picked something else to do, which is the
 * whole point of the background slot.
 *
 * Touches step rows only. The caller owns the projection write — see
 * {@link STEP_PROJECTION_SET_SQL}.
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
        AND ($6::boolean OR slot = 'primary')`,
    [input.reason, input.at, input.iterationId ?? null, input.threadId, input.spaceId, input.includeBackground ?? false],
  );
}

/**
 * Starts a step. A primary step replaces whatever primary step was open —
 * choosing a different next action abandons the previous intent rather than
 * queueing beside it, which is what the single-primary unique index enforces.
 *
 * Re-declaring the kind that is already running is a no-op: repeating the
 * command must not restart the clock on work already under way, and for a
 * background kind it must not open a second search.
 *
 * Touches step rows only. The caller owns the projection write — see
 * {@link STEP_PROJECTION_SET_SQL}.
 */
async function startStep(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    threadId: string;
    kind: NextFocusKind;
    /** `undefined` leaves the note alone; `null` clears it. */
    note?: string | null;
    origin: StepOrigin;
    at: string;
  },
): Promise<StepRow | null> {
  const slot = slotForKind(input.kind);
  const existing = await db.query<StepRow>(
    `SELECT * FROM inquiry_thread_steps
      WHERE thread_id = $1 AND space_id = $2 AND status = 'in_progress' AND kind = $3
      LIMIT 1`,
    [input.threadId, input.spaceId, input.kind],
  );
  if (existing.rows[0]) {
    // Already running: keep the step and its clock. Only an explicitly supplied
    // note revises it — following the call to action again sends no note, and
    // must not wipe the one the user wrote when they started the step.
    if (input.note === undefined) return existing.rows[0];
    const updated = await db.query<StepRow>(
      `UPDATE inquiry_thread_steps SET note = $1 WHERE id = $2 RETURNING *`,
      [input.note, existing.rows[0].id],
    );
    return updated.rows[0] ?? existing.rows[0];
  }

  if (slot === "primary") {
    await db.query(
      `UPDATE inquiry_thread_steps
          SET status = 'abandoned', completed_at = $1
        WHERE thread_id = $2 AND space_id = $3 AND slot = 'primary' AND status = 'in_progress'`,
      [input.at, input.threadId, input.spaceId],
    );
  }

  const inserted = await db.query<StepRow>(
    `INSERT INTO inquiry_thread_steps (
       id, space_id, project_id, thread_id, kind, status, slot, note, origin, started_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, $8, $9, $9)
     RETURNING *`,
    [randomUUID(), input.spaceId, input.projectId, input.threadId, input.kind, slot, input.note ?? null, input.origin, input.at],
  );
  return inserted.rows[0] ?? null;
}

/**
 * Applies a requested Next Focus to the step record.
 *
 * A background kind leaves the primary slot empty on purpose: the search is
 * running, the user's attention is free, and the Advance surface is expected to
 * recommend what to do meanwhile rather than pretend the person is busy.
 *
 * Touches step rows only. The caller owns the projection write — see
 * {@link STEP_PROJECTION_SET_SQL}.
 */
export async function applyNextFocus(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    threadId: string;
    kind: NextFocusKind | null;
    note?: string | null;
    origin: StepOrigin;
    at: string;
  },
): Promise<void> {
  if (!input.kind) {
    // Clearing the next step ends everything open, background included. This
    // is the only command a user has for calling off a running search, so it
    // cannot quietly leave one behind.
    await closeOpenSteps(db, { ...input, reason: "abandoned", includeBackground: true });
    return;
  }
  await startStep(db, { ...input, kind: input.kind });
}

/**
 * The Thread's open steps. Callers that must reason about what a Thread is
 * actually doing have to read this rather than `next_focus_kind`: the column
 * projects the primary slot only, so a Thread running a background search is
 * indistinguishable from an idle one by the column alone.
 */
/**
 * Completes the running background step a domain event just finished.
 *
 * Manual steps are deliberately not closed this way — there is no fact that
 * says a person finished reading, and asking them to click "done" would be the
 * bookkeeping this model exists to remove. Those end when the round does.
 *
 * The target reference records what the step produced, which is what lets the
 * destination Area say which Thread sent the user there.
 */
export async function completeBackgroundStep(
  db: Queryable,
  input: {
    spaceId: string;
    threadId: string;
    kind: NextFocusKind;
    at: string;
    targetRefKind?: string | null;
    targetRefId?: string | null;
  },
): Promise<boolean> {
  // One step per completion, oldest first. `startStep` returns the running row
  // rather than inserting a second of the same kind, so today this matches at
  // most one step anyway; the narrowing is here so that if a Thread ever runs
  // two same-kind operations, each completion closes the one it produced
  // instead of attributing the wrong Workflow to both.
  const updated = await db.query<{ id: string }>(
    `UPDATE inquiry_thread_steps
        SET status = 'done', completed_at = $1,
            target_ref_kind = COALESCE($2, target_ref_kind),
            target_ref_id = COALESCE($3, target_ref_id)
      WHERE id = (
        SELECT id FROM inquiry_thread_steps
         WHERE thread_id = $4 AND space_id = $5 AND kind = $6
           AND slot = 'background' AND status = 'in_progress'
         ORDER BY created_at ASC, id ASC
         LIMIT 1
      )
      RETURNING id`,
    [input.at, input.targetRefKind ?? null, input.targetRefId ?? null, input.threadId, input.spaceId, input.kind],
  );
  // No projection write: the projection mirrors the primary slot, and this
  // only ever touches a background step.
  return Boolean(updated.rows[0]);
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
 * destination can say which Thread sent them and offer the way back. A URL
 * parameter was rejected for this — it dies on refresh, on a second navigation,
 * and on another device, which is exactly when a person has lost the thread.
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
        AND ${contentReadSql("space_object", "so", "$3")}
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
    `SELECT * FROM inquiry_thread_steps
      WHERE thread_id = $1 AND space_id = $2 AND project_id = $3
      ORDER BY created_at DESC, id DESC`,
    [input.threadId, input.spaceId, input.projectId],
  );
  return rows.rows;
}

