import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { spaceMemberships, spaces } from "./spaces.js";
import { focusAreas } from "./focusAreas.js";

export const projects = pgTable("projects", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	status: varchar({ length: 32 }).notNull(),
	currentFocus: text("current_focus"),
	settingsJson: jsonb("settings_json"),
	/** Which long-term focus area this Project serves. Navigation only. ADR 0015. */
	focusAreaId: varchar("focus_area_id", { length: 36 }),
	activeBriefVersionId: varchar("active_brief_version_id", { length: 36 }),
	activeInstructionVersionId: varchar("active_instruction_version_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_projects_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_projects_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_projects_status").using("btree", table.status.asc().nullsLast()),
	index("ix_projects_focus_area_id")
		.using("btree", table.focusAreaId.asc().nullsLast())
		.where(sql`focus_area_id IS NOT NULL`),
	uniqueIndex("uq_projects_space_name_active").using("btree", table.spaceId.asc().nullsLast(), table.name.asc().nullsLast()).where(sql`((status)::text = 'active'::text)`),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "projects_owner_user_id_fkey"
	}),
	foreignKey({
		columns: [table.activeInstructionVersionId, table.id, table.spaceId],
		foreignColumns: [projectInstructionVersions.id, projectInstructionVersions.projectId, projectInstructionVersions.spaceId],
		name: "projects_active_instruction_version_fkey"
	}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "projects_space_id_fkey"
		}),
	// Composite so a Project cannot point at another Space's focus area.
	foreignKey({
			columns: [table.focusAreaId, table.spaceId],
			foreignColumns: [focusAreas.id, focusAreas.spaceId],
			name: "projects_focus_area_id_fkey"
		}),
	foreignKey({
			columns: [table.activeBriefVersionId, table.id, table.spaceId],
			foreignColumns: [projectBriefVersions.id, projectBriefVersions.projectId, projectBriefVersions.spaceId],
			name: "projects_active_brief_version_fkey"
		}),
	unique("uq_projects_space_id_id").on(table.id, table.spaceId),
	check("ck_projects_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text])`),
]);

// Versioned Project Brief. Material changes create a new version; the active
// pointer lives on `projects.active_brief_version_id`. See ADR 0011 and the
// current Projects architecture document.
export const projectBriefVersions = pgTable("project_brief_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	version: varchar({ length: 16 }).notNull(),
	goal: text(),
	scopeIncluded: text("scope_included"),
	scopeExcluded: text("scope_excluded"),
	successDefinition: text("success_definition"),
	constraints: text(),
	assumptions: text(),
	projectStatus: varchar("project_status", { length: 32 }).notNull(),
	currentFocus: text("current_focus"),
	confirmedDecisionsJson: jsonb("confirmed_decisions_json").default([]).notNull(),
	workspaceIdentityJson: jsonb("workspace_identity_json").default({}).notNull(),
	workspaceBoundaryJson: jsonb("workspace_boundary_json").default({}).notNull(),
	sourceRefsJson: jsonb("source_refs_json").default([]).notNull(),
	status: varchar({ length: 32 }).default('draft').notNull(),
	reviewedByUserId: varchar("reviewed_by_user_id", { length: 36 }),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	publishedByUserId: varchar("published_by_user_id", { length: 36 }),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_brief_versions_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_brief_versions_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("uq_project_brief_versions_project_version").using("btree", table.projectId.asc().nullsLast(), table.version.asc().nullsLast()),
	unique("uq_project_brief_versions_id_project_space").on(table.id, table.projectId, table.spaceId),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_brief_versions_space_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_brief_versions_space_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "project_brief_versions_created_by_user_id_fkey"
	}).onDelete("set null"),
	foreignKey({ columns: [table.reviewedByUserId], foreignColumns: [users.id], name: "project_brief_versions_reviewed_by_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.publishedByUserId], foreignColumns: [users.id], name: "project_brief_versions_published_by_user_id_fkey" }).onDelete("set null"),
	check("ck_project_brief_versions_status", sql`status IN ('draft', 'in_review', 'published', 'archived')`),
	check("ck_project_brief_versions_project_status", sql`project_status IN ('active', 'archived', 'deleted')`),
	check("ck_project_brief_versions_confirmed_decisions_array", sql`jsonb_typeof(confirmed_decisions_json) = 'array'`),
	check("ck_project_brief_versions_workspace_identity_object", sql`jsonb_typeof(workspace_identity_json) = 'object'`),
	check("ck_project_brief_versions_workspace_boundary_object", sql`jsonb_typeof(workspace_boundary_json) = 'object'`),
	check("ck_project_brief_versions_source_refs_array", sql`jsonb_typeof(source_refs_json) = 'array'`),
]);

