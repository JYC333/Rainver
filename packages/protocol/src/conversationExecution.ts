import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

/** The only filesystem modes a Conversation may use for its Primary. */
export const ConversationWorkspaceModeSchema = z.enum(["managed", "location"]);
export type ConversationWorkspaceMode = z.infer<typeof ConversationWorkspaceModeSchema>;

export const ConversationExecutionStateSchema = z.enum(["draft", "initialized"]);
export type ConversationExecutionState = z.infer<typeof ConversationExecutionStateSchema>;

export const ConversationAttachmentAccessModeSchema = z.enum(["read", "write"]);
export type ConversationAttachmentAccessMode = z.infer<typeof ConversationAttachmentAccessModeSchema>;

export const ConversationAttachmentStatusSchema = z.enum(["active", "revoked"]);
export type ConversationAttachmentStatus = z.infer<typeof ConversationAttachmentStatusSchema>;

/** A concrete, user-visible Primary choice. */
export const ConversationPrimarySelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("managed") }).strict(),
  z.object({ kind: z.literal("location"), workspace_location_id: IdSchema }).strict(),
]);
export type ConversationPrimarySelection = z.infer<typeof ConversationPrimarySelectionSchema>;

export const ConversationExecutionSelectionSchema = z.object({
  execution_host_id: IdSchema,
  primary: ConversationPrimarySelectionSchema,
}).strict();
export type ConversationExecutionSelection = z.infer<typeof ConversationExecutionSelectionSchema>;

/** The Agent/CLI pin that is fixed together with the first Run. */
export const ConversationRuntimeSelectionSchema = z.object({
  agent_id: IdSchema,
  runtime_profile_id: IdSchema,
  credential_profile_id: IdSchema.nullable(),
  adapter_type: z.string().trim().min(1).max(64),
  runtime_installation: z.string().trim().min(1).max(128),
}).strict();
export type ConversationRuntimeSelection = z.infer<typeof ConversationRuntimeSelectionSchema>;

/**
 * A first-run CLI choice. A matching reusable Agent runtime profile may
 * already exist, but it is not a prerequisite: initialization resolves or
 * creates that profile atomically from the Host/CLI/Primary tuple.
 */
export const ConversationRuntimeChoiceSchema = ConversationRuntimeSelectionSchema.extend({
  runtime_profile_id: IdSchema.nullable(),
}).strict();
export type ConversationRuntimeChoice = z.infer<typeof ConversationRuntimeChoiceSchema>;

/** Read-only data used to render the composer preflight before a send. */
export const ConversationExecutionHostSummarySchema = z.object({
  host_id: IdSchema,
  host_name: z.string().trim().min(1),
  host_kind: z.string().trim().min(1),
  online: z.boolean(),
  managed_workspace_available: z.boolean(),
  daemon_last_heartbeat_at: ISODateTimeSchema.nullable(),
}).strict();
export type ConversationExecutionHostSummary = z.infer<typeof ConversationExecutionHostSummarySchema>;

export const ConversationPrimarySummarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed"),
    managed_workspace_id: IdSchema,
    display_path: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("location"),
    project_folder_id: IdSchema,
    workspace_location_id: IdSchema,
    display_path: z.string().nullable(),
  }).strict(),
]);
export type ConversationPrimarySummary = z.infer<typeof ConversationPrimarySummarySchema>;

export const ConversationAttachmentSummarySchema = z.object({
  id: IdSchema,
  project_folder_id: IdSchema,
  workspace_location_id: IdSchema,
  folder_name: z.string().trim().min(1),
  display_path: z.string().nullable(),
  access_mode: ConversationAttachmentAccessModeSchema,
  status: ConversationAttachmentStatusSchema,
  granted_by_user_id: IdSchema,
  granted_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  revoked_at: ISODateTimeSchema.nullable(),
}).strict();
export type ConversationAttachmentSummary = z.infer<typeof ConversationAttachmentSummarySchema>;

