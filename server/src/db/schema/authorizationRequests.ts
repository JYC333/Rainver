import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { actionApprovalGrants } from "./actionApprovalGrants";
import { policyDecisionRecords } from "./policy";
import { projects } from "./projects";
import { runs } from "./runs";
import { spaces } from "./spaces";
import { users } from "./auth";

export const authorizationRequests = pgTable("authorization_requests", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  runId: varchar("run_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  instructedByUserId: varchar("instructed_by_user_id", { length: 36 }).notNull(),
  policyDecisionRecordId: varchar("policy_decision_record_id", { length: 36 }).notNull(),
  actionId: varchar("action_id", { length: 128 }).notNull(),
  policyAction: varchar("policy_action", { length: 128 }).notNull(),
  projectId: varchar("project_id", { length: 36 }),
  resourceKind: varchar("resource_kind", { length: 64 }),
  resourceId: varchar("resource_id", { length: 256 }),
  reason: varchar({ length: 1000 }).notNull(),
  status: varchar({ length: 16 }).default("pending").notNull(),
  resultingActionGrantId: varchar("resulting_action_grant_id", { length: 36 }),
  decidedByUserId: varchar("decided_by_user_id", { length: 36 }),
  requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_authorization_requests_run").using("btree", table.spaceId, table.runId, table.requestedAt),
  index("ix_authorization_requests_reviewer").using("btree", table.spaceId, table.status, table.instructedByUserId),
  unique("uq_authorization_requests_decision").on(table.spaceId, table.policyDecisionRecordId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "authorization_requests_space_id_fkey" }),
  foreignKey({ columns: [table.runId, table.spaceId], foreignColumns: [runs.id, runs.spaceId], name: "authorization_requests_run_id_fkey" }),
  foreignKey({ columns: [table.agentId, table.spaceId], foreignColumns: [agents.id, agents.spaceId], name: "authorization_requests_agent_id_fkey" }),
  foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "authorization_requests_project_id_fkey" }),
  foreignKey({ columns: [table.policyDecisionRecordId, table.spaceId], foreignColumns: [policyDecisionRecords.id, policyDecisionRecords.spaceId], name: "authorization_requests_policy_decision_record_id_fkey" }),
  foreignKey({ columns: [table.instructedByUserId], foreignColumns: [users.id], name: "authorization_requests_instructed_by_user_id_fkey" }),
  foreignKey({ columns: [table.decidedByUserId], foreignColumns: [users.id], name: "authorization_requests_decided_by_user_id_fkey" }),
  foreignKey({
    columns: [
      table.resultingActionGrantId,
      table.spaceId,
      table.agentId,
      table.actionId,
      table.runId,
    ],
    foreignColumns: [
      actionApprovalGrants.id,
      actionApprovalGrants.spaceId,
      actionApprovalGrants.agentId,
      actionApprovalGrants.actionId,
      actionApprovalGrants.targetRunId,
    ],
    name: "authorization_requests_resulting_action_grant_binding_fkey",
  }),
  check("ck_authorization_requests_status", sql`${table.status} IN ('pending', 'approved', 'rejected')`),
  check("ck_authorization_requests_decision", sql`(${table.status} = 'pending' AND ${table.decidedByUserId} IS NULL AND ${table.decidedAt} IS NULL AND ${table.resultingActionGrantId} IS NULL) OR (${table.status} = 'rejected' AND ${table.decidedByUserId} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ${table.resultingActionGrantId} IS NULL) OR (${table.status} = 'approved' AND ${table.decidedByUserId} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ${table.resultingActionGrantId} IS NOT NULL)`),
]);
