import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { JobDeferredError, type JobHandlerRegistry, type JobHandlerResult } from "../jobs/handlerRegistry.js";
import { RoomDiscussionService } from "./discussionService.js";
import { isTransientDatabaseError, ROOM_QUEUED_MESSAGE_RELEASE_JOB } from "./messageQueue.js";

const TURN_BUSY_RETRY_DELAY_MS = 30_000;

/**
 * Releases a conversation's waiting messages when no turn boundary did: the
 * turn ended before the message was queued, or the server stopped between a
 * turn's completion and its release. Releasing is idempotent, so a job that
 * finds the queue already empty is done.
 */
export function registerRoomQueuedMessageReleaseHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const service = new RoomDiscussionService(config, getDbPool(config.databaseUrl));
  registry.register(ROOM_QUEUED_MESSAGE_RELEASE_JOB, async (job): Promise<JobHandlerResult> => {
    const sessionId = typeof job.payload.session_id === "string" ? job.payload.session_id : null;
    if (!sessionId) throw new Error(`${ROOM_QUEUED_MESSAGE_RELEASE_JOB} requires session_id`);
    const outcome = await service.releaseQueued(job.space_id, sessionId).catch((error: unknown) => {
      // A deadlock or a lost connection says nothing about the message: try again, without spending an attempt.
      if (isTransientDatabaseError(error)) return "busy" as const;
      throw error;
    });
    if (outcome === "busy") throw new JobDeferredError("Room conversation turn is still taken", TURN_BUSY_RETRY_DELAY_MS);
    return { session_id: sessionId, status: outcome };
  });
}
