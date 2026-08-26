import { pgTable, index, check, foreignKey, varchar, text, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hostTaskThreads } from "./hostTaskThreads.js";
import { modelProviders } from "./providers.js";
import { runs } from "./runs.js";
import { tasks } from "./tasks.js";

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
	/**
	 * execution-topology-and-project-control-plane-plan.md P1.7: which Task
	 * this message dispatches under — write-once, set at enqueue time and
	 * carried onto the Run `advanceThreadQueue` creates for it (`task_runs`,
	 * budget admission). A thread has no `task_id` of its own (it can outlive
	 * any one Task across P1.7's queue-continuation use), so each message
	 * fixes this at the moment it is queued, not the thread at creation.
	 */
	taskId: varchar("task_id", { length: 36 }).notNull(),
	prompt: text().notNull(),
	status: varchar({ length: 16 }).notNull().default('queued'),
	/**
	 * The ModelProvider binding resolved for this message **at dispatch
	 * time** (per-dispatch override,
	 * else the Host×adapter default, else null for the machine's ambient
	 * login). Snapshotted here rather than resolved when the queue advances,
	 * for two reasons: validation can fail the dispatch request itself with a
	 * 422 the sender sees, and a message already queued does not silently
	 * change backend because someone edited the Host default in between.
	 *
	 * This row is the **provenance** record for a *dispatched* run.
	 * `runs.model_provider_id` is not evidence of a binding before execution —
	 * `PgRouteDecisionRepository.routeRun` stamps that column for any routed run
	 * before host kind is even resolved, so a remote run created by some other
	 * path can carry a provider it never used. A run with no row here is not
	 * unbound: execution falls back to the Host default, then writes back what
	 * it actually used.
	 */
	modelProviderId: varchar("model_provider_id", { length: 36 }),
	model: varchar({ length: 256 }),
	// Separate from `model` because ACP exposes them as two settings and a
	// model id can contain brackets of its own — Claude's `claude-fable-5[1m]`
	// is one name, not a model and an effort. Encoding the pair into one string
	// therefore cannot be decoded again.
	reasoningEffort: varchar("reasoning_effort", { length: 32 }),
	runId: varchar("run_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_host_thread_messages_thread_id").using("btree", table.hostTaskThreadId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_host_thread_messages_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_host_thread_messages_task_id").using("btree", table.taskId.asc().nullsLast()),
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
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "host_thread_messages_task_id_fkey"
		}),
	foreignKey({
			columns: [table.modelProviderId],
			foreignColumns: [modelProviders.id],
			name: "host_thread_messages_model_provider_id_fkey"
		}),
	check("ck_host_thread_messages_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('dispatched'::character varying)::text, ('withdrawn'::character varying)::text])`),
	check("ck_host_thread_messages_run_id_consistency", sql`(status = 'dispatched') = (run_id IS NOT NULL)`),
]);
