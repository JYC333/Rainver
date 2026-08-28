import type { ProjectWorkEventKind } from "@rainver/protocol";
import { resolveAgentActorId, resolveUserActorId } from "../../db/actorResolver.js";
import type { Queryable } from "../routeUtils/common.js";
import { appendProjectWorkEvent } from "./eventWriter.js";

/**
 * How a domain's direct advancement reaches the Project's readable account.
 *
 * ADR 0017 lets an Agent advance a Thread — and ADR 0003 §2 lets it remember
 * something — without asking first, and makes that conditional on the person
 * seeing it afterwards and being able to reverse it. This is that record: one
 * append-only stream, so the Project has one story rather than one per
 * domain.
 *
 * Written inside the caller's transaction. An advancement that happened
 * without a row saying so is exactly the invisibility the direct write was
 * allowed on the promise of avoiding.
 *
 * Shared rather than copied per domain: attribution, the batch key and the
 * undo linkage are the properties the feed and the undo route both depend on,
 * and a second domain re-deriving them is how they drift.
 */
export interface WorkEventProvenance {
  /** Set when a Run did the work; absent for a person acting directly. */
  runId?: string | null;
  agentId?: string | null;
  /**
   * The update this reverses, when it is an undo.
   *
   * Only `undoProjectUpdate` sets it. It is deliberately not readable from a
   * request body: the read model reports an event named here as undone, which
   * removes its Undo control and makes the genuine undo refuse — so a
   * caller-supplied value would let any writer forge "already undone" on any
   * event in the Space and strand it that way.
   */
  undoOfEventId?: string | null;
}

/**
 * What one turn's writes of one kind share, so the feed can fold them into a
 * single "opened 6 questions" row. A person acting directly has no batch: one
 * deliberate action is one row.
 */
export function workEventBatchKey(
  kind: ProjectWorkEventKind,
  provenance: WorkEventProvenance | undefined,
): string | null {
  return provenance?.runId ? `${provenance.runId}:${kind}` : null;
}

export async function recordDomainWorkEvent(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    subjectType: string;
    subjectId: string;
    userId: string;
    eventKind: ProjectWorkEventKind;
    occurredAt: string;
    /** Distinguishes one advancement of this subject from the next. */
    idempotencySuffix: string;
    data: Record<string, unknown>;
    provenance?: WorkEventProvenance;
  },
): Promise<void> {
  // The Agent is the actor when a Run did the work: attributing it to the
  // person who instructed the turn would make the feed unable to answer "who
  // did this", which is the first thing it is read for.
  const actorId = input.provenance?.agentId
    ? await resolveAgentActorId(db, input.spaceId, input.provenance.agentId)
    : await resolveUserActorId(db, input.spaceId, input.userId);
  const batchKey = workEventBatchKey(input.eventKind, input.provenance);
  await appendProjectWorkEvent(db, {
    spaceId: input.spaceId,
    projectId: input.projectId,
    eventKind: input.eventKind,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    actorId,
    occurredAt: input.occurredAt,
    ...(input.provenance?.runId ? { correlationId: input.provenance.runId } : {}),
    idempotencyKey: `${input.eventKind}:${input.subjectId}:${input.idempotencySuffix}`,
    data: {
      ...input.data,
      ...(input.provenance?.undoOfEventId ? { undo_of_event_id: input.provenance.undoOfEventId } : {}),
      ...(batchKey ? { batch_key: batchKey } : {}),
      origin: input.provenance?.agentId ? "agent" : "user",
      ...(input.provenance?.runId ? { run_id: input.provenance.runId } : {}),
    },
  });
}
