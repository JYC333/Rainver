/**
 * Execution-host contracts: what a paired host can run, and what a dispatch
 * to it can choose from.
 *
 * The daemon's heartbeat is normalized by the server into `HostCapabilities`
 * before it is stored, so this is the one shape the server, the web, and any
 * other reader agree on — a runtime on a host has one identity, adapter type
 * × copy, and everything about a copy lives on the copy.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";

export const RuntimeOptionChoiceSchema = z.object({
  value: z.string(),
  /** The runtime's own display name for the choice, when it gave one. */
  name: z.string().nullable(),
  /** What the choice resolves to, when the runtime said (e.g. what `default` means). */
  description: z.string().nullable(),
  /** ACP select group label, when the Agent grouped this choice. */
  group: z.string().nullable().default(null),
});
export type RuntimeOptionChoice = z.infer<typeof RuntimeOptionChoiceSchema>;

/**
 * One ACP session option exactly as the Agent reports it. Categories are UX
 * hints, not a closed vocabulary; unknown categories remain renderable.
 */
const RuntimeSessionConfigOptionBaseSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).nullable(),
  category: z.string().max(128).nullable(),
});

export const RuntimeSessionConfigOptionSchema = z.discriminatedUnion("type", [
  RuntimeSessionConfigOptionBaseSchema.extend({
    type: z.literal("select"),
    current_value: z.string(),
    options: z.array(RuntimeOptionChoiceSchema),
  }),
  RuntimeSessionConfigOptionBaseSchema.extend({
    type: z.literal("boolean"),
    current_value: z.boolean(),
  }),
]);
export type RuntimeSessionConfigOption = z.infer<typeof RuntimeSessionConfigOptionSchema>;

export const RuntimeSessionConfigSelectionSchema = z.object({
  id: z.string().trim().min(1).max(256),
  type: z.enum(["select", "boolean"]),
  value: z.union([z.string().max(1000), z.boolean()]),
  category: z.string().max(128).nullable(),
}).strict();
export type RuntimeSessionConfigSelection = z.infer<typeof RuntimeSessionConfigSelectionSchema>;

/** What a copy of a runtime says its ACP session can be configured to. */
export const RuntimeOptionsSchema = z.object({
  config_options: z.array(RuntimeSessionConfigOptionSchema),
});
export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>;

export const OWN_INSTALLATION = "own";

/** One copy of a runtime on a host: the machine's own PATH install, or a daemon-managed one. */
export const RuntimeInstallationSchema = z.object({
  /** `own` or `managed:<version>`. */
  id: z.string(),
  version: z.string().nullable(),
  /** Whether its login state exists; null when the runtime declares no login. */
  logged_in: z.boolean().nullable(),
  /** Null when the copy could not be asked and has no configured model either. */
  options: RuntimeOptionsSchema.nullable(),
});
export type RuntimeInstallation = z.infer<typeof RuntimeInstallationSchema>;

export const HostCapabilitiesSchema = z.object({
  /** PATH binaries the daemon found (vendor CLIs and git), for display only. */
  runtimes: z.array(z.string()),
  versions: z.record(z.string(), z.string()),
  /** Every copy of every adapter, keyed by adapter type. */
  installations: z.record(z.string(), z.array(RuntimeInstallationSchema)),
});
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export const HostExecutionTargetLocationSchema = z.object({
  id: IdSchema,
  project_folder_id: IdSchema,
  folder_name: z.string().trim().min(1),
  display_path: z.string().nullable(),
  execution_ready: z.boolean(),
}).strict();
export type HostExecutionTargetLocation = z.infer<typeof HostExecutionTargetLocationSchema>;

export const HostExecutionTargetAdapterSchema = z.object({
  adapter_type: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  installations: z.array(RuntimeInstallationSchema.pick({ id: true, version: true, logged_in: true })),
}).strict();
export type HostExecutionTargetAdapter = z.infer<typeof HostExecutionTargetAdapterSchema>;

export const HostExecutionTargetSchema = z.object({
  host_id: IdSchema,
  host_name: z.string().trim().min(1),
  host_online: z.boolean(),
  locations: z.array(HostExecutionTargetLocationSchema),
  adapters: z.array(HostExecutionTargetAdapterSchema),
  managed_workspace_available: z.boolean(),
}).strict();
export type HostExecutionTarget = z.infer<typeof HostExecutionTargetSchema>;

export const HostExecutionTargetsResponseSchema = z.object({
  targets: z.array(HostExecutionTargetSchema),
}).strict();
export type HostExecutionTargetsResponse = z.infer<typeof HostExecutionTargetsResponseSchema>;

export const ManagedWorkspaceContainerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), user_id: IdSchema }).strict(),
  z.object({ kind: z.literal("conversation"), conversation_id: IdSchema }).strict(),
]);
export type ManagedWorkspaceContainer = z.infer<typeof ManagedWorkspaceContainerSchema>;

export const LaunchWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("location"), workspace_location_id: IdSchema }),
  z.object({
    kind: z.literal("managed"),
    agent_id: IdSchema,
    container: ManagedWorkspaceContainerSchema,
  }),
]);
export type LaunchWorkspace = z.infer<typeof LaunchWorkspaceSchema>;

export const ManagedWorkspaceHeartbeatSchema = z.discriminatedUnion("container_kind", [
  z.object({
    agent_id: IdSchema,
    container_kind: z.literal("direct"),
    container_id: IdSchema,
    archived_available: z.boolean(),
  }).strict(),
  // Conversation managed workspaces are shared by all Agents in a Session;
  // there is intentionally no agent_id in this heartbeat identity.
  z.object({
    container_kind: z.literal("conversation"),
    container_id: IdSchema,
    archived_available: z.boolean(),
  }).strict(),
]);
export type ManagedWorkspaceHeartbeat = z.infer<typeof ManagedWorkspaceHeartbeatSchema>;
