import type { RunAdapterResultEnvelope, RuntimeSemanticEvent } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters";
import type { RunRecord } from "./repository";
import { CliRenderError, renderCliCommand } from "./cliCommandRendering";
import type { CliCommandExecutor, CliExecutionResult, CliProcessRegistry, CliStdioController } from "./localCliExecution";
import type { VendorCliAdapterType } from "./vendorCliAdapter";
import { createCliConversationController } from "./cliConversationProtocol";
import { normalizeVendorEvents } from "./runtimeEventNormalization";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "../hosts/connectionRegistry";
import { createThreadEventNormalizer, type ThreadEventDraft } from "../hosts/threadEventNormalization";
import { getDbPool } from "../../db/pool";
import type { ServerConfig } from "../../config";
import type { ProviderProxyLeaseRegistry } from "../providers/proxy/lease";
import type { Queryable } from "../routeUtils/common";
import {
  boundAcpModelId,
  buildRemoteProviderBinding,
  recordRemoteRunBackend,
  resolveRemoteRunBinding,
  RemoteProviderBindingError,
  type RemoteProviderBinding,
  type RemoteProviderBindingFrame,
  type ResolvedRemoteBinding,
} from "./remoteProviderBinding";

/**
 * ADR 0016 P3: the remote-host counterpart to `executeVendorCliAdapter` —
 * deliberately a separate, much smaller function rather than a branch
 * inside it. `executeVendorCliAdapter` is credential/provider/MCP-coupled
 * throughout (grant → sandbox config → provider binding → tool transport,
 * each with its own cleanup-on-failure path); a trusted remote host gets
 * none of that (D1: no server-brokered credentials, no provider binding, no
 * delivery, no MCP — it uses whatever the machine is already logged into).
 * Forking that function's internals would risk the credential-sensitive
 * server-host path for a feature that shares almost none of its logic. The
 * two functions share only genuinely pure pieces: spec lookup and argv
 * rendering. ACP protocol events are consumed by the conversation controller
 * on both paths; they are not vendor stdout text to parse.
 *
 * Remote-eligible adapters: the `acp` protocol (`claude_code`, `opencode`,
 * `codex_cli`) — driven via
 * `createCliConversationController` over the daemon's duplex
 * `stdin`/`stdin_close` frames, the same controller abstraction the
 * server-host path already uses. `codex_cli`'s adapter binary (`codex-acp`)
 * is a pinned dependency of `packages/host-daemon`, not something a trusted
 * host installs itself — the daemon resolves and spawns its own bundled copy
 * (see `packages/host-daemon/src/execution.ts`).
 */
/**
 * ACP runtime replatform P2: the daemon knows the real workspace path for a
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
export const REMOTE_HOST_ACP_CWD_PLACEHOLDER = "agent-space:remote-workspace-cwd";

export interface RemoteHostCliAdapterInput {
  run: RunRecord;
  prompt: string | null;
  model: string | null;
  resume_session_id: string | null;
  timeout_seconds?: number | null;
  runtime_event_sink?: (event: RuntimeSemanticEvent) => Promise<void> | void;
  /**
   * control-center-phase2-plan.md P1 (C2): the normalized conversation event
   * sink, persisted as frames arrive (not a post-hoc parse of accumulated
   * stdout, unlike `runtime_event_sink`/`run_events`, which only reflects
   * whatever the caller does with what has already resolved).
   */
  thread_event_sink?: (drafts: ThreadEventDraft[]) => Promise<void> | void;
  process_registry?: CliProcessRegistry;
}

/**
 * How long a remote runtime may say nothing before the run is given up on.
 *
 * The server-host path has had this budget all along (`stallTimeoutSeconds`);
 * the remote path accepted the same option and never implemented it, so a
 * runtime that went quiet burned the entire run timeout before anyone found
 * out.
 *
 * A third of the run budget, so a slow-but-working turn is never cut off and
 * a run that configured a short timeout gets a proportionally short stall
 * budget rather than one that can exceed its own deadline. Capped at two
 * minutes: past that the wait costs more than the answer is worth, and a
 * retry is cheap.
 */
export function remoteStallTimeoutSeconds(timeoutSeconds: number): number {
  return Math.min(120, Math.max(5, Math.floor(timeoutSeconds / 3)));
}

