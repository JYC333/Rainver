import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { actionApprovalGrants } from "./actionApprovalGrants.js";
import { policyDecisionRecords } from "./policy.js";
import { projects } from "./projects.js";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";
import { pluginDataGrants } from "./pluginDataGrants.js";

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
  /**
   * `expired`: a pending core data tool request ended because what it would allow went away (opt-out,
   * disconnect, reconnect, forget, leaving the Project, account disable). Nobody decided it and it is
   * never approved later; its Run is cancelled.
   */
  status: varchar({ length: 16 }).default("pending").notNull(),
  resultingActionGrantId: varchar("resulting_action_grant_id", { length: 36 }),
  /** `plugin_data` requests are decided by the data owner (ADR 0030) and approve into a plugin data grant. */
  requestKind: varchar("request_kind", { length: 16 }).default("action_grant").notNull(),
  resultingPluginDataGrantId: varchar("resulting_plugin_data_grant_id", { length: 36 }),
  /**
   * A core data tool's request (ADR 0033): the consent the owner is asked for, frozen when the request is
   * made — owner, Project, connection, its generation and purpose. Approval writes exactly this binding
   * after rechecking each part live; a request without one (made under the earlier per-Run consent) is
   * never approved. Snapshots, not references: the live rows are rechecked at approval.
   */
  consentOwnerUserId: varchar("consent_owner_user_id", { length: 36 }),
  consentProjectId: varchar("consent_project_id", { length: 36 }),
  consentConnectionId: varchar("consent_connection_id", { length: 36 }),
  consentConnectionGeneration: integer("consent_connection_generation"),
  consentPurpose: varchar("consent_purpose", { length: 32 }),
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
  check("ck_authorization_requests_status", sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired')`),
  foreignKey({ columns: [table.resultingPluginDataGrantId], foreignColumns: [pluginDataGrants.id], name: "authorization_requests_resulting_plugin_data_grant_fkey" }),
  check("ck_authorization_requests_consent_binding", sql`(${table.consentOwnerUserId} IS NULL AND ${table.consentProjectId} IS NULL AND ${table.consentConnectionId} IS NULL AND ${table.consentConnectionGeneration} IS NULL AND ${table.consentPurpose} IS NULL)
    OR (${table.requestKind} = 'plugin_data' AND ${table.consentOwnerUserId} IS NOT NULL AND ${table.consentOwnerUserId} = ${table.instructedByUserId}
      AND ${table.consentProjectId} IS NOT NULL AND ${table.consentConnectionId} IS NOT NULL AND ${table.consentConnectionGeneration} IS NOT NULL
      AND ${table.consentConnectionGeneration} >= 1 AND ${table.consentPurpose} IS NOT NULL AND ${table.consentPurpose} = 'on_demand_read')`),
  check("ck_authorization_requests_kind", sql`${table.requestKind} IN ('action_grant', 'plugin_data')`),
  check("ck_authorization_requests_decision", sql`(${table.status} = 'pending' AND ${table.decidedByUserId} IS NULL AND ${table.decidedAt} IS NULL AND ${table.resultingActionGrantId} IS NULL AND ${table.resultingPluginDataGrantId} IS NULL) OR (${table.status} = 'rejected' AND ${table.decidedByUserId} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ${table.resultingActionGrantId} IS NULL AND ${table.resultingPluginDataGrantId} IS NULL) OR (${table.status} = 'expired' AND ${table.decidedByUserId} IS NULL AND ${table.decidedAt} IS NOT NULL AND ${table.resultingActionGrantId} IS NULL AND ${table.resultingPluginDataGrantId} IS NULL) OR (${table.status} = 'approved' AND ${table.decidedByUserId} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ((${table.requestKind} = 'action_grant' AND ${table.resultingActionGrantId} IS NOT NULL AND ${table.resultingPluginDataGrantId} IS NULL) OR (${table.requestKind} = 'plugin_data' AND ${table.resultingActionGrantId} IS NULL AND ${table.resultingPluginDataGrantId} IS NOT NULL)))`),
]);
