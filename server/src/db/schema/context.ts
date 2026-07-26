import { pgTable, index, uniqueIndex, check, foreignKey, varchar, text, integer, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { sessions } from "./sessions";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { artifacts } from "./artifacts";

export const contextArtifactRevocations = pgTable("context_artifact_revocations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	artifactId: varchar("artifact_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 16 }).notNull(),
	scopeId: varchar("scope_id", { length: 36 }).notNull(),
	reason: text(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	deletedByUserId: varchar("deleted_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_context_artifact_revocations_artifact_id").using("btree", table.artifactId.asc().nullsLast()),
	index("ix_context_artifact_revocations_space_scope").using("btree", table.spaceId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()),
	uniqueIndex("uq_context_artifact_revocations_active_scope").using("btree", table.spaceId.asc().nullsLast(), table.artifactId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()).where(sql`(deleted_at IS NULL)`),
	foreignKey({
			columns: [table.artifactId],
			foreignColumns: [artifacts.id],
			name: "context_artifact_revocations_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "context_artifact_revocations_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.deletedByUserId],
			foreignColumns: [users.id],
			name: "context_artifact_revocations_deleted_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "context_artifact_revocations_space_id_fkey"
		}),
	check("ck_context_artifact_revocations_scope_type", sql`(scope_type)::text = ANY (ARRAY[('project_folder'::character varying)::text, ('project'::character varying)::text])`),
]);

export const contextDigests = pgTable("context_digests", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 32 }).notNull(),
	scopeId: varchar("scope_id", { length: 36 }),
	digestType: varchar("digest_type", { length: 32 }).notNull(),
	version: integer().default(1).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	content: text(),
	sourceMemoryIdsJson: jsonb("source_memory_ids_json"),
	sourcePolicyIdsJson: jsonb("source_policy_ids_json"),
	sourceRelationIdsJson: jsonb("source_relation_ids_json"),
	sourceHash: varchar("source_hash", { length: 128 }),
	contentHash: varchar("content_hash", { length: 128 }),
	dirtySince: timestamp("dirty_since", { withTimezone: true, mode: 'string' }),
	dirtyReasonJson: jsonb("dirty_reason_json"),
	dirtyCount: integer("dirty_count").default(0).notNull(),
	generatedAt: timestamp("generated_at", { withTimezone: true, mode: 'string' }),
	createdFromRunId: varchar("created_from_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_context_digests_digest_type").using("btree", table.digestType.asc().nullsLast()),
	index("ix_context_digests_scope_id").using("btree", table.scopeId.asc().nullsLast()),
	index("ix_context_digests_scope_type").using("btree", table.scopeType.asc().nullsLast()),
	index("ix_context_digests_source_hash").using("btree", table.sourceHash.asc().nullsLast()),
	index("ix_context_digests_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_context_digests_status").using("btree", table.status.asc().nullsLast()),
	uniqueIndex("uq_context_digests_current_scope").using("btree", sql`space_id`, sql`scope_type`, sql`COALESCE(scope_id, ''::character varying)`, sql`digest_type`).where(sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('dirty'::character varying)::text]))`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "context_digests_space_id_fkey"
		}),
	check("ck_context_digests_digest_type", sql`(digest_type)::text = ANY (ARRAY[('policy_bundle'::character varying)::text, ('project_folder'::character varying)::text, ('agent'::character varying)::text])`),
	check("ck_context_digests_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('dirty'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text])`),
]);

export const contextProfiles = pgTable("context_profiles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 32 }).notNull(),
	scopeId: varchar("scope_id", { length: 128 }),
	status: varchar({ length: 32 }).notNull(),
	version: integer().default(1).notNull(),
	contextPackJson: jsonb("context_pack_json").default({}).notNull(),
	routingManifestJson: jsonb("routing_manifest_json").default({}).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_context_profiles_scope").using("btree", table.spaceId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()),
	index("ix_context_profiles_status").using("btree", table.status.asc().nullsLast()),
	uniqueIndex("uq_context_profiles_active_scope").using("btree", sql`space_id`, sql`scope_type`, sql`COALESCE(scope_id, ''::character varying)`).where(sql`((status)::text = 'active'::text)`),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "context_profiles_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "context_profiles_space_id_fkey"
		}),
	check("ck_context_profiles_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_context_profiles_context_pack_object", sql`jsonb_typeof(context_pack_json) = 'object'::text`),
	check("ck_context_profiles_routing_manifest_object", sql`jsonb_typeof(routing_manifest_json) = 'object'::text`),
	check("ck_context_profiles_scope_id", sql`(((scope_type)::text = 'space'::text) AND (scope_id IS NULL)) OR (((scope_type)::text <> 'space'::text) AND (scope_id IS NOT NULL))`),
	check("ck_context_profiles_scope_type", sql`(scope_type)::text = ANY (ARRAY[('space'::character varying)::text, ('project'::character varying)::text, ('project_folder'::character varying)::text, ('agent'::character varying)::text, ('user'::character varying)::text])`),
	check("ck_context_profiles_version_positive", sql`version >= 1`),
]);

