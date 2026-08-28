import type { TaskCompletionOverride } from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { resolveUserActorId } from "../../db/actorResolver.js";
import { appendProjectWorkEvent } from "./eventWriter.js";
import { taskCompletionState } from "./completion.js";

/**
 * What a person's Task edit records in the Project stream.
 *
 * Called from inside the Task repository's own transaction, so the event and
 * the row it describes commit together. An event written afterwards can be
 * lost by a rollback the writer never sees, and a stream missing the change it
 * is the authority for is worse than no stream.
 */

export interface UserTaskEventContext {
  spaceId: string;
  userId: string;
  taskId: string;
  projectId: string | null;
  /**
   * Who to attribute the write to, when that is not the instructing person.
   * An Agent creating a Task through a tool call runs under the person who
   * asked, but the Task was the Agent's doing and the timeline has to say so.
   */
  actorId?: string;
  /** The Run that produced it, when one did. */
  runId?: string | null;
}

/** Space-only Tasks have no Project stream to write to. */
async function actorFor(db: Queryable, context: UserTaskEventContext): Promise<string | null> {
  if (!context.projectId) return null;
  return context.actorId ?? resolveUserActorId(db, context.spaceId, context.userId);
}

export async function recordTaskCreated(
  db: Queryable,
  context: UserTaskEventContext,
  data: { title: string; status: string },
): Promise<void> {
  const actorId = await actorFor(db, context);
  if (!actorId || !context.projectId) return;
  await appendProjectWorkEvent(db, {
    spaceId: context.spaceId,
    projectId: context.projectId,
    eventKind: "task.created",
    subjectType: "task",
    subjectId: context.taskId,
    actorId,
    idempotencyKey: `task.created:${context.taskId}`,
    ...(context.runId ? { correlationId: context.runId } : {}),
    // Two of the three fields every direct write records
    // (`projectWork/domainWorkEvents.ts`), written here rather than through
    // that helper because the actor is already resolved by the caller — the
    // Task repository knows whether the Agent or the person decided it, and
    // the helper re-derives that from an agent id it does not have.
    //
    // `origin` is the one that matters on its own: on the Board
    // `created_by_user_id` is the person either way, so the stream is the only
    // place that can answer "did I ask for this Task, or did the Agent".
    data: {
      ...data,
      origin: context.actorId ? "agent" : "user",
      ...(context.runId ? { run_id: context.runId } : {}),
    },
  });
}

/**
 * Refuse a manual close that has not met what the Task declared.
 *
 * The refusal is the point: a Task closed with its declared outputs missing
 * and its evaluation unread means the completion contract described nothing.
 * Overriding stays available — a person can always decide a requirement no
 * longer applies — but it names what it skipped, so the record says the Task
 * was closed early rather than that it met its bar.
 *
 * Runs before the row is written, so a refused close leaves nothing behind.
 */
export async function assertCompletionForClose(
  db: Queryable,
  context: UserTaskEventContext,
  requiredOutputsJson: unknown,
  override: TaskCompletionOverride | null,
): Promise<{ overridden: string[] }> {
  const completion = await taskCompletionState(
    db,
    context.spaceId,
    context.taskId,
    requiredOutputsJson,
  );
  if (completion.ok) return { overridden: [] };
  const acknowledged = new Set(override?.acknowledged ?? []);
  const unacknowledged = completion.missing.filter((reason) => !acknowledged.has(reason));
  if (unacknowledged.length > 0) {
    throw new HttpError(422, "Task completion requirements are not met", {
      code: "completion_requirements_unmet",
      missing: completion.missing,
      unacknowledged,
    });
  }
  return { overridden: completion.missing };
}

/** Records a flow move, and the acceptance decision when the move closes it. */
export async function recordTaskFlowChange(
  db: Queryable,
  context: UserTaskEventContext,
  input: { fromStatus: string; toStatus: string; overridden: readonly string[]; basedOn: string },
): Promise<void> {
  const actorId = await actorFor(db, context);
  if (!actorId || !context.projectId) return;
  await appendProjectWorkEvent(db, {
    spaceId: context.spaceId,
    projectId: context.projectId,
    eventKind: "task.flow_changed",
    subjectType: "task",
    subjectId: context.taskId,
    actorId,
    // Keyed on the row the writer *read*, not on the clock: two writers that
    // both read the same row are one decision, while a later move of the same
    // Task reads a newer row and is its own. The transaction lock makes the
    // duplicate unreachable; the key is what makes that a property of the
    // event rather than of the caller.
    idempotencyKey: `task.flow_changed:${context.taskId}:${input.fromStatus}:${input.toStatus}:${input.basedOn}`,
    data: { from: input.fromStatus, to: input.toStatus, via: "user" },
  });
  if (input.toStatus === "done") {
    await appendProjectWorkEvent(db, {
      spaceId: context.spaceId,
      projectId: context.projectId,
      eventKind: "task.accepted",
      subjectType: "task",
      subjectId: context.taskId,
      actorId,
      idempotencyKey: `task.accepted:${context.taskId}:${input.basedOn}`,
      data: {
        decided_by: "user",
        basis: input.overridden.length > 0 ? "override" : "requirements_met",
        overridden: [...input.overridden],
      },
    });
  }
}

export async function recordTaskResponsibilityChange(
  db: Queryable,
  context: UserTaskEventContext,
  data: Record<string, unknown>,
): Promise<void> {
  const actorId = await actorFor(db, context);
  if (!actorId || !context.projectId) return;
  await appendProjectWorkEvent(db, {
    spaceId: context.spaceId,
    projectId: context.projectId,
    eventKind: "task.responsibility_changed",
    subjectType: "task",
    subjectId: context.taskId,
    actorId,
    data,
  });
}
