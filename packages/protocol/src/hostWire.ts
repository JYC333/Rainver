/**
 * The execution-host WebSocket wire, both directions, as one contract.
 *
 * `HostServerFrameSchema` is every frame the control plane pushes to a paired
 * daemon; `HostDaemonFrameSchema` is every frame a daemon sends back. Both
 * ends parse inbound frames with these schemas and type outbound frames
 * against them, so a field exists in exactly one place. Before this each side
 * rebuilt every frame by hand from untyped JSON, and a field the rebuild did
 * not name vanished without a trace — `provider_binding`, then `server_url`,
 * then `work_surface`, each shipped inert once that way.
 *
 * Objects are not `.strict()`: an unknown field is dropped, not fatal. What
 * guards against a field being *lost* is that neither side names fields by
 * hand any more. Both ends ship from this repository together, so there is no
 * older peer to stay compatible with and nothing here is optional for that
 * reason.
 *
 * Wire shapes only. What a daemon does with a frame — resolving a Location to
 * a path, choosing a profile directory — is the daemon's, and the server's
 * deeper validation of a folder read result (path safety, size caps) stays in
 * the server, because it is policy, not shape.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";
import {
  AmbientSessionCountSchema,
  AmbientSessionImportSchema,
  AmbientTrimLimitsSchema,
} from "./ambientSessions.js";
import { LaunchWorkspaceSchema, ManagedWorkspaceHeartbeatSchema, RuntimeAuthMethodSchema } from "./hosts.js";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Placeholders the control plane writes into a launch's argv, stdin and
 * prompt for values only the executing machine knows. The daemon substitutes
 * them in every byte it forwards to the child — argv, the initial stdin, and
 * each `stdin` frame — so a prompt can say "read this file" with a path the
 * server never had.
 */
export const REMOTE_CWD_PLACEHOLDER = "rainver:remote-workspace-cwd";
export const WORK_SKILL_PATH_PLACEHOLDER = "rainver:work-skill-path";

/**
 * How a runtime is logged into and how a login is recognised. The server's
 * adapter spec is the source; the daemon applies it and adds nothing.
 */
export const RuntimeLoginSpecSchema = z.object({
  command: z.array(z.string()),
  managed_command: z.array(z.string()).optional(),
  home_subdir: z.string(),
  credential_file: z.string(),
  hint: z.string().optional(),
});
export type RuntimeLoginSpec = z.infer<typeof RuntimeLoginSpecSchema>;

/** How to obtain a managed copy of a runtime. */
export const RuntimeDistributionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npx"), package: z.string(), args: z.array(z.string()), env: z.record(z.string()) }),
  z.object({ kind: z.literal("uvx"), package: z.string(), args: z.array(z.string()), env: z.record(z.string()) }),
  z.object({
    kind: z.literal("binary"),
    platforms: z.record(z.object({
      archive: z.string(),
      cmd: z.string(),
      args: z.array(z.string()),
      sha256: z.string().nullable(),
      env: z.record(z.string()),
    })),
  }),
]);
export type RuntimeDistribution = z.infer<typeof RuntimeDistributionSchema>;

/**
 * Everything the control plane knows about one runtime adapter, sent in the
 * initial `hello_ack` and refreshed by `heartbeat_ack`. The daemon holds no
 * independent catalog: a runtime it can dispatch to is one the server told it
 * how to look for, ask, install, and log into.
 */
export const RuntimeProbeSchema = z.object({
  adapter_type: z.string().min(1),
  /** The PATH binary of the machine's own install; null for a managed-only runtime. */
  runtime: z.string().nullable(),
  /** The launch argv, with the daemon's cwd placeholder where a workspace path goes. */
  argv: z.array(z.string()),
  distribution: RuntimeDistributionSchema.nullable(),
  /** The pinned version a managed install gets, when the distribution names one. */
  version: z.string().nullable(),
  login: RuntimeLoginSpecSchema.nullable(),
  remote_host_only: z.boolean(),
});
export type RuntimeProbe = z.infer<typeof RuntimeProbeSchema>;

