import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, integer, boolean, doublePrecision, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { retrievalObjectType } from "./_types";
import { agents } from "./agents";
import { activityRecords } from "./activity";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { workspaces } from "./workspaces";
import { artifacts } from "./artifacts";
import { proposals } from "./proposals";
import { projects } from "./projects";
import { extractionJobs, sourceConnections, sourceItems, sourceSnapshots } from "./sources";

export const evidenceLinks = pgTable("evidence_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	evidenceId: varchar("evidence_id", { length: 36 }).notNull(),
	targetType: varchar("target_type", { length: 64 }).notNull(),
	targetId: varchar("target_id", { length: 36 }),
	linkType: varchar("link_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	confidence: doublePrecision(),
	reason: varchar({ length: 1024 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_evidence_links_created_by_agent_id").using("btree", table.createdByAgentId.asc().nullsLast()),
	index("ix_evidence_links_created_by_run_id").using("btree", table.createdByRunId.asc().nullsLast()),
	index("ix_evidence_links_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast()),
	index("ix_evidence_links_evidence_id").using("btree", table.evidenceId.asc().nullsLast()),
	index("ix_evidence_links_evidence_target").using("btree", table.evidenceId.asc().nullsLast(), table.targetType.asc().nullsLast(), table.targetId.asc().nullsLast()),
	index("ix_evidence_links_link_type").using("btree", table.linkType.asc().nullsLast()),
	index("ix_evidence_links_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_evidence_links_status").using("btree", table.status.asc().nullsLast()),
	index("ix_evidence_links_target").using("btree", table.spaceId.asc().nullsLast(), table.targetType.asc().nullsLast(), table.targetId.asc().nullsLast()),
	index("ix_evidence_links_target_id").using("btree", table.targetId.asc().nullsLast()),
	index("ix_evidence_links_target_type").using("btree", table.targetType.asc().nullsLast()),
	uniqueIndex("uq_evidence_links_active_dedupe").using("btree", table.spaceId.asc().nullsLast(), table.evidenceId.asc().nullsLast(), table.targetType.asc().nullsLast(), table.targetId.asc().nullsLast(), table.linkType.asc().nullsLast()).where(sql`((status)::text = 'active'::text)`),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "evidence_links_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "evidence_links_created_by_run_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "evidence_links_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.evidenceId],
			foreignColumns: [extractedEvidence.id],
			name: "evidence_links_evidence_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "evidence_links_space_id_fkey"
		}),
	check("ck_evidence_links_link_type", sql`(link_type)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('derived_from'::character varying)::text, ('mentions'::character varying)::text, ('context_candidate'::character varying)::text, ('used_in_context'::character varying)::text])`),
	check("ck_evidence_links_status", sql`(status)::text = ANY (ARRAY[('candidate'::character varying)::text, ('active'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_evidence_links_target_type", sql`(target_type)::text = ANY (ARRAY[('space'::character varying)::text, ('workspace'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text, ('run'::character varying)::text, ('proposal'::character varying)::text, ('artifact'::character varying)::text, ('knowledge'::character varying)::text, ('memory'::character varying)::text, ('task'::character varying)::text])`),
]);

export const extractedEvidence = pgTable("extracted_evidence", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	visibility: varchar({ length: 32 }).default('private').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	sourceItemId: varchar("source_item_id", { length: 36 }),
	originSourceItemId: varchar("origin_source_item_id", { length: 36 }),
	extractionJobId: varchar("extraction_job_id", { length: 36 }),
	sourceSnapshotId: varchar("source_snapshot_id", { length: 36 }),
	sourceObjectType: varchar("source_object_type", { length: 64 }),
	sourceObjectId: varchar("source_object_id", { length: 36 }),
	evidenceType: varchar("evidence_type", { length: 64 }).notNull(),
	title: varchar({ length: 1024 }).notNull(),
	contentExcerpt: varchar("content_excerpt", { length: 4096 }),
	contentHash: varchar("content_hash", { length: 128 }),
	artifactId: varchar("artifact_id", { length: 36 }),
	sourceUri: text("source_uri"),
	sourceTitle: varchar("source_title", { length: 1024 }),
	sourceAuthor: varchar("source_author", { length: 512 }),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }),
	trustLevel: varchar("trust_level", { length: 32 }).notNull(),
	extractionMethod: varchar("extraction_method", { length: 64 }).notNull(),
	confidence: doublePrecision(),
	status: varchar({ length: 32 }).notNull(),
	metadataJson: jsonb("metadata_json"),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_extracted_evidence_artifact_id").using("btree", table.artifactId.asc().nullsLast()),
	index("ix_extracted_evidence_content_hash").using("btree", table.contentHash.asc().nullsLast()),
	index("ix_extracted_evidence_created_by_agent_id").using("btree", table.createdByAgentId.asc().nullsLast()),
	index("ix_extracted_evidence_created_by_run_id").using("btree", table.createdByRunId.asc().nullsLast()),
	index("ix_extracted_evidence_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast()),
	index("ix_extracted_evidence_deleted_at").using("btree", table.deletedAt.asc().nullsLast()),
	index("ix_extracted_evidence_evidence_type").using("btree", table.evidenceType.asc().nullsLast()),
	index("ix_extracted_evidence_extraction_job_id").using("btree", table.extractionJobId.asc().nullsLast()),
	index("ix_extracted_evidence_occurred_at").using("btree", table.occurredAt.asc().nullsLast()),
	index("ix_extracted_evidence_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_extracted_evidence_origin_source_item_id").using("btree", table.originSourceItemId.asc().nullsLast()),
	index("ix_extracted_evidence_source_item_id").using("btree", table.sourceItemId.asc().nullsLast()),
	index("ix_extracted_evidence_source_object").using("btree", table.spaceId.asc().nullsLast(), table.sourceObjectType.asc().nullsLast(), table.sourceObjectId.asc().nullsLast()),
	index("ix_extracted_evidence_source_object_id").using("btree", table.sourceObjectId.asc().nullsLast()),
	index("ix_extracted_evidence_source_object_type").using("btree", table.sourceObjectType.asc().nullsLast()),
	index("ix_extracted_evidence_source_snapshot_id").using("btree", table.sourceSnapshotId.asc().nullsLast()),
	index("ix_extracted_evidence_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_extracted_evidence_space_status").using("btree", table.spaceId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ix_extracted_evidence_status").using("btree", table.status.asc().nullsLast()),
	index("ix_extracted_evidence_trust_level").using("btree", table.trustLevel.asc().nullsLast()),
	index("ix_extracted_evidence_visibility").using("btree", table.visibility.asc().nullsLast()),
	uniqueIndex("uq_extracted_evidence_source_content").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.sourceItemId.asc().nullsLast(),
		table.contentHash.asc().nullsLast(),
	).where(sql`source_item_id IS NOT NULL AND content_hash IS NOT NULL`),
	unique("uq_extracted_evidence_id_space").on(table.id, table.spaceId),
	foreignKey({
			columns: [table.artifactId],
			foreignColumns: [artifacts.id],
			name: "extracted_evidence_artifact_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "extracted_evidence_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "extracted_evidence_created_by_run_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "extracted_evidence_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.extractionJobId],
			foreignColumns: [extractionJobs.id],
			name: "extracted_evidence_extraction_job_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "extracted_evidence_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "extracted_evidence_source_item_id_fkey"
		}),
	foreignKey({
			columns: [table.originSourceItemId, table.spaceId],
			foreignColumns: [sourceItems.id, sourceItems.spaceId],
			name: "extracted_evidence_origin_source_item_space_fkey"
		}),
	foreignKey({
			columns: [table.sourceSnapshotId],
			foreignColumns: [sourceSnapshots.id],
			name: "extracted_evidence_source_snapshot_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "extracted_evidence_space_id_fkey"
		}),
	check("ck_extracted_evidence_evidence_type", sql`(evidence_type)::text = ANY (ARRAY[('document'::character varying)::text, ('excerpt'::character varying)::text, ('event'::character varying)::text, ('log'::character varying)::text, ('artifact'::character varying)::text, ('claim'::character varying)::text, ('summary'::character varying)::text])`),
	check("ck_extracted_evidence_status", sql`(status)::text = ANY (ARRAY[('candidate'::character varying)::text, ('active'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_extracted_evidence_trust_level", sql`(trust_level)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text])`),
	check("ck_extracted_evidence_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_extracted_evidence_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_extracted_evidence_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const knowledgeItems = pgTable("knowledge_items", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	rootItemId: varchar("root_item_id", { length: 36 }),
	supersedesItemId: varchar("supersedes_item_id", { length: 36 }),
	knowledgeKind: varchar("knowledge_kind", { length: 32 }).notNull(),
	slug: varchar({ length: 512 }),
	aliasesJson: jsonb("aliases_json"),
	content: text().notNull(),
	contentJson: jsonb("content_json"),
	contentFormat: varchar("content_format", { length: 32 }).notNull(),
	contentSchemaVersion: integer("content_schema_version").notNull(),
	plainText: text("plain_text"),
	verificationStatus: varchar("verification_status", { length: 32 }).notNull(),
	reflectionStatus: varchar("reflection_status", { length: 32 }).notNull(),
	tagsJson: jsonb("tags_json").notNull(),
	confidence: doublePrecision(),
	createdFromProposalId: varchar("created_from_proposal_id", { length: 36 }),
	approvedByUserId: varchar("approved_by_user_id", { length: 36 }),
	redirectToItemId: varchar("redirect_to_item_id", { length: 36 }),
	version: integer().notNull(),
	deprecatedAt: timestamp("deprecated_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_knowledge_items_created_from_proposal_id").using("btree", table.createdFromProposalId.asc().nullsLast()),
	index("ix_knowledge_items_knowledge_kind").using("btree", table.knowledgeKind.asc().nullsLast()),
	index("ix_knowledge_items_redirect_to_item_id").using("btree", table.redirectToItemId.asc().nullsLast()),
	index("ix_knowledge_items_root_item_id").using("btree", table.rootItemId.asc().nullsLast()),
	index("ix_knowledge_items_slug").using("btree", table.slug.asc().nullsLast()),
	index("ix_knowledge_items_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_knowledge_items_space_slug").using("btree", table.spaceId.asc().nullsLast(), table.slug.asc().nullsLast()),
	index("ix_knowledge_items_supersedes_item_id").using("btree", table.supersedesItemId.asc().nullsLast()),
	foreignKey({
			columns: [table.redirectToItemId],
			foreignColumns: [table.objectId],
			name: "knowledge_items_redirect_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.redirectToItemId, table.spaceId],
			foreignColumns: [table.objectId, table.spaceId],
			name: "fk_knowledge_items_redirect_to_item_id_knowledge_items"
		}),
	foreignKey({
			columns: [table.rootItemId],
			foreignColumns: [table.objectId],
			name: "knowledge_items_root_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.rootItemId, table.spaceId],
			foreignColumns: [table.objectId, table.spaceId],
			name: "fk_knowledge_items_root_item_id_knowledge_items"
		}),
	foreignKey({
			columns: [table.supersedesItemId],
			foreignColumns: [table.objectId],
			name: "knowledge_items_supersedes_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.supersedesItemId, table.spaceId],
			foreignColumns: [table.objectId, table.spaceId],
			name: "fk_knowledge_items_supersedes_item_id_knowledge_items"
		}),
	foreignKey({
			columns: [table.approvedByUserId],
			foreignColumns: [users.id],
			name: "knowledge_items_approved_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.createdFromProposalId],
			foreignColumns: [proposals.id],
			name: "knowledge_items_created_from_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "knowledge_items_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "knowledge_items_space_id_fkey"
		}),
	unique("knowledge_items_object_id_space_id_key").on(table.objectId, table.spaceId),
	check("ck_knowledge_items_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_knowledge_items_content_format", sql`(content_format)::text = ANY (ARRAY[('markdown'::character varying)::text, ('plain'::character varying)::text, ('prosemirror_json'::character varying)::text])`),
	check("ck_knowledge_items_knowledge_kind", sql`(knowledge_kind)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('question'::character varying)::text, ('answer'::character varying)::text, ('summary'::character varying)::text])`),
	check("ck_knowledge_items_reflection_status", sql`(reflection_status)::text = ANY (ARRAY[('unreviewed'::character varying)::text, ('reviewed'::character varying)::text, ('distilled'::character varying)::text])`),
	check("ck_knowledge_items_verification_status", sql`(verification_status)::text = ANY (ARRAY[('unverified'::character varying)::text, ('needs_review'::character varying)::text, ('verified'::character varying)::text])`),
]);

export const spaceObjects = pgTable("space_objects", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectType: varchar("object_type", { length: 32 }).notNull(),
	title: varchar({ length: 512 }).notNull(),
	summary: text(),
	status: varchar({ length: 32 }).notNull(),
	visibility: varchar({ length: 32 }).default('space_shared').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	primaryProjectId: varchar("primary_project_id", { length: 36 }),
	workspaceId: varchar("workspace_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_space_objects_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast()),
	index("ix_space_objects_deleted_at").using("btree", table.deletedAt.asc().nullsLast()),
	index("ix_space_objects_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_space_objects_primary_project_id").using("btree", table.primaryProjectId.asc().nullsLast()),
	index("ix_space_objects_space_type").using("btree", table.spaceId.asc().nullsLast(), table.objectType.asc().nullsLast()),
	index("ix_space_objects_status").using("btree", table.status.asc().nullsLast()),
	index("ix_space_objects_visibility").using("btree", table.visibility.asc().nullsLast()),
	index("ix_space_objects_workspace_id").using("btree", table.workspaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "space_objects_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "space_objects_created_by_run_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "space_objects_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "space_objects_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.primaryProjectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "space_objects_primary_project_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "space_objects_space_id_fkey"
		}),
	foreignKey({
			columns: [table.workspaceId, table.spaceId],
			foreignColumns: [workspaces.id, workspaces.spaceId],
			name: "space_objects_workspace_id_fkey"
		}),
	unique("space_objects_id_space_id_key").on(table.id, table.spaceId),
	check("ck_space_objects_object_type", sql`(object_type)::text = ANY (ARRAY[('knowledge_item'::character varying)::text, ('note'::character varying)::text, ('source'::character varying)::text, ('person'::character varying)::text, ('organization'::character varying)::text, ('relationship'::character varying)::text, ('claim'::character varying)::text])`),
	check("ck_space_objects_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('disputed'::character varying)::text, ('superseded'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text, ('raw'::character varying)::text, ('processing'::character varying)::text, ('processed'::character varying)::text, ('error'::character varying)::text])`),
	check("ck_space_objects_status_by_type", sql`CASE (object_type)::text
    WHEN 'knowledge_item'::text THEN ((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text]))
    WHEN 'note'::text THEN ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text]))
    WHEN 'source'::text THEN ((status)::text = ANY (ARRAY[('raw'::character varying)::text, ('processing'::character varying)::text, ('processed'::character varying)::text, ('archived'::character varying)::text, ('error'::character varying)::text]))
    WHEN 'claim'::text THEN ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disputed'::character varying)::text, ('superseded'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text]))
    ELSE true
END`),
	check("ck_space_objects_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_space_objects_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_space_objects_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const spaceObjectKinds = pgTable("space_object_kinds", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	key: varchar({ length: 64 }).notNull(),
	label: varchar({ length: 160 }).notNull(),
	description: text(),
	baseObjectType: retrievalObjectType("base_object_type").notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	version: integer().default(1).notNull(),
	fieldSchemaJson: jsonb("field_schema_json").default({}).notNull(),
	extractionPolicyJson: jsonb("extraction_policy_json").default({}).notNull(),
	retrievalPolicyJson: jsonb("retrieval_policy_json").default({}).notNull(),
	uiConfigJson: jsonb("ui_config_json").default({}).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdFromProposalId: varchar("created_from_proposal_id", { length: 36 }),
	updatedFromProposalId: varchar("updated_from_proposal_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_space_object_kinds_base_object_type").using("btree", table.baseObjectType.asc().nullsLast()),
	index("ix_space_object_kinds_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast()),
	index("ix_space_object_kinds_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_space_object_kinds_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "space_object_kinds_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.createdFromProposalId],
			foreignColumns: [proposals.id],
			name: "space_object_kinds_created_from_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "space_object_kinds_space_id_fkey"
		}),
	foreignKey({
			columns: [table.updatedFromProposalId],
			foreignColumns: [proposals.id],
			name: "space_object_kinds_updated_from_proposal_id_fkey"
		}),
	unique("space_object_kinds_space_base_key_key").on(table.baseObjectType, table.key, table.spaceId),
	check("ck_space_object_kinds_extraction_policy_object", sql`jsonb_typeof(extraction_policy_json) = 'object'::text`),
	check("ck_space_object_kinds_field_schema_object", sql`jsonb_typeof(field_schema_json) = 'object'::text`),
	check("ck_space_object_kinds_key", sql`(key)::text ~ '^[a-z][a-z0-9_]{0,63}$'::text`),
	check("ck_space_object_kinds_key_by_base_object_type", sql`CASE (base_object_type)::text
    WHEN 'knowledge_item'::text THEN ((key)::text = ANY (ARRAY[('concept'::character varying)::text, ('lesson'::character varying)::text, ('procedure'::character varying)::text, ('decision'::character varying)::text, ('question'::character varying)::text, ('answer'::character varying)::text, ('summary'::character varying)::text]))
    WHEN 'note'::text THEN ((key)::text = 'note'::text)
    WHEN 'source'::text THEN ((key)::text = ANY (ARRAY[('activity_record'::character varying)::text, ('chat_capture'::character varying)::text, ('webpage'::character varying)::text, ('article'::character varying)::text, ('paper'::character varying)::text, ('pdf'::character varying)::text, ('file'::character varying)::text, ('email'::character varying)::text, ('manual_reference'::character varying)::text, ('external_note'::character varying)::text]))
    WHEN 'claim'::text THEN ((key)::text = ANY (ARRAY[('fact'::character varying)::text, ('hypothesis'::character varying)::text, ('belief'::character varying)::text, ('preference'::character varying)::text, ('commitment'::character varying)::text, ('question'::character varying)::text, ('interpretation'::character varying)::text, ('instruction'::character varying)::text, ('metric'::character varying)::text, ('relationship'::character varying)::text, ('event'::character varying)::text]))
    WHEN 'memory_entry'::text THEN ((key)::text = ANY (ARRAY[('preference'::character varying)::text, ('semantic'::character varying)::text, ('episodic'::character varying)::text, ('procedural'::character varying)::text, ('project'::character varying)::text]))
    WHEN 'project_public_summary'::text THEN ((key)::text = 'project_public_summary'::text)
    WHEN 'source_item'::text THEN ((key)::text = ANY (ARRAY[('external_url'::character varying)::text, ('feed_entry'::character varying)::text, ('activity_record'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('file'::character varying)::text, ('document'::character varying)::text, ('log'::character varying)::text]))
    WHEN 'extracted_evidence'::text THEN ((key)::text = ANY (ARRAY[('document'::character varying)::text, ('excerpt'::character varying)::text, ('event'::character varying)::text, ('log'::character varying)::text, ('artifact'::character varying)::text, ('claim'::character varying)::text, ('summary'::character varying)::text]))
    ELSE false
END`),
	check("ck_space_object_kinds_retrieval_policy_object", sql`jsonb_typeof(retrieval_policy_json) = 'object'::text`),
	check("ck_space_object_kinds_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('deprecated'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_space_object_kinds_ui_config_object", sql`jsonb_typeof(ui_config_json) = 'object'::text`),
	check("ck_space_object_kinds_version_positive", sql`version >= 1`),
]);

export const spaceObjectKindRelationHints = pgTable("space_object_kind_relation_hints", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectKindId: varchar("object_kind_id", { length: 36 }).notNull(),
	endpointObjectType: retrievalObjectType("endpoint_object_type").notNull(),
	endpointObjectKindId: varchar("endpoint_object_kind_id", { length: 36 }),
	relationType: varchar("relation_type", { length: 64 }).notNull(),
	direction: varchar({ length: 16 }).default('from').notNull(),
	confidenceDefault: doublePrecision("confidence_default").default(0.55).notNull(),
	required: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_space_object_kind_relation_hints_endpoint_kind").using("btree", table.endpointObjectKindId.asc().nullsLast()),
	index("ix_space_object_kind_relation_hints_object_kind").using("btree", table.objectKindId.asc().nullsLast()),
	index("ix_space_object_kind_relation_hints_required").using("btree", table.spaceId.asc().nullsLast(), table.required.asc().nullsLast()),
	foreignKey({
			columns: [table.endpointObjectKindId],
			foreignColumns: [spaceObjectKinds.id],
			name: "space_object_kind_relation_hints_endpoint_kind_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.objectKindId],
			foreignColumns: [spaceObjectKinds.id],
			name: "space_object_kind_relation_hints_object_kind_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "space_object_kind_relation_hints_space_id_fkey"
		}),
	check("ck_space_object_kind_relation_hints_confidence", sql`(confidence_default >= (0)::double precision) AND (confidence_default <= (1)::double precision)`),
	check("ck_space_object_kind_relation_hints_direction", sql`(direction)::text = ANY (ARRAY[('from'::character varying)::text, ('to'::character varying)::text, ('either'::character varying)::text])`),
	check("ck_space_object_kind_relation_hints_relation_type", sql`(relation_type)::text = ANY (ARRAY[('related_to'::character varying)::text, ('explains'::character varying)::text, ('depends_on'::character varying)::text, ('prerequisite_of'::character varying)::text, ('part_of'::character varying)::text, ('example_of'::character varying)::text, ('applies_to'::character varying)::text, ('supports'::character varying)::text, ('contradicts'::character varying)::text, ('derived_from'::character varying)::text, ('summarizes'::character varying)::text, ('updates'::character varying)::text, ('references'::character varying)::text, ('source_for'::character varying)::text, ('about'::character varying)::text, ('supersedes'::character varying)::text, ('refines'::character varying)::text, ('same_as'::character varying)::text])`),
]);

export const knowledgeItemSources = pgTable("knowledge_item_sources", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	knowledgeItemId: varchar("knowledge_item_id", { length: 36 }).notNull(),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	relationType: varchar("relation_type", { length: 32 }).notNull(),
	locator: varchar({ length: 1024 }),
	quote: text(),
	note: text(),
	confidence: doublePrecision(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_knowledge_item_sources_knowledge_item_id").using("btree", table.knowledgeItemId.asc().nullsLast()),
	index("ix_knowledge_item_sources_relation_type").using("btree", table.relationType.asc().nullsLast()),
	index("ix_knowledge_item_sources_source_id").using("btree", table.sourceId.asc().nullsLast()),
	index("ix_knowledge_item_sources_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("ix_knowledge_item_sources_unique").using("btree", table.knowledgeItemId.asc().nullsLast(), table.sourceId.asc().nullsLast(), table.relationType.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "knowledge_item_sources_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.knowledgeItemId, table.spaceId],
			foreignColumns: [knowledgeItems.objectId, knowledgeItems.spaceId],
			name: "knowledge_item_sources_knowledge_item_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceId, table.spaceId],
			foreignColumns: [sources.objectId, sources.spaceId],
			name: "knowledge_item_sources_source_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "knowledge_item_sources_space_id_fkey"
		}),
	check("ck_knowledge_item_sources_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_knowledge_item_sources_relation_type", sql`(relation_type)::text = ANY (ARRAY[('derived_from'::character varying)::text, ('supported_by'::character varying)::text, ('cites'::character varying)::text, ('summarizes'::character varying)::text, ('mentions'::character varying)::text])`),
]);

export const sources = pgTable("sources", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	sourceType: varchar("source_type", { length: 64 }).notNull(),
	uri: text(),
	contentRef: varchar("content_ref", { length: 1024 }),
	rawText: text("raw_text"),
	summary: text(),
	metadataJson: jsonb("metadata_json").notNull(),
	sourceActivityId: varchar("source_activity_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_sources_source_activity_id").using("btree", table.sourceActivityId.asc().nullsLast()),
	index("ix_sources_source_type").using("btree", table.sourceType.asc().nullsLast()),
	index("ix_sources_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.sourceActivityId],
			foreignColumns: [activityRecords.id],
			name: "sources_source_activity_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "sources_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "sources_object_id_fkey"
		}).onDelete("cascade"),
	unique("sources_object_id_space_id_key").on(table.objectId, table.spaceId),
	check("ck_sources_source_type", sql`(source_type)::text = ANY (ARRAY[('activity_record'::character varying)::text, ('chat_capture'::character varying)::text, ('webpage'::character varying)::text, ('article'::character varying)::text, ('paper'::character varying)::text, ('pdf'::character varying)::text, ('file'::character varying)::text, ('email'::character varying)::text, ('manual_reference'::character varying)::text, ('external_note'::character varying)::text])`),
]);

// Canonical bridge from an ingested SourceItem to the Knowledge Reference it
// materialized. SourceItem origin fields describe where an item was captured
// from (Activity/Artifact/RunEvent); they must not also carry Reference identity.
export const sourceItemReferences = pgTable("source_item_references", {
	sourceItemId: varchar("source_item_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	referenceObjectId: varchar("reference_object_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_source_item_references_reference").using("btree", table.spaceId.asc().nullsLast(), table.referenceObjectId.asc().nullsLast()),
	foreignKey({
		columns: [table.sourceItemId, table.spaceId],
		foreignColumns: [sourceItems.id, sourceItems.spaceId],
		name: "source_item_references_source_item_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.referenceObjectId, table.spaceId],
		foreignColumns: [sources.objectId, sources.spaceId],
		name: "source_item_references_reference_fkey",
	}).onDelete("cascade"),
]);

export const claims = pgTable("claims", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	subjectObjectId: varchar("subject_object_id", { length: 36 }),
	subjectText: text("subject_text"),
	claimKind: varchar("claim_kind", { length: 32 }).notNull(),
	claimText: text("claim_text").notNull(),
	normalizedClaimHash: varchar("normalized_claim_hash", { length: 128 }).notNull(),
	holderObjectId: varchar("holder_object_id", { length: 36 }),
	holderType: varchar("holder_type", { length: 64 }),
	holderId: varchar("holder_id", { length: 128 }),
	confidence: doublePrecision(),
	confidenceMethod: varchar("confidence_method", { length: 32 }).notNull(),
	resolutionState: varchar("resolution_state", { length: 32 }).notNull(),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }),
	validUntil: timestamp("valid_until", { withTimezone: true, mode: 'string' }),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdFromProposalId: varchar("created_from_proposal_id", { length: 36 }),
	approvedByUserId: varchar("approved_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_claims_claim_kind").using("btree", table.claimKind.asc().nullsLast()),
	index("ix_claims_created_from_proposal_id").using("btree", table.createdFromProposalId.asc().nullsLast()),
	index("ix_claims_holder_object_id").using("btree", table.holderObjectId.asc().nullsLast()),
	index("ix_claims_normalized_claim_hash").using("btree", table.normalizedClaimHash.asc().nullsLast()),
	index("ix_claims_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_claims_subject_object_id").using("btree", table.subjectObjectId.asc().nullsLast()),
	foreignKey({
			columns: [table.approvedByUserId],
			foreignColumns: [users.id],
			name: "claims_approved_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.createdFromProposalId],
			foreignColumns: [proposals.id],
			name: "claims_created_from_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.holderObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "claims_holder_object_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "claims_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "claims_space_id_fkey"
		}),
	foreignKey({
			columns: [table.subjectObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "claims_subject_object_id_fkey"
		}),
	unique("claims_object_id_space_id_key").on(table.objectId, table.spaceId),
	check("ck_claims_claim_kind", sql`(claim_kind)::text = ANY (ARRAY[('fact'::character varying)::text, ('hypothesis'::character varying)::text, ('belief'::character varying)::text, ('preference'::character varying)::text, ('commitment'::character varying)::text, ('question'::character varying)::text, ('interpretation'::character varying)::text, ('instruction'::character varying)::text, ('metric'::character varying)::text, ('relationship'::character varying)::text, ('event'::character varying)::text])`),
	check("ck_claims_claim_text", sql`btrim(claim_text) <> ''::text`),
	check("ck_claims_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_claims_confidence_method", sql`(confidence_method)::text = ANY (ARRAY[('human_confirmed'::character varying)::text, ('source_extracted'::character varying)::text, ('llm_extracted'::character varying)::text, ('inferred'::character varying)::text, ('imported'::character varying)::text])`),
	check("ck_claims_holder_ref", sql`((holder_object_id IS NOT NULL) AND (holder_type IS NULL) AND (holder_id IS NULL)) OR ((holder_object_id IS NULL) AND (((holder_type IS NULL) AND (holder_id IS NULL)) OR ((holder_type IS NOT NULL) AND (holder_id IS NOT NULL))))`),
	check("ck_claims_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_claims_resolution_state", sql`(resolution_state)::text = ANY (ARRAY[('unreviewed'::character varying)::text, ('confirmed'::character varying)::text, ('contradicted'::character varying)::text, ('stale'::character varying)::text, ('needs_source'::character varying)::text])`),
	check("ck_claims_subject", sql`(subject_object_id IS NOT NULL) OR ((subject_text IS NOT NULL) AND (btrim(subject_text) <> ''::text))`),
	check("ck_claims_valid_range", sql`(valid_from IS NULL) OR (valid_until IS NULL) OR (valid_from <= valid_until)`),
]);

export const claimSources = pgTable("claim_sources", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	claimId: varchar("claim_id", { length: 36 }).notNull(),
	sourceObjectId: varchar("source_object_id", { length: 36 }),
	sourceRefType: varchar("source_ref_type", { length: 64 }),
	sourceRefId: varchar("source_ref_id", { length: 36 }),
	sourceConnectionId: varchar("source_connection_id", { length: 36 }),
	sourcePolicySnapshotJson: jsonb("source_policy_snapshot_json").default({}).notNull(),
	locator: varchar({ length: 1024 }),
	quoteExcerpt: text("quote_excerpt"),
	evidenceRole: varchar("evidence_role", { length: 32 }).notNull(),
	sourceTrust: varchar("source_trust", { length: 32 }),
	confidence: doublePrecision(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_claim_sources_claim_id").using("btree", table.claimId.asc().nullsLast()),
	index("ix_claim_sources_source_connection_id").using("btree", table.sourceConnectionId.asc().nullsLast()),
	index("ix_claim_sources_source_object_id").using("btree", table.sourceObjectId.asc().nullsLast()),
	index("ix_claim_sources_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.claimId, table.spaceId],
			foreignColumns: [claims.objectId, claims.spaceId],
			name: "claim_sources_claim_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "claim_sources_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceConnectionId, table.spaceId],
			foreignColumns: [sourceConnections.id, sourceConnections.spaceId],
			name: "claim_sources_source_connection_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "claim_sources_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "claim_sources_space_id_fkey"
		}),
	check("ck_claim_sources_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_claim_sources_evidence_role", sql`(evidence_role)::text = ANY (ARRAY[('supports'::character varying)::text, ('contradicts'::character varying)::text, ('mentions'::character varying)::text, ('derived_from'::character varying)::text, ('cites'::character varying)::text, ('summarizes'::character varying)::text])`),
	check("ck_claim_sources_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_claim_sources_policy_snapshot_object", sql`jsonb_typeof(source_policy_snapshot_json) = 'object'::text`),
	check("ck_claim_sources_has_source", sql`(source_object_id IS NOT NULL) OR ((source_ref_type IS NOT NULL) AND (source_ref_id IS NOT NULL)) OR (source_connection_id IS NOT NULL)`),
	check("ck_claim_sources_source_ref", sql`((source_ref_type IS NULL) AND (source_ref_id IS NULL)) OR ((source_ref_type IS NOT NULL) AND (source_ref_id IS NOT NULL))`),
	check("ck_claim_sources_source_ref_connection", sql`(source_ref_type IS NULL) OR (source_connection_id IS NOT NULL)`),
	check("ck_claim_sources_source_ref_type", sql`(source_ref_type IS NULL) OR ((source_ref_type)::text = ANY (ARRAY[('activity'::character varying)::text, ('artifact'::character varying)::text, ('run_event'::character varying)::text, ('extracted_evidence'::character varying)::text, ('source_snapshot'::character varying)::text, ('external_pointer'::character varying)::text, ('source_item'::character varying)::text]))`),
	check("ck_claim_sources_source_trust", sql`(source_trust IS NULL) OR ((source_trust)::text = ANY (ARRAY[('trusted'::character varying)::text, ('normal'::character varying)::text, ('untrusted'::character varying)::text, ('unknown'::character varying)::text]))`),
]);

