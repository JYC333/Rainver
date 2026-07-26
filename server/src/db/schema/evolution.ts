import { pgTable, index, uniqueIndex, check, foreignKey, varchar, text, integer, boolean, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { proposals } from "./proposals";
import { capabilityVersions } from "./capabilities";
import { users } from "./auth";

export const evolutionBundles = pgTable("evolution_bundles", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	title: varchar({ length: 256 }).notNull(),
	description: text(),
	status: varchar({ length: 32 }).default("pending_review").notNull(),
	riskLevel: varchar("risk_level", { length: 32 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: 'string' }),
	rollbackError: text("rollback_error"),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_bundles_space_status_updated").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast(), table.updatedAt.desc().nullsFirst()),
	index("ix_evolution_bundles_created_by_user").using("btree", table.createdByUserId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolution_bundles_space_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "evolution_bundles_created_by_user_id_fkey"
		}),
	check("ck_evolution_bundles_status", sql`(status)::text = ANY (ARRAY[('pending_review'::character varying)::text, ('partially_approved'::character varying)::text, ('applied'::character varying)::text, ('rejected'::character varying)::text, ('rolled_back'::character varying)::text, ('rollback_failed'::character varying)::text])`),
	check("ck_evolution_bundles_risk_level", sql`(risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
]);

export const evolutionBundleMembers = pgTable("evolution_bundle_members", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	bundleId: varchar("bundle_id", { length: 36 }).notNull(),
	proposalId: varchar("proposal_id", { length: 36 }).notNull(),
	position: integer().notNull(),
	status: varchar({ length: 32 }).default("pending").notNull(),
	decisionNote: text("decision_note"),
	decidedByUserId: varchar("decided_by_user_id", { length: 36 }),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	beforeSnapshotJson: jsonb("before_snapshot_json").default({}).notNull(),
	afterSnapshotJson: jsonb("after_snapshot_json").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_bundle_members_bundle_position").using("btree", table.bundleId.asc().nullsLast(), table.position.asc().nullsLast()),
	index("ix_evolution_bundle_members_proposal_id").using("btree", table.proposalId.asc().nullsLast()),
	uniqueIndex("uq_evolution_bundle_members_proposal").using("btree", table.proposalId.asc().nullsLast()),
	foreignKey({
			columns: [table.bundleId],
			foreignColumns: [evolutionBundles.id],
			name: "evolution_bundle_members_bundle_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "evolution_bundle_members_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.decidedByUserId],
			foreignColumns: [users.id],
			name: "evolution_bundle_members_decided_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_evolution_bundle_members_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('released'::character varying)::text, ('rolled_back'::character varying)::text, ('rollback_failed'::character varying)::text])`),
	check("ck_evolution_bundle_members_position", sql`position > 0`),
	check("ck_evolution_bundle_members_before_snapshot_object", sql`jsonb_typeof(before_snapshot_json) = 'object'::text`),
	check("ck_evolution_bundle_members_after_snapshot_object", sql`jsonb_typeof(after_snapshot_json) = 'object'::text`),
]);

