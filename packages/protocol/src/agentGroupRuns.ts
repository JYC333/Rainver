/**
 * Agent group run contracts.
 *
 * These schemas model a manager-started room where agents may request child
 * runs from other allowed agents. They are wire contracts only. The server
 * owns membership checks, policy enforcement, child-run creation, queueing,
 * context rendering, and audit persistence.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { TraceSafeJsonSchema } from "./runOrchestration.js";

const TraceSafeObjectSchema = TraceSafeJsonSchema.refine(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  "Expected a trace-safe JSON object.",
);

export const AGENT_RUN_GROUP_STATUS_VALUES = [
  "active",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "archived",
] as const;
export const AgentRunGroupStatusSchema = z.enum(AGENT_RUN_GROUP_STATUS_VALUES);

export const AGENT_RUN_GROUP_MEMBER_ROLE_VALUES = [
  "manager",
  "planner",
  "worker",
  "reviewer",
  "curator",
  "observer",
] as const;
export const AgentRunGroupMemberRoleSchema = z.enum(
  AGENT_RUN_GROUP_MEMBER_ROLE_VALUES,
);

export const AGENT_RUN_GROUP_MEMBER_STATUS_VALUES = [
  "active",
  "disabled",
] as const;
export const AgentRunGroupMemberStatusSchema = z.enum(
  AGENT_RUN_GROUP_MEMBER_STATUS_VALUES,
);

export const AGENT_RUN_MESSAGE_TYPE_VALUES = [
  "user_instruction",
  "agent_message",
  "delegation_request",
  "delegation_result",
  "system_event",
  "review_note",
] as const;
export const AgentRunMessageTypeSchema = z.enum(
  AGENT_RUN_MESSAGE_TYPE_VALUES,
);

export const RUN_DELEGATION_STATUS_VALUES = [
  "requested",
  "policy_denied",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const RunDelegationStatusSchema = z.enum(
  RUN_DELEGATION_STATUS_VALUES,
);

export const AgentRunMentionSchema = z
  .object({
    agent_id: IdSchema,
    handle: z.string().min(1).nullish(),
    display_name: z.string().min(1).nullish(),
  })
  .strict();
export type AgentRunMention = z.infer<typeof AgentRunMentionSchema>;

export const AGENT_RUN_MESSAGE_ROUTING_MODE_VALUES = [
  "direct",
  "agent_coordination",
] as const;
export const AgentRunMessageRoutingModeSchema = z.enum(
  AGENT_RUN_MESSAGE_ROUTING_MODE_VALUES,
);
export type AgentRunMessageRoutingMode = z.infer<
  typeof AgentRunMessageRoutingModeSchema
>;

export const AgentRunMessageRecipientSegmentSchema = z
  .object({
    recipient_agent_ids: z.array(IdSchema).min(1),
    content: z.string().min(1),
  })
  .strict();
export type AgentRunMessageRecipientSegment = z.infer<
  typeof AgentRunMessageRecipientSegmentSchema
>;

export const AgentRunGroupSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    root_run_id: IdSchema.nullish(),
    manager_user_id: IdSchema,
    manager_agent_id: IdSchema.nullish(),
    room_id: IdSchema.nullish(),
    session_id: IdSchema.nullish(),
    trigger_message_id: IdSchema.nullish(),
    project_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    title: z.string().min(1),
    goal: z.string(),
    status: AgentRunGroupStatusSchema,
    budget_json: TraceSafeObjectSchema.nullish(),
    policy_snapshot_json: TraceSafeObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ended_at: ISODateTimeSchema.nullish(),
    ...SecretResponseGuards,
  })
  .strict();
export type AgentRunGroup = z.infer<typeof AgentRunGroupSchema>;

export const AgentRunGroupMemberSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    group_id: IdSchema,
    agent_id: IdSchema,
    role: AgentRunGroupMemberRoleSchema,
    status: AgentRunGroupMemberStatusSchema,
    capabilities_json: TraceSafeObjectSchema.nullish(),
    context_policy_json: TraceSafeObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type AgentRunGroupMember = z.infer<typeof AgentRunGroupMemberSchema>;

export const AgentRunMessageSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    group_id: IdSchema,
    run_id: IdSchema.nullish(),
    parent_message_id: IdSchema.nullish(),
    sender_actor_ref_json: TraceSafeObjectSchema,
    sender_user_id: IdSchema.nullish(),
    sender_agent_id: IdSchema.nullish(),
    message_type: AgentRunMessageTypeSchema,
    content: z.string(),
    mentions_json: z.array(AgentRunMentionSchema).default([]),
    metadata_json: TraceSafeObjectSchema.nullish(),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type AgentRunMessage = z.infer<typeof AgentRunMessageSchema>;

export const RunDelegationSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    group_id: IdSchema,
    parent_run_id: IdSchema,
    child_run_id: IdSchema.nullish(),
    request_message_id: IdSchema.nullish(),
    requesting_agent_id: IdSchema,
    target_agent_id: IdSchema,
    requested_by_user_id: IdSchema.nullish(),
    policy_decision_record_id: IdSchema.nullish(),
    status: RunDelegationStatusSchema,
    instruction: z.string().min(1),
    reason: z.string().nullish(),
    budget_json: TraceSafeObjectSchema.nullish(),
    context_policy_json: TraceSafeObjectSchema.nullish(),
    result_summary: z.string().nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    completed_at: ISODateTimeSchema.nullish(),
    ...SecretResponseGuards,
  })
  .strict();
export type RunDelegation = z.infer<typeof RunDelegationSchema>;

export const CreateAgentRunGroupRequestSchema = z
  .object({
    space_id: IdSchema,
    title: z.string().min(1),
    goal: z.string().optional().default(""),
    manager_agent_id: IdSchema,
    member_agent_ids: z.array(IdSchema).min(1),
    budget_json: TraceSafeObjectSchema.nullish(),
    context_policy_json: TraceSafeObjectSchema.nullish(),
  })
  .strict();
export type CreateAgentRunGroupRequest = z.infer<
  typeof CreateAgentRunGroupRequestSchema
>;

export const CreateAgentRunGroupResponseSchema = z
  .object({
    group: AgentRunGroupSchema,
    members: z.array(AgentRunGroupMemberSchema),
    ...SecretResponseGuards,
  })
  .strict();
export type CreateAgentRunGroupResponse = z.infer<
  typeof CreateAgentRunGroupResponseSchema
>;

export const UpdateAgentRunGroupRequestSchema = z
  .object({
    space_id: IdSchema,
    title: z.string().min(1).optional(),
    goal: z.string().optional(),
  })
  .strict();
export type UpdateAgentRunGroupRequest = z.infer<
  typeof UpdateAgentRunGroupRequestSchema
>;

export const UpdateAgentRunGroupResponseSchema = z
  .object({
    group: AgentRunGroupSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type UpdateAgentRunGroupResponse = z.infer<
  typeof UpdateAgentRunGroupResponseSchema
>;

export const SendAgentRunGroupMessageRequestSchema = z
  .object({
    space_id: IdSchema,
    group_id: IdSchema,
    content: z.string().min(1),
    parent_message_id: IdSchema.nullish(),
    routing_mode: AgentRunMessageRoutingModeSchema.default("direct"),
    recipient_segments: z.array(AgentRunMessageRecipientSegmentSchema).min(1).nullish(),
    metadata_json: TraceSafeObjectSchema.nullish(),
  })
  .strict();
export type SendAgentRunGroupMessageRequest = z.infer<
  typeof SendAgentRunGroupMessageRequestSchema
>;

export const SendAgentRunGroupMessageResponseSchema = z
  .object({
    message: AgentRunMessageSchema,
    ...SecretResponseGuards,
  })
  .strict();
export type SendAgentRunGroupMessageResponse = z.infer<
  typeof SendAgentRunGroupMessageResponseSchema
>;

export const SpawnChildRunRequestSchema = z
  .object({
    space_id: IdSchema,
    group_id: IdSchema,
    parent_run_id: IdSchema,
    root_run_id: IdSchema,
    requesting_agent_id: IdSchema,
    target_agent_id: IdSchema,
    manager_user_id: IdSchema,
    request_message_id: IdSchema.nullish(),
    instruction: z.string().min(1),
    reason: z.string().nullish(),
    budget_json: TraceSafeObjectSchema.nullish(),
    context_policy_json: TraceSafeObjectSchema.nullish(),
  })
  .strict();

export const SpawnChildRunResponseSchema = z
  .object({
    delegation: RunDelegationSchema,
    child_run_id: IdSchema.nullish(),
    policy_decision_record_id: IdSchema.nullish(),
    ...SecretResponseGuards,
  })
  .strict();

export const RuntimeDelegationOutputItemSchema = z
  .object({
    target_agent_id: IdSchema,
    instruction: z.string().min(1),
    reason: z.string().min(1).nullish(),
    budget: TraceSafeObjectSchema.nullish(),
    context: TraceSafeObjectSchema.nullish(),
  })
  .strict();
export type RuntimeDelegationOutputItem = z.infer<
  typeof RuntimeDelegationOutputItemSchema
>;

const NormalizedAgentWaitIdListSchema = z.array(z.string()).transform((values) => [
  ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
]);
const NormalizedAgentWaitTextSchema = z.string().transform((value) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
});

/** The shared input contract for the live `agent.wait_for_results` tool. */
export const AgentWaitForResultsInputSchema = z
  .object({
    scope: z.enum(["current_turn", "own_delegations", "run_ids"]).optional(),
    run_ids: NormalizedAgentWaitIdListSchema.optional(),
    target_agent_ids: NormalizedAgentWaitIdListSchema.optional(),
    reason: NormalizedAgentWaitTextSchema.optional(),
    resume_instruction: NormalizedAgentWaitTextSchema.optional(),
  })
  .strict();
