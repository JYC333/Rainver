import { assertProjectWriter, lockProjectAudience } from "../projects/access.js";
import type { Queryable } from "../routeUtils/common.js";
import { lockRoomConversationQueue } from "./messageQueue.js";
import { PgRoomRepository } from "./repository.js";
import type { RoomIdentity } from "./service.js";

/** Match grouped lifecycle admission before a discussion or quota write. */
export async function lockRoomConversationWriter(db: Queryable, identity: RoomIdentity, roomId: string, sessionId: string) {
  const { spaceId, userId } = identity;
  const rooms = new PgRoomRepository(db);
  const visible = await rooms.getVisibleRoom(spaceId, userId, roomId);
  if (!visible) return null;
  await lockRoomConversationQueue(db, spaceId, sessionId);
  await lockProjectAudience(db, spaceId, visible.project_id);
  await rooms.lockRoomForTurn(spaceId, roomId);
  const room = await rooms.getVisibleRoom(spaceId, userId, roomId);
  if (!room) return null;
  await assertProjectWriter(db, spaceId, room.project_id, userId);
  return room;
}
