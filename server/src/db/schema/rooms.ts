import {
  bigint,
  boolean,
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
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { projects } from "./projects.js";
import { projectFolders } from "./projectFolders.js";
import { spaces } from "./spaces.js";

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
  rosterRevision: bigint("roster_revision", { mode: "number" }).default(0).notNull(),
  /**
   * The Project's one mainline conversation. Project members belong to it by
   * being Project members, so the chat panel has a stable Room to bind to
   * rather than "whichever Room the viewer happens to be in that was most
   * recently active" — which switched under people and was empty for anyone
   * not on a roster. It is created with the Project (ADR 0018 decision 4);
   * a Room opened afterwards is never the mainline.
   */
  isMainline: boolean("is_mainline").default(false).notNull(),
  /**
   * A Room whose audience is one person: the Room private continuation lands
   * in, so a private imported session is not seeded into the Project's shared
   * channel. Set at creation and cleared the moment anyone else is added,
   * because a "personal" Room with two members would keep being reused for
   * content meant for one.
   */
  personalForUserId: varchar("personal_for_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_rooms_project_updated").on(table.spaceId, table.projectId, table.updatedAt),
  uniqueIndex("uq_rooms_mainline_per_project").on(table.spaceId, table.projectId).where(sql`is_mainline AND status = 'active'`),
  uniqueIndex("uq_rooms_personal_per_project")
    .on(table.spaceId, table.projectId, table.personalForUserId)
    .where(sql`personal_for_user_id IS NOT NULL AND status = 'active'`),
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
  foreignKey({
    columns: [table.personalForUserId],
    foreignColumns: [users.id],
    name: "rooms_personal_for_user_id_fkey",
  }).onDelete("restrict"),
  check("ck_rooms_status", sql`status IN ('active', 'archived')`),
  check("ck_rooms_personal_not_mainline", sql`personal_for_user_id IS NULL OR NOT is_mainline`),
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
  uniqueIndex("uq_room_user_members_owner").on(table.roomId)
    .where(sql`role = 'owner' AND status = 'active'`),
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
  triggerPolicy: varchar("trigger_policy", { length: 24 }).default("owner_only").notNull(),
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
  check("ck_room_agent_members_trigger_policy", sql`trigger_policy IN ('owner_only')`),
]);

/** Room-only sharing grants; never consumed by generic Agent visibility. */
export const roomAgentAccessGrants = pgTable("room_agent_access_grants", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  granteeUserId: varchar("grantee_user_id", { length: 36 }).notNull(),
  grantedByUserId: varchar("granted_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_room_agent_access_grants_grantee").on(table.spaceId, table.granteeUserId, table.roomId),
  index("ix_room_agent_access_grants_agent").on(table.spaceId, table.agentId, table.roomId),
  uniqueIndex("uq_room_agent_access_grants_active")
    .on(table.roomId, table.agentId, table.granteeUserId)
    .where(sql`revoked_at IS NULL`),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_agent_access_grants_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.agentId, table.spaceId],
    foreignColumns: [agents.id, agents.spaceId],
    name: "room_agent_access_grants_agent_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.granteeUserId],
    foreignColumns: [users.id],
    name: "room_agent_access_grants_grantee_user_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.grantedByUserId],
    foreignColumns: [users.id],
    name: "room_agent_access_grants_granted_by_user_fkey",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.revokedByUserId],
    foreignColumns: [users.id],
    name: "room_agent_access_grants_revoked_by_user_fkey",
  }).onDelete("set null"),
]);

export const roomUserInvitations = pgTable("room_user_invitations", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  inviteeUserId: varchar("invitee_user_id", { length: 36 }).notNull(),
  invitedByUserId: varchar("invited_by_user_id", { length: 36 }).notNull(),
  status: varchar({ length: 32 }).notNull(),
  requiredRosterRevision: bigint("required_roster_revision", { mode: "number" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_room_user_invitations_invitee").on(table.spaceId, table.inviteeUserId, table.status),
  index("ix_room_user_invitations_room").on(table.spaceId, table.roomId, table.status),
  unique("uq_room_user_invitations_id_space").on(table.id, table.spaceId),
  uniqueIndex("uq_room_user_invitations_pending").on(table.roomId, table.inviteeUserId)
    .where(sql`status = 'pending'`),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_user_invitations_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.inviteeUserId],
    foreignColumns: [users.id],
    name: "room_user_invitations_invitee_user_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.invitedByUserId],
    foreignColumns: [users.id],
    name: "room_user_invitations_invited_by_user_fkey",
  }).onDelete("restrict"),
  check("ck_room_user_invitations_status", sql`status IN ('pending', 'active', 'rejected', 'expired', 'cancelled', 'invalidated')`),
]);

export const roomInvitationAgentApprovals = pgTable("room_invitation_agent_approvals", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  invitationId: varchar("invitation_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
  status: varchar({ length: 32 }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_room_invitation_agent_approvals_owner").on(table.spaceId, table.ownerUserId, table.status),
  unique("uq_room_invitation_agent_approvals_invitation_agent").on(table.invitationId, table.agentId),
  foreignKey({
    columns: [table.invitationId, table.spaceId],
    foreignColumns: [roomUserInvitations.id, roomUserInvitations.spaceId],
    name: "room_invitation_agent_approvals_invitation_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.agentId, table.spaceId],
    foreignColumns: [agents.id, agents.spaceId],
    name: "room_invitation_agent_approvals_agent_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.ownerUserId],
    foreignColumns: [users.id],
    name: "room_invitation_agent_approvals_owner_user_fkey",
  }).onDelete("cascade"),
  check("ck_room_invitation_agent_approvals_status", sql`status IN ('pending', 'approved', 'rejected', 'invalidated')`),
]);

/** Caller-scoped retry record for preset instantiation. */
export const roomAgentPresetIdempotencies = pgTable("room_agent_preset_idempotencies", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  roomId: varchar("room_id", { length: 36 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 128 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_room_agent_preset_idempotencies_caller_key").on(table.spaceId, table.userId, table.roomId, table.idempotencyKey),
  foreignKey({
    columns: [table.roomId, table.spaceId],
    foreignColumns: [rooms.id, rooms.spaceId],
    name: "room_agent_preset_idempotencies_room_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.agentId, table.spaceId],
    foreignColumns: [agents.id, agents.spaceId],
    name: "room_agent_preset_idempotencies_agent_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "room_agent_preset_idempotencies_user_fkey",
  }).onDelete("cascade"),
]);
