import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { PgJobQueueRepository } from "../jobs/repository.js";

export const RESEARCH_OPERATION_CANCEL_JOB = "research_operation_cancel";

/** The statuses in which a research Operation is over. Kept as one list —
 * the SQL below is built from it — because a status missed in one copy would
 * let cancel flip a finished Operation back to `cancelled` and enqueue a kill
 * for Runs that legitimately produced its result. */
export const RESEARCH_OPERATION_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

const TERMINAL_SQL_LIST = RESEARCH_OPERATION_TERMINAL_STATUSES.map((status) => `'${status}'`).join(",");

/**
 * Stopping a research Operation is two writes with different reach.
 *
 * The durable half — the Operation row moving to `cancelled` — has to be
 * synchronous, because the caller's next read must not still show the
 * Operation as active, and because `startResearchReconcilePass` reads that
 * status under `FOR UPDATE` to decide whether a new pass may start. Once it
 * says `cancelled`, no further pass can begin.
 *
 * The process half — terminating whatever is already running — cannot be done
 * here. Cancelling a Run means reaching the child process through
 * `RunOrchestrationService`'s process registry, which exists only in the jobs
 * worker. So this enqueues `research_operation_cancel` in one transaction
 * with the status write: the stop request and the state change commit
 * together or not at all. Callers hand this service a plain pool, so the
 * transaction is opened here — without it the UPDATE would auto-commit, a
 * failed enqueue would leave a dead Operation whose Runs keep spending, and
 * the second press of Stop would short-circuit on `already_terminal` with no
 * path that ever re-enqueues the kill.
 *
 * The two halves are ordered, not atomic in effect: between the commit and
 * the worker claiming the job, a Run may reach terminal on its own. That is
 * why the handler treats an already-terminal Run as success rather than an
 * error — see `researchOperationCancelJob.ts`.
 */
export class ResearchOperationCancelService {
  constructor(private readonly db: Queryable) {}

  async cancelOperation(
    identity: SpaceUserIdentity,
    projectId: string,
    operationId: string,
    reason?: string | null,
  ): Promise<{ operation_id: string; status: "cancelled"; already_terminal: boolean }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const normalizedReason = reason?.trim() || null;
    if (normalizedReason && normalizedReason.length > 2_000) {
      throw new HttpError(422, "reason must be at most 2000 characters");
    }
    return withQueryableTransaction(this.db, async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM project_operations
          WHERE id=$1 AND space_id=$2 AND project_id=$3 AND kind='research'`,
        [operationId, identity.spaceId, projectId],
      );
      if (!existing.rows[0]) throw new HttpError(404, "Research operation not found");

      const updated = await tx.query<{ id: string }>(
        `UPDATE project_operations
            SET status='cancelled', version=version+1, updated_at=$4
          WHERE id=$1 AND space_id=$2 AND project_id=$3
            AND status NOT IN (${TERMINAL_SQL_LIST})
          RETURNING id`,
        [operationId, identity.spaceId, projectId, new Date().toISOString()],
      );
      // Already over — by completion, failure, an earlier cancel, or a race
      // lost against any of them. The caller asked for a stopped Operation
      // and has one, so this answers success rather than conflict; the
      // winner's own path covers the processes.
      if (!updated.rows[0]) {
        return { operation_id: operationId, status: "cancelled" as const, already_terminal: true };
      }

      await new PgJobQueueRepository(tx).enqueue({
        job_type: RESEARCH_OPERATION_CANCEL_JOB,
        space_id: identity.spaceId,
        user_id: identity.userId,
        payload: {
          operation_id: operationId,
          project_id: projectId,
          ...(normalizedReason ? { reason: normalizedReason } : {}),
        },
      });
      return { operation_id: operationId, status: "cancelled" as const, already_terminal: false };
    });
  }
}
