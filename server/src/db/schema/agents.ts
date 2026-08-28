import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { activityRecords } from "./activity.js";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";
import { modelProviders, networkProfiles } from "./providers.js";
import { proposals } from "./proposals.js";
import { projects } from "./projects.js";

export const agents = pgTable("agents", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	roleInstruction: text("role_instruction"),
	status: varchar({ length: 32 }).notNull(),
	agentKind: varchar("agent_kind", { length: 32 }).default('standard').notNull(),
	currentVersionId: varchar("current_version_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	visibility: varchar({ length: 32 }).notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_agents_agent_kind").using("btree", table.agentKind.asc().nullsLast()),
	index("ix_agents_current_version_id").using("btree", table.currentVersionId.asc().nullsLast()),
	index("ix_agents_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_agents_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_agents_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_agents_status").using("btree", table.status.asc().nullsLast()),
	// One Assistant per Project, plus one for the Space itself. Two indexes
	// rather than one over `(space_id, project_id)`, because a NULL project_id
	// does not collide in a composite unique index — the Space-level instance
	// would be unconstrained, which is the one the `/home` chat depends on.
	uniqueIndex("uq_agents_system_assistant_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`(((agent_kind)::text = 'system_assistant'::text) AND ((status)::text = 'active'::text) AND (project_id IS NULL))`),
	uniqueIndex("uq_agents_system_assistant_per_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()).where(sql`(((agent_kind)::text = 'system_assistant'::text) AND ((status)::text = 'active'::text) AND (project_id IS NOT NULL))`),
	uniqueIndex("uq_agents_system_source_post_processor_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`(((agent_kind)::text = 'system_source_post_processor'::text) AND ((status)::text = 'active'::text))`),
	uniqueIndex("uq_agents_system_source_annotator_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`(((agent_kind)::text = 'system_source_annotator'::text) AND ((status)::text = 'active'::text))`),
	uniqueIndex("uq_agents_system_research_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`(((agent_kind)::text = 'system_research'::text) AND ((status)::text = 'active'::text))`),
	uniqueIndex("uq_agents_system_remote_dispatch_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`(((agent_kind)::text = 'system_remote_dispatch'::text) AND ((status)::text = 'active'::text))`),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "agents_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "agents_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "fk_agents_project_id_projects"
		}),
	foreignKey({
			columns: [table.currentVersionId, table.id, table.spaceId],
			foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.spaceId],
			name: "fk_agents_current_version_id_agent_versions"
		}),
	unique("uq_agents_space_id_id").on(table.id, table.spaceId),
	check("ck_agents_agent_kind", sql`(agent_kind)::text = ANY (ARRAY[('standard'::character varying)::text, ('system_assistant'::character varying)::text, ('system_source_post_processor'::character varying)::text, ('system_source_annotator'::character varying)::text, ('system_research'::character varying)::text, ('system_remote_dispatch'::character varying)::text])`),
	check("ck_agents_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text, ('archived'::character varying)::text, ('disabled'::character varying)::text])`),
	check("ck_agents_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_agents_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_agents_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const actors = pgTable("actors", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	actorType: varchar("actor_type", { length: 32 }).notNull(),
	userId: varchar("user_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	serviceName: varchar("service_name", { length: 128 }),
	displayName: varchar("display_name", { length: 256 }),
	status: varchar({ length: 32 }).default('active').notNull(),
	metadataJson: jsonb("metadata_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_actors_actor_type").using("btree", table.actorType.asc().nullsLast()),
	index("ix_actors_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_actors_service_name").using("btree", table.serviceName.asc().nullsLast()),
	index("ix_actors_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_actors_status").using("btree", table.status.asc().nullsLast()),
	index("ix_actors_user_id").using("btree", table.userId.asc().nullsLast()),
	// One identity per person and per service in a Space. Without these the
	// resolver's insert-on-conflict was decorative: two concurrent first writes
	// for the same person produced two actors, and every audit row after that
	// named one of them at random.
	uniqueIndex("uq_actors_user_per_space").using("btree", table.spaceId.asc().nullsLast(), table.userId.asc().nullsLast()).where(sql`actor_type = 'user' AND status = 'active'`),
	uniqueIndex("uq_actors_service_per_space").using("btree", table.spaceId.asc().nullsLast(), table.actorType.asc().nullsLast(), table.serviceName.asc().nullsLast()).where(sql`service_name IS NOT NULL AND status = 'active'`),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "actors_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "actors_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "actors_user_id_fkey"
		}),
	check("ck_actors_actor_type", sql`(actor_type)::text = ANY (ARRAY[('user'::character varying)::text, ('agent'::character varying)::text, ('system'::character varying)::text, ('automation'::character varying)::text, ('connector'::character varying)::text, ('integration'::character varying)::text, ('service'::character varying)::text, ('job'::character varying)::text])`),
	check("ck_actors_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const agentVersions = pgTable("agent_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	versionLabel: varchar("version_label", { length: 64 }).notNull(),
	modelProviderId: varchar("model_provider_id", { length: 36 }),
	modelName: varchar("model_name", { length: 256 }),
	systemPrompt: text("system_prompt"),
	promptProvenanceJson: jsonb("prompt_provenance_json"),
	modelConfigJson: jsonb("model_config_json").notNull(),
	runtimeConfigJson: jsonb("runtime_config_json").notNull(),
	contextPolicyJson: jsonb("context_policy_json").notNull(),
	memoryPolicyJson: jsonb("memory_policy_json").notNull(),
	capabilitiesJson: jsonb("capabilities_json").notNull(),
	toolPermissionsJson: jsonb("tool_permissions_json").notNull(),
	runtimePolicyJson: jsonb("runtime_policy_json").notNull(),
	toolPolicyJson: jsonb("tool_policy_json").default({}).notNull(),
	outputPolicyJson: jsonb("output_policy_json").default({}).notNull(),
	scheduleConfigJson: jsonb("schedule_config_json").default({}).notNull(),
	outputSchemaJson: jsonb("output_schema_json").default({}).notNull(),
	sourceProposalId: varchar("source_proposal_id", { length: 36 }),
	sourceActivityId: varchar("source_activity_id", { length: 36 }),
	/**
	 * Set when this version is a materialization of a managed seed, naming
	 * which seed. Non-null means "keep me in step with it"; null means the
	 * instance has been given a version of its own and must be left alone.
	 * Without it, re-materializing the seed would silently overwrite work a
	 * person or an evolution proposal did on one Project's Assistant.
	 */
	followsSeedKey: varchar("follows_seed_key", { length: 128 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_agent_versions_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_agent_versions_model_provider_id").using("btree", table.modelProviderId.asc().nullsLast()),
	index("ix_agent_versions_source_activity_id").using("btree", table.sourceActivityId.asc().nullsLast()),
	index("ix_agent_versions_source_proposal_id").using("btree", table.sourceProposalId.asc().nullsLast()),
	index("ix_agent_versions_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "agent_versions_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.modelProviderId],
			foreignColumns: [modelProviders.id],
			name: "agent_versions_model_provider_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "agent_versions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceActivityId],
			foreignColumns: [activityRecords.id],
			name: "fk_agent_versions_source_activity_id_activity_records"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sourceProposalId],
			foreignColumns: [proposals.id],
			name: "fk_agent_versions_source_proposal_id_proposals"
		}).onDelete("set null"),
	unique("uq_agent_versions_id_agent_space").on(table.id, table.agentId, table.spaceId),
	unique("uq_agent_versions_agent_label").on(table.agentId, table.versionLabel),
]);

export const agentRuntimeProfiles = pgTable("agent_runtime_profiles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	modelProviderId: varchar("model_provider_id", { length: 36 }),
	modelName: varchar("model_name", { length: 256 }),
	runtimeConfigJson: jsonb("runtime_config_json").default({}).notNull(),
	runtimePolicyJson: jsonb("runtime_policy_json").default({}).notNull(),
	enabled: boolean().default(true).notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_agent_runtime_profiles_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_agent_runtime_profiles_model_provider_id").using("btree", table.modelProviderId.asc().nullsLast()),
	index("ix_agent_runtime_profiles_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("uq_agent_runtime_profiles_default_per_agent").using("btree", table.agentId.asc().nullsLast()).where(sql`(is_default = true)`),
	foreignKey({
			columns: [table.agentId, table.spaceId],
			foreignColumns: [agents.id, agents.spaceId],
			name: "agent_runtime_profiles_agent_scope_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.modelProviderId],
			foreignColumns: [modelProviders.id],
			name: "agent_runtime_profiles_model_provider_id_fkey"
		}),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "agent_runtime_profiles_space_id_fkey"
	}).onDelete("cascade"),
	unique("uq_agent_runtime_profiles_id_space_agent").on(table.id, table.spaceId, table.agentId),
	unique("uq_agent_runtime_profiles_agent_name").on(table.agentId, table.name),
]);