export const WorkspaceStatusReportSchema = z.object({
  location_id: IdSchema,
  branch: z.string().nullable(),
  git_head: z.string().nullable(),
  dirty: z.boolean().nullable(),
  execution_ready: z.boolean(),
});
export type WorkspaceStatusReport = z.infer<typeof WorkspaceStatusReportSchema>;

/**
 * What a daemon says about itself in `hello` and every `heartbeat`.
 *
 * `capabilities_json` is deliberately loose here: the daemon's wire format for
 * it and its history are the server's `hosts/capabilities.ts` concern, which
 * normalizes it into `HostCapabilities` before anything reads it.
 */
export const HostHelloInfoSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  daemon_version: z.string(),
  environment_kind: z.string(),
  capabilities_json: z.record(z.unknown()),
  workspace_reports: z.array(WorkspaceStatusReportSchema),
  managed_workspaces: z.array(ManagedWorkspaceHeartbeatSchema),
  /** Counts only, never content: whether an import is worth offering. */
  ambient_sessions: z.array(AmbientSessionCountSchema),
  /**
   * The address this daemon actually reaches the control plane at. The server
   * cannot guess it — its own hostname is a Compose service name no paired
   * machine resolves — and every URL it hands this host derives from it.
   */
  server_url: z.string().optional(),
});
export type HostHelloInfo = z.infer<typeof HostHelloInfoSchema>;

export const HostLaunchProviderBindingSchema = z.object({
  /** `<adapter_type>/<provider_id>`: which profile directory on the host the runtime uses. */
  profile_key: z.string().min(1),
  /** Literal environment; never a provider API key (ADR 0008 channel isolation). */
  env: z.record(z.string()),
  /** Variable → path relative to the profile root, resolved on the host. */
  profile_env: z.record(z.string()),
  files: z.array(z.object({
    relative_path: z.string().min(1),
    contents: z.string(),
    escape: z.literal("toml_basic_string").optional(),
  })),
});
export type HostLaunchProviderBinding = z.infer<typeof HostLaunchProviderBindingSchema>;

export const HostLaunchWorkSurfaceSchema = z.object({
  /** Literal values: the API base URL, the run id, and the run's tool token. */
  env: z.record(z.string()),
  files: z.array(z.object({ relative_path: z.string().min(1), contents: z.string() })),
  /** Variable → path relative to the run directory, resolved on the host. */
  dir_env: z.record(z.string()),
});
export type HostLaunchWorkSurface = z.infer<typeof HostLaunchWorkSurfaceSchema>;

export const HostLaunchWorkspaceAccessSchema = z.object({
  workspace_location_id: IdSchema,
  access_mode: z.enum(["read", "write"]),
});
export type HostLaunchWorkspaceAccess = z.infer<typeof HostLaunchWorkspaceAccessSchema>;

export const ManagedWorkspaceContainerKindSchema = z.enum(["direct", "conversation"]);

export const FolderReadKindSchema = z.enum(["tree", "file", "git_status", "git_diff"]);
export type FolderReadKind = z.infer<typeof FolderReadKindSchema>;

/** What a daemon can answer a folder read with; the server adds its own transport codes. */
export const FolderReadDaemonErrorSchema = z.enum([
  "location_unknown",
  "path_forbidden",
  "not_found",
  "is_directory",
  "too_large",
  "read_failed",
]);
export type FolderReadDaemonError = z.infer<typeof FolderReadDaemonErrorSchema>;

// ---------------------------------------------------------------------------
// Control plane → daemon
// ---------------------------------------------------------------------------

