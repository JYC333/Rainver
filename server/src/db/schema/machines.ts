import { pgTable, index, foreignKey, varchar, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * execution-topology-and-project-control-plane-plan.md P1 / D1: a physical
 * device's identity — nothing else. Answers "which device?", never "which
 * execution environment?" (that's `hosts`/ExecutionHost) or "which checkout?"
 * (that's `workspace_locations`). Carries no filesystem path, runtime
 * availability, CLI login state, or capability data — those stay on the
 * `hosts` row(s) it owns, since one Machine can run several execution
 * environments (Windows native + WSL on one desktop is the driving case).
 *
 * `owner_user_id` is nullable for the same reason as `hosts.owner_user_id`:
 * the system Machine seeded for the server host (`ensureServerMachineId`)
 * belongs to no individual user.
 */
export const machines = pgTable("machines", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	displayName: varchar("display_name", { length: 120 }).notNull(),
	deviceKind: varchar("device_kind", { length: 32 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_machines_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "machines_owner_user_id_fkey"
		}).onDelete("cascade"),
]);