export const cliCredentialProfiles = pgTable("cli_credential_profiles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	runtime: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 128 }).notNull(),
	sourcePath: text("source_path").notNull(),
	targetPath: text("target_path").notNull(),
	readonly: boolean().notNull(),
	notes: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_cli_credential_profiles_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_cli_credential_profiles_runtime").using("btree", table.runtime.asc().nullsLast()),
	foreignKey({
		columns: [table.ownerUserId],
		foreignColumns: [users.id],
		name: "cli_credential_profiles_owner_user_id_fkey"
	}).onDelete("cascade"),
	unique("uq_cli_credential_profiles_id_owner").on(table.id, table.ownerUserId),
	unique("uq_cli_credential_profiles_owner_runtime_name").on(table.name, table.ownerUserId, table.runtime),
]);

export const cliCredentialEvents = pgTable("cli_credential_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }),
	runtimeAdapterType: varchar("runtime_adapter_type", { length: 64 }),
	credentialProfileId: varchar("credential_profile_id", { length: 128 }),
	credentialSource: varchar("credential_source", { length: 32 }).notNull(),
	triggerOrigin: varchar("trigger_origin", { length: 64 }),
	fallbackUsed: boolean("fallback_used").notNull(),
	fallbackReason: varchar("fallback_reason", { length: 128 }),
	brokerError: boolean("broker_error").notNull(),
	cleanupStatus: varchar("cleanup_status", { length: 32 }).notNull(),
	action: varchar({ length: 64 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_cli_credential_events_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_cli_credential_events_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "cli_credential_events_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "cli_credential_events_space_id_fkey"
		}),
	check("ck_cli_credential_events_credential_source", sql`(credential_source)::text = ANY (ARRAY[('profile'::character varying)::text, ('container_default'::character varying)::text, ('none'::character varying)::text])`),
]);

export const cliCredentialSpaceGrants = pgTable("cli_credential_space_grants", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	profileId: varchar("profile_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	grantedByUserId: varchar("granted_by_user_id", { length: 36 }),
	enabled: boolean().notNull(),
	isDefault: boolean("is_default").notNull(),
	networkProfileId: varchar("network_profile_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_cli_credential_space_grants_network_profile_id").using("btree", table.networkProfileId.asc().nullsLast()),
	index("ix_cli_credential_space_grants_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_cli_credential_space_grants_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.grantedByUserId],
			foreignColumns: [users.id],
			name: "cli_credential_space_grants_granted_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.networkProfileId],
			foreignColumns: [networkProfiles.id],
			name: "cli_credential_space_grants_network_profile_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "cli_credential_space_grants_owner_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.profileId],
			foreignColumns: [cliCredentialProfiles.id],
			name: "cli_credential_space_grants_profile_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "cli_credential_space_grants_space_id_fkey"
		}).onDelete("cascade"),
	unique("uq_cli_credential_space_grants_profile_space").on(table.profileId, table.spaceId),
]);
