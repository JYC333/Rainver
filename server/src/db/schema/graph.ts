import { pgTable, index, unique, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";

export const graphViewStates = pgTable("graph_view_states", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	scopeKey: varchar("scope_key", { length: 128 }).notNull(),
	stateJson: jsonb("state_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_graph_view_states_scope_key").using("btree", table.scopeKey.asc().nullsLast()),
	index("ix_graph_view_states_space_user").using("btree", table.spaceId.asc().nullsLast(), table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "graph_view_states_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "graph_view_states_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_graph_view_states_scope").on(table.scopeKey, table.spaceId, table.userId),
	check("ck_graph_view_states_state_object", sql`jsonb_typeof(state_json) = 'object'::text`),
]);
