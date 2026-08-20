import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { JobDeferredError, type JobHandlerRegistry, type JobHandlerResult } from "../jobs/handlerRegistry";
import { withDbTransaction } from "../routeUtils/common";
import { isConversationTurnInProgressError } from "../sessions/conversationRuntimeSessionRepository";
import { RoomService } from "../rooms/service";
import { PgAgentGroupRepository } from "./repository";

export const ROOM_DELEGATION_COMPLETION_RETRY_JOB = "room_delegation_completion_retry";
const TURN_BUSY_RETRY_DELAY_MS = 8_000;

/**
 * Retries the Phase 3 delegate-completion Room notification
 * (`AgentGroupRunLifecycleProjector.notifyRoomOfDelegationCompletion`) when
 * its first attempt lost the conversation's turn-claim to a concurrent
 * notification — the case a Room fanning out to more than one specialist
 * without waiting produces routinely (budget allows `max_fanout: 2`). The
 * original attempt's SAVEPOINT rollback only protects the delegation's own
 * bookkeeping from this failure; it does not retry the notification itself,
 * which is this job's entire job. `continueAfterDomainEventInTransaction`'s
 * existing idempotency (`findRoomEventContinuation`, keyed by delegation id)
 * makes a redundant retry — one that fires after another attempt already
 * succeeded — a safe no-op.
 */
export function registerRoomDelegationCompletionRetryHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(ROOM_DELEGATION_COMPLETION_RETRY_JOB, async (job): Promise<JobHandlerResult> => {
    const delegationId = stringValue(job.payload.delegation_id);
    const childRunId = stringValue(job.payload.child_run_id);
    if (!delegationId || !childRunId) {
      throw new Error(`${ROOM_DELEGATION_COMPLETION_RETRY_JOB} requires delegation_id and child_run_id`);
    }
    let deferAfterMs: number | null = null;
    await withDbTransaction(pool, async (client) => {
      const groups = new PgAgentGroupRepository(client);
      const delegation = await groups.getDelegationForChildRun({
        space_id: job.space_id,
        delegation_id: delegationId,
        child_run_id: childRunId,
      });
      if (!delegation || (delegation.status !== "succeeded" && delegation.status !== "failed" && delegation.status !== "cancelled")) return;
      const group = await groups.getGroup(job.space_id, delegation.group_id);
      if (!group?.room_id || !group.session_id) return;
      try {
        await new RoomService(config, pool).continueAfterDomainEventInTransaction(
          client,
          { spaceId: group.space_id, userId: group.manager_user_id },
          group.room_id,
          group.session_id,
          {
            kind: "agent_delegation_result",
            key: delegation.id,
            payload: {
              instruction: delegation.instruction,
              result_summary: delegation.result_summary ?? "",
              status: delegation.status,
            },
          },
        );
      } catch (error) {
        if (isConversationTurnInProgressError(error)) {
          deferAfterMs = TURN_BUSY_RETRY_DELAY_MS;
          return;
        }
        throw error;
      }
    });
    if (deferAfterMs !== null) {
      throw new JobDeferredError("Room conversation turn is still busy", deferAfterMs);
    }
    return { delegation_id: delegationId, child_run_id: childRunId, status: "notified_or_already_current" };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