export const ConversationExecutionSummarySchema = z.object({
  session_id: IdSchema,
  state: ConversationExecutionStateSchema,
  host: ConversationExecutionHostSummarySchema.nullable(),
  runtime: ConversationRuntimeSelectionSchema.nullable(),
  /** Every pinned Conversation × Agent runtime, not only the manager. */
  runtimes: z.array(ConversationRuntimeSelectionSchema).default([]),
  primary: ConversationPrimarySummarySchema.nullable(),
  attachments: z.array(ConversationAttachmentSummarySchema),
  dispatch_locked: z.boolean(),
  queue_paused_at: ISODateTimeSchema.nullable(),
  can_send: z.boolean(),
  blocked_reason: z.string().trim().min(1).nullable(),
  ...SecretResponseGuards,
}).strict();
export type ConversationExecutionSummary = z.infer<typeof ConversationExecutionSummarySchema>;

/** A runtime candidate with server-authoritative availability diagnostics. */
export const ConversationExecutionRuntimeProfileSchema = z.object({
  agent_id: IdSchema,
  agent_name: z.string().trim().min(1),
  runtime_profile_id: IdSchema.nullable(),
  adapter_type: z.string().trim().min(1),
  runtime_installation: z.string().trim().min(1).nullable(),
  execution_host_id: IdSchema.nullable(),
  workspace_mode: ConversationWorkspaceModeSchema.nullable(),
  workspace_location_id: IdSchema.nullable(),
  /** Whether an existing reusable profile is the Agent's default suggestion. */
  preferred: z.boolean().default(false),
  usable: z.boolean(),
  reason: z.string().trim().min(1).nullable(),
}).strict();
export type ConversationExecutionRuntimeProfile = z.infer<
  typeof ConversationExecutionRuntimeProfileSchema
>;

export const ConversationExecutionPreflightRequestSchema = z.object({
  selection: ConversationExecutionSelectionSchema.nullable(),
  runtime: ConversationRuntimeChoiceSchema.nullable(),
}).strict();
export type ConversationExecutionPreflightRequest = z.infer<typeof ConversationExecutionPreflightRequestSchema>;

export const ConversationExecutionPreflightResponseSchema = z.object({
  summary: ConversationExecutionSummarySchema,
  available_hosts: z.array(ConversationExecutionHostSummarySchema),
  available_runtime_profiles: z.array(ConversationExecutionRuntimeProfileSchema),
  available_primary_locations: z.array(z.object({
    workspace_location_id: IdSchema,
    project_folder_id: IdSchema,
    folder_name: z.string().trim().min(1),
    execution_host_id: IdSchema,
    display_path: z.string().nullable(),
    execution_ready: z.boolean(),
  }).strict()),
}).strict();
export type ConversationExecutionPreflightResponse = z.infer<typeof ConversationExecutionPreflightResponseSchema>;

export const ConversationExecutionInitializeRequestSchema = z.object({
  selection: ConversationExecutionSelectionSchema,
  runtime: ConversationRuntimeChoiceSchema,
  /** Explicit runtime pins for the other Agents in a Room conversation. */
  additional_runtimes: z.array(ConversationRuntimeChoiceSchema).optional(),
}).strict();
export type ConversationExecutionInitializeRequest = z.infer<typeof ConversationExecutionInitializeRequestSchema>;

export const ConversationAttachmentMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("attach"),
    mutation_id: IdSchema,
    project_folder_id: IdSchema,
    workspace_location_id: IdSchema,
    access_mode: ConversationAttachmentAccessModeSchema.default("read"),
  }).strict(),
  z.object({
    action: z.literal("set_access"),
    mutation_id: IdSchema,
    attachment_id: IdSchema,
    access_mode: ConversationAttachmentAccessModeSchema,
  }).strict(),
  z.object({
    action: z.literal("revoke"),
    mutation_id: IdSchema,
    attachment_id: IdSchema,
  }).strict(),
]);
export type ConversationAttachmentMutation = z.infer<typeof ConversationAttachmentMutationSchema>;

export const ConversationAttachmentMutationResponseSchema = z.object({
  attachment: ConversationAttachmentSummarySchema,
  effective_after_run_id: IdSchema.nullable(),
}).strict();
export type ConversationAttachmentMutationResponse = z.infer<typeof ConversationAttachmentMutationResponseSchema>;
