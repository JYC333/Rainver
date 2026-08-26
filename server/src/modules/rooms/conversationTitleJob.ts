import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { JobHandlerRegistry, JobHandlerResult } from "../jobs/handlerRegistry.js";
import {
  ROOM_CONVERSATION_TITLE_JOB,
  RoomConversationTitleService,
} from "./conversationTitleService.js";

export function registerRoomConversationTitleHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  registry.register(ROOM_CONVERSATION_TITLE_JOB, async (job): Promise<JobHandlerResult> => {
    const roomId = stringValue(job.payload.room_id);
    const sessionId = stringValue(job.payload.session_id);
    const sourceMessageId = stringValue(job.payload.source_message_id);
    const provisionalTitle = stringValue(job.payload.provisional_title);
    if (!roomId || !sessionId || !sourceMessageId || !provisionalTitle || !job.user_id) {
      throw new Error(`${ROOM_CONVERSATION_TITLE_JOB} requires room_id, session_id, source_message_id, provisional_title, and user_id`);
    }
    return new RoomConversationTitleService(config, db).process({
      spaceId: job.space_id,
      roomId,
      sessionId,
      sourceMessageId,
      sourceUserId: job.user_id,
      provisionalTitle,
      jobId: job.job_id,
    });
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
