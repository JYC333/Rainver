import { pgTable, index, foreignKey, varchar, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { hosts } from "./hosts.js";
import { users } from "./auth.js";

/**
 * What changed about the runtimes an execution host runs, and when.
 *
 * An upgrade replaces the copy every Run of that Agent uses, and a rollback
 * puts the previous one back; both are instance-level changes someone needs to
 * be able to look up afterwards ("since when has this Agent been on 2.1?").
 * The Updates page shows them beside instance updates, which is the same
 * question asked about the images.
 *
 * Append-only and purely a record: nothing reads it to decide anything, and
 * the host's own report is the authority on what is installed now.
 */
export const hostRuntimeChanges = pgTable("host_runtime_changes", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	hostId: varchar("host_id", { length: 36 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	/** `install`, `upgrade`, `rollback` or `remove`. */
	action: varchar({ length: 16 }).notNull(),
	/** The version in place before the change, when there was one. */
	fromVersion: varchar("from_version", { length: 64 }),
	/** The version in place after it; null when the copy was removed. */
	toVersion: varchar("to_version", { length: 64 }),
	actorUserId: varchar("actor_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_host_runtime_changes_created_at").using("btree", table.createdAt.desc().nullsLast()),
	foreignKey({
			columns: [table.hostId],
			foreignColumns: [hosts.id],
			name: "host_runtime_changes_host_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "host_runtime_changes_actor_user_id_fkey"
		}).onDelete("set null"),
]);