export const evolutionSignals = pgTable("evolution_signals", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	targetId: varchar("target_id", { length: 36 }).notNull(),
	signalType: varchar("signal_type", { length: 128 }).notNull(),
	sourceType: varchar("source_type", { length: 64 }).notNull(),
	sourceId: varchar("source_id", { length: 128 }),
	severity: varchar({ length: 32 }).notNull(),
	summary: text(),
	payloadJson: jsonb("payload_json").notNull(),
	triageStatus: varchar("triage_status", { length: 32 }).default("new").notNull(),
	triagedAt: timestamp("triaged_at", { withTimezone: true, mode: 'string' }),
	triagedByUserId: varchar("triaged_by_user_id", { length: 36 }),
	triageNote: text("triage_note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_signals_severity").using("btree", table.severity.asc().nullsLast()),
	index("ix_evolution_signals_signal_type").using("btree", table.signalType.asc().nullsLast()),
	index("ix_evolution_signals_source_id").using("btree", table.sourceId.asc().nullsLast()),
	index("ix_evolution_signals_source_type").using("btree", table.sourceType.asc().nullsLast()),
	index("ix_evolution_signals_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evolution_signals_space_target_type_created").using("btree", table.spaceId.asc().nullsLast(), table.targetId.asc().nullsLast(), table.signalType.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_evolution_signals_space_triage_created").using("btree", table.spaceId.asc().nullsLast(), table.triageStatus.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_evolution_signals_target_id").using("btree", table.targetId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolution_signals_space_id_fkey"
		}),
	foreignKey({
			columns: [table.targetId],
			foreignColumns: [evolutionTargets.id],
			name: "evolution_signals_target_id_fkey"
		}),
	check("ck_evolution_signals_triage_status", sql`(triage_status)::text = ANY (ARRAY[('new'::character varying)::text, ('acknowledged'::character varying)::text, ('dismissed'::character varying)::text, ('actioned'::character varying)::text])`),
]);

