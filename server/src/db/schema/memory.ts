import { pgTable, index, check, foreignKey, varchar, text, integer, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { spaces } from "./spaces";
import { artifacts } from "./artifacts";
import { proposals } from "./proposals";
import { projects } from "./projects";

export const memoryEntries = pgTable("memory_entries", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 32 }).notNull(),
	memoryType: varchar("memory_type", { length: 32 }).notNull(),
	content: text().notNull(),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }),
	validTo: timestamp("valid_to", { withTimezone: true, mode: 'string' }),
	subjectUserId: varchar("subject_user_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	sensitivityLevel: varchar("sensitivity_level", { length: 32 }).default('normal').notNull(),
	lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true, mode: 'string' }),
	// Producing-Agent provenance only. Memory authorization and retrieval must
	// never use this column as an attribution scope.
	agentId: varchar("agent_id", { length: 36 }),
	namespace: varchar({ length: 255 }),
	title: varchar({ length: 512 }),
	visibility: varchar({ length: 32 }).notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	confidence: doublePrecision().notNull(),
	importance: doublePrecision().notNull(),
	sourceId: varchar("source_id", { length: 36 }),
	createdBy: varchar("created_by", { length: 64 }),
	approvedBy: varchar("approved_by", { length: 64 }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	version: integer().notNull(),
	accessCount: integer("access_count").notNull(),
	lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true, mode: 'string' }),
	tags: jsonb(),
	memoryLayer: varchar("memory_layer", { length: 32 }),
	eventTime: timestamp("event_time", { withTimezone: true, mode: 'string' }),
	eventType: varchar("event_type", { length: 64 }),
	lastRetrievedAt: timestamp("last_retrieved_at", { withTimezone: true, mode: 'string' }),
	rootMemoryId: varchar("root_memory_id", { length: 36 }),
	supersedesMemoryId: varchar("supersedes_memory_id", { length: 36 }),
	sourceTrust: varchar("source_trust", { length: 32 }),
	createdFromProposalId: varchar("created_from_proposal_id", { length: 36 }),
	projectId: varchar("project_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_memory_entries_agent_id").using("btree", table.agentId.asc().nullsLast()),
	index("ix_memory_entries_created_from_proposal_id").using("btree", table.createdFromProposalId.asc().nullsLast()),
	index("ix_memory_entries_memory_layer").using("btree", table.memoryLayer.asc().nullsLast()),
	index("ix_memory_entries_memory_type").using("btree", table.memoryType.asc().nullsLast()),
	index("ix_memory_entries_namespace").using("btree", table.namespace.asc().nullsLast()),
	index("ix_memory_entries_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_memory_entries_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_memory_entries_root_memory_id").using("btree", table.rootMemoryId.asc().nullsLast()),
	index("ix_memory_entries_scope_type").using("btree", table.scopeType.asc().nullsLast()),
	index("ix_memory_entries_sensitivity_level").using("btree", table.sensitivityLevel.asc().nullsLast()),
	index("ix_memory_entries_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_memory_entries_status").using("btree", table.status.asc().nullsLast()),
	index("ix_memory_entries_subject_user_id").using("btree", table.subjectUserId.asc().nullsLast()),
	index("ix_memory_entries_supersedes_memory_id").using("btree", table.supersedesMemoryId.asc().nullsLast()),
	index("ix_memory_entries_visibility").using("btree", table.visibility.asc().nullsLast()),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "memory_entries_project_id_delete_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "fk_memory_entries_project_id_projects"
		}),
	foreignKey({
			columns: [table.rootMemoryId],
			foreignColumns: [table.id],
			name: "fk_memory_entries_root_memory_id_memory_entries"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.supersedesMemoryId],
			foreignColumns: [table.id],
			name: "fk_memory_entries_supersedes_memory_id_memory_entries"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [agents.id],
			name: "memory_entries_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdFromProposalId],
			foreignColumns: [proposals.id],
			name: "memory_entries_created_from_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "memory_entries_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "memory_entries_space_id_fkey"
		}),
	foreignKey({
			columns: [table.subjectUserId],
			foreignColumns: [users.id],
			name: "memory_entries_subject_user_id_fkey"
		}),
	check("ck_memory_entries_memory_layer", sql`(memory_layer IS NULL) OR ((memory_layer)::text = ANY (ARRAY[('episodic'::character varying)::text, ('semantic'::character varying)::text]))`),
	check("ck_memory_entries_scope_type", sql`scope_type IN ('user', 'project')`),
	check("ck_memory_entries_scope_placement", sql`(scope_type = 'user' AND project_id IS NULL) OR (scope_type = 'project' AND project_id IS NOT NULL)`),
	check("ck_memory_entries_sensitivity_level", sql`(sensitivity_level)::text = ANY (ARRAY[('normal'::character varying)::text, ('sensitive'::character varying)::text, ('restricted'::character varying)::text, ('highly_restricted'::character varying)::text])`),
	check("ck_memory_entries_source_trust", sql`(source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('user_confirmed'::character varying)::text, ('internal_system'::character varying)::text, ('trusted_external'::character varying)::text, ('untrusted_external'::character varying)::text, ('agent_inferred'::character varying)::text]))`),
	check("ck_memory_entries_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_memory_entries_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_memory_entries_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
	check("ck_memory_entries_highly_restricted_private", sql`sensitivity_level <> 'highly_restricted' OR visibility = 'private'`),
]);