function resolveTimeoutSeconds(input: RemoteHostCliAdapterInput, defaultSeconds: number, maxSeconds: number): number {
  const requested = input.timeout_seconds && input.timeout_seconds > 0 ? Math.trunc(input.timeout_seconds) : defaultSeconds;
  const contract = input.run.contract_snapshot_json as Record<string, unknown> | null | undefined;
  const maxDuration = typeof contract?.max_duration_seconds === "number" && contract.max_duration_seconds > 0
    ? Math.trunc(contract.max_duration_seconds)
    : null;
  return Math.min(requested, maxSeconds, maxDuration ?? Number.MAX_SAFE_INTEGER);
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
  resolve(run: RunRecord, hostId: string, adapterType: string): Promise<ResolvedRemoteBinding | null>;
  record(runId: string, used: { provider_id: string; model: string | null } | null, spaceId: string): Promise<void>;
}

/** For a caller with no bindings at all: every run is unbound, nothing recorded. */
export const NO_PROVIDER_BINDINGS: RemoteBindingPort = {
  async resolve() { return null; },
  async record() {},
};

function databaseBindingPort(config: ServerConfig): RemoteBindingPort | null {
  if (!config.databaseUrl) return null;
  const db = getDbPool(config.databaseUrl);
  return {
    resolve: (run, hostId, adapterType) => resolveRemoteRunBinding(db, run, hostId, adapterType),
    record: (runId, used, spaceId) => recordRemoteRunBackend(db, runId, used, spaceId),
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
  workspaceLocationId: string,
  deps: RemoteHostCliAdapterDeps = {},
): Promise<RunAdapterResultEnvelope> {
  const leases: Array<() => void> = [];
  try {
    return await runRemoteHostCliAdapter(input, hostId, workspaceLocationId, deps, leases);
  } finally {
    for (const revoke of leases) revoke();
  }
}

async function runRemoteHostCliAdapter(
  input: RemoteHostCliAdapterInput,
  hostId: string,
  // execution-topology-and-project-control-plane-plan.md P1 / D2/D5: this is
  // a WorkspaceLocation id. The daemon wire frame uses the same
  // `workspace_location_id` field, and the daemon's local config maps that id
  // to the real directory on the owning machine.
  workspaceLocationId: string,
  deps: RemoteHostCliAdapterDeps,
  leases: Array<() => void>,
): Promise<RunAdapterResultEnvelope> {
  const startedAt = new Date().toISOString();
  const adapterType = input.run.adapter_type;
  const spec = getLocalCliRuntimeAdapterSpec(adapterType);
  if (!spec) {
    return remoteFailureWithEvent(input, adapterType ?? "unknown", "runtime_adapter_not_found", "Runtime adapter is not registered.", startedAt);
  }
  if (spec.implementation_status !== "implemented") {
    return remoteFailureWithEvent(input, spec.adapter_type, "runtime_adapter_not_implemented", `Runtime adapter '${adapterType}' is not executable.`, startedAt);
  }
  // Every currently-implemented local_cli adapter is ACP; this defends only
  // against a hypothetical future non-ACP adapter slipping past routes.ts's
  // own remote-eligibility gate.
  if (spec.invocation.protocol !== "acp") {
    return remoteFailureWithEvent(
      input,
      spec.adapter_type,
      "remote_execution_protocol_not_supported",
      `Runtime adapter '${spec.adapter_type}' requires a bidirectional session protocol and cannot run on a remote execution host yet.`,
      startedAt,
    );
  }

  // control-center-phase2-plan.md P3 follow-up (real-usage feedback,
  // 2026-08-22): every remote dispatch is workspace-bound (`dispatch`
  // requires `project_folder_id`) and the daemon's diff capture already
  // stages new files with `git add --intent-to-add --all` before `git diff
  // HEAD`, so a brand-new file written directly into the workspace shows
  // its full content in "Review diff" — nudging the agent to write
  // deliverables to `$AGENT_SPACE_OUTPUT_DIR` instead only misdirected
  // ordinary work out of the workspace the user actually asked for it in.
  // The daemon still injects `AGENT_SPACE_OUTPUT_DIR` and uploads whatever
  // lands there (kept dormant, not removed — a future structured
  // agent-space-information channel, distinct from workspace file
  // changes, is a real open design question logged in
  // `tasks/deferred-register.md`, not decided here).
  const prompt = input.prompt ?? input.run.prompt ?? "";

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
      // Trusted-host semantics (D1) do not fit `renderCliCommand`'s built-in
      // permission-bypass gate, which requires a server-known worktree
      // sandbox_cwd and a high/critical risk_level — both server-host
      // concepts. Remote's auto-approve flag is appended manually below.
      permission_bypass: false,
      risk_level: "low",
      project_folder_id: input.run.project_folder_id,
      sandbox_cwd: REMOTE_HOST_ACP_CWD_PLACEHOLDER,
      resume_session_id: input.resume_session_id,
      required_sandbox_level: null,
      // See renderCliCommand's doc comment: no server-local path exists to
      // check, and faking one would be security theater, not enforcement.
      // Known gap, not silently ignored — see hosts.md and the deferred
      // register: a real remote deny-config would need the daemon to write
      // it into its own workspace, which phase 1 does not do.
      skip_subagent_disable_check: true,
    });
  } catch (error) {
    return remoteFailureWithEvent(
      input,
      spec.adapter_type,
      error instanceof CliRenderError ? error.code : "cli_command_render_failed",
      error instanceof Error ? error.message : "CLI command render failed.",
      startedAt,
    );
  }

  const argv = [...rendered.argv];
  if (spec.permissions.supports_permission_bypass && spec.permissions.permission_bypass_arg_template) {
    // Trusted-host default (D1): auto-approve edits/commands in the
    // workspace — headless execution has no human to answer a permission
    // prompt. P4's dispatch composer exposes this as a per-dispatch choice;
    // phase 1 always takes this default.
    argv.push(...spec.permissions.permission_bypass_arg_template);
  }

  const registry = deps.connectionRegistry ?? sharedHostConnectionRegistry;
  const threadEvents = createThreadEventNormalizer();
  const timeoutSeconds = resolveTimeoutSeconds(input, spec.limits.default_timeout_seconds, spec.limits.max_timeout_seconds);

  // The control plane's choice of model backend for this run, if it made one.
  // Read from the thread message rather than `runs.model_provider_id` — see
  // `remoteProviderBinding.ts` for why that column is not evidence.
  let providerBinding: RemoteProviderBinding | null = null;
  let unusableHostDefault: string | null = null;
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
      const bound = await bindings.resolve(input.run, hostId, spec.adapter_type);
      if (bound) {
        if (!config) {
          throw new RemoteProviderBindingError(
            "provider_binding_unavailable",
            "This run is bound to a ModelProvider, but no server configuration was available to reach it.",
          );
        }
        try {
          providerBinding = await buildRemoteProviderBinding({
            config,
            run: input.run,
            hostId,
            adapterType: spec.adapter_type,
            binding: bound,
            // Outlive the run itself, the way the server-host path does, so a
            // request in flight at the timeout boundary is not cut off.
            ttlSeconds: timeoutSeconds + 300,
            leaseRegistry: deps.leaseRegistry,
            // Reads this host's reported control-plane address to derive a
            // proxy URL it can actually reach. `config.databaseUrl` is proven
            // by `databaseBindingPort` having resolved the binding at all;
            // a test-supplied port must say which database it means.
            db: deps.db ?? getDbPool(config.databaseUrl!),
          });
          leases.push(providerBinding.revoke);
        } catch (error) {
          // A Host default that cannot be used *here* is not this run's
          // error: a Host is user-scoped and can back Locations in several
          // Spaces, so its default may name a provider granted in a different
          // one. Before this existed such a run used the machine's own login
          // and succeeded; failing it now would be a regression nobody asked
          // for. A binding the dispatch explicitly asked for still fails.
          if (bound.origin !== "host_default") throw error;
          unusableHostDefault = error instanceof Error ? error.message : String(error);
          providerBinding = null;
        }
      }
      if (unusableHostDefault) {
        const text = "This host's default model backend is not usable for this run, "
          + `so it ran on the machine's own login state instead: ${unusableHostDefault}`;
        // Through `runtime_event_sink`, not the thread sink: the degradation
        // only happens to a run with **no** thread — a thread always has a
        // dispatched message, and a dispatched message always carries a
        // resolved binding — so a thread-only diagnostic would be silent for
        // this branch's entire real population.
        void input.runtime_event_sink?.({
          schema_version: "runtime_event.v1",
          type: "warning",
          occurred_at: new Date().toISOString(),
          summary: text,
          metadata_json: { reason: "host_default_binding_unusable" },
        });
        void input.thread_event_sink?.([{ event_type: "diagnostic", text }]);
      }
      // Make the Run row say what this run actually executes against — the
      // router may have predicted a different provider at run start, and usage
      // attributes to the one the lease names, not the one the row does.
      await bindings.record(
        input.run.id,
        bound && providerBinding
          ? { provider_id: bound.provider_id, model: providerBinding.used_model }
          : null,
        input.run.space_id,
      );
    } catch (error) {
      // Fail the run rather than silently executing on the machine's own
      // login: the user chose a backend and is owed the reason it could not
      // be used (B67).
      return remoteFailureWithEvent(
        input,
        spec.adapter_type,
        error instanceof RemoteProviderBindingError ? error.code : "provider_binding_failed",
        error instanceof Error ? error.message : "Could not prepare the selected model backend.",
        startedAt,
      );
    }
  }

  const executor = deps.executor ?? new RemoteWsCliCommandExecutor(
    hostId,
    workspaceLocationId,
    input.run.project_folder_id,
    registry,
    providerBinding?.frame ?? null,
  );
  let stdoutText = "";
  const stdioController = createCliConversationController({
    adapter_type: spec.adapter_type as VendorCliAdapterType,
    prompt,
    cwd: REMOTE_HOST_ACP_CWD_PLACEHOLDER,
    // The backend the binding actually resolved, in this runtime's identifier
    // space — not `input.model`, which is the router's idea of a model and can
    // name one the bound provider does not serve. Null for Claude, whose model
    // is decided entirely by the environment the binding sets.
    //
    // A run with no binding keeps whatever the caller asked for. No production
    // caller supplies one today — `RunExecuteRequestSchema` has no `model`
    // field, so every host-thread dispatch arrives with null — but the input
    // is part of this adapter's contract and dropping it would silently
    // discard a model a future caller passes.
    model: providerBinding
      ? boundAcpModelId(spec.adapter_type as VendorCliAdapterType, providerBinding.used_model)
      : input.model,
    // What the run executes against, which the server decided and does not
    // need to ask the host about. Without it, attribution reads the runtime's
    // echo: an alias for Claude (which is told no model at all), and the
    // `<provider>/<model>` form for OpenCode rather than the provider's own
    // model name.
    attributed_model: providerBinding?.used_model ?? null,
    runtime_session_id: input.resume_session_id,
    on_thought_delta: (delta) => {
      const drafts = threadEvents.pushAcpThoughtDelta(delta);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
    on_text_delta: (delta) => {
      const drafts = threadEvents.pushAcpTextDelta(delta);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
    on_protocol_event: (event) => {
      for (const semanticEvent of normalizeVendorEvents(spec.adapter_type, [event], new Date().toISOString())) {
        void input.runtime_event_sink?.(semanticEvent);
      }
      const drafts = threadEvents.pushAcpProtocolEvent(event);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
    // execution-topology-and-project-control-plane-plan.md P0.4/D7: makes
    // the dispatch-preset pre-authorization a durable, visible fact on the
    // thread this Run belongs to, rather than an invisible default. Reuses
    // the existing `diagnostic` event type (§2.14's plan correction: not a
    // new `host_thread_events` CHECK-constraint value) — kept human-readable
    // (discovery review finding #3), not a serialized JSON blob, since
    // `ThreadConversation.tsx`'s `DiagnosticsDrawer` renders every
    // `diagnostic` line verbatim and this fires on essentially every
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
    timeout_seconds: timeoutSeconds,
    stall_timeout_seconds: remoteStallTimeoutSeconds(timeoutSeconds),
    env: {},
    run_id: input.run.id,
    stdin: rendered.stdin,
    process_registry: input.process_registry,
    stdio_controller: stdioController,
    on_stdout_chunk: (chunk) => {
      // Kept only as the last-resort output_text/measurement fallback for
      // the (effectively unreachable today) case where the controller never
      // formed at all — see its own doc comment below.
      stdoutText += chunk;
    },
    on_stderr_chunk: (chunk) => {
      const drafts = threadEvents.pushStderr(chunk);
      if (drafts.length > 0) void input.thread_event_sink?.(drafts);
    },
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
  if (result.timed_out) {
    const stalled = result.failure_code === "stall_timeout";
    const idle = typeof result.idle_seconds === "number" ? result.idle_seconds : null;
    // Say which kind of stuck this was. "Remote Run timed out" is true of a
    // runtime that worked for the whole budget and of one that said nothing
    // after the first second, and only the second is worth retrying quickly.
    const detail = stalled
      ? `Remote Run produced no output for ${idle ?? "?"}s and was stopped.`
      : idle !== null && idle > 0
        ? `Remote Run timed out after ${timeoutSeconds}s (last output ${idle}s earlier).`
        : `Remote Run timed out after ${timeoutSeconds}s.`;
    await input.thread_event_sink?.([
      { event_type: "diagnostic", text: detail },
      { event_type: "status", status: "run_timeout" },
    ]);
    return remoteFailure(
      spec.adapter_type,
      stalled ? "runtime_stall_timeout" : "runtime_timeout",
      detail,
      startedAt,
      completedAt,
    );
  }
  const success = result.returncode === 0 && (!protocolResult || (protocolResult.completed && !protocolResult.error));
  await input.thread_event_sink?.([{ event_type: "status", status: success ? "run_succeeded" : "run_failed" }]);
  return {
    adapter_type: spec.adapter_type,
    adapter_kind: "local_cli",
    success,
    output_text: protocolResult?.text ?? stdoutText,
    output_json: {
      adapter_type: spec.adapter_type,
      external_session_id: measurement.external_session_id,
    },
    metadata_json: {
      adapter_type: spec.adapter_type,
      external_session_id: measurement.external_session_id,
      subscription_quota: measurement.subscription_quota,
    },
    exit_code: result.returncode,
    error_code: success ? null : resumedSessionInvalid ? "runtime_session_invalid" : "runtime_nonzero_exit",
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
 * control-center-phase2-plan.md P3 (closure review): every one of the four
 * early-return failure paths above the `run_started` status event
 * (line ~144) used to return via bare `remoteFailure` with no thread event
 * at all — a Run could reach a terminal DB status
 * (`orchestrationService.ts`) while `host_thread_events` stayed completely
 * empty for it. `ThreadConversation.tsx`'s poll only learns a run finished
 * from a `status` event in that same stream, so those failures left the
 * conversation UI stuck showing the run as still active indefinitely.
 * Awaited, matching the terminal `run_succeeded`/`run_failed`/`run_timeout`
 * emissions further down this file (not the per-chunk fire-and-forget
 * pattern) — the same "a poller right at the terminal transition must not
 * observe a truncated conversation" reasoning applies here too.
 */
async function remoteFailureWithEvent(
  input: RemoteHostCliAdapterInput,
  adapterType: string,
  errorCode: string,
  message: string,
  startedAt: string,
): Promise<RunAdapterResultEnvelope> {
  await input.thread_event_sink?.([{ event_type: "status", status: "run_failed" }]);
  return remoteFailure(adapterType, errorCode, message, startedAt);
}

function remoteFailure(
  adapterType: string,
  errorCode: string,
  message: string,
  startedAt: string,
  completedAt: string = new Date().toISOString(),
): RunAdapterResultEnvelope {
  return {
    adapter_type: adapterType,
    adapter_kind: "local_cli",
    success: false,
    output_text: "",
    output_json: { adapter_type: adapterType },
    exit_code: 1,
    error_code: errorCode,
    error_message: message,
    started_at: startedAt,
    completed_at: completedAt,
  };
}

/**
 * `CliCommandExecutor` backed by a daemon's WebSocket connection instead of
 * the local sandbox-runner's TCP port. Same interface as
 * `SandboxRunnerCliCommandExecutor` on purpose: everything above this class
 * (argv rendering, vendor event parsing) stays identical regardless of
 * which one executes the command.
 */
export class RemoteWsCliCommandExecutor implements CliCommandExecutor {
  constructor(
    private readonly hostId: string,
    // A remote Run is pinned to this physical checkout, not merely to its
    // logical Folder.
    private readonly workspaceLocationId: string,
    private readonly projectFolderId: string | null,
    private readonly registry: HostConnectionRegistry,
    /** Null when this run uses the machine's own login state. */
    private readonly providerBinding: RemoteProviderBindingFrame | null = null,
  ) {}

  async runCommand(input: Parameters<CliCommandExecutor["runCommand"]>[0]): Promise<CliExecutionResult> {
    if (!this.registry.isOnline(this.hostId)) {
      return { returncode: 1, stdout: "", stderr: "Host is offline.", timed_out: false, failure_code: "sandbox_runner_unavailable" };
    }
    const controller = input.stdio_controller;
    // Line-split incoming `output` frames into the controller, exactly as
    // `SandboxRunnerCliCommandExecutor`'s `connectAndRun` does for the
    // server-host sandbox-runner socket — same controller abstraction,
    // different transport underneath.
    const sendToController = (message: Record<string, unknown>) => {
      this.registry.sendStdin(this.hostId, input.run_id, `${JSON.stringify(message)}\n`);
    };
    const closeControllerStdin = () => {
      this.registry.sendStdinClose(this.hostId, input.run_id);
    };
    let protocolBuffer = "";
    // Last sign of life from the runtime. A run whose ACP stream has gone
    // quiet and one that is working look identical from here otherwise, and
    // waiting out the whole run timeout to tell them apart is what made a
    // stalled OpenCode turn cost five silent minutes.
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
        // `await` — awaiting it here would only reintroduce a microtask hop
        // this synchronous design exists to avoid. The `.catch()` below
        // guards a different hazard: `async` turns even a synchronous
        // internal throw into a rejected Promise instead of letting it
        // reach this `try/catch`, so without it a future bug inside
        // `receive()` would become an unhandled rejection rather than a
        // contained Run failure (discovery review finding #2).
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
    let onLaunched: (() => void) | undefined;
    const launchedPromise = controller
      ? new Promise<void>((resolve) => { onLaunched = resolve; })
      : null;
    const completion = this.registry.dispatchLaunch(
      this.hostId,
      input.run_id,
      {
        workspace_location_id: this.workspaceLocationId,
        // Dual-write the pre-P1 field during rolling upgrades. New daemons
        // prefer the physical Location id; older paired daemons only know the
        // logical Folder key and must still resolve their local checkout.
        project_folder_id: this.projectFolderId ?? undefined,
        argv: input.command,
        stdin: controller ? null : input.stdin,
        timeout_seconds: input.timeout_seconds,
        keep_stdin_open: Boolean(controller),
        provider_binding: this.providerBinding ?? undefined,
      },
      onOutput,
      input.on_stderr_chunk,
      onLaunched,
    );
    if (controller) void launchedPromise!.then(() => controller.start(sendToController));
    input.process_registry?.registerRemote?.(
      input.run_id,
      () => { this.registry.sendTerminate(this.hostId, input.run_id, false); },
      () => { this.registry.sendTerminate(this.hostId, input.run_id, true); },
    );

    const timeoutMs = input.timeout_seconds > 0 ? input.timeout_seconds * 1000 : null;
    const stallMs = input.stall_timeout_seconds && input.stall_timeout_seconds > 0
      ? input.stall_timeout_seconds * 1000
      : null;
    if (!timeoutMs && !stallMs) {
      const outcome = await completion;
      input.process_registry?.deregister(input.run_id);
      return toExecutionResult(outcome, controller);
    }
    let expiry: "timeout" | "stall_timeout" | null = null;
    const deadlines: Array<Promise<null>> = [];
    if (timeoutMs) {
      deadlines.push(new Promise<null>((resolve) => {
        const timer = setTimeout(() => { expiry ??= "timeout"; resolve(null); }, timeoutMs);
        timer.unref?.();
      }));
    }
    if (stallMs) {
      deadlines.push(new Promise<null>((resolve) => {
        // Re-armed rather than a single timer: the deadline is measured from
        // the last output, not from launch, so a run producing events stays
        // alive indefinitely under the run timeout alone.
        const check = () => {
          const idleMs = Date.now() - lastOutputAt;
          if (idleMs >= stallMs) { expiry ??= "stall_timeout"; resolve(null); return; }
          const timer = setTimeout(check, stallMs - idleMs);
          timer.unref?.();
        };
        const timer = setTimeout(check, stallMs);
        timer.unref?.();
      }));
    }
    const outcome = await Promise.race([completion, ...deadlines]);
    input.process_registry?.deregister(input.run_id);
    if (expiry || !outcome) {
      this.registry.sendTerminate(this.hostId, input.run_id, true);
      return {
        returncode: 1,
        stdout: "",
        stderr: "",
        timed_out: true,
        failure_code: expiry ?? "timeout",
        idle_seconds: Math.round((Date.now() - lastOutputAt) / 1000),
      };
    }
    return toExecutionResult(outcome, controller);
  }
}

function toExecutionResult(
  outcome: { exit_code: number; timed_out: boolean; error: string | null },
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
    timed_out: outcome.timed_out,
  };
}