export const objectRelations = pgTable("object_relations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	fromObjectId: varchar("from_object_id", { length: 36 }).notNull(),
	toObjectId: varchar("to_object_id", { length: 36 }).notNull(),
	relationType: varchar("relation_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	confidence: doublePrecision(),
	evidenceSummary: text("evidence_summary"),
	sourceClaimId: varchar("source_claim_id", { length: 36 }),
	sourceObjectId: varchar("source_object_id", { length: 36 }),
	sourceProposalId: varchar("source_proposal_id", { length: 36 }),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_object_relations_from_object_id").using("btree", table.fromObjectId.asc().nullsLast()),
	index("ix_object_relations_relation_type").using("btree", table.relationType.asc().nullsLast()),
	index("ix_object_relations_source_claim_id").using("btree", table.sourceClaimId.asc().nullsLast()),
	index("ix_object_relations_source_object_id").using("btree", table.sourceObjectId.asc().nullsLast()),
	index("ix_object_relations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_object_relations_status").using("btree", table.status.asc().nullsLast()),
	index("ix_object_relations_to_object_id").using("btree", table.toObjectId.asc().nullsLast()),
	uniqueIndex("ix_object_relations_unique_active").using("btree", table.spaceId.asc().nullsLast(), table.fromObjectId.asc().nullsLast(), table.toObjectId.asc().nullsLast(), table.relationType.asc().nullsLast()).where(sql`((status)::text = 'active'::text)`),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "object_relations_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "object_relations_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.fromObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "object_relations_from_object_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceClaimId, table.spaceId],
			foreignColumns: [claims.objectId, claims.spaceId],
			name: "object_relations_source_claim_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "object_relations_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceProposalId],
			foreignColumns: [proposals.id],
			name: "object_relations_source_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "object_relations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.toObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "object_relations_to_object_id_fkey"
		}),
	check("ck_object_relations_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_object_relations_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_object_relations_no_self", sql`(from_object_id)::text <> (to_object_id)::text`),
	check("ck_object_relations_relation_type", sql`(relation_type)::text = ANY (ARRAY[('related_to'::character varying)::text, ('references'::character varying)::text, ('depends_on'::character varying)::text, ('part_of'::character varying)::text, ('source_for'::character varying)::text, ('derived_from'::character varying)::text, ('about'::character varying)::text, ('supports'::character varying)::text, ('contradicts'::character varying)::text, ('supersedes'::character varying)::text, ('refines'::character varying)::text, ('same_as'::character varying)::text, ('affiliated_with'::character varying)::text, ('cites'::character varying)::text, ('authored_by'::character varying)::text])`),
	check("ck_object_relations_status", sql`(status)::text = ANY (ARRAY[('candidate'::character varying)::text, ('active'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text])`),
]);

