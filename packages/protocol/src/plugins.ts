/**
 * Official Optional Module (plugin) wire contracts.
 *
 * These are shared, serializable types for the official plugin control plane.
 * No functions, no handlers, no transport logic. See
 * `.agent/architecture/OFFICIAL_OPTIONAL_MODULES.md`.
 *
 * Terminology note: "plugin" is the internal identifier used in code and the
 * API surface. "Official Optional Module" is the product-facing term. These
 * types describe official product modules developed by agent-space maintainers.
 * They are NOT third-party plugins.
 */

// ── Value sets ────────────────────────────────────────────────────────────────

/**
 * Category for grouping official optional modules in management UIs.
 * Does not affect routing or data isolation.
 */
export type OfficialPluginCategory =
  | "personal"
  | "household"
  | "team"
  | "knowledge"
  | "agent_work"
  | "system";

/**
 * Whether a plugin's enablement row is scoped to a space or to a user.
 *
 * space  → one enablement row per (plugin_id, space_id); space_id NOT NULL, user_id NULL
 *          Team/collaborative tools. Controlled by space admin.
 *
 * user   → one enablement row per (plugin_id, user_id); space_id NULL, user_id NOT NULL
 *          Personal tools (e.g. diary). Enabled once, works across all spaces.
 *          Data belongs to the user, not any specific space.
 */
export type OfficialPluginScope = "space" | "user";

/**
 * Lifecycle status of an official optional module descriptor.
 * Deprecated modules are still accessible but discouraged.
 */
export type OfficialPluginLifecycleStatus = "available" | "deprecated";

// ── Descriptor ────────────────────────────────────────────────────────────────

/**
 * Frontend entry registered in `apps/web/src/modules/registry.ts` for an
 * official optional module. Pure display/routing metadata — no component
 * reference (components are bundled statically, not described here).
 */
export interface OfficialPluginFrontendEntry {
  /** Must match the `Module.id` in the frontend registry. */
  module_id: string;
  /** Display label. */
  label: string;
  /** Route path (without space prefix). */
  path: string;
  /** Lucide icon name. */
  icon: string;
  /** Nav section. */
  section: string;
  /** Gallery group. */
  group: string;
}

/**
 * Serializable descriptor for an official optional module bundled with the
 * codebase. No functions. Registered in the static OfficialPluginRegistry.
 *
 * This is NOT a ServerModule. ServerModule is the internal code registration
 * unit. OfficialPluginDescriptor is the product-level control-plane object.
 */
export interface OfficialPluginDescriptor {
  /** Stable unique identifier. Snake_case. Max 128 chars. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description for management UIs. */
  description: string;
  /** Semver string. */
  version: string;
  category: OfficialPluginCategory;
  /**
   * Whether the module is enabled for new spaces/users without an explicit
   * enablement row. false = opt-in.
   */
  default_enabled: boolean;
  /**
   * Whether the gallery card / nav entry is shown by default, even when
   * disabled. true = visible but grayed out when disabled.
   */
  default_visible: boolean;
  scope: OfficialPluginScope;
  lifecycle_status: OfficialPluginLifecycleStatus;
  /** Frontend module entries this plugin contributes. */
  frontend_entries: OfficialPluginFrontendEntry[];
  /**
   * Backend feature string identifiers this plugin owns, if any.
   * These are informational; they do not affect route mounting.
   */
  backend_feature_ids: string[];
  /** Declared sensitive integrations. Used in UI and future permission gates. */
  permissions: {
    /** Plugin creates ActivityRecord entries. */
    creates_activity?: boolean;
    /** Plugin can generate memory proposals (which still require user approval). */
    can_propose_memory?: boolean;
    /**
     * Whether this plugin can contribute to context assembly.
     * "never"  → never contributes context.
     * "opt_in" → only when user has enabled context contribution in settings.
     * "always" → always contributes when enabled.
     */
    can_contribute_context?: "never" | "opt_in" | "always";
    /** Plugin calls AI/LLM APIs. */
    uses_ai?: boolean;
    /** Plugin registers scheduled tasks. */
    uses_scheduler?: boolean;
  };
  /**
   * Default values for settings_json keys. Stored in the enablement row.
   * Opaque JSON in MVP; a typed settings schema per plugin is future work.
   */
  settings_defaults: Record<string, unknown>;
}

// ── Effective state ───────────────────────────────────────────────────────────

