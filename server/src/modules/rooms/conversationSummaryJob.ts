import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry, JobHandlerResult } from "../jobs/handlerRegistry.js";
import { RoomConversationSummaryService, ROOM_CONVERSATION_SUMMARY_JOB } from "./conversationSummaryService.js";

export function registerRoomConversationSummaryHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  registry.register(ROOM_CONVERSATION_SUMMARY_JOB, async (job): Promise<JobHandlerResult> => {
    const roomId = stringValue(job.payload.room_id);
    const sessionId = stringValue(job.payload.session_id);
    if (!roomId || !sessionId) throw new Error(`${ROOM_CONVERSATION_SUMMARY_JOB} requires room_id and session_id`);
    return new RoomConversationSummaryService(config, db).process({
      spaceId: job.space_id,
      roomId,
      sessionId,
    });
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
