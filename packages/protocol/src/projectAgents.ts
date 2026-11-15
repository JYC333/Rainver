import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { RoomSchema } from "./rooms.js";

/**
 * A Project's Agent list and its Rooms index.
 *
 * Project Agents and Room rosters are separate relations. Linking an Agent to
 * a Project (`project_agent_links`) makes it selectable for this Project's
 * work, including independent use in Project context; it does not add it to
 * any Room, does not let it read a Room's history, and does not share a
 * private Agent with anyone. Every read below is additionally filtered by the
 * viewer's own Agent and Room read gates, so a list never names an Agent or a
 * Room the viewer could not open directly.
 */

/** A Room this Agent is on, limited to Rooms the viewer is an active member of. */
export const ProjectAgentRoomRefSchema = z.object({
  room_id: IdSchema,
  title: z.string(),
  is_mainline: z.boolean(),
}).strict();
export type ProjectAgentRoomRef = z.infer<typeof ProjectAgentRoomRefSchema>;

export const ProjectAgentSchema = z.object({
  agent_id: IdSchema,
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  agent_kind: z.string().trim().min(1),
  visibility: z.string().trim().min(1),
  status: z.string().trim().min(1),
  /** Not `space_shared`: it stays private outside the Rooms its owner explicitly shared it into. */
  private: z.boolean(),
  viewer_is_owner: z.boolean(),
  /** This entry grants execution in its listed Rooms only; Agent content stays hidden. */
  room_only: z.boolean().optional(),
  added_at: ISODateTimeSchema,
  rooms: z.array(ProjectAgentRoomRefSchema),
  ...SecretResponseGuards,
}).strict();
export type ProjectAgent = z.infer<typeof ProjectAgentSchema>;

export const ProjectAgentListResponseSchema = z.object({
  items: z.array(ProjectAgentSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Project write authority: whether the viewer may add or remove Project Agents. */
  viewer_can_write: z.boolean(),
}).strict();
export type ProjectAgentListResponse = z.infer<typeof ProjectAgentListResponseSchema>;

/** An Agent from the viewer's library that may be linked to this Project by the viewer. */
export const ProjectAgentCandidateSchema = z.object({
  agent_id: IdSchema,
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  visibility: z.string().trim().min(1),
  private: z.boolean(),
  linked: z.boolean(),
  ...SecretResponseGuards,
}).strict();
export type ProjectAgentCandidate = z.infer<typeof ProjectAgentCandidateSchema>;

export const ProjectAgentCandidatesResponseSchema = z.object({
  items: z.array(ProjectAgentCandidateSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();
export type ProjectAgentCandidatesResponse = z.infer<typeof ProjectAgentCandidatesResponseSchema>;

/** One Room on the Project's Rooms index: only Rooms the viewer is an active member of. */
export const ProjectRoomSummarySchema = z.object({
  room: RoomSchema,
  /** Active human members other than the viewer, by display name. */
  other_member_names: z.array(z.string()),
  person_count: z.number().int().nonnegative(),
  /** Active Agents on the roster, the manager included. */
  agent_count: z.number().int().nonnegative(),
  conversation_count: z.number().int().nonnegative(),
  last_activity_at: ISODateTimeSchema.nullable(),
  ...SecretResponseGuards,
}).strict();
export type ProjectRoomSummary = z.infer<typeof ProjectRoomSummarySchema>;

export const ProjectRoomsResponseSchema = z.object({
  items: z.array(ProjectRoomSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /** Project write authority: whether the viewer may open a new Room here. */
  viewer_can_write: z.boolean(),
}).strict();
export type ProjectRoomsResponse = z.infer<typeof ProjectRoomsResponseSchema>;

const id = z.string().trim().min(1).max(36);
const link = { project_id: id, agent_id: id };
export const ProjectAgentReceiptSchema = z.object({ id, space_id: id, project_id: id, agent_id: id }).strict();

export const PROJECT_AGENT_OPERATION_SCHEMAS = {
  "project.agent.add": { input: z.object(link).strict(), output: ProjectAgentReceiptSchema },
  "project.agent.remove": { input: z.object(link).strict(), output: ProjectAgentReceiptSchema },
} as const;
export const PROJECT_AGENT_OPERATION_TITLES: Record<keyof typeof PROJECT_AGENT_OPERATION_SCHEMAS, string> = {
  "project.agent.add": "Add an existing Agent to a Project",
  "project.agent.remove": "Remove an Agent from a Project",
};
