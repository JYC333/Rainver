import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runs } from "./runs.js";
import { policyDecisionRecords } from "./policy.js";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";
import { agentRuntimeProfiles, agents, cliCredentialProfiles } from "./agents.js";
import { modelProviders } from "./providers.js";
import { projects, projectBriefVersions, projectInstructionVersions } from "./projects.js";

export const runtimeContextPolicyVersions = pgTable("runtime_context_policy_versions", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  scopeType: varchar("scope_type", { length: 32 }).notNull(),
  scopeId: varchar("scope_id", { length: 36 }).notNull(),
  version: integer().notNull(),
  policyJson: jsonb("policy_json").notNull(),
  baseVersionId: varchar("base_version_id", { length: 36 }),
  typedDiffJson: jsonb("typed_diff_json").notNull(),
  reason: varchar({ length: 2000 }).notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_runtime_context_policy_versions_scope").on(table.spaceId, table.scopeType, table.scopeId),
  unique("uq_runtime_context_policy_versions_scope_version").on(table.spaceId, table.scopeType, table.scopeId, table.version),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "runtime_context_policy_versions_space_id_fkey" }),
  foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "runtime_context_policy_versions_created_by_user_id_fkey" }),
  foreignKey({ columns: [table.baseVersionId], foreignColumns: [table.id], name: "runtime_context_policy_versions_base_version_id_fkey" }).onDelete("restrict"),
  check("ck_runtime_context_policy_versions_scope_type", sql`scope_type IN ('space', 'project', 'project_folder', 'agent', 'user')`),
  check("ck_runtime_context_policy_versions_version_positive", sql`version >= 1`),
  check("ck_runtime_context_policy_versions_policy_object", sql`jsonb_typeof(policy_json) = 'object'`),
  check("ck_runtime_context_policy_versions_diff_object", sql`jsonb_typeof(typed_diff_json) = 'object'`),
]);

export const runtimeContextPolicyBindings = pgTable("runtime_context_policy_bindings", {
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  scopeType: varchar("scope_type", { length: 32 }).notNull(),
  scopeId: varchar("scope_id", { length: 36 }).notNull(),
  activeVersionId: varchar("active_version_id", { length: 36 }).notNull(),
  updatedByUserId: varchar("updated_by_user_id", { length: 36 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  primaryKey({ columns: [table.spaceId, table.scopeType, table.scopeId], name: "runtime_context_policy_bindings_pkey" }),
  unique("uq_runtime_context_policy_bindings_active_version").on(table.activeVersionId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "runtime_context_policy_bindings_space_id_fkey" }),
  foreignKey({ columns: [table.activeVersionId], foreignColumns: [runtimeContextPolicyVersions.id], name: "runtime_context_policy_bindings_active_version_id_fkey" }).onDelete("restrict"),
  foreignKey({ columns: [table.updatedByUserId], foreignColumns: [users.id], name: "runtime_context_policy_bindings_updated_by_user_id_fkey" }),
  check("ck_runtime_context_policy_bindings_scope_type", sql`scope_type IN ('space', 'project', 'project_folder', 'agent', 'user')`),
]);

export const runtimeContextPolicyAudits = pgTable("runtime_context_policy_audits", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  scopeType: varchar("scope_type", { length: 32 }).notNull(),
  scopeId: varchar("scope_id", { length: 36 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 36 }).notNull(),
  baseVersionId: varchar("base_version_id", { length: 36 }),
  newVersionId: varchar("new_version_id", { length: 36 }).notNull(),
  policyDecisionRecordId: varchar("policy_decision_record_id", { length: 36 }),
  typedDiffJson: jsonb("typed_diff_json").notNull(),
  reason: varchar({ length: 2000 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_runtime_context_policy_audits_scope_created").on(table.spaceId, table.scopeType, table.scopeId, table.createdAt),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "runtime_context_policy_audits_space_id_fkey" }),
  foreignKey({ columns: [table.actorUserId], foreignColumns: [users.id], name: "runtime_context_policy_audits_actor_user_id_fkey" }),
  foreignKey({ columns: [table.baseVersionId], foreignColumns: [runtimeContextPolicyVersions.id], name: "runtime_context_policy_audits_base_version_id_fkey" }).onDelete("restrict"),
  foreignKey({ columns: [table.newVersionId], foreignColumns: [runtimeContextPolicyVersions.id], name: "runtime_context_policy_audits_new_version_id_fkey" }).onDelete("restrict"),
  foreignKey({ columns: [table.policyDecisionRecordId, table.spaceId], foreignColumns: [policyDecisionRecords.id, policyDecisionRecords.spaceId], name: "runtime_context_policy_audits_policy_decision_record_id_fkey" }).onDelete("restrict"),
  check("ck_runtime_context_policy_audits_diff_object", sql`jsonb_typeof(typed_diff_json) = 'object'`),
]);

export const executionControlSnapshots = pgTable("execution_control_snapshots", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  runId: varchar("run_id", { length: 36 }).notNull(),
  snapshotJson: jsonb("snapshot_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_execution_control_snapshots_run_created").on(table.runId, table.createdAt),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "execution_control_snapshots_space_id_fkey" }),
  foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "execution_control_snapshots_run_id_fkey" }).onDelete("cascade"),
  check("ck_execution_control_snapshots_json_object", sql`jsonb_typeof(snapshot_json) = 'object'`),
]);

