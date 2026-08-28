import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import {
  AgentRunMessageRecipientSegmentSchema,
  AgentRunMessageRoutingModeSchema,
} from "./agentGroupRuns.js";

export const RoomSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  project_id: IdSchema,
  project_folder_id: IdSchema.nullish(),
  created_by_user_id: IdSchema,
  title: z.string().trim().min(1),
  status: z.enum(["active", "archived"]),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  archived_at: ISODateTimeSchema.nullish(),
  // Internal concurrency cursor surfaced when available; older clients may omit it.
  roster_revision: z.number().int().nonnegative().optional(),
  /** The Project's mainline conversation, which every Project member belongs to. */
  is_mainline: z.boolean().default(false),
  ...SecretResponseGuards,
}).strict();

/**
 * What the Project chat panel binds to.
 *
 * Membership is Project membership: a reader who is not yet on the roster is
 * enrolled by this read, so `joined` says whether that just happened.
 * `viewer_can_write` tells a surface with no Room yet whether offering to
 * start one is honest.
 */
export const ProjectMainlineRoomResponseSchema = z.object({
  room: RoomSchema.nullable(),
  joined: z.boolean(),
  viewer_can_write: z.boolean(),
}).strict();
export type ProjectMainlineRoomResponse = z.infer<typeof ProjectMainlineRoomResponseSchema>;
export type Room = z.infer<typeof RoomSchema>;

export const RoomUserMemberSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  room_id: IdSchema,
  user_id: IdSchema,
  role: z.enum(["owner", "member"]),
  status: z.enum(["active", "removed"]),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type RoomUserMember = z.infer<typeof RoomUserMemberSchema>;

export const RoomAgentMemberSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  room_id: IdSchema,
  agent_id: IdSchema,
  agent_name: z.string().trim().min(1),
  agent_kind: z.string().trim().min(1),
  role: z.enum(["manager", "member"]),
  status: z.enum(["active", "removed"]),
  private_shared_user_ids: z.array(IdSchema).optional(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type RoomAgentMember = z.infer<typeof RoomAgentMemberSchema>;

export const RoomAgentCandidateSchema = z.object({
  agent_id: IdSchema,
  name: z.string().trim().min(1),
  agent_kind: z.string().trim().min(1),
  owner_user_id: IdSchema.nullish(),
  visibility: z.string().trim().min(1),
  in_room: z.boolean(),
  member_status: z.enum(["active", "removed"]).nullish(),
  private: z.boolean(),
  shared_with_user_ids: z.array(IdSchema).default([]),
  ...SecretResponseGuards,
}).strict();
export type RoomAgentCandidate = z.infer<typeof RoomAgentCandidateSchema>;

export const RoomAgentPresetSchema = z.object({
  preset_id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  ...SecretResponseGuards,
}).strict();
export type RoomAgentPreset = z.infer<typeof RoomAgentPresetSchema>;

export const RoomAgentCandidatesResponseSchema = z.object({
  agents: z.array(RoomAgentCandidateSchema),
  presets: z.array(RoomAgentPresetSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  ...SecretResponseGuards,
}).strict();
export type RoomAgentCandidatesResponse = z.infer<typeof RoomAgentCandidatesResponseSchema>;

export const RoomAgentAddRequestSchema = z.object({
  agent_id: IdSchema,
  share_private_with_member_ids: z.array(IdSchema).default([]),
  confirm_room_share: z.boolean().default(false),
}).strict();
export type RoomAgentAddRequest = z.infer<typeof RoomAgentAddRequestSchema>;

export const RoomAgentPresetRequestSchema = z.object({
  preset_id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(256).nullish(),
  confirm_room_share: z.boolean().default(false),
}).strict();
export type RoomAgentPresetRequest = z.infer<typeof RoomAgentPresetRequestSchema>;

export const RoomInvitationApprovalSchema = z.object({
  id: IdSchema,
  agent_id: IdSchema,
  owner_user_id: IdSchema,
  status: z.enum(["pending", "approved", "rejected", "invalidated"]),
  decided_at: ISODateTimeSchema.nullish(),
  ...SecretResponseGuards,
}).strict();
export type RoomInvitationApproval = z.infer<typeof RoomInvitationApprovalSchema>;

export const RoomInvitationSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  room_id: IdSchema,
  invitee_user_id: IdSchema,
  invited_by_user_id: IdSchema,
  status: z.enum(["pending", "active", "rejected", "expired", "cancelled", "invalidated"]),
  required_roster_revision: z.number().int().nonnegative(),
  expires_at: ISODateTimeSchema,
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  resolved_at: ISODateTimeSchema.nullish(),
  approvals: z.array(RoomInvitationApprovalSchema),
  can_decide: z.boolean(),
  ...SecretResponseGuards,
}).strict();
export type RoomInvitation = z.infer<typeof RoomInvitationSchema>;

