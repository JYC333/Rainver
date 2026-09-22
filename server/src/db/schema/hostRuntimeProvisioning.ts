import {
	pgTable,
	primaryKey,
	foreignKey,
	check,
	varchar,
	integer,
	timestamp,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hosts } from "./hosts.js";

/** Durable desired/active state for control-plane-managed built-in runtimes. */
export const hostRuntimeProvisioning = pgTable("host_runtime_provisioning", {
	hostId: varchar("host_id", { length: 36 }).notNull(),
	runtimeKey: varchar("runtime_key", { length: 64 }).notNull(),
	desiredVersion: varchar("desired_version", { length: 64 }).notNull(),
	state: varchar({ length: 16 }).notNull(),
	installedVersion: varchar("installed_version", { length: 64 }),
	error: varchar({ length: 1000 }),
	attempts: integer().notNull().default(0),
	/** Doubles as the install-claim heartbeat: its owner refreshes it while waiting on the daemon, so a stale value means the owner died rather than that the install is slow. */
	lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	primaryKey({ columns: [table.hostId, table.runtimeKey], name: "host_runtime_provisioning_pkey" }),
	foreignKey({
		columns: [table.hostId],
		foreignColumns: [hosts.id],
		name: "host_runtime_provisioning_host_id_fkey",
	}).onDelete("cascade"),
	check("ck_host_runtime_provisioning_state", sql`${table.state} IN ('queued', 'installing', 'ready', 'failed')`),
	check("ck_host_runtime_provisioning_attempts", sql`${table.attempts} >= 0`),
]);