export const HostLaunchFrameSchema = z.object({
  type: z.literal("launch"),
  run_id: IdSchema,
  /**
   * Which dispatch of this run this is. A supervisor retry reuses the run id
   * within seconds of the first attempt's kill, before that attempt's child
   * has reported; the daemon echoes this on every run frame so the control
   * plane routes a late `complete` from attempt 1 nowhere rather than into
   * attempt 2's promise, and the daemon itself knows which attempt's cleanup
   * owns the run directory.
   */
  launch_id: IdSchema,
  workspace_location_id: IdSchema.optional(),
  workspace: LaunchWorkspaceSchema.optional(),
  /** Concrete attached Locations authorized for this Run; paths are resolved on the host. */
  workspace_access: z.array(HostLaunchWorkspaceAccessSchema).optional(),
  argv: z.array(z.string()),
  stdin: z.string().nullable().optional(),
  timeout_seconds: z.number().nullable().optional(),
  /** A bidirectional-protocol run streams `stdin` frames over its lifetime; the daemon must not close stdin after launch. */
  keep_stdin_open: z.boolean().optional(),
  /** Which copy of the runtime: `own` or `managed:<version>`. */
  installation: z.string().optional(),
  adapter_type: z.string().optional(),
  provider_binding: HostLaunchProviderBindingSchema.optional(),
  /**
   * How this run calls back into Rainver: its identity, the control-plane
   * address to use it at, and the Skill that says how. Runtime-agnostic on
   * purpose — environment and one file, with no branch on which agent runs.
   */
  work_surface: HostLaunchWorkSurfaceSchema.optional(),
});
export type HostLaunchFrame = z.infer<typeof HostLaunchFrameSchema>;
/** What a dispatcher supplies; the registry adds `type`, `run_id` and the `launch_id` nonce. */
export type HostLaunchPayload = Omit<HostLaunchFrame, "type" | "run_id" | "launch_id">;

export const HostInstallToolFrameSchema = z.object({
  type: z.literal("install_tool"),
  request_id: IdSchema,
  adapter_type: z.string().min(1),
  version: z.string().min(1),
  distribution: RuntimeDistributionSchema,
  login: RuntimeLoginSpecSchema.nullable(),
});
export const HostUninstallToolFrameSchema = z.object({
  type: z.literal("uninstall_tool"),
  request_id: IdSchema,
  adapter_type: z.string().min(1),
  version: z.string().min(1),
});
export const HostLoginOpenFrameSchema = z.object({
  type: z.literal("login_open"),
  session_id: IdSchema,
  adapter_type: z.string().min(1),
  installation: z.string().min(1),
  login: RuntimeLoginSpecSchema.nullable(),
  /** Normal ACP launch program; required when a machine-owned copy uses ACP auth. */
  argv: z.array(z.string()).optional(),
  /** Selected from this installation's last ACP initialize response. */
  auth_method: RuntimeAuthMethodSchema.nullable().optional(),
  /** Rainver-owned compatibility flow; mutually exclusive with `auth_method`. */
  login_action: z.literal("cli").nullable().optional(),
});
export const HostAmbientImportFrameSchema = z.object({
  type: z.literal("ambient_import"),
  request_id: IdSchema,
  workspace_location_id: IdSchema,
  adapter_type: z.string().min(1),
  installation: z.string().min(1),
  /** Null replays every session in the window; a list replays only those. */
  session_ids: z.array(z.string()).nullable(),
  /** Sessions held unfinished server-side; replayed even outside the window. */
  retry_session_ids: z.array(z.string()),
  /** Sessions the server already holds and the `updated_at` it holds them at. */
  unchanged: z.array(z.object({ session_id: z.string(), updated_at: z.string() })),
  window_days: z.number().int().positive(),
  max_sessions: z.number().int().positive(),
  limits: AmbientTrimLimitsSchema,
});
export const HostFolderReadFrameSchema = z.object({
  type: z.literal("folder_read"),
  request_id: IdSchema,
  workspace_location_id: IdSchema,
  kind: FolderReadKindSchema,
  path: z.string().optional(),
  protected: z.boolean(),
});
const managedWorkspaceActionFields = {
  request_id: IdSchema,
  agent_id: IdSchema,
  container_kind: ManagedWorkspaceContainerKindSchema,
  container_id: IdSchema,
};