/**
 * Effective enablement state for a plugin for the current space/user.
 * Computed by overlaying the DB enablement row on top of descriptor defaults.
 */
export interface OfficialPluginEffectiveState {
  plugin_id: string;
  /** Whether the plugin package has been installed on this instance. */
  installed: boolean;
  install_status?: "active" | "disabled" | "removed" | null;
  installed_version?: string | null;
  /** Whether the plugin has an explicit enablement row in the DB. */
  has_row: boolean;
  enabled: boolean;
  visible: boolean;
  /** Current resolved settings (defaults merged with stored overrides). */
  settings: Record<string, unknown>;
  enabled_at?: string | null;
  enabled_by_user_id?: string | null;
  disabled_at?: string | null;
  disabled_by_user_id?: string | null;
  updated_at?: string | null;
}

/**
 * List item combining descriptor + effective state.
 * Returned by GET /api/v1/plugins.
 */
export interface OfficialPluginListItem {
  descriptor: OfficialPluginDescriptor;
  effective: OfficialPluginEffectiveState;
}

/**
 * Response for GET /api/v1/plugins/effective.
 * Maps plugin_id → effective state. Used by frontend overlay.
 */
export type OfficialPluginEffectiveMap = Record<string, OfficialPluginEffectiveState>;

// ── Request types ─────────────────────────────────────────────────────────────

// ── Plugin guard error ────────────────────────────────────────────────────────

/** Error shape returned by the plugin guard when a plugin is not enabled. */
export interface PluginDisabledError {
  detail: string;
  error_code: "plugin_disabled" | "plugin_not_found" | "plugin_not_installed";
  plugin_id: string;
}

// ── Plugin Host API ───────────────────────────────────────────────────────────
//
// These types define the contract between the plugin host and plugin code.
// Official plugins (Level 1 built-in, Level 2 downloaded) use these interfaces
// to contribute routes, jobs, scheduler tasks, proposal appliers, and context
// providers to the running server. Activation is deliberately synchronous:
// plugin routes and contribution registrations must complete before the host
// installs the API catch-all and starts background workers.
//
// Plugins must not import server internals directly. All access goes through
// PluginHostContext.

/**
 * Minimal database interface for plugin domain queries.
 * Satisfied by pg.Pool without the plugin depending on the pg package.
 */
export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** Resolved caller identity from an HTTP request. */
export interface ResolvedIdentity {
  spaceId: string;
  userId: string;
}

/**
 * HTTP utilities provided by the host. Lets plugins handle auth and body
 * parsing without importing server internals.
 */
export interface PluginHttpPort {
  /**
   * Resolve the caller's identity from a Fastify request.
   * Sends 401/502 to reply and returns null on auth failure.
   */
  resolveIdentity(request: unknown, reply: unknown): Promise<ResolvedIdentity | null>;

  /**
   * resolveIdentity + check this plugin is enabled for the resolved user/space.
   * Sends 401/403/404 to reply and returns null if either check fails.
   */
  pluginGuard(request: unknown, reply: unknown): Promise<ResolvedIdentity | null>;

  /**
   * Send a standard error response. Re-throws unexpected errors so Fastify's
   * error handler can send a 500.
   */
  sendError(reply: unknown, err: unknown): void;

  /**
   * Parse a JSON object body from the request buffer.
   * Throws 422 if the body is not a valid JSON object.
   */
  parseJsonBody(request: unknown): Record<string, unknown>;
}

/** Envelope wrapping a job when it reaches a plugin job handler. */
export interface PluginJobEnvelope {
  job_id: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempt_number: number;
}

export type PluginJobResult = Record<string, unknown> | null | undefined;
export type PluginJobHandler = (job: PluginJobEnvelope) => Promise<PluginJobResult>;

/** Registered by plugins via ctx.jobs.register(). */
export interface PluginJobPort {
  /**
   * Register a job handler. The host wraps it with enablement gating: if the
   * plugin is disabled for the job's target user/space at dispatch time, the
   * job is skipped and returns { skipped: true, reason: 'plugin_disabled' }.
   */
  register(jobType: string, handler: PluginJobHandler): void;

  /**
   * Enqueue a background job. The host uses the server's job queue under the hood.
   * Fails if no database is configured.
   */
  enqueue(
    jobType: string,
    payload: Record<string, unknown>,
    opts?: { spaceId?: string; userId?: string },
  ): Promise<{ jobId: string }>;
}

