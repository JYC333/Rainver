import { z } from "zod";
import { ConversationInputPartsSchema } from "./conversationInput.js";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import {
  AgentRunMessageRecipientSegmentSchema,
  AgentRunMessageRoutingModeSchema,
} from "./agentGroupRuns.js";
import { ConversationMessageInputPartsSchema, MessageMetadataSchema } from "./memorySessions.js";
import { RuntimeSessionConfigSelectionSchema } from "./hosts.js";
import { RuntimeKeySchema } from "./runtimeAuthority.js";
import { RoomDiscussionSchema } from "./roomDiscussions.js";

export const RoomConversationDefaultSchema = z.object({
  agent_id: IdSchema,
  participating: z.boolean(),
  runtime_profile_id: IdSchema.nullable(),
  session_config: z.array(RuntimeSessionConfigSelectionSchema).max(32),
}).strict();
export type RoomConversationDefault = z.infer<typeof RoomConversationDefaultSchema>;

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
  conversation_defaults_json: z.array(RoomConversationDefaultSchema).optional(),
  roster_revision: z.number().int().nonnegative().optional(),
  /** The Project's mainline conversation, which every Project member belongs to. */
  is_mainline: z.boolean().default(false),
  /**
   * Set when the Room's audience is one person — where private continuation
   * lands so it is not seeded into the Project's shared channel. Cleared the
   * moment anyone else joins.
   */
  personal_for_user_id: IdSchema.nullish(),
  ...SecretResponseGuards,
}).strict();

/**
 * What the Project chat panel binds to.
 *
 * Membership is Project membership: a reader who is not yet on the roster is
 * enrolled by this read, so `joined` says whether that just happened.
 * `viewer_can_write` is Project write authority — whether offering to open a
 * Room is honest. Speaking in the mainline needs no such authority.
 */
export const ProjectMainlineRoomResponseSchema = z.object({
  // Never null: a Project is created with its mainline (ADR 0018 decision 4).
  room: RoomSchema,
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
  trigger_policy: z.literal("owner_only"),
  host_name: z.string().trim().min(1).nullable().optional(),
  workspace_mode: z.enum(["location", "managed"]).nullish().optional(),
  host_online: z.boolean().optional(),
  host_owner_is_me: z.boolean().optional(),
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
  /** Already on this Project's Agent list; the Room add dialog offers these first. */
  in_project: z.boolean(),
  member_status: z.enum(["active", "removed"]).nullish(),
  private: z.boolean(),
  shared_with_user_ids: z.array(IdSchema).default([]),
  workspace_mode: z.enum(["location", "managed"]).nullish().optional(),
  host_state_archive_available: z.boolean().optional(),
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
  restore_workspace: z.boolean().default(false),
}).strict();
export type RoomAgentAddRequest = z.infer<typeof RoomAgentAddRequestSchema>;

export const RoomAgentPresetRequestSchema = z.object({
  preset_id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(256).nullish(),
  confirm_room_share: z.boolean().default(false),
  execution: z.object({
    host_id: IdSchema,
    workspace_location_id: IdSchema.nullable(),
    workspace_mode: z.enum(["location", "managed"]),
    runtime_key: RuntimeKeySchema,
    installation: z.string().trim().min(1),
  }).strict().superRefine((value, ctx) => {
    if (value.workspace_mode === "location" && !value.workspace_location_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace_location_id"], message: "Location execution requires a Workspace Location" });
    }
    if (value.workspace_mode === "managed" && value.workspace_location_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace_location_id"], message: "Managed execution cannot include a Workspace Location" });
    }
  }).nullish(),
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
  can_delete_empty: z.boolean().optional(),
  last_message_at: ISODateTimeSchema.nullable().optional(),
  is_running: z.boolean().optional(),
  /** Recycle bin list only: when it was deleted and when it stops being restorable. */
  deleted_at: ISODateTimeSchema.optional(),
  purge_after: ISODateTimeSchema.optional(),
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
  /**
   * The other people who can see this conversation — the Room's active human
   * roster minus the viewer, by display name. The interface names a Room by
   * its audience rather than by its title, because the audience is what a Room
   * *is* ([ADR 0018](../../../.agent/decisions/0018-room-as-visibility-boundary.md)
   * decision 1) and the title is a label somebody typed. Empty when the
   * viewer is the only person in the Room, which is what a personal Room is.
   */
  room_other_member_names: z.array(z.string()),
  /** Active Agents on that Room's roster, the manager included. */
  room_agent_count: z.number().int().nonnegative(),
  title: z.string().nullable(),
  created_at: ISODateTimeSchema,
  last_message_at: ISODateTimeSchema.nullable(),
  last_message_role: z.string().nullable(),
  last_message_preview: z.string().nullable(),
  message_count: z.number().int().nonnegative(),
  is_running: z.boolean().optional(),
}).strict();
export type ProjectConversation = z.infer<typeof ProjectConversationSchema>;

