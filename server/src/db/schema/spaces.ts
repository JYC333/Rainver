import { pgTable, index, unique, check, foreignKey, varchar, integer, boolean, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";

export const spaces = pgTable("spaces", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	name: varchar({ length: 256 }).notNull(),
	type: varchar({ length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	snapshotRetentionDaysDefault: integer("snapshot_retention_days_default"),
	snapshotMaxCountDefault: integer("snapshot_max_count_default"),
	oversightMode: varchar("oversight_mode", { length: 16 }).notNull().default('none'),
	egressNotificationsEnabled: boolean("egress_notifications_enabled").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "fk_spaces_created_by_user_id_users"
		}).onDelete("set null"),
	check("ck_spaces_type", sql`(type)::text = ANY (ARRAY[('personal'::character varying)::text, ('household'::character varying)::text, ('team'::character varying)::text])`),
	check("ck_spaces_oversight_mode", sql`(oversight_mode)::text = ANY (ARRAY[('none'::character varying)::text, ('summary'::character varying)::text, ('content'::character varying)::text, ('full'::character varying)::text])`),
]);

export const spaceInvitations = pgTable("space_invitations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	invitedEmail: varchar("invited_email", { length: 256 }).notNull(),
	role: varchar({ length: 32 }).notNull(),
	tokenHash: varchar("token_hash", { length: 128 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	invitedByUserId: varchar("invited_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_space_invitations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_space_invitations_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.invitedByUserId],
			foreignColumns: [users.id],
			name: "fk_space_invitations_invited_by_user_id_users"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "space_invitations_space_id_fkey"
		}),
	unique("space_invitations_token_hash_key").on(table.tokenHash),
	check("ck_space_invitations_role", sql`(role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('reviewer'::character varying)::text, ('member'::character varying)::text, ('guest'::character varying)::text])`),
]);

export const spaceMemberships = pgTable("space_memberships", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	role: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_space_memberships_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_space_memberships_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "space_memberships_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "space_memberships_user_id_fkey"
		}),
	unique("uq_space_memberships_space_user").on(table.spaceId, table.userId),
	check("ck_space_memberships_role", sql`(role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('reviewer'::character varying)::text, ('member'::character varying)::text, ('guest'::character varying)::text])`),
]);
