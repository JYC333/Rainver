import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { rooms } from "./rooms.js";
import { sessions } from "./sessions.js";

/**
 * A Room conversation whose audience was frozen when someone joined the Room
 * without being given its history (`.agent/modules/rooms.md`, "Conversation
 * audience"). The row's existence is the restriction: a conversation without
 * one is visible to the Room's whole current audience. A restricted
 * conversation is visible to the Room audience intersected with
 * `room_conversation_audience_members`; it is never widened again, so an
 * invitation that shares history leaves an already-restricted thread alone.
 *
 * The marker is separate from the member rows on purpose: a member row can
 * disappear with its user (cascade), and an empty member set must still mean
 * "restricted to nobody", not "unrestricted".
 */
export const roomConversationAudiences = pgTable("room_conversation_audiences", {
  sessionId: varchar("session_id", { length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  /**
   * The invitation whose activation froze this audience; provenance only, no
   * foreign key (a composite SET NULL would also null `space_id`).
   */
  frozenByInvitationId: varchar("frozen_by_invitation_id", { length: 36 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_room_conversation_audiences_room").on(table.spaceId, table.roomId),
  foreignKey({
    columns: [table.sessionId, table.spaceId, table.roomId, table.projectId],
    foreignColumns: [sessions.id, sessions.spaceId, sessions.roomId, sessions.projectId],
    name: "room_conversation_audiences_session_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_conversation_audiences_room_scope_fkey",
  }).onDelete("cascade"),
]);

export const roomConversationAudienceMembers = pgTable("room_conversation_audience_members", {
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  sessionId: varchar("session_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  primaryKey({ columns: [table.sessionId, table.userId], name: "room_conversation_audience_members_pkey" }),
  index("ix_room_conversation_audience_members_user").on(table.spaceId, table.userId),
  foreignKey({
    columns: [table.sessionId],
    foreignColumns: [roomConversationAudiences.sessionId],
    name: "room_conversation_audience_members_audience_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "room_conversation_audience_members_user_fkey",
  }).onDelete("cascade"),
]);
