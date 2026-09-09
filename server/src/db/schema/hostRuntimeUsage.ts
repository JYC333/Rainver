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
 * Cache only. Nothing decides anything from these rows — no dispatch, no
 * budget, no gate — so a stale or missing row costs a stale panel and nothing
 * else. `checked_at` is what makes the staleness visible rather than implied.
 */
export const hostRuntimeUsage = pgTable("host_runtime_usage", {
	hostId: varchar("host_id", { length: 36 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	/** `own` or `managed:<version>` — the copy, not the runtime (B68). */
	installation: varchar({ length: 64 }).notNull(),
	/** The wire's `HostUsageQuota`: percentages, reset text, and a reason when unavailable. Never a credential. */
	quotaJson: jsonb("quota_json").notNull(),
	checkedAt: timestamp("checked_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	primaryKey({ columns: [table.hostId, table.adapterType, table.installation], name: "host_runtime_usage_pkey" }),
	foreignKey({
			columns: [table.hostId],
			foreignColumns: [hosts.id],
			name: "host_runtime_usage_host_id_fkey"
		}).onDelete("cascade"),
]);