export const workContextSetups = pgTable("work_context_setups", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  scopeKind: varchar("scope_kind", { length: 32 }).notNull(),
  version: integer().notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }),
  projectFolderId: varchar("project_folder_id", { length: 36 }),
  agentId: varchar("agent_id", { length: 36 }),
  runtimeRefJson: jsonb("runtime_ref_json"),
  pinnedRefsJson: jsonb("pinned_refs_json").default([]).notNull(),
  excludedRefsJson: jsonb("excluded_refs_json").default([]).notNull(),
  retrievalPreferencesJson: jsonb("retrieval_preferences_json").default({}).notNull(),
  continuityPreferencesJson: jsonb("continuity_preferences_json").default({}).notNull(),
  projectBriefVersionId: varchar("project_brief_version_id", { length: 36 }),
  projectInstructionVersionId: varchar("project_instruction_version_id", { length: 36 }),
  projectInstructionEnabled: boolean("project_instruction_enabled").notNull(),
	governingPolicyRefsJson: jsonb("governing_policy_refs_json").default([]).notNull(),
	setupFingerprint: varchar("setup_fingerprint", { length: 64 }).notNull(),
	baseVersion: integer("base_version"),
	typedDiffJson: jsonb("typed_diff_json").default({}).notNull(),
	reason: varchar({ length: 512 }).notNull(),
	policyDecisionRecordId: varchar("policy_decision_record_id", { length: 36 }).notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_work_context_setups_scope").on(table.spaceId, table.workContextScopeId),
  unique("uq_work_context_setups_scope_user_version").on(table.spaceId, table.workContextScopeId, table.userId, table.version),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "work_context_setups_space_id_fkey" }),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "work_context_setups_user_id_fkey" }),
  foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "work_context_setups_created_by_user_id_fkey" }),
  foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "work_context_setups_project_id_fkey" }),
  foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "work_context_setups_agent_id_fkey" }),
  foreignKey({ columns: [table.projectBriefVersionId], foreignColumns: [projectBriefVersions.id], name: "work_context_setups_project_brief_version_id_fkey" }).onDelete("restrict"),
	foreignKey({ columns: [table.projectInstructionVersionId], foreignColumns: [projectInstructionVersions.id], name: "work_context_setups_project_instruction_version_id_fkey" }).onDelete("restrict"),
	foreignKey({ columns: [table.policyDecisionRecordId], foreignColumns: [policyDecisionRecords.id], name: "work_context_setups_policy_decision_record_id_fkey" }),
  check("ck_work_context_setups_scope_kind", sql`scope_kind IN ('direct_session', 'room_recipient', 'root_task', 'workflow_execution')`),
  check("ck_work_context_setups_version_positive", sql`version >= 1`),
]);

