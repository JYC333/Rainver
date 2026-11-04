import type { ProblemReference } from "@rainver/protocol";
import { assertProblemReferences } from "./problemReferences.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { lockProblem, problemRound, refreshProblem, startPrimary, type PrimaryIntent } from "./problemFacts.js";
import { recordThreadWorkEvent } from "./threadWorkEvents.js";

/** Called only inside the Updates undo transaction, with a server-read event. */
export async function revertRoundCloseout(db: Queryable, identity: SpaceUserIdentity, projectId: string, threadId: string, eventId: string, closeoutId: string): Promise<void> {
  const thread = await lockProblem(db, identity, projectId, threadId);
  const r = await db.query<{
    id: string;
    round_number: number;
    closed_revision: number;
    previous_primary: Record<string, unknown> | null;
  }>(`SELECT id,round_number,closed_revision,previous_primary FROM inquiry_round_closeouts WHERE id=$1 AND space_id=$2 AND thread_id=$3 AND project_id=$4`, [closeoutId, identity.spaceId, threadId, projectId]);
  const c = r.rows[0];
  if (!c || c.closed_revision !== thread.problem_revision) throw new HttpError(409, "Later problem work prevents close-out reversal");
  const round = await problemRound(db, identity.spaceId, threadId);
  // The next primary a close-out opened itself (`start_next_primary`) shares its
  // transaction timestamp. It is part of the command being compensated, not a
  // later dependency; any other later work also changed the revision above.
  const ownNextPrimary = `slot='primary' AND status='in_progress' AND round_number=$3+1 AND created_at=(SELECT created_at FROM inquiry_round_closeouts WHERE id=$4 AND space_id=$1)`;
  const dependency = await db.query(`SELECT 1 FROM inquiry_thread_steps WHERE space_id=$1 AND thread_id=$2 AND (round_number>$3 OR (slot='background' AND status='in_progress')) AND NOT (${ownNextPrimary}) LIMIT 1`, [identity.spaceId, threadId, c.round_number, closeoutId]);
  if (round !== c.round_number + 1 || dependency.rows.length) throw new HttpError(409, "Later round or running execution prevents close-out reversal");
  await db.query(`UPDATE inquiry_thread_steps SET status='abandoned',ended_reason='closeout_reverted',completed_at=now() WHERE space_id=$1 AND thread_id=$2 AND ${ownNextPrimary}`, [identity.spaceId, threadId, c.round_number, closeoutId]);
  const p = c.previous_primary;
  // Restore the choice as new work, never reopen/move the old historical Step.
  // Its input context comes back with it; outputs stay with the historical Step.
  if (p) {
    const inputRefs = (Array.isArray(p.context_refs) ? p.context_refs as { role?: unknown; ref: ProblemReference }[] : []).filter(r => r.role === "input").map(r => r.ref);
    await assertProblemReferences(db, identity, projectId, inputRefs);
    await startPrimary(db, identity, projectId, threadId, {
      stage: p.method_stage,
      work_kind: p.work_kind,
      reason: String(p.note ?? "Restored work choice")
    } as PrimaryIntent, round, { input_refs: inputRefs });
  }
  await refreshProblem(db, identity.spaceId, threadId);
  await recordThreadWorkEvent(db, {
    spaceId: identity.spaceId,
    projectId,
    threadId,
    userId: identity.userId,
    eventKind: "thread.round_closeout_reverted",
    occurredAt: new Date().toISOString(),
    idempotencySuffix: closeoutId,
    data: {
      statement: thread.statement,
      closeout_id: closeoutId,
      summary: "Reverted round close-out; history retained"
    },
    provenance: {
      undoOfEventId: eventId
    }
  });
}
