import { foreignKey, pgTable, timestamp, unique, varchar, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { rooms } from "./rooms.js";
import { sessions } from "./sessions.js";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";

/**
 * Retry protection for the send that creates its own conversation.
 *
 * `POST /rooms/:roomId/messages` means "start a conversation by speaking", so
 * two deliveries of one request produce two conversations, two dispatches and
 * two copies of whatever references rode along. `claimTurn` cannot catch that:
 * it guards one conversation, and each delivery brings its own. The key does.
 */
export const roomFirstMessageIdempotencies = pgTable("room_first_message_idempotencies", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  /**
   * The message the first delivery wrote. A replay answers with this one
   * rather than the thread's newest, which by then may be somebody else's.
   */
  messageId: varchar("message_id", { length: 36 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_room_first_message_idempotency_scope").on(table.spaceId, table.userId, table.idempotencyKey),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "room_first_message_idempotencies_space_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "room_first_message_idempotencies_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.roomId, table.spaceId], foreignColumns: [rooms.id, rooms.spaceId], name: "room_first_message_idempotencies_room_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.sessionId, table.spaceId], foreignColumns: [sessions.id, sessions.spaceId], name: "room_first_message_idempotencies_session_fkey" }).onDelete("cascade"),
]);