export const contextWindowReconciliations = pgTable("context_window_reconciliations", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  invocationId: varchar("invocation_id", { length: 36 }).notNull(),
  deliveryId: varchar("delivery_id", { length: 36 }),
  model: varchar({ length: 256 }).notNull(),
  modelCatalogVersion: varchar("model_catalog_version", { length: 64 }).notNull(),
  tokenizerVersion: varchar("tokenizer_version", { length: 64 }).notNull(),
  plannedPromptTokens: integer("planned_prompt_tokens").notNull(),
  planHash: varchar("plan_hash", { length: 64 }).notNull(),
  planJson: jsonb("plan_json").notNull(),
  actualPromptTokens: integer("actual_prompt_tokens"),
  deltaTokens: integer("delta_tokens"),
  status: varchar({ length: 16 }).default("planned").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_context_window_reconciliations_delivery").on(table.deliveryId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_window_reconciliations_space_id_fkey" }),
  check("ck_context_window_reconciliations_tokens", sql`planned_prompt_tokens >= 0 AND (actual_prompt_tokens IS NULL OR actual_prompt_tokens >= 0)`),
  check("ck_context_window_reconciliations_plan_object", sql`jsonb_typeof(plan_json) = 'object'`),
  check("ck_context_window_reconciliations_status", sql`status IN ('planned', 'matched', 'under', 'over')`),
]);

export const invocationDeliveries = pgTable("invocation_deliveries", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  invocationId: varchar("invocation_id", { length: 36 }).notNull(),
  attempt: integer().notNull(),
  executionControlSnapshotId: varchar("execution_control_snapshot_id", { length: 36 }).notNull(),
  adapterType: varchar("adapter_type", { length: 64 }).notNull(),
  providerId: varchar("provider_id", { length: 36 }),
  rendererVersion: varchar("renderer_version", { length: 64 }).notNull(),
  deliveryMetadataJson: jsonb("delivery_metadata_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_invocation_deliveries_invocation_attempt").on(table.spaceId, table.invocationId, table.attempt),
  index("ix_invocation_deliveries_control").on(table.executionControlSnapshotId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "invocation_deliveries_space_id_fkey" }),
  foreignKey({ columns: [table.executionControlSnapshotId], foreignColumns: [executionControlSnapshots.id], name: "invocation_deliveries_control_id_fkey" }).onDelete("restrict"),
  check("ck_invocation_deliveries_attempt_positive", sql`attempt >= 1`),
  check("ck_invocation_deliveries_metadata_object", sql`jsonb_typeof(delivery_metadata_json) = 'object'`),
]);

export const invocationSnapshots = pgTable("invocation_snapshots", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  invocationId: varchar("invocation_id", { length: 36 }).notNull(),
  deliveryId: varchar("delivery_id", { length: 36 }).notNull(),
  attempt: integer().notNull(),
  safeSnapshotJson: jsonb("safe_snapshot_json").notNull(),
  status: varchar({ length: 16 }).default("draft").notNull(),
  acknowledgementFingerprint: varchar("acknowledgement_fingerprint", { length: 64 }),
  finalizationFingerprint: varchar("finalization_fingerprint", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_invocation_snapshots_delivery").on(table.deliveryId),
  unique("uq_invocation_snapshots_invocation_attempt").on(table.spaceId, table.invocationId, table.attempt),
  index("ix_invocation_snapshots_invocation").on(table.spaceId, table.invocationId, table.createdAt),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "invocation_snapshots_space_id_fkey" }),
  foreignKey({ columns: [table.deliveryId], foreignColumns: [invocationDeliveries.id], name: "invocation_snapshots_delivery_id_fkey" }).onDelete("restrict"),
  check("ck_invocation_snapshots_attempt_positive", sql`attempt >= 1`),
  check("ck_invocation_snapshots_json_object", sql`jsonb_typeof(safe_snapshot_json) = 'object'`),
  check("ck_invocation_snapshots_status", sql`status IN ('draft', 'accepted', 'rejected', 'failed', 'finalized')`),
]);