export const projectInstructionVersions = pgTable("project_instruction_versions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	version: varchar({ length: 16 }).notNull(),
	title: varchar({ length: 256 }).notNull(),
	instructionText: text("instruction_text").notNull(),
	status: varchar({ length: 32 }).default('draft').notNull(),
	reviewedByUserId: varchar("reviewed_by_user_id", { length: 36 }),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	publishedByUserId: varchar("published_by_user_id", { length: 36 }),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_project_instruction_versions_project_id").on(table.projectId),
	uniqueIndex("uq_project_instruction_versions_project_version").on(table.projectId, table.version),
	unique("uq_project_instruction_versions_id_project_space").on(table.id, table.projectId, table.spaceId),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "project_instruction_versions_space_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "project_instruction_versions_space_id_fkey" }),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "project_instruction_versions_created_by_user_id_fkey" }),
	foreignKey({ columns: [table.reviewedByUserId], foreignColumns: [users.id], name: "project_instruction_versions_reviewed_by_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.publishedByUserId], foreignColumns: [users.id], name: "project_instruction_versions_published_by_user_id_fkey" }).onDelete("set null"),
	check("ck_project_instruction_versions_status", sql`status IN ('draft', 'in_review', 'published', 'archived')`),
]);

// Per-user UI state over aggregated ProjectAttentionItem rows (which are
// computed on demand from registered domain adapters, not stored). See plan
// section 8.
export const projectAttentionUserStates = pgTable("project_attention_user_states", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	sourceType: varchar("source_type", { length: 64 }).notNull(),
	sourceId: varchar("source_id", { length: 36 }).notNull(),
	seenAt: timestamp("seen_at", { withTimezone: true, mode: 'string' }),
	snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: 'string' }),
	pinnedAt: timestamp("pinned_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("uq_project_attention_user_states_scope").using("btree", table.userId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.sourceType.asc().nullsLast(), table.sourceId.asc().nullsLast()),
	index("ix_project_attention_user_states_project_id").using("btree", table.projectId.asc().nullsLast()),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_attention_user_states_space_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_attention_user_states_space_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "project_attention_user_states_user_id_fkey"
		}).onDelete("cascade"),
]);

export const projectPublicSummaries = pgTable("project_public_summaries", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	summaryText: text("summary_text").notNull(),
	topicsJson: jsonb("topics_json").default([]).notNull(),
	highlightsJson: jsonb("highlights_json").default([]).notNull(),
	sourceRefsJson: jsonb("source_refs_json").default([]).notNull(),
	redactionVersion: varchar("redaction_version", { length: 64 }).notNull(),
	reviewStatus: varchar("review_status", { length: 32 }).default('pending').notNull(),
	updatedByUserId: varchar("updated_by_user_id", { length: 36 }),
	generatedByRunId: varchar("generated_by_run_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("ix_project_public_summaries_project_unique").using("btree", table.projectId.asc().nullsLast()),
	index("ix_project_public_summaries_review_status").using("btree", table.reviewStatus.asc().nullsLast()),
	index("ix_project_public_summaries_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.generatedByRunId],
			foreignColumns: [runs.id],
			name: "project_public_summaries_generated_by_run_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_public_summaries_space_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_public_summaries_space_id_fkey"
		}),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "project_public_summaries_updated_by_user_id_fkey"
		}).onDelete("set null"),
	check("ck_project_public_summaries_highlights_array", sql`jsonb_typeof(highlights_json) = 'array'::text`),
	check("ck_project_public_summaries_review_status", sql`(review_status)::text = ANY (ARRAY[('draft'::character varying)::text, ('approved'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_project_public_summaries_source_refs_array", sql`jsonb_typeof(source_refs_json) = 'array'::text`),
	check("ck_project_public_summaries_topics_array", sql`jsonb_typeof(topics_json) = 'array'::text`),
]);

export const projectMembers = pgTable("project_members", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	role: varchar({ length: 32 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("ix_project_members_project_user_unique").using("btree", table.projectId.asc().nullsLast(), table.userId.asc().nullsLast()),
	index("ix_project_members_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_project_members_user_id").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "project_members_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "project_members_space_project_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "project_members_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId, table.userId],
			foreignColumns: [spaceMemberships.spaceId, spaceMemberships.userId],
			name: "project_members_space_membership_fkey"
		}).onDelete("cascade"),
	check("ck_project_members_role", sql`(role)::text = ANY (ARRAY[('owner'::character varying)::text, ('member'::character varying)::text, ('viewer'::character varying)::text])`),
	check("ck_project_members_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('invited'::character varying)::text, ('revoked'::character varying)::text])`),
]);
