import { pgTable, index, unique, check, foreignKey, varchar, text, integer, bigint, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";

export const modelProviders = pgTable("model_providers", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	name: varchar({ length: 128 }).notNull(),
	providerType: varchar("provider_type", { length: 64 }).notNull(),
	baseUrl: varchar("base_url", { length: 512 }),
	networkProfileId: varchar("network_profile_id", { length: 36 }),
	defaultModel: varchar("default_model", { length: 256 }),
	enabled: boolean().notNull(),
	credentialId: varchar("credential_id", { length: 36 }),
	capabilitiesJson: jsonb("capabilities_json").notNull(),
	configJson: jsonb("config_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_model_providers_credential_id").using("btree", table.credentialId.asc().nullsLast()),
	index("ix_model_providers_network_profile_id").using("btree", table.networkProfileId.asc().nullsLast()),
	index("ix_model_providers_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_model_providers_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.credentialId],
			foreignColumns: [credentials.id],
			name: "model_providers_credential_id_fkey"
		}),
	foreignKey({
			columns: [table.networkProfileId],
			foreignColumns: [networkProfiles.id],
			name: "model_providers_network_profile_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "model_providers_owner_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "model_providers_space_id_fkey"
		}),
]);

export const networkProfiles = pgTable("network_profiles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	mode: varchar({ length: 32 }).notNull(),
	proxyUrl: varchar("proxy_url", { length: 512 }),
	noProxy: text("no_proxy"),
	enabled: boolean().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_network_profiles_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "network_profiles_space_id_fkey"
		}),
	check("ck_network_profiles_mode", sql`(mode)::text = ANY (ARRAY[('direct'::character varying)::text, ('http_proxy'::character varying)::text])`),
]);

export const credentials = pgTable("credentials", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	credentialType: varchar("credential_type", { length: 64 }).notNull(),
	secretRef: text("secret_ref").notNull(),
	scopesJson: jsonb("scopes_json").notNull(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_credentials_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_credentials_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "credentials_space_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "credentials_owner_user_id_fkey"
		}).onDelete("set null"),
]);

export const modelProviderCredentials = pgTable("model_provider_credentials", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	providerId: varchar("provider_id", { length: 36 }).notNull(),
	credentialId: varchar("credential_id", { length: 36 }).notNull(),
	position: integer().notNull(),
	enabled: boolean().notNull(),
	healthy: boolean().notNull(),
	cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: 'string' }),
	lastFailureClass: varchar("last_failure_class", { length: 32 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestCount: bigint("request_count", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	failureCount: bigint("failure_count", { mode: "number" }).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_model_provider_credentials_provider_id").using("btree", table.providerId.asc().nullsLast()),
	index("ix_model_provider_credentials_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.credentialId],
			foreignColumns: [credentials.id],
			name: "model_provider_credentials_credential_id_fkey"
		}),
	foreignKey({
			columns: [table.providerId],
			foreignColumns: [modelProviders.id],
			name: "model_provider_credentials_provider_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "model_provider_credentials_space_id_fkey"
		}),
	unique("uq_model_provider_credentials_provider_credential").on(table.credentialId, table.providerId),
	check("ck_model_provider_credentials_failure_class", sql`((last_failure_class)::text = ANY (ARRAY[('rate_limit'::character varying)::text, ('payment_required'::character varying)::text, ('unauthorized'::character varying)::text, ('quota_exhausted'::character varying)::text, ('transient'::character varying)::text, ('permanent'::character varying)::text])) OR (last_failure_class IS NULL)`),
]);

export const modelProviderSpaceGrants = pgTable("model_provider_space_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	providerId: varchar("provider_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }),
	enabled: boolean().notNull(),
	isDefault: boolean("is_default").notNull(),
	networkProfileId: varchar("network_profile_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_model_provider_space_grants_network_profile_id").using("btree", table.networkProfileId.asc().nullsLast()),
	index("ix_model_provider_space_grants_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_model_provider_space_grants_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.grantedByUserId],
			foreignColumns: [users.id],
			name: "model_provider_space_grants_granted_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.networkProfileId],
			foreignColumns: [networkProfiles.id],
			name: "model_provider_space_grants_network_profile_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "model_provider_space_grants_owner_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.providerId],
			foreignColumns: [modelProviders.id],
			name: "model_provider_space_grants_provider_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "model_provider_space_grants_space_id_fkey"
		}).onDelete("cascade"),
	unique("uq_model_provider_space_grants_provider_space").on(table.providerId, table.spaceId),
]);

export const providerTaskPolicies = pgTable("provider_task_policies", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	task: varchar({ length: 64 }).notNull(),
	chainJson: jsonb("chain_json").notNull(),
	enabled: boolean().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_provider_task_policies_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "provider_task_policies_space_id_fkey"
		}),
	unique("uq_provider_task_policies_space_task").on(table.spaceId, table.task),
]);