/**
 * Append-only continuity ledger state.  The row is locked whenever a scope
 * sequence is allocated, so committed events are dense even with concurrent
 * adapter reports.
 */
export const contextEventScopes = pgTable("context_event_scopes", {
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  eventHeadCursor: integer("event_head_cursor").default(0).notNull(),
  checkpointCursor: integer("checkpoint_cursor").default(0).notNull(),
  cliKnownCursor: integer("cli_known_cursor"),
  captureStatus: varchar("capture_status", { length: 16 }).default("complete").notNull(),
  activeMicroCheckpointId: varchar("active_micro_checkpoint_id", { length: 36 }),
  activeSemanticCheckpointId: varchar("active_semantic_checkpoint_id", { length: 36 }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  primaryKey({ columns: [table.spaceId, table.workContextScopeId], name: "context_event_scopes_pkey" }),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_event_scopes_space_id_fkey" }),
  check("ck_context_event_scopes_cursors", sql`event_head_cursor >= 0 AND checkpoint_cursor >= 0 AND checkpoint_cursor <= event_head_cursor AND (cli_known_cursor IS NULL OR (cli_known_cursor >= 0 AND cli_known_cursor <= event_head_cursor))`),
  check("ck_context_event_scopes_capture_status", sql`capture_status IN ('complete','recovered','partial')`),
]);

/**
 * One durable vendor-session binding per active CLI work-scope identity.
 * Vendor state is only an opaque resumable cache; canonical continuity remains
 * in Context Events and checkpoints.
 */
export const runtimeContextCliBindings = pgTable("runtime_context_cli_bindings", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  scopeKind: varchar("scope_kind", { length: 32 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  runtimeProfileId: varchar("runtime_profile_id", { length: 36 }).notNull(),
  credentialProfileId: varchar("credential_profile_id", { length: 36 }),
  adapterType: varchar("adapter_type", { length: 64 }).notNull(),
  providerId: varchar("provider_id", { length: 36 }),
  model: varchar({ length: 256 }),
  runtimeStateKey: varchar("runtime_state_key", { length: 36 }).notNull(),
  vendorSessionId: varchar("vendor_session_id", { length: 512 }),
  authorityFingerprint: varchar("authority_fingerprint", { length: 64 }).notNull(),
  runtimeFingerprint: varchar("runtime_fingerprint", { length: 64 }).notNull(),
  fingerprintJson: jsonb("fingerprint_json").notNull(),
  cliKnownCursor: integer("cli_known_cursor").default(0).notNull(),
  acknowledgedItemIdsJson: jsonb("acknowledged_item_ids_json").default([]).notNull(),
  generation: integer().default(1).notNull(),
  status: varchar({ length: 16 }).default("active").notNull(),
  rotationReason: varchar("rotation_reason", { length: 64 }),
  executionLeaseId: varchar("execution_lease_id", { length: 36 }),
  executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true, mode: "string" }),
  lastAcknowledgedAt: timestamp("last_acknowledged_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("uq_runtime_context_cli_bindings_active_scope").on(
    table.spaceId,
    table.workContextScopeId,
    table.userId,
    table.agentId,
  ).where(sql`status = 'active'`),
  index("ix_runtime_context_cli_bindings_scope").on(table.spaceId, table.workContextScopeId),
  index("ix_runtime_context_cli_bindings_runtime_profile").on(table.runtimeProfileId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "runtime_context_cli_bindings_space_id_fkey" }),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "runtime_context_cli_bindings_user_id_fkey" }),
  foreignKey({ columns: [table.agentId, table.spaceId], foreignColumns: [agents.id, agents.spaceId], name: "runtime_context_cli_bindings_agent_scope_fkey" }),
  foreignKey({ columns: [table.runtimeProfileId, table.spaceId, table.agentId], foreignColumns: [agentRuntimeProfiles.id, agentRuntimeProfiles.spaceId, agentRuntimeProfiles.agentId], name: "runtime_context_cli_bindings_runtime_scope_fkey" }),
  foreignKey({ columns: [table.credentialProfileId, table.userId], foreignColumns: [cliCredentialProfiles.id, cliCredentialProfiles.ownerUserId], name: "runtime_context_cli_bindings_credential_owner_fkey" }),
  foreignKey({ columns: [table.providerId], foreignColumns: [modelProviders.id], name: "runtime_context_cli_bindings_provider_id_fkey" }),
  check("ck_runtime_context_cli_bindings_scope_kind", sql`scope_kind IN ('direct_session','room_recipient','root_task','workflow_execution')`),
  check("ck_runtime_context_cli_bindings_status", sql`status IN ('active','rotated')`),
  check("ck_runtime_context_cli_bindings_cursor_generation", sql`cli_known_cursor >= 0 AND generation >= 1`),
  check("ck_runtime_context_cli_bindings_json", sql`jsonb_typeof(fingerprint_json) = 'object' AND jsonb_typeof(acknowledged_item_ids_json) = 'array'`),
]);

