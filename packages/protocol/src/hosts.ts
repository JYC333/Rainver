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

/**
 * One authentication flow advertised by an Agent during ACP initialize.
 * Missing `type` on the wire is normalized to `agent`, as required by ACP.
 * Terminal arguments and environment are Agent-provided data. Rainver's
 * managed CLI fallback is deliberately represented separately on
 * `RuntimeOptions`, because it is not an ACP authentication method.
 */
export const RuntimeAuthMethodSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).nullable(),
  type: z.enum(["agent", "terminal"]),
  args: z.array(z.string().max(2000)),
  env: z.record(z.string(), z.string()),
});
export type RuntimeAuthMethod = z.infer<typeof RuntimeAuthMethodSchema>;

/**
 * Whether an ACP JSON-RPC error means "authenticate first". The protocol's
 * explicit signal is `data.reason: "auth_required"`; not every Agent uses it
 * (Cursor answers `session/new` with `message: "Authentication required"`),
 * so the message is read too. Shared by the server's session controller and
 * the host daemon's probe so both react the same way: authenticate with the
 * Agent-advertised method, then open the session again.
 */
export function isAcpAuthRequiredError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as { message?: unknown; data?: unknown };
  const data = error.data && typeof error.data === "object" ? (error.data as { reason?: unknown }) : null;
  if (data?.reason === "auth_required") return true;
  return typeof error.message === "string" && /authentication required|not (?:logged|signed) in|unauthenticated/i.test(error.message);
}

/** The first Agent-Auth method an ACP `initialize` result advertised, or null. */
export function acpAgentAuthMethodId(initializeResult: unknown): string | null {
  const methods = initializeResult && typeof initializeResult === "object"
    ? (initializeResult as { authMethods?: unknown }).authMethods
    : null;
  if (!Array.isArray(methods)) return null;
  for (const raw of methods) {
    if (!raw || typeof raw !== "object") continue;
    const method = raw as { id?: unknown; type?: unknown };
    if (typeof method.id !== "string" || !method.id) continue;
    if (method.type === undefined || method.type === "agent") return method.id;
  }
  return null;
}

/** What a copy of a runtime says during ACP initialization/session setup. */
export const RuntimeOptionsSchema = z.object({
  config_options: z.array(RuntimeSessionConfigOptionSchema),
  auth_methods: z.array(RuntimeAuthMethodSchema).optional(),
  /** Rainver verified that this managed copy supports its fixed top-level `login` command. */
  cli_login_available: z.boolean().optional(),
  /** Whether the post-initialize session probe succeeded; null when not tested. */
  authenticated: z.boolean().nullable().optional(),
});
export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>;

export const OWN_INSTALLATION = "own";

/** One copy of a runtime on a host: the machine's own PATH install, or a daemon-managed one. */
/** One account a multi-account CLI holds: its provider id and the credential kind (`api`, `oauth`), never the secret. */
export const RuntimeAccountSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.string().min(1).max(64),
});
export type RuntimeAccount = z.infer<typeof RuntimeAccountSchema>;

export const RuntimeInstallationSchema = z.object({
  /** `own` or `managed:<version>`. */
  id: z.string(),
  version: z.string().nullable(),
  /** Whether its login state exists; ACP session setup is the generic fallback signal. */
  logged_in: z.boolean().nullable(),
  /** Null when the copy could not be asked and has no configured model either. */
  options: RuntimeOptionsSchema.nullable(),
  /** Present only for a CLI whose login spec declares an accounts format; the list may be empty. */
  accounts: z.array(RuntimeAccountSchema).optional(),
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