export const noteCollections = pgTable("note_collections", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	parentId: varchar("parent_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	systemRole: varchar("system_role", { length: 32 }).notNull(),
	sortOrder: integer("sort_order").notNull(),
	isSystem: boolean("is_system").notNull(),
	isHidden: boolean("is_hidden").notNull(),
	projectId: varchar("project_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("ix_note_collections_one_archive_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`((system_role)::text = 'archive'::text)`),
	uniqueIndex("ix_note_collections_one_inbox_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`((system_role)::text = 'inbox'::text)`),
	uniqueIndex("ix_note_collections_one_projects_root_per_space").using("btree", table.spaceId.asc().nullsLast()).where(sql`((system_role)::text = 'projects_root'::text)`),
	uniqueIndex("ix_note_collections_one_per_project").using("btree", table.spaceId.asc().nullsLast(), table.projectId.asc().nullsLast()).where(sql`(project_id IS NOT NULL)`),
	index("ix_note_collections_parent_id").using("btree", table.parentId.asc().nullsLast()),
	index("ix_note_collections_parent_sort").using("btree", table.spaceId.asc().nullsLast(), table.parentId.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	index("ix_note_collections_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_note_collections_system_role").using("btree", table.systemRole.asc().nullsLast()),
	foreignKey({
			columns: [table.parentId],
			foreignColumns: [table.id],
			name: "note_collections_parent_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.parentId, table.spaceId],
			foreignColumns: [table.id, table.spaceId],
			name: "note_collections_parent_id_space_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "note_collections_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "note_collections_project_id_fkey"
		}).onDelete("cascade"),
	unique("note_collections_id_space_id_key").on(table.id, table.spaceId),
	check("ck_note_collections_not_self_parent", sql`(parent_id IS NULL) OR ((parent_id)::text <> (id)::text)`),
	check("ck_note_collections_system_role", sql`(system_role)::text = ANY (ARRAY[('normal'::character varying)::text, ('inbox'::character varying)::text, ('archive'::character varying)::text, ('project'::character varying)::text, ('projects_root'::character varying)::text])`),
	check("ck_note_collections_project_role", sql`(project_id IS NULL) OR (system_role = 'project')`),
]);

export const noteCollectionItems = pgTable("note_collection_items", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	collectionId: varchar("collection_id", { length: 36 }).notNull(),
	noteId: varchar("note_id", { length: 36 }).notNull(),
	sortOrder: integer("sort_order").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_note_collection_items_collection_id").using("btree", table.spaceId.asc().nullsLast(), table.collectionId.asc().nullsLast()),
	index("ix_note_collection_items_note_id").using("btree", table.spaceId.asc().nullsLast(), table.noteId.asc().nullsLast()),
	foreignKey({
			columns: [table.collectionId, table.spaceId],
			foreignColumns: [noteCollections.id, noteCollections.spaceId],
			name: "note_collection_items_collection_id_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.noteId, table.spaceId],
			foreignColumns: [notes.objectId, notes.spaceId],
			name: "note_collection_items_note_id_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "note_collection_items_space_id_fkey"
		}),
	unique("uq_note_collection_items_collection_note").on(table.collectionId, table.noteId, table.spaceId),
]);

export const notes = pgTable("notes", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	contentJson: jsonb("content_json"),
	contentFormat: varchar("content_format", { length: 32 }).notNull(),
	contentSchemaVersion: integer("content_schema_version").notNull(),
	plainText: text("plain_text"),
	createdFromActivityId: varchar("created_from_activity_id", { length: 36 }),
	version: integer().default(1).notNull(),
	contentHash: varchar("content_hash", { length: 64 }),
	updatedByUserId: varchar("updated_by_user_id", { length: 36 }),
	updatedByRunId: varchar("updated_by_run_id", { length: 36 }),
	refsJson: jsonb("refs_json").default([]).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_notes_created_from_activity_id").using("btree", table.createdFromActivityId.asc().nullsLast()),
	index("ix_notes_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.createdFromActivityId],
			foreignColumns: [activityRecords.id],
			name: "notes_created_from_activity_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "notes_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "notes_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "notes_updated_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.updatedByRunId],
			foreignColumns: [runs.id],
			name: "notes_updated_by_run_id_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.updatedByRunId, table.spaceId],
			foreignColumns: [runs.id, runs.spaceId],
			name: "notes_updated_by_run_id_fkey"
		}),
	unique("notes_object_id_space_id_key").on(table.objectId, table.spaceId),
	check("ck_notes_content_format", sql`(content_format)::text = ANY (ARRAY[('markdown'::character varying)::text, ('plain'::character varying)::text, ('prosemirror_json'::character varying)::text])`),
	check("ck_notes_version", sql`version >= 1`),
	check("ck_notes_refs_array", sql`jsonb_typeof(refs_json) = 'array'`),
]);

