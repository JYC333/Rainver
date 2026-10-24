import { randomUUID } from "node:crypto";
import { REMOTE_CWD_PLACEHOLDER, WORK_SKILL_PATH_PLACEHOLDER, type HostEgressTransport, type HostLaunchIsolation, type InvocationDelivery, type LaunchWorkspace, type RunAdapterResultEnvelope, type RuntimeSemanticEvent, type RuntimeSessionConfigDroppedSelection as DroppedSessionConfigSelection } from "@rainver/protocol";
import type { ContentBlock } from "./cliConversationProtocol.js";
import type { CredentialSpendDeps } from "../policy/credentialSpend.js";
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import { AcpRuntimeAdapter } from "../runtimeAdapters/acpRuntimeAdapter.js";
import { PgRunRepository, type AgentRunRecord } from "./repository.js";
import { buildRunWorkSurface, type RunWorkSurface, type RunWorkSurfaceFrame } from "./runWorkSurface.js";
import { acpRuntimeContextPromptBlocks } from "./acpRuntimeContextPrompt.js";
import { RUN_QUIET_STATUS, stallTimeoutSeconds } from "./stallTimeout.js";
import { RUN_TIMED_OUT_ERROR_CODE } from "./runTimeLimit.js";
import { classifyRuntimeFailure } from "./retryPolicy.js";
import { workSkillPromptPointer } from "../skills/workSkill.js";
import { PgRunToolIdentityRepository } from "./runToolIdentityRepository.js";
import { assembleRunInputEnvelope } from "./runInputEnvelope.js";
import { CliRenderError, renderCliCommand } from "./cliCommandRendering.js";
import type { CliCommandExecutor, CliExecutionResult, CliProcessRegistry, CliStdioController } from "./localCliExecution.js";
import type { VendorCliRuntimeKey } from "../runtimeAdapters/specs.js";
import {
  acpSessionConfigFromRunOverride,
  withStrictHostSelections,
  withAcpModelSelection,
} from "./cliConversationProtocol.js";
import { createVendorEventNormalizer } from "./runtimeEventNormalization.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry, type HostRunCompletion } from "../hosts/connectionRegistry.js";
import { createThreadEventNormalizer, type ThreadEventDraft } from "../hosts/threadEventNormalization.js";
import { getDbPool } from "../../db/pool.js";
import { ConversationInputService } from "../sessions/conversationInputService.js";
import type { ServerConfig } from "../../config.js";
import type { ProviderProxyLeaseRegistry } from "../providers/proxy/lease.js";
import type { Queryable } from "../routeUtils/common.js";
import { managedHostEgressTransport, readInstanceOperationsPolicy } from "../settings/index.js";
import {
  boundAcpModelId,
  buildRemoteProviderBinding,
  buildUnboundRuntimeProfile,
  recordDroppedSessionConfig,
  recordRemoteRunBackend,
  recordRuntimeReportedModel,
  resolveRemoteRunBinding,
  resolveRuntimeProfileScope,
  RemoteProviderBindingError,
  type RemoteProviderBinding,
  type RemoteProviderBindingFrame,
  type ResolvedRemoteBinding,
  type RuntimeProfileScope,
} from "./remoteProviderBinding.js";

/**
 * CLI execution for a daemon Run (`executeRemoteHostCliAdapter`). Every
 * `local_cli` adapter is a daemon run: the built-in host or a paired
 * machine. Do not add a second CLI executor in the server process.
 *
 * The control plane prepares Runtime Context Delivery and sends it through
 * ACP. A host that uses its own login does not receive a server-brokered
 * credential. This path stages the `rainver` work surface and the Run-scoped
 * identity.
 *
 * `claude_code`, `opencode`, and `codex_cli` speak ACP through
 * `createCliConversationController` and the daemon's duplex `stdin` /
 * `stdin_close` frames. `codex_cli`'s adapter binary (`codex-acp`) is a
 * pinned dependency of `packages/host-daemon`. The daemon resolves and
 * spawns that bundled copy (`packages/host-daemon/src/execution.ts`). Do not
 * ask the host to install it.
 */
/**
 * The daemon knows the real workspace path for a
 * run (it resolved it to spawn the process); the server never does (ADR 0016
 * B64). An ACP session still needs to name its `cwd` — both as an argv token
 * (opencode's `headless_command_template`) and inside the controller's own
 * `session/new`/`session/resume` JSON-RPC params — so the server writes this
 * exact placeholder wherever a real path would go, and the daemon substitutes
 * its own resolved path before spawning / before writing to the child's
 * stdin (`packages/host-daemon/src/execution.ts`'s `REMOTE_CWD_PLACEHOLDER`,
 * which must stay textually identical to this literal — the two packages
 * share no dependency to enforce that at the type level).
 */
export const REMOTE_HOST_ACP_CWD_PLACEHOLDER = REMOTE_CWD_PLACEHOLDER;

interface RemoteHostCliAdapterInput {
  run: AgentRunRecord;
  prompt: string | null;
  invocation_delivery?: InvocationDelivery;
  model: string | null;
  resume_session_id: string | null;
  /**
   * Aborted when the Run's explicitly set time limit is reached
   * (`runTimeLimit.ts`); orchestration then stops the runtime. Absent when no
   * limit was set — there is no default one.
   */
  deadline_signal?: AbortSignal;
  /**
   * Aborted when the Run is stopped. A stop that lands while this dispatch is
   * still being prepared has no process to reach; this keeps it from launching.
   */
  cancel_signal?: AbortSignal;
  /** The dispatch's adapter settings; `stall_timeout_seconds` is read from it. */
  adapter_config?: Record<string, unknown>;
  runtime_event_sink?: (event: RuntimeSemanticEvent) => Promise<void> | void;
  /**
   * Normalized conversation events, persisted as frames arrive. Not a
   * post-hoc parse of accumulated stdout. `runtime_event_sink` / `run_events`
   * only reflect what the caller does with what has already resolved.
   */
  thread_event_sink?: (drafts: ThreadEventDraft[]) => Promise<void> | void;
  process_registry?: CliProcessRegistry;
  workspace?: LaunchWorkspace;
  workspace_access?: Array<{ workspace_location_id: string; access_mode: "read" | "write" }>;
  /**
   * How many Runs this host may execute at once, or null for no cap. Only the
   * built-in host has one; the caller knows which host this is, and looking it
   * up here would be a database read on every dispatch to learn a constant.
   */
  max_concurrent_runs?: number | null;
  /** Set only for a built-in-host Location; the daemon joins it under its own workspace root. */
  workspace_relative_path?: string | null;
}

/**
 * Which copy on the host this dispatch launches.
 *
 * The dispatch's own override first — Task dispatch pins a thread's copy that
 * way — then the runtime profile's, which is where every other surface records
 * it. Do not read only the override. A Room turn and a direct chat would
 * launch `own`: on a paired machine that is the owner's logged-in CLI, and on
 * the built-in host there is no vendor CLI on PATH. The usage ledger and the
 * quota cache would also disagree about which copy had run.
 */
export function dispatchInstallation(run: {
  model_override_json?: unknown;
  runtime_profile_snapshot_json?: unknown;
}): string {
  return runOverrideField(run.model_override_json, "installation")
    ?? snapshotField(run.runtime_profile_snapshot_json, "runtime_installation")
    ?? "own";
}

/** A field of the immutable runtime profile snapshot the router wrote for this Run. */
function snapshotField(snapshot: unknown, key: string): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A setting a dispatch asked for, as the admission stamped it on the Run. */
function runOverrideField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function chatTurnMessageId(value: unknown): string | null {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const turn = root.chat_turn && typeof root.chat_turn === "object" && !Array.isArray(root.chat_turn)
    ? root.chat_turn as Record<string, unknown>
    : {};
  // A handoff prepares the next vendor session before the person's turn. Its
  // Gateway current ref is the handoff Run, not the pending message.
  if (turn.schema_version !== "chat_turn.v1" || turn.kind === "handoff") return null;
  return typeof turn.user_message_id === "string" && turn.user_message_id.trim() ? turn.user_message_id : null;
}

