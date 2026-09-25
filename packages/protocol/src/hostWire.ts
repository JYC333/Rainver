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
import { IdSchema, ISODateTimeSchema } from "./common.js";
import {
  AmbientSessionCountSchema,
  AmbientSessionImportSchema,
  AmbientTrimLimitsSchema,
} from "./ambientSessions.js";
import { LaunchWorkspaceSchema, LocationLaunchWorkspaceSchema, ManagedWorkspaceHeartbeatSchema, RuntimeAuthMethodSchema } from "./hosts.js";
import { ConversationInputResourceSchema } from "./conversationInput.js";
import { RuntimeKeySchema } from "./runtimeAuthority.js";

/**
 * The most a single `login_input` frame may carry. Keystrokes are bytes; a
 * pasted key or code is well under this, and anything larger is not typing.
 * Enforced by the server route (413) and by the daemon's frame schema, so
 * neither end relies on the other.
 */
export const LOGIN_INPUT_MAX_CHARS = 4096;

/**
 * The login PTY grid. The daemon sizes the terminal to this before the
 * login command starts and the browser renders the same grid, so vendor
 * pickers wrap and place their cursor identically at both ends. A classic
 * 24-row terminal: tall enough for every vendor's login and device-code
 * screens, short enough that the panel does not push the host card off the
 * page. Wrapped URLs stay clickable (the web-links addon follows wraps).
 */
export const LOGIN_TERMINAL_COLS = 120;
export const LOGIN_TERMINAL_ROWS = 24;

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
  /** The vendor's logout, in the same two forms; absent when the CLI has none. */
  logout_command: z.array(z.string()).optional(),
  managed_logout_command: z.array(z.string()).optional(),
  home_subdir: z.string(),
  credential_file: z.string(),
  /**
   * How the credential file lists accounts, for a CLI that holds several
   * (OpenCode): a JSON object keyed by provider id whose values carry a
   * `type`. Only ids and types are ever read from it, never secrets.
   */
  accounts_format: z.literal("json_object_by_provider").optional(),
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
  runtime_key: RuntimeKeySchema,
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
});
export type HostHelloInfo = z.infer<typeof HostHelloInfoSchema>;

/**
 * The runtime profile this run's CLI lives in, and the model backend binding
 * when there is one.
 *
 * Every host-bound Agent run carries this frame, including a run with no
 * ModelProvider: the CLI's own state root — its login, its sessions, its
 * auto-memory — is the profile rather than the machine's `~/.claude` or
 * `~/.codex`, which is what keeps two Agents on one machine, and one Agent in
 * two Rooms, from sharing what the runtime remembers. An unbound run's frame
 * carries no `files` and no `env`, only `profile_env` and `login_link`.
 */
export const HostLaunchProviderBindingSchema = z.object({
  /**
   * `agents/<agent_id>/<container_kind>/<container_id>/<runtime_key>/<provider_id|ambient>`:
   * which profile directory on the host the runtime uses. The container is the
   * Conversation for a Room turn, the owner for a direct chat, and the
   * WorkspaceLocation for everything else.
   */
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
  /**
   * Where this run's credential comes from, and therefore how much of the
   * machine the daemon may leave in place.
   *
   * `provider_lease` — the control plane chose the backend, so B67 applies in
   * full: the executing machine contributes nothing to which backend,
   * credential or upstream the runtime reaches, and its environment is
   * filtered to an allowlist.
   *
   * `host_login` — the run uses the machine's own login, reached through the
   * link below. B67's closing rule stands: a run with no binding keeps the
   * machine's environment, so `~/.gitconfig`, `~/.ssh/config` and the proxy
   * variables a paired machine needs are still there. What the profile
   * replaces is only the runtime's *state root*.
   */
  credential_source: z.enum(["provider_lease", "host_login"]),
  /**
   * For a `host_login` run: which file to link out of this installation's
   * login home into the profile, so one login per host × installation serves
   * every Agent profile on it. The daemon links it and never reads its
   * contents (ADR 0008). Null for a provider-bound run, which carries its
   * lease configuration in `files` and needs no login.
   */
  login_link: z.object({
    home_subdir: z.string().min(1),
    credential_file: z.string().min(1),
  }).nullable(),
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
  /** Only populated for a built-in Host; relative to its shared workspace root. */
  workspace_relative_path: z.string().trim().min(1).max(4096).optional(),
});
export type HostLaunchWorkspaceAccess = z.infer<typeof HostLaunchWorkspaceAccessSchema>;

