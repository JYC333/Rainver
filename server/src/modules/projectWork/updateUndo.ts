import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectReadable } from "../projects/access.js";
import { InquiryIterationService } from "../inquiry/iterationService.js";
import { PgMemoryApplyRepository } from "../memory/memoryApplyRepository.js";
import { recordDomainWorkEvent } from "./domainWorkEvents.js";
import { updateUndoAction } from "./updatesReadModel.js";

/**
 * Reversing one update from the Project's readable account.
 *
 * This is the counterpart ADR 0017 §4 makes a direct write conditional on: an
 * Agent may create, archive or conclude without asking precisely because the
 * person can see it here and put it back in one action. Undo is itself an
 * ordinary `manual`-origin write — it goes through the same domain command,
 * records its own event, and names the event it reversed — so the account
 * stays a record of what happened rather than a mutable list.
 */
export async function undoProjectUpdate(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  eventId: string,
): Promise<{ undone_event_id: string; action: string }> {
  await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  // One transaction around load, guard and dispatch. Without it two concurrent
  // undos of the same conclusion both pass the "already undone" check and both
  // record a reverting Iteration — the archive path is saved by its own domain
  // 409, the revert path is not. The domain services join this transaction.
  return withQueryableTransaction(db, async (tx) => undoLocked(tx, identity, projectId, eventId));
}

async function undoLocked(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  eventId: string,
): Promise<{ undone_event_id: string; action: string }> {
  const row = await db.query<{
    event_kind: string; subject_type: string; subject_id: string; data_json: Record<string, unknown> | null;
  }>(
    `SELECT event_kind, subject_type, subject_id, data_json
       FROM project_work_events
      WHERE id = $1 AND space_id = $2 AND project_id = $3
      FOR UPDATE`,
    [eventId, identity.spaceId, projectId],
  );
  const event = row.rows[0];
  if (!event) throw new HttpError(404, "Update not found");

  const action = updateUndoAction(event.event_kind);
  if (!action) throw new HttpError(409, `A ${event.event_kind} update cannot be undone`);

  // An update already reversed offers no second reversal: the reversal is its
  // own row, and undoing that is done from there.
  // Scoped to the Project as well as the Space, because that is how the read
  // model decides a row is undone: a narrower check here would let a row look
  // undone in the feed and still accept a second undo.
  const already = await db.query<{ id: string }>(
    `SELECT id FROM project_work_events
      WHERE space_id = $1 AND project_id = $3 AND data_json->>'undo_of_event_id' = $2 LIMIT 1`,
    [identity.spaceId, eventId, projectId],
  );
  if (already.rows[0]) throw new HttpError(409, "This update has already been undone");

  if (action === "archive_memory") {
    // Archiving, not deleting: the entry and its provenance stay readable, so
    // "the Agent remembered this and I took it back" is still answerable
    // later. Scoped to the reader's own entries — a direct write is private
    // to the person in the turn, and the read model already refuses to name
    // anyone else's.
    const archived = await new PgMemoryApplyRepository(db).setOwnStatus(
      identity.spaceId,
      identity.userId,
      event.subject_id,
      "archived",
    );
    if (!archived) throw new HttpError(409, "That memory is no longer the caller's to archive");
    await recordDomainWorkEvent(db, {
      spaceId: identity.spaceId,
      projectId,
      subjectType: "memory_entry",
      subjectId: event.subject_id,
      userId: identity.userId,
      eventKind: "memory.archived",
      occurredAt: new Date().toISOString(),
      idempotencySuffix: `undo:${eventId}`,
      data: { summary: "Archived what the Agent remembered" },
      provenance: { undoOfEventId: eventId },
    });
    return { undone_event_id: eventId, action };
  }

  const iterations = new InquiryIterationService(db);
  if (action === "archive_thread" || action === "reopen_thread") {
    await iterations.transitionLifecycle(identity, projectId, event.subject_id, {
      lifecycle_status: action === "archive_thread" ? "archived" : "active",
      reason: "Undone from the Project's updates",
    }, { undoOfEventId: eventId });
    return { undone_event_id: eventId, action };
  }

  // Reverting a conclusion is recording the position it replaced, not
  // deleting the Iteration: the account keeps both, and the Thread's history
  // says it went one way and then came back.
  const previous = event.data_json?.previous_position;
  if (!previous || typeof previous !== "object") {
    throw new HttpError(409, "This conclusion did not record the position it replaced");
  }
  await iterations.recordIteration(identity, projectId, event.subject_id, {
    ...(previous as Record<string, unknown>),
    change_summary: "Reverted the previous conclusion",
    trigger_kind: "user_edit",
  }, { undoOfEventId: eventId });
  return { undone_event_id: eventId, action };
}
