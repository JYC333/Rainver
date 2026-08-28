import { createHash } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { threadEventBatchKey, type ThreadEventProvenance } from "./threadWorkEvents.js";

/**
 * How many questions one turn may open.
 *
 * The bound is what replaced the approval queue on decomposition (ADR 0017
 * §2). It is not a safety limit on a dangerous write — opening a question is
 * cheap and archivable — but on how much a person is asked to take in at
 * once: past about five, a decomposition stops being reviewable at a glance,
 * which is the same threshold the screening corpus limit exists at for cost.
 *
 * Refusing costs a turn, never a decision: the Agent is told to continue in
 * the next one.
 */
export const THREAD_FAN_OUT_PER_TURN = 5;

/**
 * Counted from the Project's own account rather than a counter, so it is the
 * same fact the person reads and cannot drift from it — and so a retried or
 * resumed Run cannot spend the budget twice.
 */
export async function countThreadsOpenedInTurn(
  db: Queryable,
  spaceId: string,
  projectId: string,
  provenance: ThreadEventProvenance,
): Promise<number> {
  const batchKey = threadEventBatchKey("thread.created", provenance);
  // Unreachable from the one caller, which always has a Run — but a bound
  // standing where a gate used to stand refuses when it cannot count, rather
  // than skipping. A future caller without a batch is one this cannot see.
  if (!batchKey) return Number.POSITIVE_INFINITY;
  const result = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total
       FROM project_work_events
      WHERE space_id = $1 AND project_id = $2
        AND event_kind = 'thread.created'
        AND data_json->>'batch_key' = $3`,
    [spaceId, projectId, batchKey],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * The key that makes one tool call open one question however many times it is
 * delivered.
 *
 * Hashed rather than concatenated: the column is 128 characters and a provider
 * tool-call id has no length contract, so the raw pair could exceed it and
 * turn a retry into a 422 — which is the failure the key exists to prevent.
 */
export function threadCallIdempotencyKey(runId: string, toolCallId: string | null | undefined): string {
  return createHash("sha256").update(`${runId}:${toolCallId ?? "no-key"}`).digest("hex");
}

/**
 * An active Thread in this Project already asking the same thing.
 *
 * The retired proposal path coalesced on the statement under an advisory lock,
 * for the case a re-planned or re-sampled decomposition actually produces:
 * the same question worded identically, under a fresh tool-call id. Without
 * it that now opens a *durable* duplicate rather than a duplicate pending
 * proposal — strictly worse, because the person has to archive it.
 *
 * Statement equality after trimming, not similarity: coalescing two questions
 * that merely resemble each other would silently drop one the person asked
 * for. The caller holds the Project lock, which serialises this against
 * another call in the same turn.
 */
export async function findActiveThreadWithStatement(
  db: Queryable,
  spaceId: string,
  projectId: string,
  statement: string,
): Promise<string | null> {
  const result = await db.query<{ object_id: string }>(
    `SELECT object_id FROM inquiry_threads
      WHERE space_id = $1 AND project_id = $2
        AND lifecycle_status = 'active'
        AND btrim(statement) = btrim($3)
      ORDER BY object_id
      LIMIT 1`,
    [spaceId, projectId, statement],
  );
  return result.rows[0]?.object_id ?? null;
}
