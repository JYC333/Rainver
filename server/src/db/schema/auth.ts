import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, timestamp, boolean, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	email: varchar({ length: 256 }).notNull(),
	displayName: varchar("display_name", { length: 256 }).notNull(),
	avatarUrl: text("avatar_url"),
	emailVerified: boolean("email_verified").default(false).notNull(),
	registrationSource: varchar("registration_source", { length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("ix_users_email").using("btree", table.email.asc().nullsLast()),
	index("ix_users_status").using("btree", table.status.asc().nullsLast()),
	check("ck_users_email_normalized", sql`email = lower(email) AND email = btrim(email)`),
	check("ck_users_status", sql`status IN ('pending', 'active', 'disabled')`),
	check("ck_users_registration_source", sql`registration_source IN ('bootstrap', 'space_invitation', 'admin_recovery', 'system')`),
]);

export const authAccounts = pgTable("auth_accounts", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	accountId: varchar("account_id", { length: 256 }).notNull(),
	providerId: varchar("provider_id", { length: 64 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_auth_accounts_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "auth_accounts_user_id_fkey"
		}),
	unique("uq_auth_accounts_provider_user").on(table.providerId, table.accountId),
]);

export const userSessions = pgTable("user_sessions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	tokenHash: varchar("token_hash", { length: 128 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: varchar("ip_address", { length: 128 }),
	userAgent: text("user_agent"),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_user_sessions_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_sessions_user_id_fkey"
		}),
	unique("user_sessions_token_hash_key").on(table.tokenHash),
]);

export const authVerifications = pgTable("auth_verifications", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	identifier: varchar({ length: 512 }).notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_auth_verifications_identifier").using("btree", table.identifier.asc().nullsLast()),
]);