export const contextSnapshots = pgTable("context_snapshots", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceRefsJson: jsonb("source_refs_json").notNull(),
	compiledSummary: text("compiled_summary"),
	tokenEstimate: integer("token_estimate"),
	relevantPeriodStart: timestamp("relevant_period_start", { withTimezone: true, mode: 'string' }),
	relevantPeriodEnd: timestamp("relevant_period_end", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	compiledPrefixText: text("compiled_prefix_text"),
	compiledTailText: text("compiled_tail_text"),
	compiledPrefixRef: varchar("compiled_prefix_ref", { length: 1024 }),
	compiledTailRef: varchar("compiled_tail_ref", { length: 1024 }),
	prefixHash: varchar("prefix_hash", { length: 128 }),
	tailHash: varchar("tail_hash", { length: 128 }),
	compilerVersion: varchar("compiler_version", { length: 64 }),
	retrievalTraceJson: jsonb("retrieval_trace_json"),
	tokenBudgetJson: jsonb("token_budget_json"),
	policyBundleVersion: varchar("policy_bundle_version", { length: 64 }),
	memoryDigestVersion: varchar("memory_digest_version", { length: 64 }),
	projectFolderDigestVersion: varchar("project_folder_digest_version", { length: 64 }),
	includedMemoryRefsJson: jsonb("included_memory_refs_json"),
	includedEvidenceRefsJson: jsonb("included_evidence_refs_json"),
	includedFileRefsJson: jsonb("included_file_refs_json"),
	includedDocRefsJson: jsonb("included_doc_refs_json"),
	redactionsJson: jsonb("redactions_json"),
	dataExposureLevel: varchar("data_exposure_level", { length: 64 }),
	renderedContextUri: varchar("rendered_context_uri", { length: 1024 }),
	renderedContextText: text("rendered_context_text"),
	agentId: varchar("agent_id", { length: 36 }),
	sessionId: varchar("session_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }),
	requestJson: jsonb("request_json"),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_context_snapshots_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_context_snapshots_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_context_snapshots_session_id").using("btree", table.sessionId.asc().nullsLast()),
	index("ix_context_snapshots_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "context_snapshots_space_id_fkey"
		}),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "fk_context_snapshots_agent_id_agents"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "fk_context_snapshots_run_id_runs"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "fk_context_snapshots_session_id_sessions"
		}).onDelete("set null"),
	check("ck_context_snapshots_data_exposure_level", sql`(data_exposure_level IS NULL) OR ((data_exposure_level)::text = ANY (ARRAY[('local_only'::character varying)::text, ('model_provider'::character varying)::text, ('vendor_platform'::character varying)::text, ('third_party_tools'::character varying)::text, ('unknown'::character varying)::text]))`),
]);

export const contextSnapshotItems = pgTable("context_snapshot_items", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	contextSnapshotId: varchar("context_snapshot_id", { length: 36 }).notNull(),
	itemType: varchar("item_type", { length: 32 }).notNull(),
	itemId: varchar("item_id", { length: 36 }),
	title: varchar({ length: 512 }),
	excerpt: text(),
	score: doublePrecision(),
	reason: varchar({ length: 256 }),
	tokenCount: integer("token_count"),
	metadataJson: jsonb("metadata_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_context_snapshot_items_context_snapshot_id").using("btree", table.contextSnapshotId.asc().nullsLast()),
	index("ix_context_snapshot_items_item_type").using("btree", table.itemType.asc().nullsLast()),
	foreignKey({
			columns: [table.contextSnapshotId],
			foreignColumns: [contextSnapshots.id],
			name: "context_snapshot_items_context_snapshot_id_fkey"
		}),
	check("ck_context_snapshot_items_item_type", sql`(item_type)::text = ANY (ARRAY[('memory'::character varying)::text, ('knowledge_item'::character varying)::text, ('source'::character varying)::text, ('activity_record'::character varying)::text, ('project_public_summary'::character varying)::text, ('task'::character varying)::text, ('idea'::character varying)::text, ('project'::character varying)::text, ('project_folder'::character varying)::text, ('run'::character varying)::text, ('proposal'::character varying)::text, ('artifact'::character varying)::text, ('manual_context'::character varying)::text])`),
]);
