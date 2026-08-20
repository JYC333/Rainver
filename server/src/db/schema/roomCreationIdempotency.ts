import { foreignKey, index, pgTable, timestamp, unique, varchar, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { sessions } from "./sessions";
import { spaces } from "./spaces";
import { users } from "./auth";

export const roomCreationIdempotencies = pgTable("room_creation_idempotencies", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  conversationId: varchar("conversation_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_room_creation_idempotency_scope").on(table.spaceId, table.userId, table.idempotencyKey),
  index("ix_room_creation_idempotency_room").on(table.spaceId, table.roomId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "room_creation_idempotencies_space_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "room_creation_idempotencies_user_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.roomId, table.spaceId], foreignColumns: [rooms.id, rooms.spaceId], name: "room_creation_idempotencies_room_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.conversationId, table.spaceId], foreignColumns: [sessions.id, sessions.spaceId], name: "room_creation_idempotencies_conversation_fkey" }).onDelete("cascade"),
]);
