import type { Pool } from "../../../db/pool";
import { getDbPool } from "../../../db/pool";
import type { ServerConfig } from "../../../config";
import { withDbTransaction, optionalString } from "../../routeUtils/common";
import {
  JobDeferredError,
  type JobHandlerRegistry,
  type JobHandlerResult,
} from "../../jobs/handlerRegistry";
import { RoomService } from "../../rooms/service";
import { isConversationTurnInProgressError } from "../../sessions/conversationRuntimeSessionRepository";

export const RESEARCH_OPERATION_FAILURE_NOTIFY_JOB = "research_operation_failure_notify";

const TURN_BUSY_RETRY_DELAY_MS = 2_000;

/**
 * Posts the `research_workflow_terminal` (failed) Room continuation for a
 * research Operation's failure. Split into its own job — enqueued via
 * `ProjectResearchOrchestrator.notifyRoomOfOperationFailure` through
 * whichever `Queryable` `failOperation` is already using — specifically so
 * the enqueue shares the same commit/rollback fate as the "failed" state
 * write it reports on (see that method's doc comment for why a direct,
 * independently-committing Room call is unsafe here). This file has no
 * dependency on `projectResearch/orchestrator.ts`, so importing the job type
 * constant from there does not create an import cycle.
 */
export function registerResearchOperationFailureNotifyHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool: Pool = getDbPool(config.databaseUrl);
  registry.register(RESEARCH_OPERATION_FAILURE_NOTIFY_JOB, async (job): Promise<JobHandlerResult> => {
    const operationId = optionalString(job.payload.operation_id);
    const roomId = optionalString(job.payload.room_id);
    const sessionId = optionalString(job.payload.session_id);
    const reason = optionalString(job.payload.reason) ?? "The research operation failed.";
    if (!operationId || !roomId || !sessionId || !job.user_id) {
      throw new Error(`${RESEARCH_OPERATION_FAILURE_NOTIFY_JOB} requires operation_id, room_id, session_id, and user_id`);
    }
    try {
      await withDbTransaction(pool, (client) =>
        new RoomService(config, pool).continueAfterDomainEventInTransaction(
          client,
          { spaceId: job.space_id, userId: job.user_id! },
          roomId,
          sessionId,
          { kind: "research_workflow_terminal", key: operationId, payload: { status: "failed", operation_id: operationId, reason } },
        ),
      );
    } catch (error) {
      if (isConversationTurnInProgressError(error)) {
        throw new JobDeferredError("Room conversation turn is still busy", TURN_BUSY_RETRY_DELAY_MS);
      }
      throw error;
    }
    return { operation_id: operationId, status: "notified" };
  });
}