export const contextEvents = pgTable("context_events", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  scopeSequence: integer("scope_sequence").notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  canonicalRefJson: jsonb("canonical_ref_json").notNull(),
  canonicalRefKey: varchar("canonical_ref_key", { length: 512 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 36 }),
  agentId: varchar("agent_id", { length: 36 }),
  invocationId: varchar("invocation_id", { length: 36 }),
  semanticRole: varchar("semantic_role", { length: 32 }),
  trust: varchar({ length: 32 }).notNull(),
  sensitivity: varchar({ length: 32 }).notNull(),
  tokenEstimate: integer("token_estimate").notNull(),
  confirmationState: varchar("confirmation_state", { length: 16 }).notNull(),
  sourceRefsJson: jsonb("source_refs_json").default([]).notNull(),
  captureStatus: varchar("capture_status", { length: 16 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_context_events_scope_sequence").on(table.spaceId, table.workContextScopeId, table.scopeSequence),
  unique("uq_context_events_scope_canonical_event").on(table.spaceId, table.workContextScopeId, table.eventType, table.canonicalRefKey),
  index("ix_context_events_invocation").on(table.spaceId, table.invocationId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_events_space_id_fkey" }),
  foreignKey({ columns: [table.actorUserId], foreignColumns: [users.id], name: "context_events_actor_user_id_fkey" }),
  foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "context_events_agent_id_fkey" }),
  check("ck_context_events_sequence_positive", sql`scope_sequence >= 1`),
  check("ck_context_events_token_estimate", sql`token_estimate >= 0`),
  check("ck_context_events_semantic_role", sql`semantic_role IS NULL OR semantic_role IN ('delegated_instruction','user_input','reference_data')`),
  check("ck_context_events_capture_status", sql`capture_status IN ('complete','recovered','partial')`),
  check("ck_context_events_confirmation_state", sql`confirmation_state IN ('observed','candidate','confirmed','corrected')`),
  check("ck_context_events_ref_object", sql`jsonb_typeof(canonical_ref_json) = 'object' AND jsonb_typeof(source_refs_json) = 'array'`),
]);