/**
 * The isolation a **strict** host applies to this Run.
 *
 * A trusted (paired) host ignores it: its whole trust model is that the owner
 * already extends this machine the trust a native process has (B62). A strict
 * host — the built-in host inside `sandbox-runner` — wraps every Run in a
 * bubblewrap namespace, and these two values are the policy the control plane
 * owns: how the workspace is bound, and whether the namespace gets a network
 * at all. Everything else about the namespace is derived on the host, because
 * only the host knows its own paths (B64).
 *
 * Omitted, a strict host falls closed on both axes: a read-only workspace and
 * no network at all. A dispatch that needs either says so; one that forgot to
 * fails visibly rather than quietly receiving the container's network.
 */
export const HostLaunchIsolationSchema = z.object({
  sandbox_mode: z.enum(["read_only", "read_write"]),
  /**
   * What this Run may reach on the network.
   *
   * - `none` — no network at all. The namespace is unshared, so this is the
   *   only profile that *confines* rather than directs.
   * - `default` — the general web and git, through the host's egress proxy.
   *   Package registries are refused with a reason the runtime can print.
   * - `install` — `default` plus package registries, for a Run that was
   *   granted them (ADR 0017's exposure row).
   *
   * `default` and `install` point the Run at the proxy with `HTTP_PROXY`,
   * which every vendor CLI, git and package manager honours and a process
   * that opens its own socket does not. They are policy and a record, not
   * containment; the proxy's private-range refusal is the one part that holds
   * regardless, because the proxy declines rather than the client.
   */
  egress_profile: z.enum(["none", "default", "install"]),
});
export type HostLaunchIsolation = z.infer<typeof HostLaunchIsolationSchema>;

/** Admin-selected public route for built-in Host Runs and verified runtime downloads. */
export const HostEgressTransportSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct") }),
  z.object({ mode: z.literal("system_tun") }),
  z.object({
    mode: z.literal("http_proxy"),
    proxy_url: z.string().url(),
    no_proxy: z.string().nullable(),
  }),
]);
export type HostEgressTransport = z.infer<typeof HostEgressTransportSchema>;

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

/** Errors returned by the explicit, user-initiated File-page write channel. */
export const FolderWriteDaemonErrorSchema = z.enum([
  "location_unknown",
  "path_forbidden",
  "not_found",
  "is_directory",
  "too_large",
  "not_text",
  "stale",
  "write_failed",
]);
export type FolderWriteDaemonError = z.infer<typeof FolderWriteDaemonErrorSchema>;

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
  /** Logical conversation file refs; the daemon resolves them to local paths. */
  input_resources: z.array(ConversationInputResourceSchema).max(8).optional(),
  argv: z.array(z.string()),
  stdin: z.string().nullable().optional(),
  timeout_seconds: z.number().nullable().optional(),
  /** A bidirectional-protocol run streams `stdin` frames over its lifetime; the daemon must not close stdin after launch. */
  keep_stdin_open: z.boolean().optional(),
  /** Which copy of the runtime: `own` or `managed:<version>`. */
  installation: z.string().optional(),
  runtime_key: RuntimeKeySchema.optional(),
  provider_binding: HostLaunchProviderBindingSchema.optional(),
  /**
   * How this run calls back into Rainver: its identity, the control-plane
   * address to use it at, and the Skill that says how. Runtime-agnostic on
   * purpose — environment and one file, with no branch on which agent runs.
   */
  work_surface: HostLaunchWorkSurfaceSchema.optional(),
  /** Namespace policy for a strict host; ignored by a trusted one. */
  isolation: HostLaunchIsolationSchema.optional(),
  /** Instance-admin-selected public route for a strict host; ignored by a trusted one. */
  egress_transport: HostEgressTransportSchema.optional(),
});
export type HostLaunchFrame = z.infer<typeof HostLaunchFrameSchema>;
/** What a dispatcher supplies; the registry adds `type`, `run_id` and the `launch_id` nonce. */
export type HostLaunchPayload = Omit<HostLaunchFrame, "type" | "run_id" | "launch_id">;

