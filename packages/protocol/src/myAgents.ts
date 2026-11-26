import { z } from "zod";
import { IdSchema, SecretResponseGuards } from "./common.js";

/**
 * "My Agents": one person's Agents across every Space they are an active
 * member of (`GET /api/v1/me/agents`).
 *
 * An entry is listed when the person may read the Agent (the ordinary Agent
 * content gate) or may use it in at least one Room (the Room execution gate,
 * whatever the Agent's own status). A Room-only entry carries no description,
 * home Project, detail or direct chat: only its name and the Rooms that admit
 * the person. Every Room and Project named is one the person is an active
 * member/reader of; nothing names a Room or Project they could not open.
 */

/** How the person reaches this Agent: they own it, it is shared with them, or a Room lets them use it. */
export const MyAgentAccessSchema = z.enum(["owner", "shared", "room_only"]);
export type MyAgentAccess = z.infer<typeof MyAgentAccessSchema>;

/**
 * Whether the person manages it (edit, stop/restore, sharing), and if not, who does:
 * its owner, the Space owner/admin (an unowned, system-managed Agent), or — for a
 * Room-only entry — nobody they can act as here.
 */
export const MyAgentManagementSchema = z.enum(["manage", "owner_only", "space_admin_only", "room_only"]);
export type MyAgentManagement = z.infer<typeof MyAgentManagementSchema>;

/** A plugin Agent's plugin at one Project: set up there now, unbound from it, or not enabled for this person. */
export const MyAgentPluginStateSchema = z.enum(["ready", "unbound", "disabled"]);
export type MyAgentPluginState = z.infer<typeof MyAgentPluginStateSchema>;

export const MyAgentRoomSchema = z.object({
  room_id: IdSchema,
  title: z.string(),
  is_mainline: z.boolean(),
}).strict();
export type MyAgentRoom = z.infer<typeof MyAgentRoomSchema>;

/** One active Project and the person's Rooms in it that admit this Agent for them now. */
export const MyAgentLocationSchema = z.object({
  project_id: IdSchema,
  project_name: z.string(),
  /** Null for an Agent no plugin contributed; otherwise whether it can work in this Project. */
  plugin_state: MyAgentPluginStateSchema.nullable(),
  rooms: z.array(MyAgentRoomSchema),
}).strict();
export type MyAgentLocation = z.infer<typeof MyAgentLocationSchema>;

export const MyAgentSchema = z.object({
  agent_id: IdSchema,
  space_id: IdSchema,
  space_name: z.string(),
  name: z.string(),
  /** Null for a Room-only entry. */
  description: z.string().nullable(),
  /** `active`, or a stopped (`disabled`/`inactive`) Agent that keeps its configuration and history. */
  status: z.string(),
  access: MyAgentAccessSchema,
  management: MyAgentManagementSchema,
  can_open_detail: z.boolean(),
  can_direct_chat: z.boolean(),
  /** The plugin that contributed its Role, if any. */
  plugin_id: z.string().nullable(),
  /** Its home Project, only when the person reads both the Agent and that Project. */
  home_project: z.object({
    project_id: IdSchema,
    project_name: z.string(),
    plugin_state: MyAgentPluginStateSchema.nullable(),
  }).strict().nullable(),
  /** Rooms where it works for this person now (Agent active, Room admits them, plugin set up there). */
  usable_room_count: z.number().int().nonnegative(),
  locations: z.array(MyAgentLocationSchema),
  ...SecretResponseGuards,
}).strict();
export type MyAgent = z.infer<typeof MyAgentSchema>;

export const MyAgentsQuerySchema = z.object({
  manage: z.enum(["all", "manageable"]).default("all"),
  source: z.enum(["all", "mine", "shared", "room_only", "plugin"]).default("all"),
});
export type MyAgentsQuery = z.infer<typeof MyAgentsQuerySchema>;

export const MyAgentsPageSchema = z.object({
  items: z.array(MyAgentSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /**
   * A digest of the whole filtered list as this page saw it: each entry's
   * shown values (ids, Space, name, status, description, access, management,
   * plugin id, home Project; not its Rooms), in order, read in the same
   * statement as `items` and `total`. Two pages with the same revision were cut
   * from the same list, so a client stitching pages together knows it repeated
   * and skipped nothing. Opaque; it digests only what the person is shown.
   */
  revision: z.string().min(1),
}).strict();
export type MyAgentsPage = z.infer<typeof MyAgentsPageSchema>;
