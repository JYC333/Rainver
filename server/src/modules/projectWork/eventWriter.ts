import { randomUUID } from "node:crypto";
import type { ProjectWorkEventKind } from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { entityDefinition } from "../ontology/entities.js";
import { workEventKindDefinition } from "./eventKinds.js";

/**
 * The single place that writes `project_work_events`.
 *
 * The stream is the authority for how a Project advanced; `task_loop_states`
 * and the Task's own columns are folds of it. A fold that can be written
 * without its event is a fold that can disagree with the record it claims to
 * summarise, and nothing afterwards can say which of the two was right — so
 * the event goes first, in the same transaction, through here.
 *
 * `spaceObjectWriter.ts` established the shape of this guard for
 * `space_objects` after eleven hand-written inserts had drifted apart. A test
 * asserts no second writer appears here either, and it is asserted before any
 * of the rules below, because hardening a choke point is worthless if a domain
 * can hand-roll the insert next to it.
 */

export class WorkEventWriteError extends Error {}

export interface WorkEventInput {
  spaceId: string;
  projectId: string;
  eventKind: ProjectWorkEventKind;
  /** Entity type of the thing this happened to (`task`, `project`, ...). */
  subjectType: string;
  subjectId: string;
  actorId: string;
  occurredAt?: string;
  /** Groups every event produced by one advancement chain. */
  correlationId?: string | null;
  /** The event that caused this one. */
  causationId?: string | null;
  /**
   * Set it whenever the caller can be replayed. Settlement, job retries and
   * at-least-once delivery all re-enter with the same facts, and an
   * advancement recorded twice is a Project that looks like it did the work
   * twice.
   */
  idempotencyKey?: string | null;
  data?: Record<string, unknown>;
}

export interface WorkEventWriteResult {
  id: string;
  /** False when an idempotency key matched an event already recorded. */
  inserted: boolean;
}

export function assertWorkEventKind(kind: string, subjectType: string): void {
  const definition = workEventKindDefinition(kind);
  if (!definition) throw new HttpError(422, `Unknown Project work event kind: ${kind}`);
  if (!definition.subjects.includes(subjectType)) {
    throw new HttpError(
      422,
      `Work event ${kind} does not accept ${subjectType} as its subject`,
    );
  }
  if (!entityDefinition(subjectType)) {
    throw new HttpError(422, `${subjectType} is not a registered entity`);
  }
}

export async function appendProjectWorkEvent(
  db: Queryable,
  input: WorkEventInput,
): Promise<WorkEventWriteResult> {
  assertWorkEventKind(input.eventKind, input.subjectType);
  if (!input.actorId) {
    throw new WorkEventWriteError(`Work event ${input.eventKind} requires an actor`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const occurredAt = input.occurredAt ?? now;
  const data = input.data ?? {};

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO project_work_events (
       id, space_id, project_id, event_kind, subject_type, subject_id, actor_id,
       occurred_at, correlation_id, causation_id, idempotency_key, data_json, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      id,
      input.spaceId,
      input.projectId,
      input.eventKind,
      input.subjectType,
      input.subjectId,
      input.actorId,
      occurredAt,
      input.correlationId ?? null,
      input.causationId ?? null,
      input.idempotencyKey ?? null,
      JSON.stringify(data),
      now,
    ],
  );
  const row = inserted.rows[0];
  if (row) return { id: row.id, inserted: true };

  if (!input.idempotencyKey) {
    throw new WorkEventWriteError(
      `Work event ${input.eventKind} was not recorded and carried no idempotency key`,
    );
  }
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM project_work_events
      WHERE space_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [input.spaceId, input.idempotencyKey],
  );
  const settled = existing.rows[0];
  if (!settled) {
    throw new WorkEventWriteError(
      `Work event ${input.eventKind} conflicted but no prior event was found`,
    );
  }
  return { id: settled.id, inserted: false };
}
