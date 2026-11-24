import type { Queryable } from "../routeUtils/common.js";
import { lockProjectAudience } from "../projects/access.js";
import { PgRoomRepository } from "../rooms/repository.js";
import { lockRoomConversationQueue } from "../rooms/messageQueue.js";
import { PgConversationRuntimeSessionRepository } from "../sessions/conversationRuntimeSessionRepository.js";
import type { PgAgentGroupRepository } from "./repository.js";

/** Acquire the enclosing scope before any delegation, Run or event write. */
export async function lockGroupLifecycleScope(
  db: Queryable, groups: PgAgentGroupRepository, spaceId: string, groupId: string,
) {
  const group = await groups.getGroup(spaceId, groupId);
  if (!group) return null;
  if (group.room_id && group.session_id) await lockRoomConversationQueue(db, spaceId, group.session_id);
  if (group.project_id) await lockProjectAudience(db, spaceId, group.project_id);
  if (group.room_id) {
    await new PgRoomRepository(db).lockRoomForTurn(spaceId, group.room_id);
  }
  if (group.session_id) {
    await new PgConversationRuntimeSessionRepository(db).lockConversation(spaceId, group.session_id);
  }
  return groups.lockGroup(spaceId, groupId);
}