/**
 * A Room of the viewer's that holds no conversation yet.
 *
 * Listing conversations would hide it entirely, and a Room becomes reachable
 * only through a conversation in it — so opening one and walking away before
 * saying anything would have no way back. It is named by its audience like
 * any other section.
 */
export const ProjectEmptyRoomSchema = z.object({
  room_id: IdSchema,
  room_is_mainline: z.boolean(),
  room_other_member_names: z.array(z.string()),
  room_agent_count: z.number().int().nonnegative(),
}).strict();
export type ProjectEmptyRoom = z.infer<typeof ProjectEmptyRoomSchema>;

export const ProjectConversationsResponseSchema = z.object({
  items: z.array(ProjectConversationSchema),
  /** Rooms the viewer is in that nobody has spoken in yet. Always present. */
  empty_rooms: z.array(ProjectEmptyRoomSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /**
   * Project **write** authority — whether the viewer may open a Room here.
   * Not whether they may speak: a Project reader is enrolled in the mainline
   * on first open and the server accepts their messages, which is the whole
   * point of the chat panel for a viewer.
   */
  viewer_can_write: z.boolean(),
}).strict();
export type ProjectConversationsResponse = z.infer<typeof ProjectConversationsResponseSchema>;

export const RoomMessageSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  session_id: IdSchema,
  user_id: IdSchema.nullish(),
  sender_agent_id: IdSchema.nullish(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  metadata_json: MessageMetadataSchema.nullish(),
  /** The message this one replies to; null only for a session's first. */
  parent_message_id: IdSchema.nullish(),
  /** The Run that produced this message, or that this message started. */
  run_id: IdSchema.nullish(),
  /** The Room discussion this message belongs to, when it is part of one. */
  discussion_id: IdSchema.nullish(),
  /** Ordered images and managed file references backed by server snapshots. */
  input_parts: ConversationMessageInputPartsSchema.optional(),
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
  /**
   * Open (or reuse) the caller's personal Room in this Project rather than a
   * new shared one. A Project has at most one per person.
   */
  personal: z.boolean().optional(),
}).strict();
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const RoomDetailSchema = z.object({
  room: RoomSchema,
  user_members: z.array(RoomUserMemberSchema),
  agent_members: z.array(RoomAgentMemberSchema),
  /**
   * Project **write** authority — whether the viewer may mutate this Room's
   * roster. Every roster mutation goes through `withRoomWriter`, which
   * requires exactly this, so it is what the roster controls are shown on.
   *
   * Deliberately not whether they may speak: a Project reader is enrolled in
   * the mainline on first open and the server accepts their messages. Reading
   * one authority as the other is how a reader gets locked out of the chat, or
   * offered a control that 403s.
   */
  viewer_can_write: z.boolean(),
  /**
   * Who else is in it, and how many Agents — the same definition the Project
   * conversation list uses, so one Room is never described two ways. Computed
   * here. Do not sort a client-side roster copy. It names people the catalog
   * has not loaded yet "Someone".
   */
  other_member_names: z.array(z.string()),
  agent_count: z.number().int().nonnegative(),
  ...SecretResponseGuards,
}).strict();
export type RoomDetail = z.infer<typeof RoomDetailSchema>;