/** Scheduled task contributed by a plugin. */
export interface PluginScheduledTask {
  /** Stable task name (unique within the server). Plugin id should be a prefix. */
  name: string;
  /** How often the task runs. */
  intervalSeconds: number;
  /** Whether to run once immediately on server start. */
  runOnStart?: boolean;
  /**
   * The task run function. For user-scoped plugins, the task is responsible
   * for querying all enabled users and performing work per-user. The host
   * does NOT gate a scheduled task wholesale (unlike job handlers, which
   * are per-identity), because tasks typically fan out across all enabled users.
   */
  run(): Promise<void>;
}

export interface PluginSchedulerPort {
  /** Register a recurring task. All tasks are registered before the scheduler starts. */
  register(task: PluginScheduledTask): void;
}

/** Context for a proposal applier contributed by a plugin. */
export interface PluginProposalContext {
  proposal: {
    id: string;
    proposal_type: string;
    space_id: string | null;
    user_id: string | null;
    payload: Record<string, unknown>;
  };
  db: Queryable;
  config: unknown;
}

export type PluginProposalApplier = (ctx: PluginProposalContext) => Promise<void>;

export interface PluginProposalPort {
  /**
   * Register a proposal applier. The host wraps it with enablement gating:
   * if the plugin is disabled for the proposal's space/user, the applier is
   * skipped with an error.
   */
  register(proposalType: string, applier: PluginProposalApplier): void;
}

/**
 * Full context passed to AgentSpacePlugin.activate().
 *
 * Official plugins (trusted, same-process) receive the raw Fastify instance
 * and a Queryable DB wrapper. Third-party plugins (future) will receive a
 * restricted proxy. Plugins MUST NOT import server internals (server/src/**)
 * directly — use this context instead.
 */
export interface PluginHostContext {
  /** Stable plugin id matching OfficialPluginDescriptor.id. */
  readonly pluginId: string;

  /**
   * Raw Fastify app for route registration. Use in activate() only.
   * Official plugins may register routes under their own path prefix.
   * Cast to FastifyInstance from the fastify package (peer dep).
   */
  readonly fastify: unknown;  // FastifyInstance at the implementation layer

  /**
   * Database queryable. Satisfies pg.Pool without the plugin importing pg.
   * Null-like (no-op) when no database is configured.
   */
  readonly db: Queryable;

  /** Check if this plugin is enabled for a given scope at runtime. */
  isEnabled(spaceId: string | null, userId: string | null): Promise<boolean>;

  /** HTTP utilities: auth, body parsing, error responses. */
  readonly http: PluginHttpPort;

  /** Contribution registries — plugin registers into these during activate(). */
  readonly jobs: PluginJobPort;
  readonly scheduler: PluginSchedulerPort;
  readonly proposals: PluginProposalPort;
}

/** Returned by a plugin after it has synchronously registered all contributions. */
export interface PluginActivationResult {
  activated: true;
}

/** Schema migration bundled with a plugin package. Run only by the installer. */
export interface PluginMigration {
  id: string;
  sql: string;
}

/**
 * Contract every official plugin runtime implements.
 *
 * Bundled official plugins implement this interface and are compiled into
 * server/dist/official-plugins before the server loads them at startup.
 * Downloaded plugins (Level 2) will use the same startup-load contract from
 * {AGENT_SPACE_HOME}/plugins/{id}/server/dist/index.js.
 */
export interface AgentSpacePlugin {
  /** Must match OfficialPluginDescriptor.id. */
  readonly id: string;
  /** Must match OfficialPluginDescriptor.version for built-in official plugins. */
  readonly version: string;
  /**
   * Plugin-owned schema migrations. These are never run during activate();
   * the installer/migration runner executes them before the plugin can be enabled.
   */
  readonly migrations?: readonly PluginMigration[];

  /**
   * Called once at server startup (after SERVER_MODULES are registered).
   * The plugin registers its routes, job handlers, scheduler tasks, and
   * proposal appliers into ctx. Must be idempotent and must not be async.
   */
  activate(ctx: PluginHostContext): PluginActivationResult;

  /**
   * Optional: called before server shutdown. Plugin should drain in-flight
   * work and release resources. Level 1 plugins may omit this.
   */
  deactivate?(ctx: PluginHostContext): Promise<void>;
}