export const HostServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello_ack"), host_id: IdSchema, runtime_probes: z.array(RuntimeProbeSchema) }),
  // The catalog can change while a daemon stays connected (for example when
  // an ACP registry agent is enabled), so every acknowledgement refreshes the
  // probes instead of making a reconnect part of installation.
  z.object({ type: z.literal("heartbeat_ack"), runtime_probes: z.array(RuntimeProbeSchema).optional() }),
  z.object({ type: z.literal("error"), detail: z.string() }),
  HostLaunchFrameSchema,
  z.object({ type: z.literal("terminate"), run_id: IdSchema, force: z.boolean() }),
  z.object({ type: z.literal("stdin"), run_id: IdSchema, value: z.string() }),
  z.object({ type: z.literal("stdin_close"), run_id: IdSchema }),
  z.object({ type: z.literal("list_dirs"), request_id: IdSchema, path: z.string().nullable() }),
  z.object({ type: z.literal("workspace_register"), request_id: IdSchema, path: z.string(), project_id: IdSchema, name: z.string() }),
  z.object({ type: z.literal("workspace_forget"), request_id: IdSchema, workspace_id: z.string() }),
  z.object({ type: z.literal("managed_workspace_archive"), ...managedWorkspaceActionFields }),
  z.object({ type: z.literal("managed_workspace_restore"), ...managedWorkspaceActionFields }),
  HostInstallToolFrameSchema,
  HostUninstallToolFrameSchema,
  HostLoginOpenFrameSchema,
  z.object({ type: z.literal("login_input"), session_id: IdSchema, data: z.string() }),
  z.object({ type: z.literal("login_close"), session_id: IdSchema }),
  HostAmbientImportFrameSchema,
  HostFolderReadFrameSchema,
]);
export type HostServerFrame = z.infer<typeof HostServerFrameSchema>;
export type HostServerFrameOf<T extends HostServerFrame["type"]> = Extract<HostServerFrame, { type: T }>;

// ---------------------------------------------------------------------------
// Daemon → control plane
// ---------------------------------------------------------------------------

/** `hello` and `heartbeat` carry the whole `HostHelloInfo`; the daemon's `helloInfo()` is typed as it. */
export const HostHelloFrameSchema = HostHelloInfoSchema.extend({ type: z.literal("hello"), token: z.string() });
export const HostHeartbeatFrameSchema = HostHelloInfoSchema.extend({ type: z.literal("heartbeat") });

export const HostDaemonFrameSchema = z.discriminatedUnion("type", [
  HostHelloFrameSchema,
  HostHeartbeatFrameSchema,
  /** The child process is registered; `stdin` frames may follow. */
  z.object({ type: z.literal("launched"), run_id: IdSchema, launch_id: IdSchema }),
  z.object({ type: z.literal("output"), run_id: IdSchema, launch_id: IdSchema, chunk: z.string() }),
  z.object({ type: z.literal("stderr"), run_id: IdSchema, launch_id: IdSchema, chunk: z.string() }),
  z.object({
    type: z.literal("complete"),
    run_id: IdSchema,
    launch_id: IdSchema,
    exit_code: z.number(),
    timed_out: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({ type: z.literal("login_output"), session_id: IdSchema, data: z.string() }),
  z.object({ type: z.literal("login_exit"), session_id: IdSchema, exit_code: z.number(), logged_in: z.boolean().nullable() }),
  /** One frame per session: a folder's history is megabytes even trimmed. */
  z.object({ type: z.literal("ambient_import_session"), request_id: IdSchema, session: AmbientSessionImportSchema }),
  z.object({
    type: z.literal("ambient_import_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    error: z.string().nullable(),
    session_count: z.number().int().min(0),
    /** What the runtime still holds for the folder; null when the enumeration was inconclusive. */
    listed_session_ids: z.array(z.string()).nullable(),
  }),
  /**
   * Shape only. `result` is validated by the server against the folder-read
   * limits and path policy, which is policy rather than wire shape.
   */
  z.object({
    type: z.literal("folder_read_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    kind: FolderReadKindSchema.optional(),
    result: z.unknown().optional(),
    error: FolderReadDaemonErrorSchema.optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("list_dirs_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    path: z.string().nullable(),
    parent: z.string().nullable(),
    dirs: z.array(z.string()),
    truncated: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("workspace_register_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    workspace_id: z.string().nullable(),
    display_path: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("workspace_forget_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    changed: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("managed_workspace_result"),
    request_id: IdSchema,
    action: z.enum(["archive", "restore"]),
    ok: z.boolean(),
    changed: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("tool_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    error: z.string().nullable(),
    installation: z.string().nullable(),
  }),
]);
export type HostDaemonFrame = z.infer<typeof HostDaemonFrameSchema>;
export type HostDaemonFrameOf<T extends HostDaemonFrame["type"]> = Extract<HostDaemonFrame, { type: T }>;