/** What the execution Host reported for a managed-workspace restore or archive. */
/**
 * The Room detail re-read after a roster command. Host archive/restore runs
 * after the roster commits and is not part of this response: a restore that
 * brought nothing back is posted as a system notice in its conversation.
 */
export const RoomAgentMutationResponseSchema = RoomDetailSchema.extend({
  revoked_grant_count: z.number().int().nonnegative().default(0),
}).strict();
export type RoomAgentMutationResponse = z.infer<typeof RoomAgentMutationResponseSchema>;

/**
 * Creating a Room creates a Room. No conversation comes back because none is
 * made: the explicit draft action creates the first conversation, so its
 * execution context can be reviewed before any message or Run exists.
 */
export const CreateRoomResponseSchema = RoomDetailSchema;
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;


/**
 * What the person is looking at while they type.
 *
 * A focus hint, never a boundary: retrieval keeps its Project scope, and the
 * hint does not narrow what the Agent can reach. "is this one done?" resolves
 * without the person restating which Task they mean.
 */
export const RoomMessageFocusRefSchema = z.object({
  // Task only. The Room is already bound to one Project. Do not accept a
  // `project` focus. It says nothing the turn does not already carry, and
  // discarding it on the way in is worse than not offering it. Widen the
  // enum when a second subject can actually be focused.
  type: z.literal("task"),
  id: IdSchema,
}).strict();
export type RoomMessageFocusRef = z.infer<typeof RoomMessageFocusRefSchema>;

/** Agents one message may ask the manager to arrange work with. */
export const ROOM_MESSAGE_MAX_COORDINATION_TARGETS = 20;

/**
 * An ordinary send's request to reach the active Run its route already
 * targets (`modules/rooms.md`, "Ordinary send into an active turn"): `auto`
 * when exactly one can take the text, or the Run the person chose among
 * several. Omitted, the message is sent or queued as before.
 */
export const RoomLiveTargetSchema = z.union([z.literal("auto"), z.object({ run_id: IdSchema }).strict()]);
export type RoomLiveTarget = z.infer<typeof RoomLiveTargetSchema>;
/** The 409 refusal code naming several Runs a message could go to; nothing was recorded. */
export const ROOM_LIVE_INPUT_CHOICE_REQUIRED = "live_input_target_choice_required";
/**
 * The 409 refusal of a Run the person explicitly chose that can no longer take
 * this message (it moved on, or the draft became one a running turn cannot
 * carry). Nothing was recorded or sent; `candidates` lists the Runs that still
 * can, possibly none. Never answered by a silent ordinary send.
 */
export const ROOM_LIVE_INPUT_TARGET_UNAVAILABLE = "live_input_target_unavailable";
/** One active Run an ordinary send could be added to, as the choice refusal lists it. */
export const RoomLiveInputCandidateSchema = z.object({
  run_id: IdSchema,
  agent_id: IdSchema,
  agent_name: z.string().nullable(),
  status: z.enum(["running", "waiting_for_dependency"]),
  /** `live`: into the running turn now; `with_results`: handed over when the parked turn resumes. */
  delivery: z.enum(["live", "with_results"]),
  /** Rainver delegated this Run to the Agent rather than the person addressing it. */
  delegated: z.boolean(),
  started_at: z.string().nullable(),
}).strict();
export type RoomLiveInputCandidate = z.infer<typeof RoomLiveInputCandidateSchema>;