/**
 * A fixed command the control plane runs in a Run's workspace on this host.
 *
 * The Verification Engine is the only sender: a verification recipe is a
 * server-side definition, and the daemon executes what it is handed rather
 * than choosing anything. That makes
 * the boundary a server-side one, unlike `login_open`, where the command comes
 * from the adapter spec and the daemon builds it: nothing in a frame may name a
 * command the control plane did not define, and the routes that send this are
 * the enforcement point.
 *
 * It is deliberately not a `launch`: there is no runtime, no session, no
 * provider binding and no work surface, and it answers once with the whole
 * output instead of streaming. A strict host still wraps it in a namespace —
 * verification asks questions *about* a Run's workspace and has no more right
 * to the machine than the Run did.
 */
export const HostCommandRunFrameSchema = z.object({
  type: z.literal("command_run"),
  request_id: IdSchema,
  /** Whose workspace to run in; resolved on the host, like every other path. */
  workspace: LaunchWorkspaceSchema.optional(),
  workspace_location_id: IdSchema.optional(),
  /**
   * Which Run this asks about, for correlation in host logs. A `workspace`
   * carrying `worktree` runs the command in that Task's worktree instead of
   * the Location — or in the Location when the Task has none there, as when
   * its Run fell back to running in place. The command's scratch HOME is its
   * own either way.
   */
  run_id: IdSchema.optional(),
  /**
   * Run in a throwaway directory the daemon makes for this request instead of
   * a workspace, for a question about an installed copy rather than about
   * anyone's work.
   */
  scratch_workspace: z.boolean().optional(),
  /**
   * Run the installed copy of this adapter rather than a command on PATH. The
   * daemon resolves the executable from that copy's manifest and appends
   * `command` as its arguments — so the thing that runs is one the daemon
   * installed, and the control plane names only the arguments.
   */
  runtime_key: RuntimeKeySchema.optional(),
  installation: z.string().min(1).optional(),
  /** A managed runtime whose read-only tree should be visible; unlike `runtime_key`, this does not alter `command`. */
  runtime_tree_key: RuntimeKeySchema.optional(),
  runtime_installation: z.string().min(1).optional(),
  command: z.array(z.string().min(1)).min(1),
  stdin: z.string().nullable().optional(),
  timeout_seconds: z.number().positive(),
  isolation: HostLaunchIsolationSchema.optional(),
});

/**
 * What one copy's subscription has left.
 *
 * Asked of the host because that is where the login is: a subscription's quota
 * is readable only with the credential the copy holds, and the whole point of
 * keeping credentials with the copy (ADR 0016 §7) is that nothing brokers them
 * back here. The daemon answers with numbers — never the token, never the
 * credential file — and the control plane caches them beside the copy.
 */
export const HostUsageProbeFrameSchema = z.object({
  type: z.literal("usage_probe"),
  request_id: IdSchema,
  runtime_key: RuntimeKeySchema,
  installation: z.string().min(1),
  /**
   * Where this runtime keeps its credential inside a login home. The daemon
   * has it in a managed copy's manifest but not for the machine's own
   * installation, and the adapter spec is the source either way.
   */
  login: RuntimeLoginSpecSchema.nullable(),
  timeout_seconds: z.number().positive(),
});

/**
 * A Task's worktree, named by the Location it belongs to. Only a Location
 * workspace has one; `worktree.task_id` says which Task's.
 */
export const HostTaskWorkspaceSchema = LocationLaunchWorkspaceSchema.extend({
  worktree: z.object({ task_id: IdSchema, merge_id: IdSchema.optional() }),
});
export type HostTaskWorkspace = z.infer<typeof HostTaskWorkspaceSchema>;

/** Git's identity for a commit the system writes: `name <email>`. */
export const HostGitIdentitySchema = z.object({
  name: z.string().trim().min(1).max(256),
  email: z.string().trim().min(1).max(320),
});
export type HostGitIdentity = z.infer<typeof HostGitIdentitySchema>;

/**
 * End one Task Run in its Task's worktree (ADR 0016 §11): commit everything
 * the Run left since its start commit — the Agent's own commits and whatever
 * it left uncommitted — as one unsigned commit on the Task branch, with
 * `author` as author and committer and `message` verbatim, then remove the
 * worktree. The branch stays for the Task's next Run and its merge.
 *
 * Sent after the Run's verification, which reads the worktree. Idempotent per
 * `run_id`: a settle for a Run already settled answers with what the first
 * one did.
 */