export const noteRevisions = pgTable("note_revisions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	noteId: varchar("note_id", { length: 36 }).notNull(),
	version: integer().notNull(),
	contentJson: jsonb("content_json").notNull(),
	normalizedText: text("normalized_text").notNull(),
	contentHash: varchar("content_hash", { length: 64 }).notNull(),
	refsJson: jsonb("refs_json").default([]).notNull(),
	source: varchar({ length: 24 }).notNull(),
	diffJson: jsonb("diff_json"),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_note_revisions_version").on(table.noteId, table.version),
	index("ix_note_revisions_note").on(table.spaceId, table.noteId, table.version),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "note_revisions_space_fkey" }),
	foreignKey({ columns: [table.noteId, table.spaceId], foreignColumns: [notes.objectId, notes.spaceId], name: "note_revisions_note_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "note_revisions_user_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.createdByRunId], foreignColumns: [runs.id], name: "note_revisions_run_delete_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.createdByRunId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "note_revisions_run_fkey" }),
	check("ck_note_revisions_version", sql`version >= 1`),
	check("ck_note_revisions_source", sql`source IN ('user_edit','ai_monitoring','ai_adhoc','seed','rollback')`),
	check("ck_note_revisions_refs_array", sql`jsonb_typeof(refs_json) = 'array'`),
]);

