import { pgTable, index, unique, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";

export const schedulerTasks = pgTable("scheduler_tasks", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	taskType: varchar("task_type", { length: 128 }).notNull(),
	taskKey: varchar("task_key", { length: 256 }).notNull(),
	scopeType: varchar("scope_type", { length: 32 }).notNull(),
	scopeId: varchar("scope_id", { length: 128 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	userId: varchar("user_id", { length: 36 }),
	status: varchar({ length: 32 }).notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	stateJson: jsonb("state_json").default({}).notNull(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_scheduler_tasks_due").using("btree", table.taskType.asc().nullsLast(), table.status.asc().nullsLast(), table.nextRunAt.asc().nullsLast()),
	index("ix_scheduler_tasks_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_scheduler_tasks_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "scheduler_tasks_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "scheduler_tasks_user_id_fkey"
		}),
	unique("uq_scheduler_tasks_type_key").on(table.taskKey, table.taskType),
	check("ck_scheduler_tasks_scope_type", sql`(scope_type)::text = ANY (ARRAY[('instance'::character varying)::text, ('space'::character varying)::text, ('user'::character varying)::text, ('space_user'::character varying)::text])`),
	check("ck_scheduler_tasks_state_json_object", sql`jsonb_typeof(state_json) = 'object'::text`),
	check("ck_scheduler_tasks_metadata_json_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_scheduler_tasks_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])`),
]);