export const HostTaskRunSettleFrameSchema = z.object({
  type: z.literal("task_run_settle"),
  request_id: IdSchema,
  workspace: HostTaskWorkspaceSchema,
  run_id: IdSchema,
  author: HostGitIdentitySchema,
  message: z.string().min(1).max(16_000),
});

/**
 * The Task is gone (cancelled or deleted): remove its worktree, if one is
 * left, and its branch. Answers `deleted: false` when neither existed, which
 * is success.
 */
export const HostTaskBranchDeleteFrameSchema = z.object({
  type: z.literal("task_branch_delete"),
  request_id: IdSchema,
  workspace: HostTaskWorkspaceSchema,
});

/** A 40- or 64-hex git object id. */
const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);

/**
 * Merging a done Task's branch into the main branch (ADR 0016 §11), in the
 * Task's worktree, one merge at a time per Task: the daemon records the
 * `merge_id` in progress and neither sweeps nor starts an ordinary Run in a
 * worktree a merge holds.
 *
 * `task_merge_prepare` squashes everything the branch has since its merge
 * base with the main branch into one unsigned commit (`author` as author and
 * committer, `message` verbatim) and merges it onto the main branch's tip —
 * `git merge-tree`, never git's sequencer, whose state files a Run could
 * write. Clean, the merged tree becomes the Task commit on that tip
 * (`rebased`). A conflict writes the merged files, markers included, into the
 * worktree with the branch left on the squashed commit, for
 * `task_merge_continue` or `task_merge_abort`. Idempotent per `merge_id`:
 * repeated while that conflict is waiting, it answers it again; after the
 * main branch moved, it merges again.
 */
export const HostTaskMergePrepareFrameSchema = z.object({
  type: z.literal("task_merge_prepare"),
  request_id: IdSchema,
  workspace: HostTaskWorkspaceSchema,
  merge_id: IdSchema,
  author: HostGitIdentitySchema,
  message: z.string().min(1).max(16_000),
});

/**
 * After a resolution Run: take only the conflicted paths from the worktree
 * onto the merged tree, refuse (`unresolved`) while any still holds conflict
 * markers or a marker-less conflict is untouched, else commit the result as
 * the Task commit on the main branch's tip. Answers like `task_merge_prepare`,
 * never with `no_changes`.
 */
export const HostTaskMergeContinueFrameSchema = z.object({
  type: z.literal("task_merge_continue"),
  request_id: IdSchema,
  workspace: HostTaskWorkspaceSchema,
  merge_id: IdSchema,
});

/**
 * Give the merge up to the person: the branch goes back to the Task's single
 * squashed commit, to be merged by hand, the worktree is reset, and the merge
 * releases it.
 */
export const HostTaskMergeAbortFrameSchema = z.object({
  type: z.literal("task_merge_abort"),
  request_id: IdSchema,
  workspace: HostTaskWorkspaceSchema,
  merge_id: IdSchema,
});

/**
 * Move the main branch to the verified Task commit, by fast-forward only.
 *
 * When the Location's checkout has the main branch checked out, the daemon
 * takes the Location's lease (answering `location_busy` while a writer holds
 * it), compares the files the Task commit changes against the person's
 * uncommitted changes (`waiting_local_changes` with the overlap when any
 * overlap), and runs `merge --ff-only`. Otherwise it moves the branch by
 * compare-and-swap from `onto_commit`. Either way a main branch no longer at
 * `onto_commit` answers `main_moved`, and nothing changes. On `merged` the
 * Task branch and its worktree are removed.
 */
export const HostTaskMergeFinishFrameSchema = z.object({
  type: z.literal("task_merge_finish"),
  request_id: IdSchema,
  workspace: HostTaskWorkspaceSchema,
  merge_id: IdSchema,
  main_branch: z.string().min(1).max(4096),
  onto_commit: GitObjectIdSchema,
  task_commit: GitObjectIdSchema,
});

