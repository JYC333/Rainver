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
  ...SecretResponseGuards,
}).strict();
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
  role: z.enum(["manager", "member"]),
  status: z.enum(["active", "removed"]),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type RoomAgentMember = z.infer<typeof RoomAgentMemberSchema>;

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
  manager_agent_id: IdSchema,
  agent_ids: z.array(IdSchema).default([]),
  user_ids: z.array(IdSchema).default([]),
}).strict();
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const RoomDetailSchema = z.object({
  room: RoomSchema,
  user_members: z.array(RoomUserMemberSchema),
  agent_members: z.array(RoomAgentMemberSchema),
  ...SecretResponseGuards,
}).strict();
export type RoomDetail = z.infer<typeof RoomDetailSchema>;

export const CreateRoomConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(512).nullish(),
}).strict();

export const SendRoomMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  routing_mode: AgentRunMessageRoutingModeSchema.default("direct"),
  recipient_segments: z.array(AgentRunMessageRecipientSegmentSchema).min(1).nullish(),
  backends: z.array(z.object({
    agent_id: IdSchema,
    runtime_profile_id: IdSchema,
    credential_profile_id: IdSchema.nullish(),
  }).strict()).default([]),
}).strict();
export type SendRoomMessageRequest = z.infer<typeof SendRoomMessageRequestSchema>;

export const SendRoomMessageResponseSchema = z.object({
  message: RoomMessageSchema,
  task_group_ids: z.array(IdSchema).min(1),
  run_ids: z.array(IdSchema).min(1),
  ...SecretResponseGuards,
}).strict();
