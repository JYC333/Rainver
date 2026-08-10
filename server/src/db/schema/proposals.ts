import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, text, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { users } from "./auth";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { projectFolders } from "./projectFolders";
import { projects } from "./projects";
import { personalMemoryGrants } from "./personalMemoryGrants";
import { actionApprovalGrants } from "./actionApprovalGrants";

export const proposals = pgTable("proposals", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	createdByRunId: varchar("created_by_run_id", { length: 36 }),
	actionIdempotencyKey: varchar("action_idempotency_key",{length:256}),
	proposalType: varchar("proposal_type", { length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	riskLevel: varchar("risk_level", { length: 32 }).notNull(),
	urgency: varchar({ length: 32 }).notNull(),
	preview: boolean().default(false).notNull(),
	title: varchar({ length: 512 }).notNull(),
	summary: text(),
	payloadJson: jsonb("payload_json").notNull(),
	reviewDeadline: timestamp("review_deadline", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	reviewedBy: varchar("reviewed_by", { length: 36 }),
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	rationale: text(),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	requiredApproverRole: varchar("required_approver_role", { length: 64 }),
	visibility: varchar({ length: 32 }).default('space_shared').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	projectId: varchar("project_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_proposals_created_by_run_id").using("btree", table.createdByRunId.asc().nullsLast()),
	index("ix_proposals_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_proposals_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_proposals_proposal_type").using("btree", table.proposalType.asc().nullsLast()),
	index("ix_proposals_risk_level").using("btree", table.riskLevel.asc().nullsLast()),
	index("ix_proposals_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_proposals_status").using("btree", table.status.asc().nullsLast()),
	index("ix_proposals_urgency").using("btree", table.urgency.asc().nullsLast()),
	index("ix_proposals_project_folder_id").using("btree", table.projectFolderId.asc().nullsLast()),
	unique("uq_proposals_id_space_id").on(table.id, table.spaceId),
	uniqueIndex("uq_proposals_run_action_idempotency").on(table.createdByRunId,table.proposalType,table.actionIdempotencyKey).where(sql`action_idempotency_key IS NOT NULL`),
	uniqueIndex("uq_proposals_pending_research_query_strategy").on(table.spaceId, table.projectId, table.proposalType).where(sql`status='pending' AND proposal_type='research_query_strategy_activation'`),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "proposals_project_id_delete_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.projectId, table.spaceId],
			foreignColumns: [projects.id, projects.spaceId],
			name: "fk_proposals_project_id_projects"
		}),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "proposals_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByRunId],
			foreignColumns: [runs.id],
			name: "proposals_created_by_run_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "proposals_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "proposals_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [users.id],
			name: "proposals_reviewed_by_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "proposals_space_id_fkey"
		}),
	foreignKey({
			columns: [table.projectFolderId, table.spaceId],
			foreignColumns: [projectFolders.id, projectFolders.spaceId],
			name: "proposals_project_folder_id_fkey"
		}),
	check("ck_proposals_risk_level", sql`(risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
	check("ck_proposals_urgency", sql`(urgency)::text = ANY (ARRAY[('low'::character varying)::text, ('normal'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
	check("ck_proposals_visibility", sql`visibility IN ('private', 'space_shared', 'selected_users')`),
	check("ck_proposals_access_level", sql`access_level IN ('full', 'summary')`),
	check("ck_proposals_private_owner", sql`visibility = 'space_shared' OR owner_user_id IS NOT NULL`),
]);

export const proposalApprovals = pgTable("proposal_approvals", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	proposalId: varchar("proposal_id", { length: 36 }).notNull(),
	approvalType: varchar("approval_type", { length: 64 }).notNull(),
	approverUserId: varchar("approver_user_id", { length: 36 }).notNull(),
	grantId: varchar("grant_id", { length: 36 }),
	actionGrantId: varchar("action_grant_id", { length: 36 }),
	targetSpaceId: varchar("target_space_id", { length: 36 }),
	status: varchar({ length: 32 }).notNull(),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_proposal_approvals_approval_type").using("btree", table.approvalType.asc().nullsLast()),
	index("ix_proposal_approvals_approver_user_id").using("btree", table.approverUserId.asc().nullsLast()),
	index("ix_proposal_approvals_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("ix_proposal_approvals_grant_id").using("btree", table.grantId.asc().nullsLast()),
	index("ix_proposal_approvals_action_grant_id").using("btree", table.actionGrantId.asc().nullsLast()),
	index("ix_proposal_approvals_proposal_id").using("btree", table.proposalId.asc().nullsLast()),
	index("ix_proposal_approvals_target_space_id").using("btree", table.targetSpaceId.asc().nullsLast()),
	uniqueIndex("ix_proposal_approvals_unique_active").using("btree", table.proposalId.asc().nullsLast(), table.approvalType.asc().nullsLast(), table.approverUserId.asc().nullsLast(), table.grantId.asc().nullsLast()).where(sql`((status)::text = 'approved'::text)`),
	uniqueIndex("uq_proposal_approvals_taint_owner").on(table.proposalId, table.approvalType, table.approverUserId).where(sql`status = 'approved' AND grant_id IS NULL AND approval_type = 'egress_granting_user'`),
	uniqueIndex("ix_proposal_approvals_unique_action_grant").on(table.proposalId, table.actionGrantId).where(sql`status = 'approved' AND action_grant_id IS NOT NULL`),
	foreignKey({
			columns: [table.approverUserId],
			foreignColumns: [users.id],
			name: "proposal_approvals_approver_user_id_fkey"
		}),
	foreignKey({
			columns: [table.grantId],
			foreignColumns: [personalMemoryGrants.id],
		name: "proposal_approvals_grant_id_fkey"
		}),
	foreignKey({
		columns: [table.actionGrantId],
		foreignColumns: [actionApprovalGrants.id],
		name: "proposal_approvals_action_grant_id_fkey"
	}),
	foreignKey({
			columns: [table.proposalId],
			foreignColumns: [proposals.id],
			name: "proposal_approvals_proposal_id_fkey"
		}),
	foreignKey({
			columns: [table.targetSpaceId],
			foreignColumns: [spaces.id],
			name: "proposal_approvals_target_space_id_fkey"
		}),
	check("ck_proposal_approvals_approval_type", sql`(approval_type)::text = ANY (ARRAY['egress_granting_user'::text, 'action_grant'::text])`),
	check("ck_proposal_approvals_status", sql`(status)::text = ANY (ARRAY[('approved'::character varying)::text, ('revoked'::character varying)::text])`),
]);
