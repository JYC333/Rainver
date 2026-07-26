import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { projects } from "./projects";
import { projectFolders } from "./projectFolders";
import { spaces } from "./spaces";

export const rooms = pgTable("rooms", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  projectFolderId: varchar("project_folder_id", { length: 36 }),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  title: varchar({ length: 256 }).notNull(),
  status: varchar({ length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_rooms_project_updated").on(table.spaceId, table.projectId, table.updatedAt),
  index("ix_rooms_space_updated").on(table.spaceId, table.updatedAt),
  unique("uq_rooms_id_space").on(table.id, table.spaceId),
  unique("uq_rooms_id_space_project").on(table.id, table.spaceId, table.projectId),
  foreignKey({
    columns: [table.spaceId],
    foreignColumns: [spaces.id],
    name: "rooms_space_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.projectFolderId, table.spaceId],
    foreignColumns: [projectFolders.id, projectFolders.spaceId],
    name: "rooms_project_folder_scope_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.projectId, table.spaceId],
    foreignColumns: [projects.id, projects.spaceId],
    name: "rooms_project_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.createdByUserId],
    foreignColumns: [users.id],
    name: "rooms_created_by_user_id_fkey",
  }).onDelete("restrict"),
  check("ck_rooms_status", sql`status IN ('active', 'archived')`),
]);

export const roomUserMembers = pgTable("room_user_members", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  role: varchar({ length: 32 }).notNull(),
  status: varchar({ length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_room_user_members_user").on(table.spaceId, table.userId, table.status),
  unique("uq_room_user_members_room_user").on(table.roomId, table.userId),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_user_members_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "room_user_members_user_id_fkey",
  }).onDelete("cascade"),
  check("ck_room_user_members_role", sql`role IN ('owner', 'member')`),
  check("ck_room_user_members_status", sql`status IN ('active', 'removed')`),
]);

export const roomAgentMembers = pgTable("room_agent_members", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  role: varchar({ length: 32 }).notNull(),
  status: varchar({ length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_room_agent_members_agent").on(table.spaceId, table.agentId, table.status),
  unique("uq_room_agent_members_room_agent").on(table.roomId, table.agentId),
  uniqueIndex("uq_room_agent_members_manager").on(table.roomId)
    .where(sql`role = 'manager' AND status = 'active'`),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_agent_members_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.agentId, table.spaceId],
    foreignColumns: [agents.id, agents.spaceId],
    name: "room_agent_members_agent_scope_fkey",
  }).onDelete("cascade"),
  check("ck_room_agent_members_role", sql`role IN ('manager', 'member')`),
  check("ck_room_agent_members_status", sql`status IN ('active', 'removed')`),
]);