export const memoryMaintenanceJobs = pgTable("memory_maintenance_jobs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	status: varchar({ length: 32 }).default('pending').notNull(),
	reviewScope: varchar("review_scope", { length: 32 }).default('private').notNull(),
	scanOptionsJson: jsonb("scan_options_json").default({}).notNull(),
	cursor: varchar({ length: 256 }),
	totalScanned: integer("total_scanned").default(0).notNull(),
	totalFindings: integer("total_findings").default(0).notNull(),
	lastReportArtifactId: varchar("last_report_artifact_id", { length: 36 }),
	lastPacketProposalId: varchar("last_packet_proposal_id", { length: 36 }),
	errorMessage: text("error_message"),
	runAfter: timestamp("run_after", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_memory_maintenance_jobs_due").using("btree", table.status.asc().nullsLast(), table.runAfter.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	index("ix_memory_maintenance_jobs_owner").using("btree", table.spaceId.asc().nullsLast(), table.ownerUserId.asc().nullsLast(), table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.lastPacketProposalId],
			foreignColumns: [proposals.id],
			name: "memory_maintenance_jobs_last_packet_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.lastReportArtifactId],
			foreignColumns: [artifacts.id],
			name: "memory_maintenance_jobs_last_report_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "memory_maintenance_jobs_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "memory_maintenance_jobs_space_id_fkey"
		}).onDelete("cascade"),
	check("ck_memory_maintenance_jobs_total_scanned", sql`total_scanned >= 0`),
	check("ck_memory_maintenance_jobs_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])`),
	check("ck_memory_maintenance_jobs_review_scope", sql`(review_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('space_ops'::character varying)::text])`),
	check("ck_memory_maintenance_jobs_total_findings", sql`total_findings >= 0`),
]);

export const memoryRelations = pgTable("memory_relations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceType: varchar("source_type", { length: 64 }).notNull(),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	targetType: varchar("target_type", { length: 64 }).notNull(),
	targetId: varchar("target_id", { length: 36 }).notNull(),
	// Deliberately NOT `link_type`: B12A freezes this vocabulary and forbids it
	// expanding into general provenance. It is not an ontology edge.
	relationType: varchar("relation_type", { length: 64 }).notNull(),
	confidence: doublePrecision(),
	evidenceJson: jsonb("evidence_json"),
	createdFromProposalId: varchar("created_from_proposal_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_memory_relations_created_from_proposal_id").using("btree", table.createdFromProposalId.asc().nullsLast()),
	index("ix_memory_relations_relation_type").using("btree", table.relationType.asc().nullsLast()),
	index("ix_memory_relations_source").using("btree", table.spaceId.asc().nullsLast(), table.sourceType.asc().nullsLast(), table.sourceId.asc().nullsLast()),
	index("ix_memory_relations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_memory_relations_target").using("btree", table.spaceId.asc().nullsLast(), table.targetType.asc().nullsLast(), table.targetId.asc().nullsLast()),
	foreignKey({
			columns: [table.createdFromProposalId],
			foreignColumns: [proposals.id],
			name: "memory_relations_created_from_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "memory_relations_space_id_fkey"
		}),
	check("ck_memory_relations_relation_type", sql`(relation_type)::text = ANY (ARRAY[('derived_from'::character varying)::text, ('supersedes'::character varying)::text, ('contradicts'::character varying)::text, ('related_to'::character varying)::text, ('caused_by'::character varying)::text, ('supports'::character varying)::text, ('applies_to'::character varying)::text, ('mentions'::character varying)::text])`),
]);

export const provenanceLinks = pgTable("provenance_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	targetType: varchar("target_type", { length: 64 }).notNull(),
	targetId: varchar("target_id", { length: 36 }).notNull(),
	sourceType: varchar("source_type", { length: 64 }).notNull(),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	sourceTrust: varchar("source_trust", { length: 32 }),
	evidenceJson: jsonb("evidence_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_provenance_links_source").using("btree", table.spaceId.asc().nullsLast(), table.sourceType.asc().nullsLast(), table.sourceId.asc().nullsLast()),
	index("ix_provenance_links_source_type").using("btree", table.sourceType.asc().nullsLast()),
	index("ix_provenance_links_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_provenance_links_target").using("btree", table.spaceId.asc().nullsLast(), table.targetType.asc().nullsLast(), table.targetId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "provenance_links_space_id_fkey"
		}),
	check("ck_provenance_links_source_trust", sql`(source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('user_confirmed'::character varying)::text, ('internal_system'::character varying)::text, ('trusted_external'::character varying)::text, ('untrusted_external'::character varying)::text, ('agent_inferred'::character varying)::text]))`),
	// B12F: membership is a `provenanceSourceable` declaration on the entity
	// registry, resolved through `isProvenanceSourceType`. The closed set that
	// used to live here was one of four copies — this CHECK plus three Sets, two
	// of which silently *dropped* unrecognized entries, so a divergence lost
	// provenance without an error. `target_type` still carries no constraint.
	check("ck_provenance_links_source_type_format", sql`(source_type)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text`),
]);