export const SendRoomMessageRequestSchema = z.object({
  content: z.string().trim().max(8000).default(""),
  input_parts: ConversationInputPartsSchema.default([]),
  focus_refs: z.array(RoomMessageFocusRefSchema).max(4).nullish(),
  /** Join this exact active discussion; omitted means an ordinary Room message. */
  discussion_id: IdSchema.nullish(),
  /**
   * Wait for the turn instead of being refused: when another turn holds the
   * conversation, the message is queued and posted at the next turn boundary
   * (202 with the queued message). A message with input parts is never
   * queued.
   */
  queue: z.boolean().default(false),
  live_target: RoomLiveTargetSchema.nullish(),
  routing_mode: AgentRunMessageRoutingModeSchema.default("direct"),
  recipient_segments: z.array(AgentRunMessageRecipientSegmentSchema).min(1).nullish(),
  /**
   * Under `agent_coordination`: the Agents the person referred to, whom the
   * manager is asked to arrange the work with. Each must be an active Agent
   * member of the Room.
   */
  coordination_target_agent_ids: z.array(IdSchema).max(ROOM_MESSAGE_MAX_COORDINATION_TARGETS).nullish(),
  backends: z.array(z.object({
    agent_id: IdSchema,
    runtime_profile_id: IdSchema,
    session_config: z.array(RuntimeSessionConfigSelectionSchema).max(32).optional(),
  }).strict()).default([]),
}).strict().superRefine((value, ctx) => {
  if (!value.content && value.input_parts.length === 0) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "content or an input part is required" });
  }
  if (value.coordination_target_agent_ids?.length && value.routing_mode !== "agent_coordination") {
    ctx.addIssue({
      code: "custom",
      path: ["coordination_target_agent_ids"],
      message: "coordination targets require routing_mode agent_coordination",
    });
  }
});
export type SendRoomMessageRequest = z.infer<typeof SendRoomMessageRequestSchema>;

export const ContinueRoomAfterProposalRequestSchema = z.object({
  proposal_id: IdSchema,
  backends: z.array(z.object({
    agent_id: IdSchema,
    runtime_profile_id: IdSchema,
    session_config: z.array(RuntimeSessionConfigSelectionSchema).max(32).optional(),
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

/** A person's message waiting for the conversation's turn. */
export const QueuedRoomMessageSchema = z.object({
  id: IdSchema,
  room_id: IdSchema,
  session_id: IdSchema,
  user_id: IdSchema,
  content: z.string(),
  /** Saved send choice; absent on older queued rows. */
  discussion_id: IdSchema.nullish(),
  status: z.enum(["queued", "released", "withdrawn", "failed"]),
  released_message_id: IdSchema.nullable(),
  failure_reason: z.string().nullable(),
  created_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type QueuedRoomMessage = z.infer<typeof QueuedRoomMessageSchema>;

export const QueuedRoomMessageResponseSchema = z.object({
  queued: QueuedRoomMessageSchema,
  ...SecretResponseGuards,
}).strict();
export type QueuedRoomMessageResponse = z.infer<typeof QueuedRoomMessageResponseSchema>;

/** Opening a discussion posts its topic as the person's message and dispatches the first wave. */
export const OpenRoomDiscussionResponseSchema = SendRoomMessageResponseSchema.extend({
  discussion: RoomDiscussionSchema,
}).strict();
export type OpenRoomDiscussionResponse = z.infer<typeof OpenRoomDiscussionResponseSchema>;

/**
 * Everyone who can read a Project — the roster picker's candidate set.
 *
 * Distinct from the Project *members* list, which is the memory ACL and omits
 * the owner. A Room's audience is chosen from this, and the server refuses to
 * invite anyone outside it, so offering a wider list produces controls that
 * only ever fail.
 */
export const ProjectReaderSchema = z.object({
  user_id: IdSchema,
  display_name: z.string(),
  /** Nullable on `users`; a Space member may have been created without one. */
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
}).strict();
export type ProjectReader = z.infer<typeof ProjectReaderSchema>;

export const ProjectReadersResponseSchema = z.object({
  readers: z.array(ProjectReaderSchema),
}).strict();
export type ProjectReadersResponse = z.infer<typeof ProjectReadersResponseSchema>;

/** Optional exact Conversation target; absent preserves the legacy Room roster action. */
export const RoomAgentResetContextRequestSchema = z.object({ session_id: IdSchema.optional() }).strict();
