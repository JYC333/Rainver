import { pgTable, index, unique, foreignKey, varchar, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { hosts } from "./hosts";
import { modelProviders } from "./providers";
import { users } from "./auth";

/**
 * The control plane's default answer to "which model backend does this
 * host's <adapter> run against". One row per
 * (Host, adapter_type); absence means the run uses the machine's own ambient
 * login state, which is the pre-existing behavior and stays the default.
 *
 * Keyed by Host and adapter only, not by Space. A ModelProvider is reachable
 * through a Space grant, so a binding whose provider has no enabled grant in
 * the dispatching Space fails validation at dispatch with a 422 rather than
 * silently falling back — loud, and it keeps one host from carrying a
 * different default per Space before anything needs that.
 *
 * `model` is optional: null means the provider's own default/first available
 * model is used, matching how a server-host provider binding resolves a model
 * (`buildClaudeProviderBinding` and siblings in `runs/runtimeProviderBinding.ts`).
 */
export const hostRuntimeProviderBindings = pgTable("host_runtime_provider_bindings", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	hostId: varchar("host_id", { length: 36 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	modelProviderId: varchar("model_provider_id", { length: 36 }).notNull(),
	model: varchar({ length: 256 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_host_runtime_provider_bindings_host_adapter").on(table.hostId, table.adapterType),
	index("ix_host_runtime_provider_bindings_provider").using("btree", table.modelProviderId.asc().nullsLast()),
	foreignKey({
			columns: [table.hostId],
			foreignColumns: [hosts.id],
			name: "host_runtime_provider_bindings_host_id_fkey"
		}).onDelete("cascade"),
	// Referential backstop only. Removing a provider through the product is a
	// *soft* delete (`enabled = false` plus disabled grants), so this cascade
	// does not fire on that path — the binding survives and every later
	// dispatch on this host fails validation instead. That failure is
	// deliberate: falling back to the machine's login because a provider went
	// away would be the silent substitution this whole path exists to prevent.
	// What it costs is a clear message and a visible stale binding, which
	// resolution and the Command Center handle.
	foreignKey({
			columns: [table.modelProviderId],
			foreignColumns: [modelProviders.id],
			name: "host_runtime_provider_bindings_model_provider_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "host_runtime_provider_bindings_created_by_user_id_fkey"
		}),
]);