export const contextCaptureGaps = pgTable("context_capture_gaps", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  invocationId: varchar("invocation_id", { length: 36 }),
  code: varchar({ length: 64 }).notNull(),
  afterCursor: integer("after_cursor").notNull(),
  beforeCursor: integer("before_cursor"),
  detail: varchar({ length: 2000 }),
  replayEventJson: jsonb("replay_event_json"),
  status: varchar({ length: 16 }).default("open").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_context_capture_gaps_scope_status").on(table.spaceId, table.workContextScopeId, table.status),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_capture_gaps_space_id_fkey" }),
  check("ck_context_capture_gaps_cursors", sql`after_cursor >= 0 AND (before_cursor IS NULL OR before_cursor > after_cursor)`),
  check("ck_context_capture_gaps_status", sql`status IN ('open','recovered')`),
  check("ck_context_capture_gaps_replay_event", sql`replay_event_json IS NULL OR jsonb_typeof(replay_event_json) = 'object'`),
]);

export const contextMicroCheckpoints = pgTable("context_micro_checkpoints", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  version: integer().notNull(),
  checkpointJson: jsonb("checkpoint_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_context_micro_checkpoints_scope_version").on(table.spaceId, table.workContextScopeId, table.version),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_micro_checkpoints_space_id_fkey" }),
  check("ck_context_micro_checkpoints_version", sql`version >= 1 AND jsonb_typeof(checkpoint_json) = 'object'`),
]);

export const contextSemanticCheckpoints = pgTable("context_semantic_checkpoints", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  version: integer().notNull(),
  coveredCursor: integer("covered_cursor").notNull(),
  status: varchar({ length: 16 }).default("active").notNull(),
  checkpointJson: jsonb("checkpoint_json").notNull(),
  extractorRefJson: jsonb("extractor_ref_json").notNull(),
  supersedesId: varchar("supersedes_id", { length: 36 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_context_semantic_checkpoints_scope_version").on(table.spaceId, table.workContextScopeId, table.version),
  index("ix_context_semantic_checkpoints_scope_status").on(table.spaceId, table.workContextScopeId, table.status),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_semantic_checkpoints_space_id_fkey" }),
  foreignKey({ columns: [table.supersedesId], foreignColumns: [table.id], name: "context_semantic_checkpoints_supersedes_id_fkey" }).onDelete("restrict"),
  check("ck_context_semantic_checkpoints_status", sql`status IN ('active','superseded')`),
  check("ck_context_semantic_checkpoints_json", sql`covered_cursor >= 0 AND jsonb_typeof(checkpoint_json) = 'object' AND jsonb_typeof(extractor_ref_json) = 'object'`),
]);

export const contextCheckpointCorrections = pgTable("context_checkpoint_corrections", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  workContextScopeId: varchar("work_context_scope_id", { length: 36 }).notNull(),
  semanticCheckpointId: varchar("semantic_checkpoint_id", { length: 36 }).notNull(),
  canonicalRefJson: jsonb("canonical_ref_json").notNull(),
  correctionJson: jsonb("correction_json").notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_context_checkpoint_corrections_checkpoint").on(table.semanticCheckpointId, table.createdAt),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "context_checkpoint_corrections_space_id_fkey" }),
  foreignKey({ columns: [table.semanticCheckpointId], foreignColumns: [contextSemanticCheckpoints.id], name: "context_checkpoint_corrections_checkpoint_id_fkey" }).onDelete("restrict"),
  foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: "context_checkpoint_corrections_created_by_user_id_fkey" }),
  check("ck_context_checkpoint_corrections_json", sql`jsonb_typeof(canonical_ref_json) = 'object' AND jsonb_typeof(correction_json) = 'object'`),
]);

export const providerTaskControls = pgTable("provider_task_controls", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  task: varchar({ length: 128 }).notNull(),
  ownerDomain: varchar("owner_domain", { length: 128 }).notNull(),
  controlJson: jsonb("control_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "provider_task_controls_space_id_fkey" }),
  check("ck_provider_task_controls_json_object", sql`jsonb_typeof(control_json) = 'object'`),
]);

