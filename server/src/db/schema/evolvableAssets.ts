import { pgTable, index, uniqueIndex, check, foreignKey, varchar, text, integer, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { proposals } from "./proposals.js";
import { artifacts } from "./artifacts.js";
import { runs } from "./runs.js";
import { evolutionTargets } from "./evolution.js";

// Generic prompt/workflow template evolution foundation. Not Academic
// Research-specific — Academic Research is one consumer. Extends the
// existing `evolution` foundation (evolution_targets/signals/strategy_assets/
// experiences) rather than duplicating it.

// 'capability' is intentionally excluded: capability_versions is the sole
// version authority for capabilities, to avoid a second source of truth.
const ASSET_TYPES = sql`ARRAY[('prompt_template'::character varying)::text, ('workflow_template'::character varying)::text, ('agent_config'::character varying)::text, ('runtime_skill_binding'::character varying)::text, ('source_post_processing_rule'::character varying)::text]`;
const SCOPE_TYPES = sql`ARRAY[('system'::character varying)::text, ('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text]`;

export const evolvableAssets = pgTable("evolvable_assets", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	assetType: varchar("asset_type", { length: 32 }).notNull(),
	assetKey: varchar("asset_key", { length: 160 }).notNull(),
	displayName: varchar("display_name", { length: 256 }).notNull(),
	description: text(),
	ownerScopeType: varchar("owner_scope_type", { length: 16 }).notNull(),
	ownerScopeId: varchar("owner_scope_id", { length: 36 }),
	status: varchar({ length: 16 }).default('active').notNull(),
	currentSystemVersionId: varchar("current_system_version_id", { length: 36 }),
	defaultEvalSuiteRefJson: jsonb("default_eval_suite_ref_json"),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolvable_assets_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evolvable_assets_asset_type").using("btree", table.assetType.asc().nullsLast()),
	index("ix_evolvable_assets_current_system_version_id").using("btree", table.currentSystemVersionId.asc().nullsLast()),
	uniqueIndex("uq_evolvable_assets_space_key").using("btree", table.spaceId.asc().nullsLast(), table.assetKey.asc().nullsLast()).where(sql`(space_id IS NOT NULL)`),
	uniqueIndex("uq_evolvable_assets_system_key").using("btree", table.assetKey.asc().nullsLast()).where(sql`(space_id IS NULL)`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolvable_assets_space_id_fkey"
		}),
	// Single-column FK: current_system_version_id is a "latest pointer"
	// convenience field, not a scoped relation, and versions are never
	// deleted — ON DELETE RESTRICT (the default) is intentional here.
	foreignKey({
			columns: [table.currentSystemVersionId],
			foreignColumns: [evolvableAssetVersions.id],
			name: "evolvable_assets_current_system_version_id_fkey"
		}),
	check("ck_evolvable_assets_asset_type", sql`(asset_type)::text = ANY (${ASSET_TYPES})`),
	check("ck_evolvable_assets_owner_scope_type", sql`(owner_scope_type)::text = ANY (${SCOPE_TYPES})`),
	check("ck_evolvable_assets_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_evolvable_assets_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
]);

export const evolvableAssetVersions = pgTable("evolvable_asset_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	assetId: varchar("asset_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	scopeType: varchar("scope_type", { length: 16 }).notNull(),
	scopeId: varchar("scope_id", { length: 36 }),
	parentVersionId: varchar("parent_version_id", { length: 36 }),
	version: integer().notNull(),
	status: varchar({ length: 16 }).default('draft').notNull(),
	source: varchar({ length: 16 }).notNull(),
	contentRef: varchar("content_ref", { length: 1024 }),
	contentHash: varchar("content_hash", { length: 128 }),
	contentJson: jsonb("content_json"),
	evalSummaryJson: jsonb("eval_summary_json"),
	promotionProposalId: varchar("promotion_proposal_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	approvedByUserId: varchar("approved_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolvable_asset_versions_asset_id").using("btree", table.assetId.asc().nullsLast()),
	index("ix_evolvable_asset_versions_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evolvable_asset_versions_scope").using("btree", table.assetId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_evolvable_asset_versions_parent_version_id").using("btree", table.parentVersionId.asc().nullsLast()),
	uniqueIndex("uq_evolvable_asset_versions_asset_version").using("btree", table.assetId.asc().nullsLast(), table.version.asc().nullsLast()),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [evolvableAssets.id],
			name: "evolvable_asset_versions_asset_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolvable_asset_versions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.parentVersionId],
			foreignColumns: [table.id],
			name: "evolvable_asset_versions_parent_version_id_fkey"
		}),
	foreignKey({
			columns: [table.promotionProposalId],
			foreignColumns: [proposals.id],
			name: "evolvable_asset_versions_promotion_proposal_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "evolvable_asset_versions_created_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.approvedByUserId],
			foreignColumns: [users.id],
			name: "evolvable_asset_versions_approved_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_evolvable_asset_versions_scope_type", sql`(scope_type)::text = ANY (${SCOPE_TYPES})`),
	check("ck_evolvable_asset_versions_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('candidate'::character varying)::text, ('testing'::character varying)::text, ('approved'::character varying)::text, ('deprecated'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_evolvable_asset_versions_source", sql`(source)::text = ANY (ARRAY[('built_in'::character varying)::text, ('user_authored'::character varying)::text, ('evolved'::character varying)::text, ('imported'::character varying)::text, ('generated'::character varying)::text])`),
	check("ck_evolvable_asset_versions_version_positive", sql`version > 0`),
]);

