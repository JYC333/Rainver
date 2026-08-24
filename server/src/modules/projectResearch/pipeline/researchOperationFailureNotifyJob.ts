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

/** The statuses `notifyRoomOfOperationStatus` reports. `waiting_review` is
 * not terminal — the operation is paused and will report again — which is
 * why the Room event key carries the status (and, for `failed`, the pass
 * generation as `episode`). */
const NOTIFIABLE_STATUSES = ["failed", "completed", "waiting_review"];

/**
 * Posts a `research_workflow_terminal` Room continuation for a research
 * Operation's status change. Split into its own job — enqueued via
 * `ProjectResearchOrchestrator.notifyRoomOfOperationStatus` through
 * whichever `Queryable` the reporting write is already using — specifically
 * so the enqueue shares the same commit/rollback fate as the state write it
 * reports on (see that method's doc comment for why a direct,
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
    // Jobs enqueued before the checkpoint reform carry no status and were all
    // failures, so an absent status still means `failed`.
    const status = optionalString(job.payload.status) ?? "failed";
    const episode = typeof job.payload.episode === "number" ? job.payload.episode : null;
    if (!operationId || !roomId || !sessionId || !job.user_id) {
      throw new Error(`${RESEARCH_OPERATION_FAILURE_NOTIFY_JOB} requires operation_id, room_id, session_id, and user_id`);
    }
    if (!NOTIFIABLE_STATUSES.includes(status)) {
      throw new Error(`${RESEARCH_OPERATION_FAILURE_NOTIFY_JOB} received an unsupported status ${JSON.stringify(status)}`);
    }
    try {
      await withDbTransaction(pool, (client) =>
        new RoomService(config, pool).continueAfterDomainEventInTransaction(
          client,
          { spaceId: job.space_id, userId: job.user_id! },
          roomId,
          sessionId,
          {
            kind: "research_workflow_terminal",
            // The event key is what `findRoomEventContinuation` dedupes on —
            // permanently. So it has to distinguish everything that is
            // genuinely a separate thing to tell the Room: the status (a pause
            // and a completion of one operation are both worth saying), and
            // for `failed` the pass generation, so an operation that is
            // retried and fails again is a new event rather than a dedupe
            // casualty of its first failure.
            key: episode === null ? `${operationId}:${status}` : `${operationId}:${status}:${episode}`,
            payload: { status, operation_id: operationId, reason },
          },
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