export const providerTaskDeliveries = pgTable("provider_task_deliveries", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  invocationId: varchar("invocation_id", { length: 36 }).notNull(),
  attempt: integer().notNull(),
  controlId: varchar("control_id", { length: 36 }).notNull(),
  providerId: varchar("provider_id", { length: 36 }).notNull(),
  model: varchar({ length: 255 }),
  inputFingerprint: varchar("input_fingerprint", { length: 64 }).notNull(),
  usageSourceId: varchar("usage_source_id", { length: 255 }).notNull(),
  deliveryMetadataJson: jsonb("delivery_metadata_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_provider_task_deliveries_invocation_attempt").on(table.spaceId, table.invocationId, table.attempt),
  unique("uq_provider_task_deliveries_usage_source").on(table.usageSourceId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "provider_task_deliveries_space_id_fkey" }),
  foreignKey({ columns: [table.controlId], foreignColumns: [providerTaskControls.id], name: "provider_task_deliveries_control_id_fkey" }).onDelete("restrict"),
  check("ck_provider_task_deliveries_attempt_positive", sql`attempt >= 1`),
  check("ck_provider_task_deliveries_metadata_object", sql`jsonb_typeof(delivery_metadata_json) = 'object'`),
]);

export const providerTaskSnapshots = pgTable("provider_task_snapshots", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  deliveryId: varchar("delivery_id", { length: 36 }).notNull(),
  safeSnapshotJson: jsonb("safe_snapshot_json").notNull(),
  status: varchar({ length: 16 }).default("draft").notNull(),
  errorCode: varchar("error_code", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_provider_task_snapshots_delivery").on(table.deliveryId),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "provider_task_snapshots_space_id_fkey" }),
  foreignKey({ columns: [table.deliveryId], foreignColumns: [providerTaskDeliveries.id], name: "provider_task_snapshots_delivery_id_fkey" }).onDelete("restrict"),
  check("ck_provider_task_snapshots_json_object", sql`jsonb_typeof(safe_snapshot_json) = 'object'`),
  check("ck_provider_task_snapshots_status", sql`status IN ('draft','accepted','failed')`),
]);

export const sealedInvocationPayloads = pgTable("sealed_invocation_payloads", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  invocationSnapshotId: varchar("invocation_snapshot_id", { length: 36 }).notNull(),
  encryptedPayload: text("encrypted_payload"),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  retentionDeadline: timestamp("retention_deadline", { withTimezone: true, mode: "string" }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_sealed_invocation_payloads_snapshot").on(table.invocationSnapshotId),
  index("ix_sealed_invocation_payloads_retention").on(table.retentionDeadline),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "sealed_invocation_payloads_space_id_fkey" }),
  foreignKey({ columns: [table.invocationSnapshotId], foreignColumns: [invocationSnapshots.id], name: "sealed_invocation_payloads_snapshot_id_fkey" }).onDelete("restrict"),
  check("ck_sealed_invocation_payloads_deleted", sql`(deleted_at IS NULL AND encrypted_payload IS NOT NULL) OR (deleted_at IS NOT NULL AND encrypted_payload IS NULL)`),
]);

export const sealedInvocationPayloadAccessAudits = pgTable("sealed_invocation_payload_access_audits", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  sealedPayloadId: varchar("sealed_payload_id", { length: 36 }).notNull(),
  viewerUserId: varchar("viewer_user_id", { length: 36 }).notNull(),
  reason: varchar({ length: 512 }).notNull(),
  accessedAt: timestamp("accessed_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_sealed_payload_access_audits_payload").on(table.sealedPayloadId, table.accessedAt),
  index("ix_sealed_payload_access_audits_viewer").on(table.viewerUserId, table.accessedAt),
  foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "sealed_payload_access_audits_space_id_fkey" }),
  foreignKey({ columns: [table.sealedPayloadId], foreignColumns: [sealedInvocationPayloads.id], name: "sealed_payload_access_audits_payload_id_fkey" }).onDelete("restrict"),
  foreignKey({ columns: [table.viewerUserId], foreignColumns: [users.id], name: "sealed_payload_access_audits_viewer_user_id_fkey" }).onDelete("restrict"),
]);