export const evolvableAssetPins = pgTable("evolvable_asset_pins", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	assetId: varchar("asset_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 16 }).notNull(),
	scopeId: varchar("scope_id", { length: 36 }).notNull(),
	versionId: varchar("version_id", { length: 36 }).notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	pinnedByUserId: varchar("pinned_by_user_id", { length: 36 }),
	reason: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolvable_asset_pins_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evolvable_asset_pins_asset_id").using("btree", table.assetId.asc().nullsLast()),
	uniqueIndex("uq_evolvable_asset_pins_active_scope").using("btree", table.spaceId.asc().nullsLast(), table.assetId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.scopeId.asc().nullsLast()).where(sql`(status)::text = 'active'::text`),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [evolvableAssets.id],
			name: "evolvable_asset_pins_asset_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.versionId],
			foreignColumns: [evolvableAssetVersions.id],
			name: "evolvable_asset_pins_version_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolvable_asset_pins_space_id_fkey"
		}),
	foreignKey({
			columns: [table.pinnedByUserId],
			foreignColumns: [users.id],
			name: "evolvable_asset_pins_pinned_by_user_id_fkey"
		}).onDelete("set null"),
	// scope_type is deliberately narrower than SCOPE_TYPES: pins target
	// space/project/user/agent, never 'system' (the system baseline is
	// current_system_version_id / the newest approved system-scope version,
	// not a pin).
	check("ck_evolvable_asset_pins_scope_type", sql`(scope_type)::text = ANY (ARRAY[('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text])`),
	check("ck_evolvable_asset_pins_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const evolvableAssetEvaluationRuns = pgTable("evolvable_asset_evaluation_runs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	assetId: varchar("asset_id", { length: 36 }).notNull(),
	candidateVersionId: varchar("candidate_version_id", { length: 36 }).notNull(),
	baselineVersionId: varchar("baseline_version_id", { length: 36 }),
	evolutionTargetId: varchar("evolution_target_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }),
	evalSuiteRefJson: jsonb("eval_suite_ref_json").notNull(),
	evaluatorVersion: varchar("evaluator_version", { length: 64 }).notNull(),
	modelProviderRefJson: jsonb("model_provider_ref_json"),
	status: varchar({ length: 16 }).default('queued').notNull(),
	metricsJson: jsonb("metrics_json").default({}).notNull(),
	blockersJson: jsonb("blockers_json").default([]).notNull(),
	outputArtifactId: varchar("output_artifact_id", { length: 36 }),
	reportArtifactId: varchar("report_artifact_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolvable_asset_evaluation_runs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evolvable_asset_evaluation_runs_asset_id").using("btree", table.assetId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_evolvable_asset_evaluation_runs_candidate_version_id").using("btree", table.candidateVersionId.asc().nullsLast()),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [evolvableAssets.id],
			name: "evolvable_asset_evaluation_runs_asset_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.candidateVersionId],
			foreignColumns: [evolvableAssetVersions.id],
			name: "evolvable_asset_evaluation_runs_candidate_version_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.baselineVersionId],
			foreignColumns: [evolvableAssetVersions.id],
			name: "evolvable_asset_evaluation_runs_baseline_version_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.evolutionTargetId],
			foreignColumns: [evolutionTargets.id],
			name: "evolvable_asset_evaluation_runs_evolution_target_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "evolvable_asset_evaluation_runs_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.outputArtifactId],
			foreignColumns: [artifacts.id],
			name: "evolvable_asset_evaluation_runs_output_artifact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.reportArtifactId],
			foreignColumns: [artifacts.id],
			name: "evolvable_asset_evaluation_runs_report_artifact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolvable_asset_evaluation_runs_space_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "evolvable_asset_evaluation_runs_created_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_evolvable_asset_evaluation_runs_status", sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('passed'::character varying)::text, ('failed'::character varying)::text, ('blocked'::character varying)::text, ('cancelled'::character varying)::text])`),
	check("ck_evolvable_asset_evaluation_runs_metrics_object", sql`jsonb_typeof(metrics_json) = 'object'::text`),
	check("ck_evolvable_asset_evaluation_runs_blockers_array", sql`jsonb_typeof(blockers_json) = 'array'::text`),
]);

export const evaluationCases = pgTable("evaluation_cases", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	assetId: varchar("asset_id", { length: 36 }).notNull(),
	name: varchar({ length: 160 }).notNull(),
	description: text(),
	inputJson: jsonb("input_json").default({}).notNull(),
	expectationJson: jsonb("expectation_json").default({}).notNull(),
	verificationRecipeJson: jsonb("verification_recipe_json").notNull(),
	baselineOutputJson: jsonb("baseline_output_json").notNull(),
	baselineVersionId: varchar("baseline_version_id", { length: 36 }).notNull(),
	sourceRunId: varchar("source_run_id", { length: 36 }),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evaluation_cases_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evaluation_cases_asset_id").using("btree", table.assetId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("ix_evaluation_cases_source_run_id").using("btree", table.sourceRunId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evaluation_cases_space_id_fkey"
		}),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [evolvableAssets.id],
			name: "evaluation_cases_asset_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.baselineVersionId],
			foreignColumns: [evolvableAssetVersions.id],
			name: "evaluation_cases_baseline_version_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.sourceRunId],
			foreignColumns: [runs.id],
			name: "evaluation_cases_source_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "evaluation_cases_created_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_evaluation_cases_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_evaluation_cases_input_object", sql`jsonb_typeof(input_json) = 'object'::text`),
	check("ck_evaluation_cases_expectation_object", sql`jsonb_typeof(expectation_json) = 'object'::text`),
	check("ck_evaluation_cases_recipe_object", sql`jsonb_typeof(verification_recipe_json) = 'object'::text`),
]);
