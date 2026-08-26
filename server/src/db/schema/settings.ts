import { pgTable, index, unique, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";

export const settings = pgTable("settings", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	scopeType: varchar("scope_type", { length: 32 }).notNull(),
	scopeId: varchar("scope_id", { length: 128 }).notNull(),
	settingsKey: varchar("settings_key", { length: 128 }).notNull(),
	settingsJson: jsonb("settings_json").default({}).notNull(),
	updatedByUserId: varchar("updated_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_settings_key").using("btree", table.settingsKey.asc().nullsLast()),
	index("ix_settings_scope").using("btree", table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "settings_updated_by_user_id_fkey"
		}),
	unique("uq_settings_scope_key").on(table.scopeId, table.scopeType, table.settingsKey),
	check("ck_settings_json_object", sql`jsonb_typeof(settings_json) = 'object'::text`),
	check("ck_settings_scope_type", sql`(scope_type)::text = ANY (ARRAY[('instance'::character varying)::text, ('space'::character varying)::text, ('user'::character varying)::text, ('space_user'::character varying)::text])`),
]);