/** What `task_merge_prepare` and `task_merge_continue` answer. */
export const HostTaskMergeStepResultSchema = z.object({
  type: z.literal("task_merge_step_result"),
  request_id: IdSchema,
  ok: z.boolean(),
  /**
   * `rebased` — the Task commit sits on the main branch's tip;
   * `conflict` — the merge stopped on conflicts (`conflicted_files`); `unresolved` — a
   * continue found files still unmerged or holding markers; `no_changes` —
   * the branch holds nothing the main branch lacks (or is gone).
   */
  outcome: z.enum(["rebased", "conflict", "unresolved", "no_changes"]).nullable(),
  main_branch: z.string().min(1).max(4096).nullable(),
  onto_commit: GitObjectIdSchema.nullable(),
  task_commit: GitObjectIdSchema.nullable(),
  conflicted_files: z.array(z.string().max(4096)).max(500),
  error: z.string().nullable(),
});

/** The shape the control plane already caches; `available: false` with a reason is a real answer. */
export const HostUsageQuotaSchema = z.object({
  available: z.boolean(),
  session_pct: z.number().nullable(),
  session_resets: z.string().nullable(),
  week_pct: z.number().nullable(),
  week_resets: z.string().nullable(),
  error: z.string().nullable(),
});
export type HostUsageQuota = z.infer<typeof HostUsageQuotaSchema>;

/**
 * Undoes the last upgrade of one managed copy, by promoting the version kept
 * behind it. Carries no version: the daemon holds exactly one rollback target
 * (ADR 0016 §9), and naming one here would let the control plane ask for a
 * directory it cannot see.
 */
export const HostRollbackToolFrameSchema = z.object({
  type: z.literal("rollback_tool"),
  request_id: IdSchema,
  runtime_key: RuntimeKeySchema,
});

export const HostInstallToolFrameSchema = z.object({
  type: z.literal("install_tool"),
  request_id: IdSchema,
  runtime_key: RuntimeKeySchema,
  version: z.string().min(1),
  distribution: RuntimeDistributionSchema,
  login: RuntimeLoginSpecSchema.nullable(),
  /** Fixed argv for reading the bundled vendor CLI version after installation. */
  runtime_version_command: z.array(z.string()).nullable().optional(),
  /** The daemon must complete this protocol's health handshake before activation. */
  health_check_protocol: z.enum(["acp"]).nullable().optional(),
  /** Instance-admin-selected network route for built-in host artifact downloads. */
  egress_transport: HostEgressTransportSchema.optional(),
});
export const HostUninstallToolFrameSchema = z.object({
  type: z.literal("uninstall_tool"),
  request_id: IdSchema,
  runtime_key: RuntimeKeySchema,
  version: z.string().min(1),
});
export const HostLoginOpenFrameSchema = z.object({
  type: z.literal("login_open"),
  session_id: IdSchema,
  runtime_key: RuntimeKeySchema,
  installation: z.string().min(1),
  login: RuntimeLoginSpecSchema.nullable(),
  /** Normal ACP launch program; required when a machine-owned copy uses ACP auth. */
  argv: z.array(z.string()).optional(),
  /** Selected from this installation's last ACP initialize response. */
  auth_method: RuntimeAuthMethodSchema.nullable().optional(),
  /** Rainver-owned fixed actions (CLI login, or the vendor's logout); mutually exclusive with `auth_method`. */
  login_action: z.enum(["cli", "logout"]).nullable().optional(),
});
export const HostAmbientImportFrameSchema = z.object({
  type: z.literal("ambient_import"),
  request_id: IdSchema,
  workspace_location_id: IdSchema,
  runtime_key: RuntimeKeySchema,
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
  /** Explicit user action may request a decoded UTF-16 conversion preview. */
  include_utf16_preview: z.boolean().optional(),
});
export const HostFolderReadCancelFrameSchema = z.object({
  type: z.literal("folder_read_cancel"),
  request_id: IdSchema,
});
/**
 * Direct File-page mutation. The daemon resolves the Location id to its own
 * registered root; an absolute path never crosses the control-plane wire.
 * `content: null` is a delete, used only when restoring a previously-created
 * file during rollback.
 */