export const evolutionTargets = pgTable("evolution_targets", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	targetType: varchar("target_type", { length: 64 }).notNull(),
	targetRefType: varchar("target_ref_type", { length: 64 }),
	targetRefId: varchar("target_ref_id", { length: 128 }),
	capabilityKey: varchar("capability_key", { length: 128 }),
	currentVersionId: varchar("current_version_id", { length: 36 }),
	riskLevel: varchar("risk_level", { length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	enabled: boolean().default(true).notNull(),
	enginePolicyJson: jsonb("engine_policy_json").notNull(),
	metadataJson: jsonb("metadata_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_targets_capability_key").using("btree", table.capabilityKey.asc().nullsLast()),
	index("ix_evolution_targets_current_version_id").using("btree", table.currentVersionId.asc().nullsLast()),
	index("ix_evolution_targets_risk_level").using("btree", table.riskLevel.asc().nullsLast()),
	index("ix_evolution_targets_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evolution_targets_space_type_ref_status").using("btree", table.spaceId.asc().nullsLast(), table.targetType.asc().nullsLast(), table.targetRefId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_evolution_targets_status").using("btree", table.status.asc().nullsLast()),
	index("ix_evolution_targets_target_ref_id").using("btree", table.targetRefId.asc().nullsLast()),
	index("ix_evolution_targets_target_type").using("btree", table.targetType.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolution_targets_space_id_fkey"
		}),
	foreignKey({
			columns: [table.currentVersionId, table.spaceId],
			foreignColumns: [capabilityVersions.id, capabilityVersions.spaceId],
			name: "evolution_targets_current_version_fkey"
		}),
	check("ck_evolution_targets_current_version_space", sql`current_version_id IS NULL OR space_id IS NOT NULL`),
]);

export const evolutionStrategyAssets = pgTable("evolution_strategy_assets", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	strategyKey: varchar("strategy_key", { length: 128 }).notNull(),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	category: varchar({ length: 32 }).notNull(),
	targetType: varchar("target_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).default('draft').notNull(),
	riskLevel: varchar("risk_level", { length: 32 }).notNull(),
	signalsMatchJson: jsonb("signals_match_json").default([]).notNull(),
	preconditionsJson: jsonb("preconditions_json").default({}).notNull(),
	strategyStepsJson: jsonb("strategy_steps_json").default([]).notNull(),
	constraintsJson: jsonb("constraints_json").default([]).notNull(),
	validationPolicyJson: jsonb("validation_policy_json").default({}).notNull(),
	toolPolicyJson: jsonb("tool_policy_json").default({}).notNull(),
	routingHintJson: jsonb("routing_hint_json").default({}).notNull(),
	provenanceType: varchar("provenance_type", { length: 32 }).notNull(),
	sourceRefJson: jsonb("source_ref_json").default({}).notNull(),
	successCount: integer("success_count").default(0).notNull(),
	failureCount: integer("failure_count").default(0).notNull(),
	confidenceScore: doublePrecision("confidence_score").default(0.5).notNull(),
	lastSelectedAt: timestamp("last_selected_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_strategy_assets_space_status_category_target").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast(), table.category.asc().nullsLast(), table.targetType.asc().nullsLast()),
	index("ix_evolution_strategy_assets_strategy_key").using("btree", table.strategyKey.asc().nullsLast()),
	uniqueIndex("uq_evolution_strategy_assets_space_key").using("btree", table.spaceId.asc().nullsLast(), table.strategyKey.asc().nullsLast()).where(sql`(space_id IS NOT NULL)`),
	uniqueIndex("uq_evolution_strategy_assets_system_key").using("btree", table.strategyKey.asc().nullsLast()).where(sql`(space_id IS NULL)`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolution_strategy_assets_space_id_fkey"
		}),
	check("ck_evolution_strategy_assets_category", sql`(category)::text = ANY (ARRAY[('repair'::character varying)::text, ('optimize'::character varying)::text, ('innovate'::character varying)::text, ('maintain'::character varying)::text, ('harden'::character varying)::text, ('review'::character varying)::text])`),
	check("ck_evolution_strategy_assets_confidence_score", sql`(confidence_score >= (0)::double precision) AND (confidence_score <= (1)::double precision)`),
	check("ck_evolution_strategy_assets_counts", sql`(success_count >= 0) AND (failure_count >= 0)`),
	check("ck_evolution_strategy_assets_provenance_type", sql`(provenance_type)::text = ANY (ARRAY[('built_in'::character varying)::text, ('user_authored'::character varying)::text, ('imported'::character varying)::text, ('evolved'::character varying)::text, ('distilled'::character varying)::text])`),
	check("ck_evolution_strategy_assets_risk_level", sql`(risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
	check("ck_evolution_strategy_assets_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('disabled'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_evolution_strategy_assets_target_type", sql`(target_type)::text = ANY (ARRAY[('agent_version'::character varying)::text, ('capability'::character varying)::text, ('runtime_skill_binding'::character varying)::text, ('memory'::character varying)::text, ('knowledge'::character varying)::text, ('workflow'::character varying)::text, ('project_folder'::character varying)::text, ('system'::character varying)::text])`),
]);

export const evolutionExperiences = pgTable("evolution_experiences", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	strategyAssetId: varchar("strategy_asset_id", { length: 36 }),
	targetId: varchar("target_id", { length: 36 }),
	sourceRunId: varchar("source_run_id", { length: 36 }),
	sourceProposalId: varchar("source_proposal_id", { length: 36 }),
	experienceKey: varchar("experience_key", { length: 160 }).notNull(),
	summary: text().notNull(),
	triggerSignalsJson: jsonb("trigger_signals_json").default([]).notNull(),
	outcomeStatus: varchar("outcome_status", { length: 32 }).notNull(),
	confidenceScore: doublePrecision("confidence_score").default(0.5).notNull(),
	blastRadiusJson: jsonb("blast_radius_json").default({}).notNull(),
	validationTraceJson: jsonb("validation_trace_json").default({}).notNull(),
	executionTraceJson: jsonb("execution_trace_json").default({}).notNull(),
	lessonsJson: jsonb("lessons_json").default([]).notNull(),
	antiPatternsJson: jsonb("anti_patterns_json").default([]).notNull(),
	environmentFingerprintJson: jsonb("environment_fingerprint_json").default({}).notNull(),
	provenanceType: varchar("provenance_type", { length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_experiences_space_source_run").using("btree", table.spaceId.asc().nullsLast(), table.sourceRunId.asc().nullsLast()),
	index("ix_evolution_experiences_space_strategy_created").using("btree", table.spaceId.asc().nullsLast(), table.strategyAssetId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	uniqueIndex("uq_evolution_experiences_space_key").using("btree", table.spaceId.asc().nullsLast(), table.experienceKey.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolution_experiences_space_id_fkey"
		}),
	foreignKey({
			columns: [table.strategyAssetId],
			foreignColumns: [evolutionStrategyAssets.id],
			name: "evolution_experiences_strategy_asset_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.targetId],
			foreignColumns: [evolutionTargets.id],
			name: "evolution_experiences_target_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sourceRunId],
			foreignColumns: [runs.id],
			name: "evolution_experiences_source_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sourceProposalId],
			foreignColumns: [proposals.id],
			name: "evolution_experiences_source_proposal_id_fkey"
		}).onDelete("set null"),
	check("ck_evolution_experiences_confidence_score", sql`(confidence_score >= (0)::double precision) AND (confidence_score <= (1)::double precision)`),
	check("ck_evolution_experiences_outcome_status", sql`(outcome_status)::text = ANY (ARRAY[('success'::character varying)::text, ('failed'::character varying)::text, ('partial'::character varying)::text, ('unknown'::character varying)::text])`),
	check("ck_evolution_experiences_provenance_type", sql`(provenance_type)::text = ANY (ARRAY[('run_observed'::character varying)::text, ('proposal_accepted'::character varying)::text, ('imported'::character varying)::text, ('user_authored'::character varying)::text])`),
]);

export const evolutionSelectorDecisions = pgTable("evolution_selector_decisions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	targetId: varchar("target_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }),
	selectedStrategyAssetId: varchar("selected_strategy_asset_id", { length: 36 }),
	candidateStrategyIdsJson: jsonb("candidate_strategy_ids_json").default([]).notNull(),
	inputSignalIdsJson: jsonb("input_signal_ids_json").default([]).notNull(),
	decisionReason: text("decision_reason"),
	scoreTraceJson: jsonb("score_trace_json").default({}).notNull(),
	rejectedReasonsJson: jsonb("rejected_reasons_json").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evolution_selector_decisions_space_run").using("btree", table.spaceId.asc().nullsLast(), table.runId.asc().nullsLast()),
	index("ix_evolution_selector_decisions_space_target_created").using("btree", table.spaceId.asc().nullsLast(), table.targetId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evolution_selector_decisions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.targetId],
			foreignColumns: [evolutionTargets.id],
			name: "evolution_selector_decisions_target_id_fkey"
		}),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "evolution_selector_decisions_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.selectedStrategyAssetId],
			foreignColumns: [evolutionStrategyAssets.id],
			name: "evolution_selector_decisions_selected_strategy_asset_id_fkey"
		}).onDelete("set null"),
]);

export const runReflections = pgTable("run_reflections", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	source: varchar({ length: 32 }).default('native').notNull(),
	whatChanged: text("what_changed"),
	whatWorked: text("what_worked"),
	whatFailed: text("what_failed"),
	reusableRulesJson: jsonb("reusable_rules_json"),
	reusableCommandsJson: jsonb("reusable_commands_json"),
	projectFolderFactsJson: jsonb("project_folder_facts_json"),
	memoryCandidatesJson: jsonb("memory_candidates_json"),
	capabilityCandidatesJson: jsonb("capability_candidates_json"),
	policyCandidatesJson: jsonb("policy_candidates_json"),
	validationCandidatesJson: jsonb("validation_candidates_json"),
	followUpTasksJson: jsonb("follow_up_tasks_json"),
	confidence: doublePrecision(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_reflections_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_run_reflections_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_reflections_run_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_reflections_space_id_fkey"
		}),
	check("ck_run_reflections_source", sql`(source)::text = ANY (ARRAY[('native'::character varying)::text, ('external_import'::character varying)::text, ('manual'::character varying)::text, ('evaluator'::character varying)::text])`),
]);
