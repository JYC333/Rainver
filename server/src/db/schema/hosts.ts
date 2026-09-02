import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { machines } from "./machines.js";

/**
 * An execution host per ADR 0016: the server host (exactly one row, seeded,
 * `owner_user_id` NULL) or a personal machine a user has paired in
 * trusted-host mode. `token_hash` doubles as the pending-pairing-code hash
 * before a daemon completes registration and as the long-lived bearer-token
 * hash afterward — there is no separate pairing-code table; a pairing code
 * is a host row in `pending_pairing` status.
 *
 * execution-topology-and-project-control-plane-plan.md P1 / D1: this row is
 * an ExecutionHost — one execution environment on a physical `machine_id`,
 * not the device itself. A single Windows desktop is one Machine with two
 * ExecutionHost rows (Windows native, WSL), each with its own
 * `environment_kind`, filesystem namespace, and daemon connection.
 */
export const hosts = pgTable("hosts", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	machineId: varchar("machine_id", { length: 36 }).notNull(),
	environmentKind: varchar("environment_kind", { length: 24 }).notNull(),
	name: varchar({ length: 120 }).notNull(),
	kind: varchar({ length: 16 }).notNull(),
	status: varchar({ length: 24 }).notNull(),
	tokenHash: varchar("token_hash", { length: 128 }),
	pairingCodeExpiresAt: timestamp("pairing_code_expires_at", { withTimezone: true, mode: 'string' }),
	lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true, mode: 'string' }),
	platform: varchar({ length: 64 }),
	arch: varchar({ length: 32 }),
	daemonVersion: varchar("daemon_version", { length: 32 }),
	// The owner's preferred CLI on this machine: what auto-provisioned
	// Assistant backends and dispatch defaults pick first. Null = the built-in
	// preference ordering.
	defaultAdapterType: varchar("default_adapter_type", { length: 64 }),
	/**
	 * The control-plane address this daemon actually reaches, as it reports it.
	 * The server cannot guess it — its own in-network hostname is a Compose
	 * service name no paired machine can resolve — and it is what lets a
	 * provider-proxy address be derived instead of configured.
	 */
	daemonServerUrl: varchar("daemon_server_url", { length: 512 }),
	/**
	 * Explicit provider-proxy base URL for this host, when the derived one is
	 * wrong: a reverse proxy in front of the API, or a proxy port published
	 * somewhere other than the API's host. Null means derive.
	 */
	providerProxyBaseUrl: varchar("provider_proxy_base_url", { length: 512 }),
	capabilitiesJson: jsonb("capabilities_json"),
	managedWorkspacesJson: jsonb("managed_workspaces_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_hosts_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_hosts_status").using("btree", table.status.asc().nullsLast()),
	index("ix_hosts_machine_id").using("btree", table.machineId.asc().nullsLast()),
	unique("uq_hosts_token_hash").on(table.tokenHash),
	// Allows workspace_locations to enforce the immutable host-kind copy with
	// a composite foreign key instead of a trigger.
	unique("uq_hosts_id_kind").on(table.id, table.kind),
	// At most one server host ever exists (seeded once at bootstrap).
	uniqueIndex("uq_hosts_single_server").using("btree", table.kind.asc().nullsLast()).where(sql`kind = 'server'`),
	// A remote host's name must be unique among the hosts one user owns;
	// the server host (owner_user_id NULL) is exempt via uq_hosts_single_server above.
	uniqueIndex("uq_hosts_owner_name")
		.using("btree", table.ownerUserId.asc().nullsLast(), table.name.asc().nullsLast())
		.where(sql`owner_user_id IS NOT NULL`),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "hosts_owner_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.machineId],
			foreignColumns: [machines.id],
			name: "hosts_machine_id_fkey"
		}),
	check("ck_hosts_kind", sql`kind IN ('server', 'remote')`),
	check("ck_hosts_status", sql`status IN ('pending_pairing', 'online', 'offline', 'revoked')`),
	check("ck_hosts_environment_kind", sql`environment_kind IN ('windows_native', 'wsl', 'linux_native', 'macos_native', 'vm', 'container', 'server')`),
	// The server host is never owned by an individual user and never
	// authenticates over the daemon protocol.
	check("ck_hosts_server_no_owner", sql`kind <> 'server' OR owner_user_id IS NULL`),
	check("ck_hosts_remote_has_owner", sql`kind <> 'remote' OR owner_user_id IS NOT NULL`),
	check("ck_hosts_server_environment", sql`kind <> 'server' OR environment_kind = 'server'`),
]);
