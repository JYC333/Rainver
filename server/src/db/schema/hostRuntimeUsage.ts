import { pgTable, foreignKey, primaryKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { hosts } from "./hosts.js";

/**
 * The last subscription quota one copy of a runtime reported, cached here.
 *
 * The number itself is only readable on the host that holds the login (ADR
 * 0016 §7), and reading it costs a network round trip or a short-lived CLI
 * launch — too slow to do while rendering a host card, and rude to the vendor
 * to do on every page load. So the scheduled refresh writes here and the card
 * reads here. `available: false` with a reason is a real answer worth caching:
 * "this copy is not logged in" should not be re-probed every few seconds.
 *
 * A cache, and one gate reads it: Agent-triggered Room turns are held while
 * the login's window is past the Space's reserve line (`rooms/quotaGate.ts`,
 * which probes first when the reading is older than a minute). A missing or
 * unreadable row holds nothing — the turn is admitted and the CLI itself is
 * the last word. `checked_at` is what makes the staleness visible rather
 * than implied.
 */
export const hostRuntimeUsage = pgTable("host_runtime_usage", {
	hostId: varchar("host_id", { length: 36 }).notNull(),
	runtimeKey: varchar("runtime_key", { length: 64 }).notNull(),
	/** `own` or `managed:<version>` — the copy, not the runtime (B68). */
	installation: varchar({ length: 64 }).notNull(),
	/** The wire's `HostUsageQuota`: percentages, reset text, and a reason when unavailable. Never a credential. */
	quotaJson: jsonb("quota_json").notNull(),
	checkedAt: timestamp("checked_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	primaryKey({ columns: [table.hostId, table.runtimeKey, table.installation], name: "host_runtime_usage_pkey" }),
	foreignKey({
			columns: [table.hostId],
			foreignColumns: [hosts.id],
			name: "host_runtime_usage_host_id_fkey"
		}).onDelete("cascade"),
]);