export const noteLinks = pgTable("note_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	fromObjectId: varchar("from_object_id", { length: 36 }).notNull(),
	fromObjectType: retrievalObjectType("from_object_type").notNull(),
	toObjectId: varchar("to_object_id", { length: 36 }).notNull(),
	toObjectType: retrievalObjectType("to_object_type").notNull(),
	linkType: varchar("link_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	confidence: doublePrecision(),
	metadataJson: jsonb("metadata_json").default({}).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_note_links_from_object").using("btree", table.spaceId.asc().nullsLast(), table.fromObjectId.asc().nullsLast()),
	index("ix_note_links_link_type").using("btree", table.linkType.asc().nullsLast()),
	index("ix_note_links_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_note_links_status").using("btree", table.status.asc().nullsLast()),
	index("ix_note_links_to_object").using("btree", table.spaceId.asc().nullsLast(), table.toObjectId.asc().nullsLast()),
	uniqueIndex("ix_note_links_unique_active").using("btree", table.spaceId.asc().nullsLast(), table.fromObjectId.asc().nullsLast(), table.toObjectId.asc().nullsLast(), table.linkType.asc().nullsLast()).where(sql`((status)::text = 'active'::text)`),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "note_links_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.fromObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "note_links_from_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "note_links_space_id_fkey"
		}),
	foreignKey({
			columns: [table.toObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "note_links_to_object_id_fkey"
		}).onDelete("cascade"),
	check("ck_note_links_confidence", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("ck_note_links_has_note_endpoint", sql`((from_object_type)::text = 'note'::text) OR ((to_object_type)::text = 'note'::text)`),
	check("ck_note_links_link_type", sql`(link_type)::text = ANY (ARRAY[('related_to'::character varying)::text, ('references'::character varying)::text, ('depends_on'::character varying)::text, ('part_of'::character varying)::text, ('source_for'::character varying)::text, ('derived_from'::character varying)::text, ('about'::character varying)::text, ('supports'::character varying)::text, ('contradicts'::character varying)::text, ('supersedes'::character varying)::text, ('refines'::character varying)::text, ('same_as'::character varying)::text, ('explains'::character varying)::text, ('prerequisite_of'::character varying)::text, ('example_of'::character varying)::text, ('applies_to'::character varying)::text, ('summarizes'::character varying)::text, ('updates'::character varying)::text])`),
	check("ck_note_links_metadata_object", sql`jsonb_typeof(metadata_json) = 'object'::text`),
	check("ck_note_links_no_self", sql`(from_object_id)::text <> (to_object_id)::text`),
	check("ck_note_links_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
]);