export type AgentWaitForResultsInput = z.infer<
  typeof AgentWaitForResultsInputSchema
>;

export const RuntimeDelegationsOutputSchema = z
  .object({
    delegations: z.array(RuntimeDelegationOutputItemSchema).default([]),
  })
  .passthrough();

export const AgentRunGroupTimelineSchema = z
  .object({
    group: AgentRunGroupSchema,
    members: z.array(AgentRunGroupMemberSchema),
    messages: z.array(AgentRunMessageSchema),
    delegations: z.array(RunDelegationSchema),
    ...SecretResponseGuards,
  })
  .strict();
export type AgentRunGroupTimeline = z.infer<
  typeof AgentRunGroupTimelineSchema
>;

export const AgentRunGroupTraceSchema = z
  .object({
    group: AgentRunGroupSchema,
    members: z.array(AgentRunGroupMemberSchema),
    root_run_id: IdSchema.nullish(),
    timeline: AgentRunGroupTimelineSchema,
    child_run_ids: z.array(IdSchema).default([]),
    artifact_ids: z.array(IdSchema).default([]),
    proposal_ids: z.array(IdSchema).default([]),
    policy_decision_record_ids: z.array(IdSchema).default([]),
    ...SecretResponseGuards,
  })
  .strict();
export type AgentRunGroupTrace = z.infer<typeof AgentRunGroupTraceSchema>;