function chatTurnRetryOfRunId(value: unknown): string | null {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const turn = root.chat_turn && typeof root.chat_turn === "object" && !Array.isArray(root.chat_turn)
    ? root.chat_turn as Record<string, unknown>
    : {};
  return typeof turn.retry_of_run_id === "string" && turn.retry_of_run_id.trim() ? turn.retry_of_run_id : null;
}

function chatTurnPromptCapabilities(value: unknown): {
  image: boolean | null;
  embedded_context: boolean | null;
  resource_link: boolean | null;
} {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const backend = root.conversation_backend && typeof root.conversation_backend === "object" && !Array.isArray(root.conversation_backend)
    ? root.conversation_backend as Record<string, unknown>
    : {};
  const capabilities = backend.prompt_capabilities && typeof backend.prompt_capabilities === "object" && !Array.isArray(backend.prompt_capabilities)
    ? backend.prompt_capabilities as Record<string, unknown>
    : {};
  return {
    image: typeof capabilities.image === "boolean" ? capabilities.image : null,
    embedded_context: typeof capabilities.embedded_context === "boolean" ? capabilities.embedded_context : null,
    resource_link: typeof capabilities.resource_link === "boolean" ? capabilities.resource_link : null,
  };
}


/**
 * The namespace and egress policy the control plane states for this Run.
 *
 * `sandbox_mode` is the workspace: a `read_only` Run gets a read-only
 * workspace, everything else read-write.
 *
 * Egress is `default` unless this Run was granted package installs — the
 * general web, git and the vendor the subscription belongs to, with package
 * registries refused.
 *
 * `install` widens that and comes only from the dispatch
 * (`model_override_json.egress_profile`), which the server composes and no
 * request body reaches. A standing grant on the Agent runtime profile is not
 * read: `runtime_config_json`
 * is free-form and `canWriteRuntimeProfiles` is a read predicate for an
 * ordinary Agent, so any member who can see the Agent could have widened what
 * its Runs reach. Granting `install` through the product needs an
 * authorization surface that does not exist yet — deferred register.
 *
 * Stated rather than omitted: an omitted policy falls closed on the daemon
 * side, which is right for a dispatch that forgot.
 */
export function dispatchIsolation(run: {
  required_sandbox_level?: string | null;
  model_override_json?: unknown;
}): HostLaunchIsolation {
  return {
    sandbox_mode: run.required_sandbox_level === "read_only" ? "read_only" : "read_write",
    egress_profile: dispatchEgressProfile(run),
  };
}

function dispatchEgressProfile(run: { model_override_json?: unknown }): HostLaunchIsolation["egress_profile"] {
  const perRun = runOverrideField(run.model_override_json, "egress_profile");
  return perRun === "none" || perRun === "install" || perRun === "default" ? perRun : "default";
}

export interface RemoteHostCliAdapterDeps {
  executor?: CliCommandExecutor;
  connectionRegistry?: HostConnectionRegistry;
  config?: ServerConfig;
  /** Overridden in tests; production uses the process-wide registry. */
  leaseRegistry?: ProviderProxyLeaseRegistry;
  /** Overridden in tests; production derives it from `config`. */
  db?: Queryable;
  /**
   * The Run executor's policy seam, which decides the lease's credential
   * spend. Production leaves it unset and the policy service decides.
   */
  policyEnforcer?: CredentialSpendDeps["enforcer"];
  /**
   * Which model backend this run uses, and where that fact is recorded. One
   * port rather than two switches, because they are the same subsystem: a
   * caller that can answer the first can record the second, and a caller that
   * can do neither must not silently proceed — guessing "unbound" would run on
   * the machine's own login while the control plane believed otherwise, which
   * is the substitution B67 forbids.
   *
   * Production derives this from `config`. A caller that genuinely has no
   * binding subsystem — a unit test of the protocol plumbing — says so by
   * passing `NO_PROVIDER_BINDINGS`.
   */
  bindings?: RemoteBindingPort;
}

export interface RemoteBindingPort {
  observeModel?(runId: string, spaceId: string, model?: string | null): Promise<void>;
  /** Saved session options the live session did not offer or apply; the runtime kept its default. */
  observeDroppedSessionConfig?(runId: string, spaceId: string, dropped: readonly DroppedSessionConfigSelection[]): Promise<void>;
  resolve(run: AgentRunRecord): Promise<ResolvedRemoteBinding | null>;
  record(runId: string, used: { provider_id: string; model: string | null } | null, spaceId: string): Promise<void>;
  /** Which Agent × container this run's CLI profile belongs to; never null — every host-bound run has one. */
  profileScope(run: AgentRunRecord, workspaceLocationId: string | null): Promise<RuntimeProfileScope>;
}

/**
 * For a caller with no bindings at all: every run is unbound, nothing
 * recorded. Its profile scope is derived from the Run alone, without the
 * `host_threads` lookup a real one does, so a protocol-plumbing test still
 * exercises a run that carries a profile rather than a special case that does
 * not.
 *
 * It refuses a run with no Location for the same reason the real resolver
 * does, rather than falling back to the run id: a per-run profile is deleted
 * along with the session the next turn is about to resume, and a stub that
 * quietly minted one would let a test pass on a shape production must never
 * produce.
 */
export const NO_PROVIDER_BINDINGS: RemoteBindingPort = {
  async resolve() { return null; },
  async record() {},
  async profileScope(run, workspaceLocationId) {
    if (!workspaceLocationId) return { agent_id: run.agent_id, container_kind: "agent", container_id: run.agent_id };
    return { agent_id: run.agent_id, container_kind: "location", container_id: workspaceLocationId };
  },
};

function databaseBindingPort(config: ServerConfig): RemoteBindingPort | null {
  if (!config.databaseUrl) return null;
  const db = getDbPool(config.databaseUrl);
  return {
    resolve: (run) => resolveRemoteRunBinding(db, run),
    observeModel: (runId, spaceId, model) => recordRuntimeReportedModel(db, runId, spaceId, model),
    observeDroppedSessionConfig: (runId, spaceId, dropped) => recordDroppedSessionConfig(db, runId, spaceId, dropped),
    record: (runId, used, spaceId) => recordRemoteRunBackend(db, runId, used, spaceId),
    profileScope: (run, workspaceLocationId) => resolveRuntimeProfileScope(db, run, workspaceLocationId),
  };
}

/**
 * Runs a Run on a paired execution host, and owns the lifetime of whatever
 * provider lease that run needed: whatever happens inside — success, failure,
 * timeout, a thrown error — the token the host was handed stops working when
 * this returns, rather than at its own TTL.
 */
export async function executeRemoteHostCliAdapter(
  input: RemoteHostCliAdapterInput,
  hostId: string,
  workspaceLocationId: string | null,
  deps: RemoteHostCliAdapterDeps = {},
): Promise<RunAdapterResultEnvelope> {
  const leases: Array<() => void> = [];
  try {
    return await runRemoteHostCliAdapter(input, hostId, workspaceLocationId, deps, leases);
  } finally {
    for (const revoke of leases) revoke();
    // Unconditional, and by Run rather than by token: every path out of this
    // function is a Run that has stopped executing, and a Run that was never
    // issued an identity simply matches no row. The tool surface must not
    // outlive the process that was allowed to use it.
    if (deps.config?.databaseUrl) {
      await new PgRunToolIdentityRepository(deps.db ?? getDbPool(deps.config.databaseUrl))
        .revoke(input.run.id)
        .catch(() => undefined);
    }
  }
}

