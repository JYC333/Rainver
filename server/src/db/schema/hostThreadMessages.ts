import { pgTable, index, check, foreignKey, varchar, text, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hostTaskThreads } from "./hostTaskThreads";
import { runs } from "./runs";

/**
 * control-center-phase2-plan.md P2 (C4): the durable record of every
 * message a user has sent into a task thread — `queued` (waiting its turn),
 * `dispatched` (became `run_id`'s Run), or `withdrawn` (never dispatched,
 * the user pulled it back). Rows are never deleted once created, including
 * `dispatched`/`withdrawn` ones: `runs.prompt` is unconditionally redacted
 * to null on every API read (`runReadModel.ts`, by design — "canonical
 * input remains in its owning Message/Run records"), so this table is that
 * canonical, readable record for a remote task thread's conversation, not
 * only a pending-work buffer. Ordered by `created_at` (no separate cursor
 * column — unlike `host_thread_events`, nothing polls this table for live
 * updates in this phase).
 */
export const hostThreadMessages = pgTable("host_thread_messages", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	hostTaskThreadId: varchar("host_task_thread_id", { length: 36 }).notNull(),
	prompt: text().notNull(),
	status: varchar({ length: 16 }).notNull().default('queued'),
	runId: varchar("run_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_host_thread_messages_thread_id").using("btree", table.hostTaskThreadId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_host_thread_messages_run_id").using("btree", table.runId.asc().nullsLast()),
	foreignKey({
			columns: [table.hostTaskThreadId],
			foreignColumns: [hostTaskThreads.id],
			name: "host_thread_messages_thread_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "host_thread_messages_run_id_fkey"
		}),
	check("ck_host_thread_messages_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('dispatched'::character varying)::text, ('withdrawn'::character varying)::text])`),
	check("ck_host_thread_messages_run_id_consistency", sql`(status = 'dispatched') = (run_id IS NOT NULL)`),
]);