export const HostFolderWriteFrameSchema = z.object({
  type: z.literal("folder_write"),
  request_id: IdSchema,
  workspace_location_id: IdSchema,
  path: z.string(),
  content: z.string().nullable(),
  expected_exists: z.boolean(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  protected: z.boolean(),
  allow_encoding_conversion: z.boolean().optional(),
  restore_encoding: z.enum(["utf8", "utf16le", "utf16be"]).optional(),
});
const managedWorkspaceActionFields = {
  request_id: IdSchema,
  agent_id: IdSchema,
  container_kind: ManagedWorkspaceContainerKindSchema,
  container_id: IdSchema,
  /**
   * Whether the shared container directory goes with the Agent's own profile.
   *
   * A Conversation's managed workspace is shared by every Agent in it, so one
   * Agent leaving a Room archives only that Agent's profile; the workspace
   * follows when the last one leaves. A direct chat has one Agent, so both
   * always move together — and a Conversation running on a registered
   * WorkspaceLocation has no managed workspace to archive at all.
   */
  include_workspace: z.boolean(),
};

export const HostServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello_ack"), host_id: IdSchema, runtime_probes: z.array(RuntimeProbeSchema) }),
  // The catalog can change while a daemon stays connected (for example when
  // an ACP registry agent is enabled), so every acknowledgement refreshes the
  // probes instead of making a reconnect part of installation.
  z.object({ type: z.literal("heartbeat_ack"), runtime_probes: z.array(RuntimeProbeSchema).optional() }),
  z.object({ type: z.literal("error"), detail: z.string() }),
  HostLaunchFrameSchema,
  /**
   * Stop a Run. With `launch_id`, only that launch attempt — a queued one is
   * taken out of its Location's queue, a running one is signalled — so a stop
   * meant for an abandoned attempt never reaches a retry of the same run id.
   * Without it, every attempt of the run.
   */
  z.object({ type: z.literal("terminate"), run_id: IdSchema, force: z.boolean(), launch_id: IdSchema.optional() }),
  z.object({ type: z.literal("stdin"), run_id: IdSchema, value: z.string() }),
  z.object({ type: z.literal("stdin_close"), run_id: IdSchema }),
  z.object({ type: z.literal("list_dirs"), request_id: IdSchema, path: z.string().nullable() }),
  z.object({ type: z.literal("workspace_register"), request_id: IdSchema, path: z.string(), project_id: IdSchema, name: z.string() }),
  z.object({ type: z.literal("workspace_forget"), request_id: IdSchema, workspace_id: z.string() }),
  z.object({ type: z.literal("managed_workspace_archive"), ...managedWorkspaceActionFields }),
  z.object({ type: z.literal("managed_workspace_restore"), ...managedWorkspaceActionFields }),
  /**
   * "Clear this Agent's CLI memory on this host": archive every runtime
   * profile the Agent has on the machine — its logins, sessions and vendor
   * auto-memory — and touch no workspace. Owner-only, and paired with
   * retiring the Agent's vendor sessions through `session_reset` so the next
   * turn starts fresh rather than resuming into a profile that is gone.
   */
  z.object({ type: z.literal("agent_profiles_reset"), request_id: IdSchema, agent_id: IdSchema }),
  HostCommandRunFrameSchema,
  HostUsageProbeFrameSchema,
  HostRollbackToolFrameSchema,
  HostInstallToolFrameSchema,
  HostUninstallToolFrameSchema,
  HostLoginOpenFrameSchema,
  z.object({ type: z.literal("login_input"), session_id: IdSchema, data: z.string().max(LOGIN_INPUT_MAX_CHARS) }),
  z.object({ type: z.literal("login_close"), session_id: IdSchema }),
  HostAmbientImportFrameSchema,
  HostFolderReadFrameSchema,
  HostFolderReadCancelFrameSchema,
  HostFolderWriteFrameSchema,
  HostTaskRunSettleFrameSchema,
  HostTaskBranchDeleteFrameSchema,
  HostTaskMergePrepareFrameSchema,
  HostTaskMergeContinueFrameSchema,
  HostTaskMergeAbortFrameSchema,
  HostTaskMergeFinishFrameSchema,
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
  /**
   * The launch is queued behind another Run that may write the same
   * WorkspaceLocation; `launched` follows once that Run releases the
   * directory, or `complete` if this one is stopped while it waits.
   */
  z.object({ type: z.literal("waiting_for_workspace"), run_id: IdSchema, launch_id: IdSchema }),
  z.object({ type: z.literal("output"), run_id: IdSchema, launch_id: IdSchema, chunk: z.string() }),
  z.object({ type: z.literal("stderr"), run_id: IdSchema, launch_id: IdSchema, chunk: z.string() }),
  z.object({
    type: z.literal("complete"),
    run_id: IdSchema,
    launch_id: IdSchema,
    exit_code: z.number(),
    timed_out: z.boolean(),
    error: z.string().nullable(),
    /**
     * What this Run reached through the host's egress proxy, and what it was
     * refused. Reported on completion rather than streamed: it explains a Run
     * after the fact ("why did the install fail"), and a Run that reaches
     * nothing sends nothing. Absent on a paired host, which runs no proxy.
     */
    egress: z.array(z.object({
      allowed: z.boolean(),
      host: z.string(),
      port: z.number().int(),
      reason: z.string().nullable(),
      at: ISODateTimeSchema,
    })).max(200).optional(),
    /**
     * The Run executed in its Task's worktree: the Task branch and the commit
     * the worktree stood at when the Run's process started — the base its
     * git-backed verification compares against, and what `task_run_settle`
     * squashes from. Absent when the Run fell back to running in place.
     */
    task_worktree: z.object({
      branch: z.string().min(1).max(4096),
      start_commit: GitObjectIdSchema,
    }).optional(),
  }),
  z.object({
    type: z.literal("folder_write_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    path: z.string().optional(),
    exists: z.boolean().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
    size: z.number().int().nonnegative().optional(),
    line_count: z.number().int().nonnegative().optional(),
    error: FolderWriteDaemonErrorSchema.optional(),
    message: z.string().optional(),
  }),
  /**
   * One `command_run`'s whole result. Not streamed: a verification recipe is a
   * question with an answer, and its caller waits.
   */
  z.object({
    type: z.literal("command_result"),
    request_id: IdSchema,
    exit_code: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    timed_out: z.boolean(),
    error: z.string().nullable(),
    /** Present only when the request asked; the workspace's top-level names. */
    entries: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("usage_probe_result"), request_id: IdSchema, quota: HostUsageQuotaSchema }),
  /**
   * `commit` is the Run's commit on `branch`, null when the Run changed
   * nothing (no commit is written then; the worktree is removed either way).
   */
  z.object({
    type: z.literal("task_run_settle_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    branch: z.string().min(1).max(4096).nullable(),
    commit: GitObjectIdSchema.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("task_branch_delete_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    deleted: z.boolean(),
    error: z.string().nullable(),
  }),
  HostTaskMergeStepResultSchema,
  z.object({
    type: z.literal("task_merge_abort_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("task_merge_finish_result"),
    request_id: IdSchema,
    ok: z.boolean(),
    outcome: z.enum(["merged", "main_moved", "waiting_local_changes"]).nullable(),
    merged_commit: GitObjectIdSchema.nullable(),
    /** For `waiting_local_changes`: the person's uncommitted files the Task commit also changes. */
    overlapping_files: z.array(z.string().max(4096)).max(500),
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
    action: z.enum(["archive", "restore", "reset"]),
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

// ---------------------------------------------------------------------------
// Daemon → control plane, over HTTP
// ---------------------------------------------------------------------------

/**
 * Where the Run's checkout stood when it exited: `rev-parse --abbrev-ref HEAD`
 * and `rev-parse HEAD`, the same two reads a heartbeat reports for a Location.
 * The send gate of a Conversation compares a moved HEAD with this to tell a
 * commit its own Agent made from one somebody else made.
 */
export const HostRunGitAfterSchema = z.object({
  // Git takes branch names longer than any column here; a long one must not
  // cost the Run its diff (the server keeps what it can store).
  branch: z.string().max(4096).nullable(),
  head: z.string().min(1).max(128),
});
export type HostRunGitAfter = z.infer<typeof HostRunGitAfterSchema>;

/**
 * `POST /api/v1/hosts/me/runs/:runId/diff`: the Run's own change and where
 * its checkout stood. `git_before` is read after the Run holds its Location's
 * lease, just before its process starts; `git_after` after the diff at exit.
 * `diff` is null when no diff could be captured but the HEAD could; both git
 * fields are absent outside a git checkout and for a Run that executed in a
 * worktree of its own, whose HEAD is not the Location's.
 */
export const HostRunDiffUploadSchema = z.object({
  diff: z.string().nullable(),
  truncated: z.boolean().optional(),
  git_before: HostRunGitAfterSchema.optional(),
  git_after: HostRunGitAfterSchema.optional(),
});
export type HostRunDiffUpload = z.infer<typeof HostRunDiffUploadSchema>;