async function runRemoteHostCliAdapter(
  input: RemoteHostCliAdapterInput,
  hostId: string,
  // A WorkspaceLocation id. The daemon wire frame uses the same
  // `workspace_location_id` field, and the daemon's local config maps that id
  // to the real directory on the owning machine.
  workspaceLocationId: string | null,
  deps: RemoteHostCliAdapterDeps,
  leases: Array<() => void>,
): Promise<RunAdapterResultEnvelope> {
  const startedAt = new Date().toISOString();
  const runtimeKey = input.run.runtime_key;
  const spec = getLocalCliRuntimeAdapterSpec(runtimeKey);
  if (!spec) {
    return remoteFailureWithEvent(input, runtimeKey ?? "unknown", "runtime_adapter_not_found", "Runtime adapter is not registered.", startedAt);
  }
  if (spec.implementation_status !== "implemented") {
    return remoteFailureWithEvent(input, spec.runtime_key, "runtime_adapter_not_implemented", `Runtime adapter '${runtimeKey}' is not executable.`, startedAt);
  }
  // This path runs ACP adapters. A spec whose protocol is not `acp` fails
  // closed here. Do not dispatch it.
  if (spec.invocation.protocol !== "acp") {
    return remoteFailureWithEvent(
      input,
      spec.runtime_key,
      "remote_execution_protocol_not_supported",
      `Runtime adapter '${spec.runtime_key}' requires a bidirectional session protocol and cannot run on a remote execution host yet.`,
      startedAt,
    );
  }

  // Every remote dispatch is workspace-bound (`dispatch` requires
  // `project_folder_id`) and the daemon's diff capture stages new files with
  // `git add --intent-to-add --all` before `git diff HEAD`, so a brand-new
  // file written into the workspace shows its full content in "Review diff".
  // Do not tell the agent to write ordinary work only to `$RAINVER_OUTPUT_DIR`.
  // The daemon still injects `RAINVER_OUTPUT_DIR` and uploads whatever lands
  // there. A structured channel for information meant for Rainver, distinct
  // from workspace file changes, is open in `tasks/deferred-register.md`.
  let prompt = input.prompt ?? input.run.prompt ?? "";
  const supplementalInstructions: string[] = [];
  // Preparation awaits the database and the provider lease. The Run's time
  // limit can pass, or a person can stop it, during any of it, and the stop
  // then finds no process to reach. So each step checks both signals itself,
  // and a Run stopped either way never launches — not even after
  // orchestration has already settled it.
  const stopRequested = () => input.deadline_signal?.aborted === true || input.cancel_signal?.aborted === true;
  const stoppedBeforeLaunch = async (): Promise<RunAdapterResultEnvelope> => {
    if (input.deadline_signal?.aborted) {
      await input.thread_event_sink?.([{ event_type: "status", status: "run_timeout" }]);
      return remoteFailure(
        spec.runtime_key,
        RUN_TIMED_OUT_ERROR_CODE,
        "The Run reached its time limit before its command was launched.",
        startedAt,
      );
    }
    return remoteFailureWithEvent(input, spec.runtime_key, "run_cancelled", "The Run was stopped before its command was launched.", startedAt);
  };

  let rendered;
  try {
    rendered = await renderCliCommand(spec, {
      executable: spec.executable.command,
      // An ACP invocation's headless_command_template carries no {prompt}
      // token — the prompt is sent later over session/prompt by the
      // controller, not embedded in argv.
      prompt: "",
      mode: "headless",
      // Model is applied via the controller's session/set_config_option for
      // ACP (renderCliCommand already skips the argv model flag for any
      // ndjson_rpc-strategy adapter); passing it here would be a no-op at
      // best and is omitted for clarity.
      model: null,
      // Do not use `renderCliCommand`'s permission-bypass gate. It requires a
      // server-known worktree path and a high or critical risk. This dispatch
      // has neither. The auto-approve flag is appended below.
      permission_bypass: false,
      risk_level: "low",
      project_folder_id: input.run.project_folder_id,
      sandbox_cwd: REMOTE_HOST_ACP_CWD_PLACEHOLDER,
      resume_session_id: input.resume_session_id,
      required_sandbox_level: null,
      // No server-local path exists to check, and faking one would not enforce
      // anything. This path does not write a deny config into the daemon workspace.
      skip_subagent_disable_check: true,
    });
  } catch (error) {
    return remoteFailureWithEvent(
      input,
      spec.runtime_key,
      error instanceof CliRenderError ? error.code : "cli_command_render_failed",
      error instanceof Error ? error.message : "CLI command render failed.",
      startedAt,
    );
  }

  if (stopRequested()) return stoppedBeforeLaunch();
  const argv = [...rendered.argv];
  if (spec.permissions.supports_permission_bypass && spec.permissions.permission_bypass_arg_template) {
    // Headless execution has no person to answer a permission prompt, so
    // this always passes the bypass arguments.
    argv.push(...spec.permissions.permission_bypass_arg_template);
  }

  const registry = deps.connectionRegistry ?? sharedHostConnectionRegistry;
  const threadEvents = createThreadEventNormalizer(spec.runtime_key);
  const runtimeEvents = createVendorEventNormalizer(spec.runtime_key);
  // A Run has no wall-clock deadline. Short-lived credentials are renewed
  // while execution is active and revoked on every terminal path.
  const credentialLifetimeSeconds = 900;

  // The control plane's choice of model backend for this run, if it made one.
  // Read the frozen Runtime Profile snapshot. Do not read
  // `runs.model_provider_id`. That column is the router's prediction until
  // execution records the binding.
  let providerBinding: RemoteProviderBinding | null = null;
  /** The provider this run actually executed against; null means the copy's own login. */
  let boundProviderId: string | null = null;
  // The frame that gives this run's CLI its own state root. A bound run's is
  // the binding above; an unbound one gets the same profile minus the lease,
  // so it reads its own login and its own vendor auto-memory rather than the
  // machine's `~/.claude`.
  let profileFrame: RemoteProviderBindingFrame | null = null;
  const config = deps.config;
  const bindings = deps.bindings ?? (config ? databaseBindingPort(config) : null);
  {
    try {
      if (!bindings) {
        throw new RemoteProviderBindingError(
          "provider_binding_unavailable",
          "Cannot determine this run's model backend: no binding port and no database connection.",
        );
      }
      const bound = await bindings.resolve(input.run);
      const scope = await bindings.profileScope(input.run, workspaceLocationId);
      if (bound) {
        if (!config) {
          throw new RemoteProviderBindingError(
            "provider_binding_unavailable",
            "This run is bound to a ModelProvider, but no server configuration was available to reach it.",
          );
        }
        providerBinding = await buildRemoteProviderBinding({
            config,
            run: input.run,
            hostId,
            runtimeKey: spec.runtime_key,
            binding: bound,
            scope,
            ttlSeconds: credentialLifetimeSeconds,
            leaseRegistry: deps.leaseRegistry,
            // Reads this host's kind and proxy override to resolve a proxy URL
            // it can actually reach. `config.databaseUrl` is proven
            // by `databaseBindingPort` having resolved the binding at all;
            // a test-supplied port must say which database it means.
            db: deps.db ?? getDbPool(config.databaseUrl!),
            enforcer: deps.policyEnforcer,
        });
        leases.push(providerBinding.revoke);
      }
      // An unbound Profile uses the runtime's own login, with a separate
      // profile directory for the Agent × container boundary.
      profileFrame = providerBinding?.frame
        ?? buildUnboundRuntimeProfile(spec.runtime_key, scope);
      // Make the Run row say what this run actually executes against — the
      // router may have predicted a different provider at run start, and usage
      // attributes to the one the lease names, not the one the row does.
      boundProviderId = bound && providerBinding ? bound.provider_id : null;
      await bindings.record(
        input.run.id,
        boundProviderId && providerBinding
          ? { provider_id: boundProviderId, model: providerBinding.used_model }
          : null,
        input.run.space_id,
      );
    } catch (error) {
      // Fail the run rather than silently executing on the machine's own
      // login: the user chose a backend and is owed the reason it could not
      // be used (B67).
      return remoteFailureWithEvent(
        input,
        spec.runtime_key,
        error instanceof RemoteProviderBindingError ? error.code : "provider_binding_failed",
        error instanceof Error ? error.message : "Could not prepare the selected model backend.",
        startedAt,
      );
    }
  }

  if (stopRequested()) return stoppedBeforeLaunch();

  // How this run reports back. Offered whenever the Run was granted any tool.
  // A Run granted nothing gets no command rather than one that would refuse
  // everything.
  //
  // The grants come from the Run's own persisted snapshot, the same source
  // `SystemActionDispatcher` enforces against — never from the dispatch
  // request, which does not carry one on this path.
  let workSurface: RunWorkSurface | null = null;
  if (assembleRunInputEnvelope(input.run).tool_grants.length > 0 && config?.databaseUrl) {
    try {
      workSurface = await buildRunWorkSurface({
        db: deps.db ?? getDbPool(config.databaseUrl),
        config,
        run: input.run,
        hostId,
        lifetimeSeconds: credentialLifetimeSeconds,
      });
    } catch (error) {
      return remoteFailureWithEvent(
        input,
        spec.runtime_key,
        "work_surface_unavailable",
        `Could not prepare this run's Rainver work surface: ${error instanceof Error ? error.message : String(error)}`,
        startedAt,
      );
    }
  }
  if (workSurface) {
    const identities = new PgRunToolIdentityRepository(deps.db ?? getDbPool(config!.databaseUrl!));
    const renewal = setInterval(() => {
      void identities.renew(input.run.id, workSurface!.frame.env.RAINVER_TOOL_TOKEN!, credentialLifetimeSeconds * 1000)
        .catch(() => undefined);
    }, 60_000);
    renewal.unref?.();
    leases.push(() => clearInterval(renewal));
    // An empty prompt stays empty. A pointer on its own would start a turn
    // nobody asked for. A resumed vendor session already holds the pointer
    // from its first turn and is sent nothing about it again.
    // The daemon substitutes the placeholder with the file's absolute path on
    // that machine (only it knows one); an unexpanded `$RAINVER_SKILL_PATH`
    // is a path a read_file tool cannot open.
    if (prompt && !input.resume_session_id) {
      const pointer = workSkillPromptPointer(WORK_SKILL_PATH_PLACEHOLDER, workSurface.options);
      if (input.invocation_delivery) supplementalInstructions.push(pointer);
      else prompt = `${prompt}\n\n${pointer}`;
    }
  } else if (assembleRunInputEnvelope(input.run).tool_grants.length > 0) {
    // Granted tools with no way to reach them. It is not worth failing the Run
    // — the work may still be worth doing — but it must not be silent: the
    // agent will finish without reporting anything and the Task will park with
    // no visible cause. The address is configuration, so this means the host
    // row or the server's database connection could not be resolved.
    void input.thread_event_sink?.([{
      event_type: "diagnostic",
      text: "This run was granted Rainver actions but could not be given a way to call them, so nothing it does will be reported back. The Host could not be resolved to a control-plane address.",
    }]);
  }

  if (stopRequested()) return stoppedBeforeLaunch();

  let promptBlocks: ContentBlock[][] | undefined;
  let hydratedBlocks: ContentBlock[] = [];
  let inputResources: Array<{
    input_id: string;
    workspace_location_id: string;
    relative_path: string;
    workspace_relative_path?: string;
    name: string;
    media_type: string;
    size_bytes: number;
  }> = [];
  // A delegated child inherits the parent's chat-turn routing metadata, but
  // its current input is its own Run request, including at the attachment edge.
  const messageId = input.run.delegation_id ? null : chatTurnMessageId(input.run.model_override_json);
  if (messageId) {
    if (!config?.databaseUrl) {
      return remoteFailureWithEvent(
        input,
        spec.runtime_key,
        "conversation_input_unavailable",
        "This run contains structured conversation input, but the server database is unavailable to hydrate it.",
        startedAt,
      );
    }
    try {
      const hydrated = await new ConversationInputService(
        deps.db ?? getDbPool(config.databaseUrl),
        config,
      ).loadPromptParts({
        spaceId: input.run.space_id,
        messageId,
        embeddedContext: chatTurnPromptCapabilities(input.run.model_override_json).embedded_context === true,
        useImmutableSnapshot: chatTurnRetryOfRunId(input.run.model_override_json) !== null,
        descriptorsInDelivery: Boolean(input.invocation_delivery),
        executionHostId: hostId,
      });
      hydratedBlocks = hydrated.blocks as ContentBlock[];
      if (hydrated.blocks.length > 0) {
        promptBlocks = [[
          ...(prompt ? [{ type: "text", text: prompt } as ContentBlock] : []),
          ...(hydrated.blocks as ContentBlock[]),
        ]];
      }
      inputResources = hydrated.resources;
    } catch (error) {
      return remoteFailureWithEvent(
        input,
        spec.runtime_key,
        "conversation_input_unavailable",
        error instanceof Error ? error.message : "Conversation input could not be prepared.",
        startedAt,
      );
    }
  }

  if (stopRequested()) return stoppedBeforeLaunch();

  if (input.invocation_delivery) {
    promptBlocks = [acpRuntimeContextPromptBlocks(
      input.invocation_delivery,
      hydratedBlocks,
      supplementalInstructions,
    )];
  }

  // Named here because the result envelope reports it too, and both must be
  // the same answer.
  const installation = dispatchInstallation(input.run);
  let strictHost: boolean;
  try {
    strictHost = await hostIsStrict(deps.config?.databaseUrl, hostId, deps.db);
  } catch (error) {
    // Not knowing is not "trusted". A built-in host taken for a paired machine
    // would launch without its strict session config and with direct egress
    // in place of the instance's managed route (B62); the Run fails instead.
    return remoteFailureWithEvent(
      input,
      spec.runtime_key,
      "host_trust_unavailable",
      `Could not read the execution host's trust mode: ${error instanceof Error ? error.message : String(error)}`,
      startedAt,
    );
  }
  const egressTransport = !deps.executor && strictHost && deps.config
    ? managedHostEgressTransport(await readInstanceOperationsPolicy(deps.config))
    : { mode: "direct" } satisfies HostEgressTransport;
  if (stopRequested()) return stoppedBeforeLaunch();
  const launchId = randomUUID();
  const executor = deps.executor ?? new RemoteWsCliCommandExecutor(
    hostId,
    workspaceLocationId,
    registry,
    profileFrame,
    installation,
    spec.runtime_key,
    skillWorkSurface(input.invocation_delivery, workSurface?.frame ?? null),
    withTaskWorktree(
      launchWorkspace(input.workspace, workspaceLocationId, input.workspace_relative_path ?? null),
      workspaceLocationId,
      input.run,
    ),
    input.workspace_access ?? [],
    inputResources,
    dispatchIsolation(input.run),
    egressTransport,
    input.max_concurrent_runs ?? null,
    launchId,
  );
  let stdoutText = "";
  // Provider binding is authoritative for a bound run. User-selected generic
  // ACP options travel independently in acp_session_config.
  const requestedModel = providerBinding?.used_model
    ?? runOverrideField(input.run.model_override_json, "model");
  const requestedSessionConfig = withStrictHostSelections(
    acpSessionConfigFromRunOverride(input.run.model_override_json),
    // Strict only. `dispatchIsolation` above says how the daemon binds the
    // workspace; this says what the runtime must not undo inside it. A paired
    // machine keeps its owner's own settings (B62, ADR 0016 section 3).
    strictHost ? spec.strict_session_config : undefined,
  );
  const runtimeModel = providerBinding
    ? boundAcpModelId(spec.runtime_key as VendorCliRuntimeKey, requestedModel)
    : null;
  // Clear the previous attempt's observation before launch; never present it as this attempt's model.
  await bindings?.observeModel?.(input.run.id, input.run.space_id);
  // The launch nonce is written on the Run's attempt before the frame leaves,
  // so the host's diff/output uploads — which name it — bind to this attempt
  // and to no other (D45). It is the last step before launch on purpose: the
  // bind requires an open attempt, so a Run already stopped (`cancelling`) or
  // settled — on this server process or another — refuses here. A test with
  // no database runs the protocol alone.
  if (deps.config?.databaseUrl) {
    const bound = await new PgRunRepository(deps.db ?? getDbPool(deps.config.databaseUrl))
      .bindAttemptLaunch({ space_id: input.run.space_id, run_id: input.run.id, launch_id: launchId });
    if (!bound && !input.deadline_signal?.aborted) {
      return remoteFailureWithEvent(input, spec.runtime_key, "run_cancelled", "The Run's attempt was closed before its command was launched.", startedAt);
    }
  }
  // Nothing below awaits before the executor dispatches, so neither signal
  // can be aborted unseen between this check and the launch.
  if (stopRequested()) return stoppedBeforeLaunch();
  let modelWrites = Promise.resolve();
  let modelWriteError: unknown;
  const stdioController = new AcpRuntimeAdapter(spec.runtime_key).createController({
    local_tool_directory: Boolean(workSurface),
    // A Delivery already contains the authoritative current input. Retaining
    // the pre-Gateway prompt as a fallback here would send it twice.
    prompt: input.invocation_delivery ? "" : prompt,
    cwd: REMOTE_HOST_ACP_CWD_PLACEHOLDER,
    // The backend the binding actually resolved, in this runtime's identifier
    // space — not `input.model`, which is the router's idea of a model and can
    // name one the bound provider does not serve. Null for Claude, whose model
    // is decided entirely by the environment the binding sets.
    //
    session_config: withAcpModelSelection(requestedSessionConfig, runtimeModel),
    // What the run executes against, which the server decided and does not
    // need to ask the host about. Without it, attribution reads the runtime's
    // echo: an alias for Claude (which is told no model at all), and the
    // `<provider>/<model>` form for OpenCode rather than the provider's own
    // model name.
    attributed_model: providerBinding?.used_model ?? null,
    runtime_session_id: input.resume_session_id,
    prompt_blocks: promptBlocks,
    on_thought_delta: (delta) => {
      const drafts = threadEvents.pushAcpThoughtDelta(delta);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
    on_text_delta: (delta) => {
      const drafts = threadEvents.pushAcpTextDelta(delta);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
    on_model_selected: (model) => {
      modelWrites = modelWrites.then(() => bindings?.observeModel?.(input.run.id, input.run.space_id, model))
        .catch(error => { modelWriteError = error; });
    },
    on_protocol_event: (event) => {
      for (const semanticEvent of runtimeEvents.push(event, new Date().toISOString())) {
        void input.runtime_event_sink?.(semanticEvent);
      }
      const drafts = threadEvents.pushAcpProtocolEvent(event);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
    // Makes the dispatch-preset pre-authorization a durable, visible fact on the
    // thread this Run belongs to. Reuses the `diagnostic` event type. Do not
    // add a new `host_thread_events` CHECK value. Keep it human-readable, not
    // a serialized JSON blob: `ThreadConversation.tsx`'s `DiagnosticsDrawer`
    // renders every `diagnostic` line verbatim and this fires on essentially every
    // tool-using turn.
    on_permission_decision: (record) => {
      void input.thread_event_sink?.([{
        event_type: "diagnostic",
        text: `Permission pre-authorized (${record.tool_kind ?? "tool"}): ${
          record.decision.outcome === "selected" ? "allowed" : "cancelled"
        }`,
      }]);
    },
  });
  void input.thread_event_sink?.([{ event_type: "status", status: "run_started" }]);
  const result = await executor.runCommand({
    command: argv,
    cwd: null,
    timeout_seconds: 0,
    deadline_signal: input.deadline_signal,
    cancel_signal: input.cancel_signal,
    // A quiet runtime may still be working. This only schedules a notice: a
    // structured status the conversation renders in the reader's language
    // (`turnProjection.ts`, `run_quiet`).
    stall_timeout_seconds: stallTimeoutSeconds(input.adapter_config),
    on_silence: async () => {
      await input.thread_event_sink?.([{ event_type: "status", status: RUN_QUIET_STATUS }]);
    },
    env: {},
    run_id: input.run.id,
    stdin: rendered.stdin,
    process_registry: input.process_registry,
    stdio_controller: stdioController,
    on_stdout_chunk: (chunk) => {
      // Fallback output_text when the controller never formed. See its doc
      // comment below.
      stdoutText += chunk;
    },
    on_stderr_chunk: (chunk) => {
      const drafts = threadEvents.pushStderr(chunk);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
  }).finally(async () => {
    await modelWrites;
    if (modelWriteError) throw modelWriteError;
  });
  const finalDrafts = threadEvents.finish();
  // Awaited (unlike the per-chunk pushes above): every event queued so far
  // must have actually committed before the terminal status event below is
  // written, so a caller polling the events endpoint right as it sees this
  // Run reach a terminal state never observes a truncated conversation.
  if (finalDrafts.length > 0) await input.thread_event_sink?.(finalDrafts);

  const completedAt = new Date().toISOString();
  // A protocol run's session id comes from the controller's own result(),
  // never from parsing raw stdout (which for ACP is JSON-RPC framing, not
  // vendor-structured output). `RemoteWsCliCommandExecutor` has already
  // folded the controller's completion state into
  // `result.returncode`/`result.stderr` by this point. A failed resume must
  // not return the requested stale id: the host-thread outcome hook uses a
  // null external id to clear the binding and permit a fresh session retry.
  // `stdioController` is only ever undefined when there were no prompts to
  // run at all (createCliConversationController's own guard) — every real
  // dispatch reaches this with a controller and a completed protocol result;
  // `stdoutText` stays only as that edge case's last-resort fallback.
  const protocolResult = stdioController?.result() ?? null;
  const resumedSessionInvalid = Boolean(
    input.resume_session_id
    && protocolResult
    && protocolResult.resume_handshake_failed,
  );
  const measurement = protocolResult
    ? {
        external_session_id: resumedSessionInvalid ? null : protocolResult.external_session_id ?? null,
        usage: protocolResult.usage ?? null,
        model_usage: protocolResult.model_usage ?? [],
        subscription_quota: protocolResult.subscription_quota ?? null,
      }
    : { external_session_id: null, usage: null, model_usage: [], subscription_quota: null };
  // A saved selection the live session no longer offered was left at the
  // runtime's default; record it so the turn says so.
  const droppedSessionConfig = protocolResult?.dropped_session_config ?? [];
  if (droppedSessionConfig.length > 0) {
    await bindings?.observeDroppedSessionConfig?.(input.run.id, input.run.space_id, droppedSessionConfig)
      .catch(() => undefined);
  }
  const metadata = {
    runtime_key: spec.runtime_key,
    external_session_id: measurement.external_session_id,
    // Which copy on the host actually ran it. The usage ledger records it as
    // the runtime's version, and the quota a Run carries back is folded into
    // that copy's cache — both need to know which copy, and only the
    // dispatch does.
    runtime_installation: installation,
    // What this Run reached through the host's egress proxy, and what it was
    // refused. Carried on the envelope so orchestration can turn it into a
    // Run event: "why did the install fail" has no other answer, since the
    // refusal happened on the host and the CLI only saw a 403.
    ...(result.egress?.length ? { egress: result.egress } : {}),
    // Where this Run's change is: its Task branch, and the commit its
    // worktree stood at when it started — the base its verification diffs
    // against and what the Run's settle squashes from (ADR 0016 §11).
    ...(result.task_worktree ? { task_worktree: result.task_worktree } : {}),
    // The provider this run actually executed against, or null when it ran
    // on the copy's own subscription login. Reported rather than read off
    // the Run row, because this path *overwrites* that row mid-execution
    // (`bindings.record` above): a host-default binding resolved here is
    // invisible to any snapshot taken before dispatch, and a conversation
    // Run that unbinds leaves a stale stamp behind. Metering keys on this.
    bound_model_provider_id: providerBinding ? boundProviderId : null,
    subscription_quota: measurement.subscription_quota,
    ...(protocolResult ? {
      cli_usage: {
        acp_turns: protocolResult.acp_prompt_count ?? null,
        occupancy_used: protocolResult.context_window?.used ?? null,
        occupancy_size: protocolResult.context_window?.size ?? null,
        usage_updates: protocolResult.usage_updates?.count ?? null,
        usage_updates_used_total: protocolResult.usage_updates?.used_total ?? null,
        // Whether this turn continued the thread's vendor session or opened
        // one: the only continuity fact the Usage page needs now that the
        // CLI owns the conversation.
        resumed_session: Boolean(input.resume_session_id) && !resumedSessionInvalid,
      },
    } : {}),
    // Which Skill text this run was given. The Skill changes what an agent
    // does the way a prompt does, so explaining the run later needs to name
    // the exact text it saw; the content is code, so a hash identifies it
    // without storing a copy per run.
    ...(workSurface ? { work_skill_content_hash: workSurface.skill_content_hash } : {}),
  };
  if (input.deadline_signal?.aborted) {
    // Orchestration stopped this Run at its explicit time limit; it owns the
    // Run's error. The thread only records that the turn ended that way.
    await input.thread_event_sink?.([{ event_type: "status", status: "run_timeout" }]);
    // What the runtime measured before the stop was spent all the same, and
    // what the host reported on exit (its Task worktree, egress) still
    // describes this attempt: only the outcome is the time limit's.
    return {
      ...remoteFailure(
        spec.runtime_key,
        RUN_TIMED_OUT_ERROR_CODE,
        "The Run reached its time limit and was stopped.",
        startedAt,
        completedAt,
      ),
      metadata_json: metadata,
      usage: measurement.usage,
      model_usage: measurement.model_usage,
    };
  }
  if (result.timed_out) {
    const stalled = result.failure_code === "stall_timeout";
    const neverLaunched = result.failure_code === "launch_wait_timeout";
    const idle = typeof result.idle_seconds === "number" ? result.idle_seconds : null;
    // Say which kind of stuck this was. "Remote Run timed out" is true of a
    // runtime that worked for the whole budget, of one that said nothing
    // after the first second, and of one the host never started; only the
    // second is worth retrying quickly, and the third is not the runtime's
    // doing at all. The executor's stderr carries that third reason. Do not
    // read the idle count when no process started. It says nothing.
    const detail = neverLaunched
      ? result.stderr || `The host did not start this run before launch.`
      : stalled
        ? `Remote Run produced no output for ${idle ?? "?"}s and was stopped.`
        : idle !== null && idle > 0
          ? `Remote runtime reported a timeout (last output ${idle}s earlier).`
          : `Remote runtime reported a timeout.`;
    await input.thread_event_sink?.([
      { event_type: "diagnostic", text: detail },
      { event_type: "status", status: "run_timeout" },
    ]);
    // A resume the runtime never answered is a session it cannot load: the
    // thread gives it up (`hosts/threadOutcome.ts`) rather than time out on
    // it every turn. A wait before the process started says nothing about it.
    const resumeHung = Boolean(input.resume_session_id && protocolResult?.resume_unanswered);
    return remoteFailure(
      spec.runtime_key,
      resumeHung ? "runtime_session_invalid" : stalled ? "runtime_stall_timeout" : "runtime_timeout",
      resumeHung ? `${detail} It never answered the request to resume its session, which is given up.` : detail,
      startedAt,
      completedAt,
    );
  }
  const success = result.returncode === 0 && (!protocolResult || (protocolResult.completed && !protocolResult.error));
  await input.thread_event_sink?.([{ event_type: "status", status: success ? "run_succeeded" : "run_failed" }]);
  return {
    runtime_key: spec.runtime_key,
    adapter_kind: "local_cli",
    success,
    output_text: protocolResult?.text ?? stdoutText,
    output_json: {
      runtime_key: spec.runtime_key,
      external_session_id: measurement.external_session_id,
      // How full the vendor session is after this turn, as the runtime said.
      // The host-thread outcome keeps it so a long session can hand off and
      // rotate before the vendor's own compaction does it invisibly.
      ...(protocolResult?.context_window ? { context_window: protocolResult.context_window } : {}),
      // The runtime asked the person a question of its own and the turn was
      // cancelled on it. A completed turn, not a failure: the chat
      // finalizer writes the question as the Agent's reply.
      ...(protocolResult?.asked_user ? { asked_user: protocolResult.asked_user } : {}),
    },
    metadata_json: metadata,
    exit_code: result.returncode,
    error_code: success
      ? null
      : resumedSessionInvalid
        ? "runtime_session_invalid"
        // A refusal for an exhausted subscription is its own, non-retryable
        // code — read from the error the turn ended on, or, with none, the
        // end of stderr, never from a notice logged earlier in the run.
        : classifyRuntimeFailure(spec.runtime_key, protocolResult?.error ?? stderrTail(result.stderr), {
          providerBound: Boolean(providerBinding),
        }) ?? "runtime_nonzero_exit",
    error_message: success
      ? null
      : protocolResult?.error
        ?? `Process exited with code ${result.returncode}${result.stderr ? `: ${result.stderr}` : ""}`,
    started_at: startedAt,
    completed_at: completedAt,
    usage: measurement.usage,
    model_usage: measurement.model_usage,
  };
}

/**
 * Early failure paths must write a thread status event and await it before
 * returning. The conversation poll learns that a run finished only from a
 * `status` event in `host_thread_events`. A terminal DB status with an empty
 * event stream leaves the UI showing the run as still active. Match the
 * terminal `run_succeeded` / `run_failed` / `run_timeout` emissions further
 * down: a poller at the terminal transition must not observe a truncated
 * conversation.
 */
/**
 * Whether this host is the instance's built-in strict one. Read from the row
 * rather than threaded down from the orchestrator, which does not carry the
 * host kind this far; it is a primary-key lookup on a Run that is already
 * doing several.
 */
/**
 * The workspace the launch frame carries.
 *
 * The relative path is merged into a Location workspace the snapshot already
 * named. Do not use it only when there is no workspace at all. The built-in
 * host's daemon does not run `workspace add`, so a Location id alone resolves
 * to nothing there and the Run dies with "no local path registered". The path
 * under the shared workspace root is what lets it resolve one (ADR 0016
 * section 4). A Conversation bound to a server Location always arrives with a
 * snapshot workspace. Skipping the merge in that case fails every such Run.
 */
export { launchWorkspace as launchWorkspaceForTest };

function launchWorkspace(
  fromSnapshot: LaunchWorkspace | undefined,
  workspaceLocationId: string | null,
  relativePath: string | null,
): LaunchWorkspace | undefined {
  if (fromSnapshot?.kind === "location") {
    return fromSnapshot.workspace_relative_path || !relativePath
      ? fromSnapshot
      : { ...fromSnapshot, workspace_relative_path: relativePath };
  }
  if (fromSnapshot) return fromSnapshot;
  if (!workspaceLocationId || !relativePath) return undefined;
  return { kind: "location", workspace_location_id: workspaceLocationId, workspace_relative_path: relativePath };
}

/**
 * A write-capable execution Task Run on a Location works in its Task's own
 * worktree, on the Task's branch (`worktree: { task_id }`, ADR 0016 §11), so
 * it never waits for the Location's writers and they never see its edits; the
 * change reaches the checkout only when the Task is done. The daemon falls
 * back to the checkout itself, under the Location's lease, when the Location
 * is not a git checkout. Every other Run — a Conversation turn above all, and
 * a Task's planning or read-only Run — works in the checkout the person is
 * looking at.
 */
export function withTaskWorktree(
  workspace: LaunchWorkspace | undefined,
  workspaceLocationId: string | null,
  run: TaskWorktreeRun,
): LaunchWorkspace | undefined {
  const taskId = executionTaskId(run);
  if (!taskId) return workspace;
  if (workspace?.kind === "managed") return workspace;
  const location: LaunchWorkspace | undefined = workspace
    ?? (workspaceLocationId ? { kind: "location", workspace_location_id: workspaceLocationId } : undefined);
  const mergeId = taskMergeIdOf(run);
  return location ? { ...location, worktree: { task_id: taskId, ...(mergeId ? { merge_id: mergeId } : {}) } } : undefined;
}

/**
 * The merge whose conflict this Run resolves (ADR 0016 §11):
 * it works in the Task worktree as the merge left it, and is never settled.
 */
export function taskMergeIdOf(run: { contract_snapshot_json?: unknown }): string | null {
  const contract = run.contract_snapshot_json;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  const mergeId = (contract as Record<string, unknown>).task_merge_id;
  return typeof mergeId === "string" && mergeId.length > 0 ? mergeId : null;
}

interface TaskWorktreeRun {
  contract_snapshot_json?: unknown;
  run_type?: string | null;
  required_sandbox_level?: string | null;
}

/**
 * The Task a Run executes, when it is an execution Run that may write: its
 * contract came from a Task, it is an `agent` Run (not `planning`), and its
 * workspace is not `read_only` — the same line `dispatchIsolation` draws.
 */
export function executionTaskId(run: TaskWorktreeRun): string | null {
  if (run.run_type !== "agent" || run.required_sandbox_level === "read_only") return null;
  const contract = run.contract_snapshot_json;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  const source = (contract as Record<string, unknown>).source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { kind, id } = source as Record<string, unknown>;
  return kind === "task" && typeof id === "string" && id.length > 0 ? id : null;
}

async function hostIsStrict(databaseUrl: string | null | undefined, hostId: string, db?: Queryable): Promise<boolean> {
  if (!databaseUrl) return false;
  const result = await (db ?? getDbPool(databaseUrl))
    .query<{ kind: string }>(`SELECT kind FROM hosts WHERE id = $1 LIMIT 1`, [hostId]);
  return result.rows[0]?.kind === "server";
}

async function remoteFailureWithEvent(
  input: RemoteHostCliAdapterInput,
  runtimeKey: string,
  errorCode: string,
  message: string,
  startedAt: string,
): Promise<RunAdapterResultEnvelope> {
  await input.thread_event_sink?.([{ event_type: "status", status: "run_failed" }]);
  return remoteFailure(runtimeKey, errorCode, message, startedAt);
}

function remoteFailure(
  runtimeKey: string,
  errorCode: string,
  message: string,
  startedAt: string,
  completedAt: string = new Date().toISOString(),
): RunAdapterResultEnvelope {
  return {
    runtime_key: runtimeKey,
    adapter_kind: "local_cli",
    success: false,
    output_text: "",
    output_json: { runtime_key: runtimeKey },
    exit_code: 1,
    error_code: errorCode,
    error_message: message,
    started_at: startedAt,
    completed_at: completedAt,
  };
}

/**
 * How long after a Run's time limit the remote executor waits for the host to
 * confirm the stop before it gives the dispatch up. Longer than
 * orchestration's own terminate-then-force sequence (7 s), shorter than its
 * settle grace (`runTimeLimit.ts`).
 */
const REMOTE_TIME_LIMIT_ABANDON_MS = 10_000;

/**
 * `CliCommandExecutor` for a daemon WebSocket. Do not open a TCP port to a
 * runner beside the server. Argv rendering and vendor event parsing stay
 * above this class.
 */
export class RemoteWsCliCommandExecutor implements CliCommandExecutor {
  constructor(
    private readonly hostId: string,
    // A remote Run is pinned to this physical checkout, not merely to its
    // logical Folder.
    private readonly workspaceLocationId: string | null,
    private readonly registry: HostConnectionRegistry,
    /** Null when this run uses the machine's own login state. */
    private readonly providerBinding: RemoteProviderBindingFrame | null = null,
    /** Which copy of the runtime on the host: `own` or `managed:<version>`. */
    private readonly installation: string = "own",
    /** The adapter the copy belongs to — managed copies are keyed by it, not by the command name. */
    private readonly runtimeKey: string | null = null,
  /** Null when this Run was granted no tool and needs no way to call back. */
  private readonly workSurface: RunWorkSurfaceFrame | null = null,
    private readonly workspace?: LaunchWorkspace,
    private readonly workspaceAccess: Array<{ workspace_location_id: string; access_mode: "read" | "write"; workspace_relative_path?: string }> = [],
    private readonly inputResources: Array<{
      input_id: string;
      workspace_location_id: string;
      relative_path: string;
      workspace_relative_path?: string;
      name: string;
      media_type: string;
      size_bytes: number;
    }> = [],
    /** The namespace policy a strict host applies; a trusted host ignores it. */
    private readonly isolation: HostLaunchIsolation = { sandbox_mode: "read_write", egress_profile: "default" },
    /** Instance-selected public route for the built-in host; a trusted host ignores it. */
    private readonly egressTransport: HostEgressTransport = { mode: "direct" },
    /**
     * How many Runs this host executes at once, or null for no cap. Set for
     * the built-in host, where the container's own limits and this count are
     * the only levers bubblewrap leaves; a paired machine is its owner's to
     * size.
     */
    private readonly maxConcurrentRuns: number | null = null,
    /** Recorded on the Run's attempt by the caller; uploads are accepted against it. */
    private readonly launchId: string = randomUUID(),
  ) {}

  async runCommand(input: Parameters<CliCommandExecutor["runCommand"]>[0]): Promise<CliExecutionResult> {
    // A Run stopped, or past its time limit, before its launch has nothing
    // running for the stop to reach. Sending the launch now would start a
    // command the control plane already counts as stopped.
    if (input.deadline_signal?.aborted) {
      return { returncode: 1, stdout: "", stderr: "The Run reached its time limit before launch.", timed_out: true };
    }
    if (input.cancel_signal?.aborted) {
      return { returncode: 1, stdout: "", stderr: "The Run was stopped before launch.", timed_out: false };
    }
    if (!this.registry.isOnline(this.hostId)) {
      return { returncode: 1, stdout: "", stderr: "Host is offline.", timed_out: false, failure_code: "sandbox_runner_unavailable" };
    }
    const controller = input.stdio_controller;
    // Line-split incoming `output` frames into the controller. This transport
    // is the daemon socket.
    const sendToController = (message: Record<string, unknown>) => {
      this.registry.sendStdin(this.hostId, input.run_id, `${JSON.stringify(message)}\n`);
    };
    const closeControllerStdin = () => {
      this.registry.sendStdinClose(this.hostId, input.run_id);
    };
    let protocolBuffer = "";
    // Silence is observation only: it cannot establish a runtime failure.
    let lastOutputAt = Date.now();
    const onOutput = (chunk: string) => {
      lastOutputAt = Date.now();
      input.on_stdout_chunk?.(chunk);
      if (!controller) return;
      protocolBuffer += chunk;
      const records = protocolBuffer.split(/\r?\n/);
      protocolBuffer = records.pop() ?? "";
      for (const record of records) {
        if (!record.trim()) continue;
        // `receive()` is declared `Promise<void>` only to match
        // `CliStdioController`'s interface (localCliExecution.ts); this
        // controller's body is fully synchronous, so the returned promise
        // is already resolved by the time this call returns and needs no
        // `await`. Awaiting it here would only reintroduce a microtask hop.
        // Do not await it. The `.catch()` below guards a different hazard:
        // `async` turns even a synchronous internal throw into a rejected
        // Promise instead of letting it reach this `try/catch`. Do not drop
        // the catch. A throw inside `receive()` would become an unhandled
        // rejection rather than a contained Run failure.
        try {
          controller.receive(JSON.parse(record), sendToController, closeControllerStdin)
            .catch(() => { controller.reject("CLI protocol emitted invalid JSON"); closeControllerStdin(); });
        } catch {
          controller.reject("CLI protocol emitted invalid JSON");
          closeControllerStdin();
        }
      }
    };
    // A controller must not write its first `stdin` frame (the `initialize`
    // request) until the daemon confirms this run is actually registered —
    // see the `launched` frame's doc comment in
    // `packages/host-daemon/src/execution.ts`.
    let resolveLaunched: (() => void) | undefined;
    const launchedPromise = controller
      ? new Promise<void>((resolve) => { resolveLaunched = resolve; })
      : null;
    // The observation clock starts when the process does: a launch the daemon
    // queued behind another writer of its Location has said nothing because
    // nothing has run yet.
    let launchedAt: number | null = null;
    const onLaunched = () => {
      launchedAt = Date.now();
      lastOutputAt = launchedAt;
      resolveLaunched?.();
    };
    const completion = this.registry.dispatchLaunch(
      this.hostId,
      input.run_id,
      {
        ...(this.workspaceLocationId ? { workspace_location_id: this.workspaceLocationId } : {}),
        argv: input.command,
        stdin: controller ? null : input.stdin,
        timeout_seconds: null,
        keep_stdin_open: Boolean(controller),
        provider_binding: this.providerBinding ?? undefined,
        installation: this.installation,
        runtime_key: this.runtimeKey ?? undefined,
        work_surface: this.workSurface ?? undefined,
        workspace: this.workspace,
        workspace_access: this.workspaceAccess,
        input_resources: this.inputResources,
        isolation: this.isolation,
        egress_transport: this.egressTransport,
      },
      onOutput,
      (chunk) => { lastOutputAt = Date.now(); input.on_stderr_chunk?.(chunk); },
      onLaunched,
      this.maxConcurrentRuns,
      this.launchId,
    );
    if (controller) void launchedPromise!.then(() => controller.start(sendToController));
    input.process_registry?.registerRemote?.(
      input.run_id,
      () => { this.registry.sendTerminate(this.hostId, input.run_id, false); },
      () => { this.registry.sendTerminate(this.hostId, input.run_id, true); },
    );

    // At an explicit time limit orchestration aborts the signal and then
    // stops the process the way an explicit stop does. A host that never
    // confirms the stop must not hold the Run, its Host slot, or its renewed
    // credentials: after a bounded wait force the stop and settle this
    // dispatch ourselves. The daemon's late `complete` then matches nothing.
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    const onDeadline = () => {
      abandonTimer = setTimeout(() => {
        this.registry.sendTerminate(this.hostId, input.run_id, true);
        this.registry.receiveComplete(
          this.hostId,
          input.run_id,
          { exit_code: -1, timed_out: true, error: "run_time_limit_reached" },
          this.launchId,
        );
      }, REMOTE_TIME_LIMIT_ABANDON_MS);
      abandonTimer.unref?.();
    };
    if (input.deadline_signal?.aborted) {
      // Unreachable while the check above and the dispatch share one tick;
      // kept so a launch that ever does race its deadline is stopped now,
      // not only when the abandon timer fires.
      this.registry.sendTerminate(this.hostId, input.run_id, false);
      onDeadline();
    } else input.deadline_signal?.addEventListener("abort", onDeadline, { once: true });

    const noticeMs = input.stall_timeout_seconds && input.stall_timeout_seconds > 0
      ? input.stall_timeout_seconds * 1000
      : null;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    if (noticeMs && input.on_silence) {
      const check = () => {
        // A queued process has not started; its silence is expected.
        if (this.registry.isWaitingForWorkspace(input.run_id) || launchedAt === null) {
          lastOutputAt = Date.now();
        }
        const idleMs = Date.now() - lastOutputAt;
        if (idleMs >= noticeMs) {
          // One notice per Run, with no terminal event or termination request.
          void Promise.resolve().then(() => input.on_silence?.(Math.floor(idleMs / 1000)))
            .catch(() => undefined);
          return;
        }
        noticeTimer = setTimeout(check, noticeMs - idleMs);
        noticeTimer.unref?.();
      };
      noticeTimer = setTimeout(check, noticeMs);
      noticeTimer.unref?.();
    }
    const outcome = await completion.finally(() => {
      clearTimeout(noticeTimer);
      clearTimeout(abandonTimer);
      input.deadline_signal?.removeEventListener("abort", onDeadline);
      input.process_registry?.deregister(input.run_id);
    });
    return toExecutionResult(outcome, controller);
  }
}

function toExecutionResult(
  outcome: HostRunCompletion,
  controller?: CliStdioController,
): CliExecutionResult {
  const protocol = controller?.result() ?? null;
  // Preserve a real process failure even if ACP never reached a terminal
  // response. A zero exit with an incomplete/failed protocol remains a
  // synthetic failure so callers cannot mistake a truncated conversation for
  // a successful run.
  const returncode = outcome.exit_code !== 0
    ? outcome.exit_code
    : protocol && (!protocol.completed || protocol.error)
      ? -1
      : outcome.exit_code;
  return {
    returncode,
    stdout: "",
    stderr: protocol?.error ?? outcome.error ?? "",
    ...(outcome.egress?.length ? { egress: outcome.egress } : {}),
    ...(outcome.task_worktree ? { task_worktree: outcome.task_worktree } : {}),
    timed_out: outcome.timed_out,
  };
}

/** The last few lines of a process's stderr: where a CLI says why it stopped. */
function stderrTail(stderr: string | null | undefined): string | null {
  const lines = (stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines.slice(-3).join("\n") : null;
}

/** Materialize exactly the package files authorized in Delivery, even without Rainver tool grants. */
export function skillWorkSurface(delivery: InvocationDelivery | undefined, base: RunWorkSurfaceFrame | null): RunWorkSurfaceFrame | null {
  const skills = delivery?.skill_packages ?? [];
  if (skills.length === 0) return base;
  const surface: RunWorkSurfaceFrame = { env: { ...base?.env }, files: [...(base?.files ?? [])],
    dir_env: { ...base?.dir_env, RAINVER_SKILL_ROOT: "rainver/skills" } };
  for (const skill of skills) {
    for (const file of skill.content.files) {
      surface.files.push({ relative_path: `rainver/skills/${skill.content.skill_package_id}/${file.path}`,
        contents: file.content_base64, encoding: "base64", content_hash: file.content_hash });
    }
  }
  return surface;
}
