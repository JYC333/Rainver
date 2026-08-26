import { pgTable, index, unique, check, foreignKey, varchar, integer, boolean, jsonb, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { proposals } from "./proposals.js";

export const policies = pgTable("policies", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	name: varchar({ length: 256 }).notNull(),
	domain: varchar({ length: 64 }).notNull(),
	policyJson: jsonb("policy_json").notNull(),
	enabled: boolean().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	policyKey: varchar("policy_key", { length: 256 }),
	policyVersion: integer("policy_version").default(1).notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	enforcementMode: varchar("enforcement_mode", { length: 32 }),
	priority: integer().default(0).notNull(),
	ruleJson: jsonb("rule_json"),
	appliesToJson: jsonb("applies_to_json"),
	supersedesPolicyId: varchar("supersedes_policy_id", { length: 36 }),
	createdFromProposalId: varchar("created_from_proposal_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_policies_created_from_proposal_id").using("btree", table.createdFromProposalId.asc().nullsLast()),
	index("ix_policies_domain").using("btree", table.domain.asc().nullsLast()),
	index("ix_policies_policy_key").using("btree", table.policyKey.asc().nullsLast()),
	index("ix_policies_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_policies_status").using("btree", table.status.asc().nullsLast()),
	index("ix_policies_supersedes_policy_id").using("btree", table.supersedesPolicyId.asc().nullsLast()),
	foreignKey({
			columns: [table.createdFromProposalId],
			foreignColumns: [proposals.id],
			name: "fk_policies_created_from_proposal_id_proposals"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.supersedesPolicyId],
			foreignColumns: [table.id],
			name: "fk_policies_supersedes_policy_id_policies"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "policies_space_id_fkey"
		}),
	check("ck_policies_enforcement_mode", sql`(enforcement_mode IS NULL) OR ((enforcement_mode)::text = ANY (ARRAY[('allow'::character varying)::text, ('deny'::character varying)::text, ('require_approval'::character varying)::text, ('allow_with_log'::character varying)::text]))`),
	check("ck_policies_status", sql`(status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('superseded'::character varying)::text, ('disabled'::character varying)::text])`),
]);

export const policyDecisionRecords = pgTable("policy_decision_records", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	actorType: varchar("actor_type", { length: 64 }),
	actorId: varchar("actor_id", { length: 36 }),
	actorRefJson: jsonb("actor_ref_json"),
	action: varchar({ length: 128 }).notNull(),
	resourceType: varchar("resource_type", { length: 64 }),
	resourceId: varchar("resource_id", { length: 256 }),
	decision: varchar({ length: 32 }).notNull(),
	riskLevel: varchar("risk_level", { length: 32 }).notNull(),
	requiredApproverRole: varchar("required_approver_role", { length: 32 }),
	approvalCapability: varchar("approval_capability", { length: 128 }),
	policyRuleId: varchar("policy_rule_id", { length: 128 }),
	policySource: varchar("policy_source", { length: 64 }),
	policyId: varchar("policy_id", { length: 36 }),
	auditCode: varchar("audit_code", { length: 128 }),
	runId: varchar("run_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }),
	metadataJson: jsonb("metadata_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_policy_decision_records_action").using("btree", table.action.asc().nullsLast()),
	index("ix_policy_decision_records_actor_id").using("btree", table.actorId.asc().nullsLast()),
	index("ix_policy_decision_records_audit_code").using("btree", table.auditCode.asc().nullsLast()),
	index("ix_policy_decision_records_audit_created").using("btree", table.auditCode.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_policy_decision_records_created_at").using("btree", table.createdAt.asc().nullsLast()),
	index("ix_policy_decision_records_decision").using("btree", table.decision.asc().nullsLast()),
	index("ix_policy_decision_records_proposal_created").using("btree", table.proposalId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_policy_decision_records_proposal_id").using("btree", table.proposalId.asc().nullsLast()),
	index("ix_policy_decision_records_resource_id").using("btree", table.resourceId.asc().nullsLast()),
	index("ix_policy_decision_records_resource_type").using("btree", table.resourceType.asc().nullsLast()),
	index("ix_policy_decision_records_risk_level").using("btree", table.riskLevel.asc().nullsLast()),
	index("ix_policy_decision_records_run_created").using("btree", table.runId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_policy_decision_records_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_policy_decision_records_space_action_created").using("btree", table.spaceId.asc().nullsLast(), table.action.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_policy_decision_records_space_created").using("btree", table.spaceId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_policy_decision_records_space_id").using("btree", table.spaceId.asc().nullsLast()),
	unique("uq_policy_decision_records_space_id_id").on(table.id, table.spaceId),
	check("ck_policy_decision_records_decision", sql`(decision)::text = ANY (ARRAY[('allow'::character varying)::text, ('deny'::character varying)::text, ('require_approval'::character varying)::text])`),
	check("ck_policy_decision_records_risk_level", sql`(risk_level)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
]);
