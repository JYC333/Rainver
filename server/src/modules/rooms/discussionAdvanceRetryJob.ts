import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { JobDeferredError, type JobHandlerRegistry, type JobHandlerResult } from "../jobs/handlerRegistry.js";
import { RoomDiscussionService, ROOM_DISCUSSION_ADVANCE_RETRY_JOB } from "./discussionService.js";

const TURN_BUSY_RETRY_DELAY_MS = 8_000;

/**
 * Retries advancing a discussion wave whose next wave (or closing turn) lost
 * the conversation's turn claim — to a person's message sent in the moment
 * between waves, or a delegation result arriving at the same time. Advancing
 * is idempotent per wave, so a retry after another attempt succeeded is a
 * no-op.
 */
export function registerRoomDiscussionAdvanceRetryHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const service = new RoomDiscussionService(config, getDbPool(config.databaseUrl));
  registry.register(ROOM_DISCUSSION_ADVANCE_RETRY_JOB, async (job): Promise<JobHandlerResult> => {
    const groupId = typeof job.payload.group_id === "string" ? job.payload.group_id : null;
    if (!groupId) throw new Error(`${ROOM_DISCUSSION_ADVANCE_RETRY_JOB} requires group_id`);
    const outcome = await service.advanceGroup(job.space_id, groupId, { enqueueRetry: false });
    if (outcome === "busy") throw new JobDeferredError("Room conversation turn is still busy", TURN_BUSY_RETRY_DELAY_MS);
    return { group_id: groupId, status: "advanced_or_current" };
  });
}