export const RoomInvitationListResponseSchema = z.object({
  items: z.array(RoomInvitationSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  ...SecretResponseGuards,
}).strict();
export type RoomInvitationListResponse = z.infer<typeof RoomInvitationListResponseSchema>;

export const RoomPendingApprovalSchema = z.object({
  invitation_id: IdSchema,
  room_id: IdSchema,
  room_title: z.string(),
  project_id: IdSchema,
  project_name: z.string(),
  invitee_user_id: IdSchema,
  invitee_display_name: z.string().nullish(),
  invitee_email: z.string().nullish(),
  agent_id: IdSchema,
  agent_name: z.string(),
  expires_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type RoomPendingApproval = z.infer<typeof RoomPendingApprovalSchema>;

export const RoomPendingApprovalListResponseSchema = z.object({
  items: z.array(RoomPendingApprovalSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  ...SecretResponseGuards,
}).strict();
export type RoomPendingApprovalListResponse = z.infer<typeof RoomPendingApprovalListResponseSchema>;

export const RoomInvitationCreateRequestSchema = z.object({
  user_id: IdSchema,
  confirm_owned_private_agent_shares: z.boolean().default(false),
}).strict();
export type RoomInvitationCreateRequest = z.infer<typeof RoomInvitationCreateRequestSchema>;

export const RoomInvitationDecisionRequestSchema = z.object({
  agent_id: IdSchema,
  decision: z.enum(["approved", "rejected"]),
}).strict();
export type RoomInvitationDecisionRequest = z.infer<typeof RoomInvitationDecisionRequestSchema>;

export const RoomOwnerTransferRequestSchema = z.object({
  user_id: IdSchema,
}).strict();
export type RoomOwnerTransferRequest = z.infer<typeof RoomOwnerTransferRequestSchema>;

export const RoomConversationSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  room_id: IdSchema,
  project_id: IdSchema,
  project_folder_id: IdSchema.nullish(),
  title: z.string().nullish(),
  status: z.string(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type RoomConversation = z.infer<typeof RoomConversationSchema>;

/**
 * One conversation as the Project's conversation list shows it: which Room it
 * is in, whether that Room is the mainline, and what was last said.
 *
 * Every step of a Project is pushed through conversation, so the place to see
 * all of it has to exist — and it has to be one list, not one Room at a time.
 */
export const ProjectConversationSchema = z.object({
  id: IdSchema,
  room_id: IdSchema,
  room_title: z.string(),
  room_is_mainline: z.boolean(),
  title: z.string().nullable(),
  created_at: ISODateTimeSchema,
  last_message_at: ISODateTimeSchema.nullable(),
  last_message_role: z.string().nullable(),
  last_message_preview: z.string().nullable(),
  message_count: z.number().int().nonnegative(),
}).strict();
export type ProjectConversation = z.infer<typeof ProjectConversationSchema>;

export const ProjectConversationsResponseSchema = z.object({
  items: z.array(ProjectConversationSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Whether the viewer may start a Room (and so a conversation) here. */
  viewer_can_write: z.boolean(),
}).strict();
export type ProjectConversationsResponse = z.infer<typeof ProjectConversationsResponseSchema>;

export const RoomConversationSummarySchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  summary_text: z.string().min(1),
  covered_through_message_id: IdSchema,
  covered_through_created_at: ISODateTimeSchema,
  covered_message_count: z.number().int().positive(),
  source_token_estimate: z.number().int().nonnegative(),
  summary_token_estimate: z.number().int().nonnegative(),
  project_id: IdSchema,
  created_at: ISODateTimeSchema,
  provider_id: IdSchema.nullish(),
  model: z.string().nullish(),
  usage: z.record(z.unknown()).nullish(),
  audit: z.record(z.unknown()).nullish(),
}).strict();
export type RoomConversationSummary = z.infer<typeof RoomConversationSummarySchema>;

export const RoomConversationSummaryResponseSchema = z.object({
  state: z.object({
    room_id: IdSchema,
    session_id: IdSchema,
    status: z.enum(["idle", "queued", "running", "waiting_provider", "retry_wait", "failed"]),
    active_summary_id: IdSchema.nullish(),
    requested_through_message_id: IdSchema.nullish(),
    requested_through_created_at: ISODateTimeSchema.nullish(),
    retry_count: z.number().int().nonnegative(),
    next_attempt_at: ISODateTimeSchema.nullish(),
    last_error: z.string().nullish(),
    updated_at: ISODateTimeSchema,
    owner_user_id: IdSchema.nullish(),
    room_title: z.string(),
  }).nullable(),
  summary: RoomConversationSummarySchema.nullable(),
}).strict();
export type RoomConversationSummaryResponse = z.infer<typeof RoomConversationSummaryResponseSchema>;

export const RoomMessageSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  session_id: IdSchema,
  user_id: IdSchema.nullish(),
  sender_agent_id: IdSchema.nullish(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  metadata_json: z.record(z.unknown()).nullish(),
  created_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict().superRefine((message, context) => {
  if (message.role === "user" && (!message.user_id || message.sender_agent_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Room user messages require user_id and no sender_agent_id",
    });
  }
  if (message.role === "assistant" && (!message.sender_agent_id || message.user_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Room assistant messages require sender_agent_id and no user_id",
    });
  }
});
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const CreateRoomRequestSchema = z.object({
  project_id: IdSchema,
  project_folder_id: IdSchema.nullish(),
  title: z.string().trim().min(1).max(256),
}).strict();
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const RoomDetailSchema = z.object({
  room: RoomSchema,
  user_members: z.array(RoomUserMemberSchema),
  agent_members: z.array(RoomAgentMemberSchema),
  conversation: RoomConversationSchema.nullish(),
  ...SecretResponseGuards,
}).strict();
export type RoomDetail = z.infer<typeof RoomDetailSchema>;

export const RoomAgentMutationResponseSchema = RoomDetailSchema.extend({
  revoked_grant_count: z.number().int().nonnegative().default(0),
}).strict();
export type RoomAgentMutationResponse = z.infer<typeof RoomAgentMutationResponseSchema>;

export const CreateRoomResponseSchema = RoomDetailSchema.extend({
  conversation: RoomConversationSchema,
}).strict();
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

export const RoomBackendSetupTargetSchema = z.enum(["model_providers", "cli_credentials"]);
export const RoomBackendRequiredErrorSchema = z.object({
  code: z.literal("conversation_backend_required"),
  detail: z.string().trim().min(1),
  setup_targets: z.array(RoomBackendSetupTargetSchema).min(1),
}).strict();
export type RoomBackendRequiredError = z.infer<typeof RoomBackendRequiredErrorSchema>;

export const CreateRoomConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(512).nullish(),
}).strict();

/**
 * What the person is looking at while they type.
 *
 * A focus hint, never a boundary: retrieval keeps its Project scope and the
 * Agent can still reach anything it could before. It exists so "is this one
 * done?" resolves without the person restating which Task they mean — the
 * highest-frequency friction in talking to an Agent about work you are
 * already looking at.
 */
export const RoomMessageFocusRefSchema = z.object({
  // Task only. The Room is already bound to one Project, so a `project` focus
  // said nothing the turn did not already carry — it was accepted here and
  // then silently discarded on the way in, which is worse than not offering
  // it. Widen the enum when a second subject can actually be focused.
  type: z.literal("task"),
  id: IdSchema,
}).strict();
export type RoomMessageFocusRef = z.infer<typeof RoomMessageFocusRefSchema>;

export const SendRoomMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  focus_refs: z.array(RoomMessageFocusRefSchema).max(4).nullish(),
  routing_mode: AgentRunMessageRoutingModeSchema.default("direct"),
  recipient_segments: z.array(AgentRunMessageRecipientSegmentSchema).min(1).nullish(),
  backends: z.array(z.object({
    agent_id: IdSchema,
    runtime_profile_id: IdSchema,
    credential_profile_id: IdSchema.nullish(),
  }).strict()).default([]),
}).strict();
export type SendRoomMessageRequest = z.infer<typeof SendRoomMessageRequestSchema>;

export const ContinueRoomAfterProposalRequestSchema = z.object({
  proposal_id: IdSchema,
  backends: z.array(z.object({
    agent_id: IdSchema,
    runtime_profile_id: IdSchema,
    credential_profile_id: IdSchema.nullish(),
  }).strict()).default([]),
}).strict();
export type ContinueRoomAfterProposalRequest = z.infer<typeof ContinueRoomAfterProposalRequestSchema>;

export const SendRoomMessageResponseSchema = z.object({
  message: RoomMessageSchema,
  conversation: RoomConversationSchema,
  task_group_ids: z.array(IdSchema).min(1),
  run_ids: z.array(IdSchema).min(1),
  ...SecretResponseGuards,
}).strict();
