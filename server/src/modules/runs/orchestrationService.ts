import type {
  InvocationDelivery,
  RunAdapterResultEnvelope,
  RunExecuteRequest,
  RunInputEnvelope,
  RunJobResult,
  RunMaterializationItemSummary,
  RuntimeSemanticEvent,
  ExecutionControlSnapshot,
  TurnContextRequest,
} from "@rainver/protocol";
import { RETRIEVAL_INTENT_MAX_CHARS } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import {
  executeManagedApiNoToolAdapter,
  type ManagedApiNoToolAdapterDeps,
} from "./managedApiAdapter.js";
import {
  executeVendorCliAdapter,
  type VendorCliAdapterDeps,
} from "./vendorCliAdapter.js";
import { executeRemoteHostCliAdapter } from "./remoteHostCliAdapter.js";
import { PgHostThreadEventRepository, createSerializedThreadEventSink } from "../hosts/threadEventRepository.js";
import { serializeCalls } from "../routeUtils/common.js";
import { AgentGroupRunLifecycleProjector } from "../agentGroups/lifecycleProjector.js";
import type { CliProcessRegistry } from "./localCliExecution.js";
import { PgRunRepository } from "./repository.js";
import { dispatchesToHostDaemon } from "./runRemoteness.js";
import type {
  RunEventInput,
  RunRecord,
  RunStepInput,
  RunStepRecord,
  RunTerminalUpdate,
  ConversationRuntimeTerminalSync,
} from "./repository.js";
import {
  EPHEMERAL_CLEANUP_KIND,
  prepareEphemeralDir,
  removeEphemeralDir,
  workingDirScopeForLevel,
} from "./ephemeralSandbox.js";
import {
  prepareConversationRuntimeState,
  removeConversationRuntimeState,
} from "./conversationRuntimeState.js";
import type { RunSandboxManagerPort } from "../projectFolders/index.js";
import {
  getRuntimeAdapterSpec,
  isVendorCliAdapter,
  type RuntimeExecutorFamily,
} from "../runtimeAdapters/index.js";
import type { RunMaterializationService } from "./materializationService.js";
import {
  createProductionRuntimeContextInvocationGateway,
  RuntimeContextCliContinuityService,
  WorkContextService,
  type RuntimeContextGatewayPort,
  type RuntimeContextInvocationGatewayPort,
} from "../runtimeContext/index.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { enforce, type EnforceResult } from "../policy/service.js";
import {
  ExecutionControlSnapshotRepository,
  type EffectiveRunContextBindings,
} from "../policy/executionControlSnapshots.js";
import { RuntimeContextPolicyRepository } from "../policy/runtimeContextPolicyRepository.js";
import { RuntimeToolRegistry } from "../runtimeTools/index.js";
import { resolveRuntimeToolVersionForSpace } from "../runtimeTools/policies.js";
import { PgRouteDecisionRepository } from "../routing/repository.js";
import { RunApprovalRequiredError, RunPreparationError } from "./orchestrationErrors.js";
import { resolveSandboxLevelForRuntime } from "./runRepositoryHelpers.js";
import {
  credentialPolicyMetadata,
  managedExecutionPolicyFromContract,
} from "../policy/managedExecutionPolicy.js";
import {
  adapterFailureEnvelope,
  adapterTimeoutEnvelope,
  canonicalRunOutput,
  semanticFailureErrorJson,
  semanticRunFailure,
  errorMessage,
  inputWithPreparedRuntime,
  isHardTerminalRunStatus,
  isTerminalRunStatus,
  materializationEventStatus,
  managedToolDegradation,
  outputJsonWithMaterialization,
  protocolRunStatus,
  recordValue,
  summarizeOutput,
  terminalStatusFromAdapter,
  toRunPreparationError,
  waitingForDependencyFromAdapter,
  withTimeout,
} from "./orchestrationResults.js";
import type {
  VerificationEnginePort,
  VerificationResultRecord,
} from "./verification/index.js";
import { assembleRunInputEnvelope } from "./runInputEnvelope.js";
import {
  createRunInvocationAttemptLifecycle,
  type RunInvocationAttemptLifecycle,
} from "./runtimeContextAttempts.js";
import { publishChatTextDelta } from "../streaming/conversationDeltaBus.js";
import { CliCredentialBroker } from "../providers/cli/credentialBroker.js";
import {
  RunExchangeManager,
  type RunExchangeHandle,
  type RunExchangePort,
} from "./runExchange.js";
import {
  recordUsageObservation,
} from "../usage/service.js";
import type { UsageObservation } from "../usage/types.js";
import { PgConversationRuntimeSessionRepository } from "../sessions/conversationRuntimeSessionRepository.js";

export interface RunExecutionRepositoryPort {
  getRun(spaceId: string, runId: string): Promise<RunRecord | null>;
  resolveRunActorId(
    run: Pick<RunRecord, "space_id" | "instructed_by_user_id">,
    commandSource: string,
  ): Promise<string>;
  markRunRunning(input: {
    run_id: string;
    space_id: string;
    started_at: string;
    required_sandbox_level?: string | null;
  }): Promise<RunRecord | null>;
  checkRunExecutionAuthorization?(run: Pick<
    RunRecord,
    | "space_id"
    | "instructed_by_user_id"
    | "project_id"
    | "project_folder_id"
    | "run_group_id"
  >): Promise<{
    allowed: boolean;
    error_code?: string;
    error_message?: string;
  }>;
  checkRunDispatchContract(run: Pick<RunRecord, "space_id" | "id" | "root_run_id" | "contract_snapshot_json">): Promise<{
    allowed: boolean;
    error_code?: string;
    error_message?: string;
  }>;
  bindRunToWorkContext(input: {
    run_id: string;
    space_id: string;
    project_id: string | null;
    project_folder_id: string | null;
    agent_id: string;
    runtime_profile_id: string | null;
  }): Promise<RunRecord | null>;
  updateRunSandboxLevel(input: {
    run_id: string;
    space_id: string;
    required_sandbox_level: string;
  }): Promise<void>;
  markRunTerminal(input: RunTerminalUpdate): Promise<RunRecord | null>;
  markRunTerminalWithConversationSession(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null>;
  publishRunTerminal(input: RunTerminalUpdate): Promise<RunRecord | null>;
  publishRunTerminalWithConversationSession(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null>;
  markRunCancelling?(input: {
    run_id: string;
    space_id: string;
    requested_at: string;
    reason?: string | null;
    requested_by_user_id?: string | null;
  }): Promise<RunRecord | null>;
  appendRunEvent(input: RunEventInput): Promise<unknown>;
  createRunStep(input: RunStepInput): Promise<RunStepRecord>;
  updateRunStepStatus(input: {
    step_id: string;
    run_id: string;
    space_id: string;
    status: "succeeded" | "failed" | "skipped" | "cancelled";
    ended_at: string;
    output_summary?: string | null;
    error_type?: string | null;
    error_message?: string | null;
  }): Promise<boolean>;
  tryAcquireExecutionLock(input: {
    run_id: string;
    worker_id: string;
    job_id?: string | null;
  }): Promise<boolean>;
  releaseExecutionLock(runId: string): Promise<void>;
  markRunWaitingForReview(input: {
    run_id: string;
    space_id: string;
    approval_code: string;
    message: string;
    paused_at: string;
  }): Promise<RunRecord | null>;
  markRunWaitingForDependency(input: {
    run_id: string;
    space_id: string;
    output_json: unknown;
    paused_at: string;
  }): Promise<RunRecord | null>;
  markRunWaitingForDependencyWithConversationSession?(
    input: {
      run_id: string;
      space_id: string;
      output_json: unknown;
      paused_at: string;
    },
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null>;
}

export interface RunExecutionAdapterDeps {
  managedApi?: ManagedApiNoToolAdapterDeps;
  vendorCli?: VendorCliAdapterDeps;
  materializer?: RunMaterializationService;
  runtimeContextGateway?: RuntimeContextInvocationGatewayPort
    & Partial<Pick<RuntimeContextGatewayPort, "ingestRuntimeEvent" | "recordRuntimeEventGap">>;
  ensureWorkContextSetup?: (
    identity: { spaceId: string; userId: string },
    scopeId: string,
    invocation: { agentId: string; runtimeProfileId: string | null },
  ) => Promise<Record<string, unknown>>;
  workspaceManager?: RunSandboxManagerPort;
  codePatchCollector?: RunCodePatchCollectorPort;
  verificationEngine?: VerificationEnginePort;
  policyEnforcer?: RunPolicyEnforcer;
  executionControlSnapshotWriter?: (
    run: RunRecord,
    inputs: {
      cliCredentialProfileId: string | null;
      policyDecisionRecordIds: string[];
      executesRemotely?: boolean;
    },
    effectiveBindings?: EffectiveRunContextBindings,
  ) => Promise<ExecutionControlSnapshot>;
  workContextResolver?: (
    run: RunRecord,
    requiredSetupRef?: { type: "work_context_setup"; id: string; version: string } | null,
  ) => Promise<EffectiveRunContextBindings>;
  runtimeToolVersionResolver?: RunRuntimeToolVersionResolver;
  delegationProjector?: RunDelegationLifecycleProjectorPort;
  /**
   * Shared active-execution registry. CLI execution registers Runner process
   * callbacks and managed API execution registers its AbortController here;
   * cancelRun terminates either through the same interface. Must be the same
   * instance across HTTP routes and the job worker.
   */
  processRegistry?: CliProcessRegistry;
  routeResolver?: RunRouteResolverPort;
  runExchange?: RunExchangePort;
  /**
   * ADR 0016 P2 / execution-topology-and-project-control-plane-plan.md P1
   * (D3): resolves a Run's execution site for `HostExecutionPort` selection.
   * `workspaceLocationId` is authoritative when present (every Run dispatched
   * through the merged endpoint carries one); `projectFolderId` is the
   * fallback for a Run that predates it, resolved via that Folder's
   * `preferred` Location.
   */
  hostKindResolver?: (input: { workspaceLocationId: string | null; projectFolderId: string | null; spaceId: string }) => Promise<{ hostKind: HostKind; hostId: string; workspaceLocationId: string }>;
  usageRecorder?: (observation: UsageObservation) => Promise<void>;
  conversationRuntimeSessions?: {
    record(input: {
      binding_id: string;
      runtime_state_key: string;
      runtime_session_id: string;
      context_fingerprint: string;
      message_cursor_id?: string | null;
    }): Promise<boolean>;
    invalidate(input: {
      binding_id: string;
      runtime_state_key: string;
    }): Promise<boolean>;
  };
  cliContinuity?: RuntimeContextCliContinuityService;
}

export interface RunRouteResolverPort {
  routeRun(run: RunRecord): Promise<RunRecord>;
}

export interface RunDelegationLifecycleProjectorPort {
  markDelegatedRunRunning(run: RunRecord): Promise<void>;
  markDelegatedRunTerminal(run: RunRecord): Promise<void>;
  reconcileWaitingRun?(run: RunRecord): Promise<void>;
}

export type RunPolicyEnforcer = (
  request: Parameters<typeof enforce>[2],
) => Promise<EnforceResult>;

export type RunRuntimeToolVersionResolver = (input: {
  spaceId: string;
  runtime: string;
  requestedVersion: string | null;
}) => Promise<string>;

export interface RunCodePatchCollectorPort {
  collect(input: {
    run: RunRecord;
    worktreePath: string | null;
    baseCommitSha: string | null;
    proposalStatus?: "pending" | "staged";
  }): Promise<{ item: RunMaterializationItemSummary; errors: string[] } | null>;
}

export type HostKind = "server" | "remote";

/**
 * ADR 0016 / execution-topology plan P1: the run-file-lifecycle seam a Run's
 * execution is bound to — prepare/cleanup the workspace, run exchange, and
 * code-patch collection — selected once per run from its Location's Host
 * kind (`resolveExecutionPort`, below). `ServerHostExecutionAdapter` wraps
 * the existing sandbox/exchange/code-patch pieces; `RemoteHostExecutionAdapter`
 * dispatches over the daemon and collects uploaded payloads. The CLI process
 * executor (`CliCommandExecutor`) and artifact materialization remain outside
 * this seam because both host adapters share those higher-level services.
 */
export interface HostExecutionPort {
  readonly hostKind: HostKind;
  /** Set only for a remote port — which daemon connection to dispatch to. */
  readonly hostId?: string;
  /** Set only for a remote port — which WorkspaceLocation this Run executes in (D3). */
  readonly workspaceLocationId?: string;
  readonly workspaceManager?: RunSandboxManagerPort;
  readonly codePatchCollector?: RunCodePatchCollectorPort;
  readonly runExchange: RunExchangePort;
}

export class ServerHostExecutionAdapter implements HostExecutionPort {
  readonly hostKind: HostKind = "server";
  constructor(
    readonly workspaceManager: RunSandboxManagerPort | undefined,
    readonly codePatchCollector: RunCodePatchCollectorPort | undefined,
    readonly runExchange: RunExchangePort,
  ) {}
}

/**
 * ADR 0016 P1: a remote run always dispatches with `required_sandbox_level:
 * "none"` (the dispatch endpoint's job), so `workingDirScopeForLevel`
 * naturally skips every local-filesystem branch in `prepareRuntimeContext` —
 * `sandbox_cwd`/`cleanup`/`exchange` never get set, so `workspaceManager`/
 * `codePatchCollector`/`runExchange` are never actually invoked for a
 * remote run. `runExchange` still needs a real (non-optional)
 * `RunExchangePort` value to satisfy the interface; this one throws instead
 * of silently touching a local path if that "never invoked" assumption is
 * ever violated by a future change.
 */
export class RemoteHostExecutionAdapter implements HostExecutionPort {
  readonly hostKind: HostKind = "remote";
  readonly workspaceManager = undefined;
  readonly codePatchCollector = undefined;
  readonly runExchange: RunExchangePort = {
    prepare: () => { throw new Error("RemoteHostExecutionAdapter: Run Exchange has no meaning on a remote host (D7)."); },
    collect: () => { throw new Error("RemoteHostExecutionAdapter: Run Exchange has no meaning on a remote host (D7)."); },
    cleanup: () => { throw new Error("RemoteHostExecutionAdapter: Run Exchange has no meaning on a remote host (D7)."); },
  };
  constructor(
    readonly hostId: string,
    readonly workspaceLocationId: string,
  ) {}
}

export interface RunExecutionInput extends RunExecuteRequest {
  run_input?: RunInputEnvelope;
  prompt?: string | null;
  /**
   * The turn's retrieval query, when the caller has one that is not its prompt.
   * Internal batch runs send a whole rendered instruction as `prompt` (Source
   * screening renders sixteen items into it) while the meaningful query is the
   * rule's goal, so they pass it here instead of leaving retrieval to guess
   * from a truncated instruction.
   */
  retrieval_intent?: string | null;
  system_prompt?: string | null;
  model?: string | null;
  max_tokens?: number | null;
  context_text?: string | null;
  sandbox_cwd?: string | null;
  adapter_config?: Record<string, unknown>;
  risk_level?: string | null;
  timeout_ms?: number | null;
  /** Internal cancellation ownership for managed provider execution. */
  abort_signal?: AbortSignal;
  runtime_event_sink?: (event: RuntimeSemanticEvent) => Promise<void> | void;
  text_delta_sink?: (delta: string) => void;
  invocation_delivery?: InvocationDelivery;
  invocation_attempts?: RunInvocationAttemptLifecycle;
  /** ADR 0016 P3: set by `executeRun` from `preparedRuntime.execution_port`; read by `invokeAdapterUnbounded` to route a `local_cli` run to the remote-host adapter instead of `executeVendorCliAdapter`. */
  execution_port?: HostExecutionPort | null;
}

type RuntimeAdapterExecutor = (
  config: ServerConfig,
  run: RunRecord,
  input: RunExecutionInput,
  deps: RunExecutionAdapterDeps,
) => Promise<RunAdapterResultEnvelope>;

const RUNTIME_EXECUTORS: Readonly<Record<RuntimeExecutorFamily, RuntimeAdapterExecutor>> = {
  managed_api: (config, run, input, deps) =>
    executeManagedApiNoToolAdapter(
      config,
      {
        run,
        run_input: input.run_input ?? assembleRunInputEnvelope(run, {
          prompt: input.prompt,
          riskLevel: input.risk_level,
        }),
        model: input.model ?? null,
        system_prompt: input.system_prompt ?? run.system_prompt ?? null,
        prompt: input.prompt ?? null,
        context_text: input.context_text ?? null,
        max_tokens: input.max_tokens ?? null,
        text_delta_sink: input.text_delta_sink,
        abort_signal: input.abort_signal,
        invocation_delivery: input.invocation_delivery,
        invocation_attempts: input.invocation_attempts,
      },
      deps.managedApi,
    ),
  local_cli: (config, run, input, deps) =>
    executeVendorCliAdapter(
      config,
      {
        run,
        run_input: input.run_input ?? assembleRunInputEnvelope(run, {
          prompt: input.prompt,
          riskLevel: input.risk_level,
        }),
        prompt: input.prompt ?? null,
        model: input.model ?? null,
        sandbox_cwd: input.sandbox_cwd ?? null,
        context_text: input.context_text ?? null,
        adapter_config: input.adapter_config ?? {},
        risk_level: input.risk_level ?? null,
        trigger_origin: run.trigger_origin,
        process_registry: deps.processRegistry,
        runtime_event_sink: input.runtime_event_sink,
        text_delta_sink: input.text_delta_sink,
        invocation_delivery: input.invocation_delivery,
        invocation_attempts: input.invocation_attempts,
      },
      deps.vendorCli,
    ),
  native: (_config, run) =>
    Promise.resolve(
      adapterFailureEnvelope(
        run,
        "runtime_adapter_not_implemented",
        `Runtime adapter '${run.adapter_type ?? "unknown"}' is not executable in server runs.`,
      ),
    ),
  custom: (_config, run) =>
    Promise.resolve(
      adapterFailureEnvelope(
        run,
        "runtime_adapter_not_implemented",
        `Runtime adapter '${run.adapter_type ?? "unknown"}' is not executable in server runs.`,
      ),
    ),
};

interface PreparedRuntimeContext {
  prompt: string | null;
  sandbox_cwd: string | null;
  context_cwd: string | null;
  context_text: string | null;
  adapter_config: Record<string, unknown>;
  risk_level: string | null;
  cleanup: {
    cleanup_kind: string;
    sandbox_cwd: string | null;
    project_folder_root: string | null;
  } | null;
  sandbox_kind: string | null;
  base_commit_sha: string | null;
  run_input: RunInputEnvelope;
  exchange: RunExchangeHandle | null;
  invocation_delivery: InvocationDelivery | null;
  invocation_attempts: RunInvocationAttemptLifecycle | null;
  cli_execution_lease: { binding_id: string; lease_id: string } | null;
  /** Resolved once per run by `resolveExecutionPort`; null until then. */
  execution_port: HostExecutionPort | null;
}

interface ResolvedRuntimePolicy {
  adapter_type: string | null;
  adapter_config: Record<string, unknown>;
  risk_level: string | null;
  required_sandbox_level: string | null;
  policy_decision_record_ids: string[];
}

export class RunOrchestrationService {
  private readonly delegationProjector: RunDelegationLifecycleProjectorPort | null;
  private readonly routeResolver: RunRouteResolverPort | null;
  private readonly runExchange: RunExchangePort;
  private readonly usageRecorder: ((observation: UsageObservation) => Promise<void>) | null;
  private readonly conversationRuntimeSessions:
    NonNullable<RunExecutionAdapterDeps["conversationRuntimeSessions"]> | null;
  private readonly executionControlSnapshotWriter:
    NonNullable<RunExecutionAdapterDeps["executionControlSnapshotWriter"]> | null;
  private readonly workContextResolver:
    NonNullable<RunExecutionAdapterDeps["workContextResolver"]> | null;
  private readonly runtimeContextGateway: (RuntimeContextInvocationGatewayPort
    & Partial<Pick<RuntimeContextGatewayPort, "ingestRuntimeEvent" | "recordRuntimeEventGap">>) | null;
  private readonly ensureWorkContextSetup:
    NonNullable<RunExecutionAdapterDeps["ensureWorkContextSetup"]> | null;
  private readonly cliContinuity: RuntimeContextCliContinuityService | null;
  private readonly serverExecutionPort: ServerHostExecutionAdapter;
  private readonly hostKindResolver: ((input: { workspaceLocationId: string | null; projectFolderId: string | null; spaceId: string }) => Promise<{ hostKind: HostKind; hostId: string; workspaceLocationId: string }>) | null;

  constructor(
    private readonly config: ServerConfig,
    private readonly repository: RunExecutionRepositoryPort | PgRunRepository,
    private readonly adapters: RunExecutionAdapterDeps = {},
  ) {
    this.delegationProjector =
      adapters.delegationProjector
      ?? (repository instanceof PgRunRepository
        ? AgentGroupRunLifecycleProjector.fromConfig(config)
        : null);
    this.routeResolver = adapters.routeResolver
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? new PgRouteDecisionRepository(
            getDbPool(config.databaseUrl),
            undefined,
            new CliCredentialBroker(config),
          )
        : null);
    this.runExchange = adapters.runExchange ?? new RunExchangeManager(config.sandboxRoot);
    this.serverExecutionPort = new ServerHostExecutionAdapter(
      adapters.workspaceManager,
      adapters.codePatchCollector,
      this.runExchange,
    );
    this.hostKindResolver = adapters.hostKindResolver
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? async ({ workspaceLocationId, projectFolderId, spaceId }) => {
            const pool = getDbPool(config.databaseUrl!);
            const result = workspaceLocationId
              ? await pool.query<{ id: string; execution_host_kind: string; execution_host_id: string }>(
                  `SELECT id, execution_host_kind, execution_host_id FROM workspace_locations WHERE id = $1 AND space_id = $2 LIMIT 1`,
                  [workspaceLocationId, spaceId],
                )
              : projectFolderId
                ? await pool.query<{ id: string; execution_host_kind: string; execution_host_id: string }>(
                    `SELECT id, execution_host_kind, execution_host_id FROM workspace_locations WHERE project_folder_id = $1 AND space_id = $2 AND preferred = true AND status = 'active' LIMIT 1`,
                    [projectFolderId, spaceId],
                  )
                : { rows: [] as Array<{ id: string; execution_host_kind: string; execution_host_id: string }> };
            const row = result.rows[0];
            return {
              hostKind: (row?.execution_host_kind as HostKind | undefined) ?? "server",
              hostId: row?.execution_host_id ?? "",
              workspaceLocationId: row?.id ?? "",
            };
          }
        : null);
    this.usageRecorder = adapters.usageRecorder
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? (observation) => recordUsageObservation(config, observation)
        : null);
    this.conversationRuntimeSessions = adapters.conversationRuntimeSessions
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? new PgConversationRuntimeSessionRepository(getDbPool(config.databaseUrl))
        : null);
    this.cliContinuity = adapters.cliContinuity
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? new RuntimeContextCliContinuityService(getDbPool(config.databaseUrl))
        : null);
    const databaseUrl = config.databaseUrl;
    this.runtimeContextGateway = adapters.runtimeContextGateway
      ?? (repository instanceof PgRunRepository && databaseUrl
        ? createProductionRuntimeContextInvocationGateway(getDbPool(databaseUrl), config)
        : null);
    this.ensureWorkContextSetup = adapters.ensureWorkContextSetup
      ?? (repository instanceof PgRunRepository && databaseUrl
        ? (identity, scopeId, invocation) => new WorkContextService(getDbPool(databaseUrl))
            .ensureForInvocation(identity, scopeId, invocation)
        : null);
    this.workContextResolver = adapters.workContextResolver
      ?? (repository instanceof PgRunRepository && databaseUrl
        ? (run, requiredSetupRef) => new ExecutionControlSnapshotRepository(getDbPool(databaseUrl))
            .resolveEffectiveBindingsForRun(run, requiredSetupRef)
        : null);
    this.executionControlSnapshotWriter = adapters.executionControlSnapshotWriter
      ?? (repository instanceof PgRunRepository && databaseUrl
          ? async (run, inputs, effectiveBindings) => {
            const pool = getDbPool(databaseUrl);
            const snapshots = new ExecutionControlSnapshotRepository(pool);
            const effective = effectiveBindings ?? await snapshots.resolveEffectiveBindingsForRun(run);
            const resolved = await new RuntimeContextPolicyRepository(pool).resolveForExecution({
              spaceId: run.space_id,
              projectId: effective.projectId,
              projectFolderId: effective.projectFolderId,
              agentId: effective.agentId,
              userId: run.instructed_by_user_id ?? run.owner_user_id ?? null,
            });
            return snapshots.createForRun(run, resolved, inputs, effective);
          }
        : null);
  }

  async executeRun(input: RunExecutionInput): Promise<RunJobResult> {
    const startedAt = new Date().toISOString();
    const run = await this.repository.getRun(input.space_id, input.run_id);
    if (!run) {
      return {
        run_id: input.run_id,
        status: "unknown",
        error_code: "run_not_found",
        error: "Run not found in this space.",
      };
    }
    if (run.run_role === "coordinator") {
      return {
        run_id: run.id,
        status: protocolRunStatus(run.status),
        skipped: true,
        skip_reason: "coordinator_run_not_executable",
      };
    }
    if (isTerminalRunStatus(run.status)) {
      await this.markDelegatedRunTerminal(run);
      return {
        run_id: run.id,
        status: run.status,
        skipped: true,
        skip_reason: "run_already_terminal",
      };
    }
    if (run.status === "waiting_for_dependency") {
      return {
        run_id: run.id,
        status: "waiting_for_dependency",
        skipped: true,
        skip_reason: "run_waiting_for_dependency",
      };
    }

    const locked = await this.repository.tryAcquireExecutionLock({
      run_id: run.id,
      worker_id: input.worker_id,
      job_id: input.job_id ?? null,
    });
    if (!locked) {
      // Duplicate execution returns the error result without writing run
      // evidence (event_type has a closed CHECK constraint).
      return {
        run_id: run.id,
        status: protocolRunStatus(run.status),
        skipped: true,
        skip_reason: "duplicate_execution",
        error_code: "duplicate_execution",
        error: "Run is already being executed by another worker.",
      };
    }

    let executionLockHeld = true;
    let step: RunStepRecord | null = null;
    let preparedRuntime: PreparedRuntimeContext | null = null;
    const releaseExecutionAuthority = async (): Promise<void> => {
      await this.cleanupRuntimeContext(preparedRuntime, run);
      if (!executionLockHeld) return;
      await this.repository.releaseExecutionLock(run.id);
      executionLockHeld = false;
    };
    try {
      let effectiveBindings = this.workContextResolver
        ? await this.workContextResolver(run)
        : undefined;
      if (effectiveBindings && this.ensureWorkContextSetup) {
        const userId = run.instructed_by_user_id ?? run.owner_user_id;
        if (!userId) throw new RunPreparationError("work_context_user_required", "Managed Runtime Context requires an instructing user.");
        const ensuredSetup = await this.ensureWorkContextSetup(
          { spaceId: run.space_id, userId },
          effectiveBindings.workContextScopeId,
          {
            agentId: run.agent_id,
            runtimeProfileId:
              run.requested_runtime_profile_id
              ?? effectiveBindings.runtimeProfileId
              ?? run.runtime_profile_id
              ?? null,
          },
        );
        const ensuredSetupRef = workContextSetupRef(ensuredSetup);
        if (!ensuredSetupRef) {
          throw new RunPreparationError(
            "work_context_setup_invalid",
            "Managed Runtime Context setup did not return an immutable version reference.",
          );
        }
        effectiveBindings = this.workContextResolver
          ? await this.workContextResolver(run, ensuredSetupRef)
          : effectiveBindings;
      }
      const proposedContextBoundRun = applyEffectiveWorkContextBindings(run, effectiveBindings);
      const currentAuthorization =
        await this.repository.checkRunExecutionAuthorization?.(proposedContextBoundRun)
        ?? { allowed: true };
      if (!currentAuthorization.allowed) {
        const rejected = await this.publishRunTerminalWithConversationRuntime({
          run_id: run.id,
          space_id: run.space_id,
          status: "failed",
          output_text: "",
          output_json: canonicalRunOutput({
            success: false,
            outputText: "",
            outputJson: {
              error_code:
                currentAuthorization.error_code
                ?? "run_execution_authorization_revoked",
            },
          }),
          error_json: {
            error_code:
              currentAuthorization.error_code
              ?? "run_execution_authorization_revoked",
            error_text:
              currentAuthorization.error_message
              ?? "Run execution authorization is no longer active.",
          },
          exit_code: 1,
          completed_at: startedAt,
        }, run, null, false);
        await releaseExecutionAuthority();
        return {
          run_id: run.id,
          status: protocolRunStatus(rejected?.status ?? "failed"),
          skipped: true,
          skip_reason: "execution_authorization_revoked",
          error_code:
            currentAuthorization.error_code
            ?? "run_execution_authorization_revoked",
          error:
            currentAuthorization.error_message
            ?? "Run execution authorization is no longer active.",
        };
      }
      if (effectiveBindings?.workContextSetupRef && !effectiveBindings.agentId) {
        throw new RunPreparationError(
          "work_context_agent_required",
          "Work Context Setup requires an active Agent.",
        );
      }
      const persistedContextBoundRun = effectiveBindings?.workContextSetupRef
        ? await this.repository.bindRunToWorkContext({
            run_id: run.id,
            space_id: run.space_id,
            project_id: effectiveBindings.projectId,
            project_folder_id: effectiveBindings.projectFolderId,
            agent_id: effectiveBindings.agentId!,
            runtime_profile_id: effectiveBindings.runtimeProfileId,
          })
        : run;
      if (!persistedContextBoundRun) {
        throw new RunPreparationError(
          "work_context_binding_stale",
          "Work Context Setup could not be bound to the queued Run.",
        );
      }
      const contextBoundRun = applyEffectiveWorkContextBindings(
        persistedContextBoundRun,
        effectiveBindings,
      );
      const routed = this.routeResolver ? await this.routeResolver.routeRun(contextBoundRun) : contextBoundRun;
      // Routing persists only route-owned columns. Reapply the immutable Setup
      // bindings to the returned read model so policy, sandbox preparation, and
      // adapter execution all observe the same Project/Folder/Agent selection.
      const routedRun = applyEffectiveWorkContextBindings(routed, effectiveBindings);
      const dispatchContract = await this.repository.checkRunDispatchContract(routedRun);
      if (!dispatchContract.allowed) {
        await this.cleanupRuntimeContext(preparedRuntime, run);
        let rejected = await this.publishRunTerminalWithConversationRuntime({
          run_id: run.id,
          space_id: run.space_id,
          status: "failed",
          output_text: "",
          output_json: canonicalRunOutput({
            success: false,
            outputText: "",
            outputJson: { error_code: dispatchContract.error_code ?? "run_contract_dispatch_denied" },
          }),
          error_json: {
            error_code: dispatchContract.error_code ?? "run_contract_dispatch_denied",
            error_text: dispatchContract.error_message ?? "Run contract rejected dispatch.",
          },
          exit_code: 1,
          completed_at: startedAt,
        }, run, null, false);
        if (!rejected) {
          const current = await this.repository.getRun(run.space_id, run.id);
          if (current?.status === "cancelling") {
            rejected = await this.publishRunTerminalWithConversationRuntime({
              run_id: run.id,
              space_id: run.space_id,
              status: "cancelled",
              output_text: "",
              output_json: canonicalRunOutput({
                success: false,
                outputText: "",
                outputJson: { error_code: "run_cancelled" },
              }),
              error_json: {
                error_code: "run_cancelled",
                error_text: "Run cancellation won the terminal publication race.",
              },
              exit_code: 1,
              completed_at: startedAt,
            }, run, null, false);
          }
        }
        if (rejected) executionLockHeld = false;
        const finalization = await this.finalizeTerminalRunBestEffort(
          rejected ?? { ...run, status: "failed", ended_at: startedAt },
        );
        const current = this.adapters.materializer
          ? await this.repository.getRun(run.space_id, run.id)
          : rejected;
        if (finalization?.status === "failed") {
          return {
            run_id: run.id,
            status: protocolRunStatus(current?.status ?? "failed"),
            error_code: "finalization_failed",
            error:
              finalization.error_message ?? "Run finalization failed.",
          };
        }
        return {
          run_id: run.id,
          status: protocolRunStatus(current?.status ?? rejected?.status ?? "failed"),
          error_code: dispatchContract.error_code ?? "run_contract_dispatch_denied",
          error: dispatchContract.error_message ?? "Run contract rejected dispatch.",
        };
      }
      const running = await this.repository.markRunRunning({
        run_id: run.id,
        space_id: run.space_id,
        started_at: startedAt,
        required_sandbox_level: run.required_sandbox_level,
      });
      if (!running) {
        const current = await this.repository.getRun(run.space_id, run.id);
        return {
          run_id: run.id,
          status: protocolRunStatus(current?.status ?? run.status),
          skipped: true,
          skip_reason: "run_not_queued",
        };
      }
      const contextBoundRunning = applyEffectiveWorkContextBindings(running, effectiveBindings);
      await this.markDelegatedRunRunningBestEffort(contextBoundRunning);

      // ADR 0016 P3: resolved once, here, rather than separately inside
      // `enforceRuntimePolicy` and `prepareRuntimeContext` — both need to
      // agree on the same host_kind for the same run, and re-querying
      // per-caller risks the two disagreeing under a concurrent host change.
      const executionPort = await this.resolveExecutionPort(contextBoundRunning);
      // Policy gate + server-owned adapter resolution first. The run row and
      // agent/runtime configuration own the adapter and sandbox level; request
      // bodies never override executable paths, permissions, or runtime policy.
      const resolved = await this.enforceRuntimePolicy(contextBoundRunning, input, executionPort.hostKind);
      const effectiveRun: RunRecord = {
        ...contextBoundRunning,
        adapter_type: resolved.adapter_type,
        // Honor the policy-resolved sandbox level (e.g. ephemeral for a
        // no-workspace CLI run); the stored row level is the creation-time
        // default and is not re-derived under server authority.
        required_sandbox_level:
          resolved.required_sandbox_level ?? contextBoundRunning.required_sandbox_level,
      };
      const executionControlSnapshot = this.executionControlSnapshotWriter
        ? await this.executionControlSnapshotWriter(effectiveRun, {
            cliCredentialProfileId: isVendorCliAdapter(effectiveRun.adapter_type)
              ? stringConfigValue(resolved.adapter_config.credential_profile_id)
              : null,
            policyDecisionRecordIds: resolved.policy_decision_record_ids,
            // Only a run handed to a daemon resolves its provider at launch
            // rather than here; anything else executes in-process against the
            // provider this run already records.
            executesRemotely: dispatchesToHostDaemon(effectiveRun.adapter_type, executionPort.hostKind),
          }, effectiveBindings)
        : null;
      // Persist the resolved level so the run read model / trace reflects what
      // actually executed (not the creation-time default).
      if (
        effectiveRun.required_sandbox_level &&
        effectiveRun.required_sandbox_level !== running.required_sandbox_level
      ) {
        await this.repository.updateRunSandboxLevel({
          run_id: effectiveRun.id,
          space_id: effectiveRun.space_id,
          required_sandbox_level: effectiveRun.required_sandbox_level,
        });
      }
      // A single stdout chunk from a CLI adapter can carry several JSONL
      // lines that each normalize to a RuntimeSemanticEvent (e.g. a tool_use
      // block immediately followed by its tool_result) — the caller fires
      // one un-awaited `runtime_event_sink` call per event
      // (`for (const event of eventStream.push(chunk)) void
      // runtime_event_sink?.(event)` in both vendorCliAdapter.ts and
      // remoteHostCliAdapter.ts). `appendRunEvent`'s `event_index` is a
      // fresh `COALESCE(MAX+1, 0)` read per INSERT, so two overlapping
      // un-awaited calls for the same run can read the same max and collide
      // on `uq_run_events_space_run_event_index` — found via
      // control-center-phase2-plan.md P1's remote-events test, which is the
      // first coverage to produce two RuntimeSemanticEvents from one chunk
      // for a remote run; the same race exists for the server-host path.
      // `serializeCalls` (routeUtils/common.ts) fixes it by construction.
      // Unlike host_thread_events' equivalent fix, no database-level lock is
      // needed on top of it: run_events' uniqueness is per-run, and
      // tryAcquireExecutionLock already guarantees only one process ever
      // executes a given run, so this in-process chain is the whole story.
      //
      // Swallowing note: `appendRuntimeSemanticEvent` rethrows for
      // "critical" event types, but no caller has ever actually observed
      // that rethrow. `remoteHostCliAdapter.ts` calls this sink via `void`,
      // un-awaited (this process has no unhandledRejection handler, so
      // Node's default there is to crash — a rethrow was observable, just
      // never intentionally). `vendorCliAdapter.ts` (the server-host path)
      // instead collects every call into a `pendingEvents` array and awaits
      // them via `Promise.allSettled`, whose per-item outcomes it never
      // inspects — a rethrow there was already silently absorbed before
      // this phase, by a different mechanism, not a crash. Either way,
      // nothing today reads or acts on a "critical" rethrow's signal.
      // `serializeCalls` turns the `void`-path's crash-on-any-write-hiccup
      // behavior into a swallow too, uniformly — a deliberate call: one
      // run's transient write failure no longer takes the whole process
      // (and every other concurrently executing run) down with it, and
      // nothing that actually enforced anything is lost. Flagged explicitly
      // per P1 discovery/closure review, not silently ridden through.
      const serializedRuntimeEventSink = serializeCalls(
        (event: RuntimeSemanticEvent) => this.appendRuntimeSemanticEvent(effectiveRun, event),
      );
      const effectiveInput: RunExecutionInput = {
        ...input,
        adapter_config: resolved.adapter_config,
        risk_level: resolved.risk_level,
        runtime_event_sink: serializedRuntimeEventSink,
        ...(isChatTurnRun(effectiveRun)
          ? { text_delta_sink: (delta: string) => publishChatTextDelta(effectiveRun.id, delta) }
          : {}),
      };

      // run_steps.actor_id is a non-null Actor FK; worker ids carry transport
      // identity only and go to metadata. Event/step types must stay within
      // the database CHECK constraint lists (ck_run_events_event_type,
      // ck_run_steps_step_type).
      const actorId = await this.repository.resolveRunActorId(
        effectiveRun,
        input.command_source,
      );
      step = await this.createRunStepBestEffort({
        run_id: effectiveRun.id,
        space_id: effectiveRun.space_id,
        actor_id: actorId,
        step_type: "adapter_started",
        status: "running",
        title: "Runtime adapter execution",
        project_folder_id: effectiveRun.project_folder_id,
        session_id: effectiveRun.session_id,
        started_at: startedAt,
        metadata_json: {
          adapter_type: effectiveRun.adapter_type,
          execution_control_snapshot_id: executionControlSnapshot?.id ?? null,
          command_source: input.command_source,
          worker_id: input.worker_id,
        },
      });
      await this.appendRunEventBestEffort({
        run_id: effectiveRun.id,
        space_id: effectiveRun.space_id,
        event_type: "adapter_invoked",
        status: "running",
        step_id: step?.id ?? null,
        actor_id: actorId,
        summary: "Runtime adapter started.",
        project_folder_id: effectiveRun.project_folder_id,
        metadata_json: {
          adapter_type: effectiveRun.adapter_type,
          execution_control_snapshot_id: executionControlSnapshot?.id ?? null,
          command_source: input.command_source,
          worker_id: input.worker_id,
        },
      });

      preparedRuntime = await this.prepareRuntimeContext(
        effectiveRun,
        effectiveInput,
        executionControlSnapshot,
        executionPort,
        effectiveBindings,
      );
      let adapterResult: RunAdapterResultEnvelope;
      try {
        adapterResult = await this.invokeAdapter(
          effectiveRun,
          {
            ...inputWithPreparedRuntime(effectiveInput, preparedRuntime),
            invocation_delivery: preparedRuntime.invocation_delivery ?? undefined,
            invocation_attempts: preparedRuntime.invocation_attempts ?? undefined,
            execution_port: preparedRuntime.execution_port,
          },
        );
      } catch (error) {
        if (preparedRuntime.invocation_delivery && preparedRuntime.invocation_attempts
          && !isManagedApiAdapter(effectiveRun.adapter_type)) {
          await preparedRuntime.invocation_attempts.acknowledge(preparedRuntime.invocation_delivery, {
            success: false,
            error_code: "runtime_adapter_transport_failed",
          });
          await preparedRuntime.invocation_attempts.finalize(
            preparedRuntime.invocation_delivery,
            "runtime_adapter_transport_failed",
          );
        }
        throw error;
      }
      if (preparedRuntime.invocation_delivery && preparedRuntime.invocation_attempts
        && !isManagedApiAdapter(effectiveRun.adapter_type)) {
        await preparedRuntime.invocation_attempts.acknowledge(preparedRuntime.invocation_delivery, adapterResult);
        await preparedRuntime.invocation_attempts.finalize(
          preparedRuntime.invocation_delivery,
          adapterResult.error_code ?? null,
        );
      }
      if (adapterResult.error_code === "runtime_session_invalid"
        && preparedRuntime.cli_execution_lease
        && this.cliContinuity) {
        const replacement = await this.cliContinuity.rotateMissingVendorState(
          preparedRuntime.cli_execution_lease.binding_id,
        );
        preparedRuntime.cli_execution_lease.binding_id = replacement.id;
      }
      if (preparedRuntime.exchange) {
        const exchange = await (preparedRuntime.execution_port?.runExchange ?? this.runExchange).collect(
          preparedRuntime.exchange,
          preparedRuntime.run_input.output_contract.required_outputs,
        );
        const exchangeFailure = adapterResult.success && exchange.errors.length > 0;
        adapterResult = {
          ...adapterResult,
          success: adapterResult.success && !exchangeFailure,
          error_code: exchangeFailure
            ? "run_exchange_output_validation_failed"
            : adapterResult.error_code,
          error_message: exchangeFailure
            ? exchange.errors.join("; ")
            : adapterResult.error_message,
          output_json: {
            ...recordValue(adapterResult.output_json),
            ...(exchange.reported_status === "rejected" ? { status: "rejected" } : {}),
            output_manifest: exchange.manifest,
          },
          exchange_artifact_paths: exchange.artifact_paths,
          runtime_events: [
            ...runtimeSemanticEvents(adapterResult),
            {
              schema_version: "runtime_event.v1",
              type: "output_validation_completed",
              occurred_at: adapterResult.completed_at ?? new Date().toISOString(),
              call_id: null,
              summary: exchange.errors.length > 0
                ? "Run Exchange output validation failed."
                : "Run Exchange output validation completed.",
              metadata_json: {
                output_count: exchange.manifest.length,
                invalid_count: exchange.manifest.filter((item) =>
                  item.status === "missing" || item.status === "invalid" || item.status === "oversized"
                ).length,
              },
            } satisfies RuntimeSemanticEvent,
          ],
        };
      }
      await this.appendRuntimeSemanticEvents(effectiveRun, adapterResult);
      await this.syncCliContinuityVendorSessionBestEffort(
        preparedRuntime.invocation_delivery,
        adapterResult,
      );
      const executionIdentity = input.job_id ?? step?.id ?? effectiveRun.id;
      const completedAt = adapterResult.completed_at ?? new Date().toISOString();
      const waitingForDependency = waitingForDependencyFromAdapter(adapterResult);
      if (waitingForDependency) {
        const waitingInput = {
          run_id: running.id,
          space_id: running.space_id,
          output_json: outputJsonWithMaterialization(
            outputJsonWithRuntimeUsage(adapterResult),
            [],
            [],
          ),
          paused_at: completedAt,
        };
        const conversation = conversationRuntimeTerminalSync(
          effectiveRun,
          adapterResult,
          true,
        );
        const retainedConversation = conversation?.keep_session
          ? conversation
          : null;
        const waitingRun = retainedConversation
          && this.repository.markRunWaitingForDependencyWithConversationSession
          ? await this.repository.markRunWaitingForDependencyWithConversationSession(
              waitingInput,
              retainedConversation,
            )
          : await this.repository.markRunWaitingForDependency(waitingInput);
        if (!waitingRun) {
          const current = await this.repository.getRun(running.space_id, running.id);
          const currentStatus = protocolRunStatus(current?.status ?? "cancelled");
          if (step) await this.updateRunStepStatusBestEffort({
            step_id: step.id,
            run_id: running.id,
            space_id: running.space_id,
            status: "cancelled",
            ended_at: completedAt,
            error_type: "run_cancelled",
            error_message: "Adapter paused after the run was cancelled; wait state not applied.",
          });
          await this.appendRunEventBestEffort({
            run_id: running.id,
            space_id: running.space_id,
            event_type: "adapter_completed",
            status: "cancelled",
            step_id: step?.id ?? null,
            summary: "Adapter paused after the run was cancelled; wait state not applied.",
            error_code: "run_cancelled",
            project_folder_id: running.project_folder_id,
            metadata_json: {
              adapter_type: adapterResult.adapter_type,
              adapter_kind: adapterResult.adapter_kind,
            },
          });
          await this.recordLocalCliUsageBestEffort(
            effectiveRun,
            adapterResult,
            executionIdentity,
          );
          await this.syncConversationRuntimeSessionBestEffort(
            effectiveRun,
            adapterResult,
            false,
          );
          return {
            run_id: running.id,
            status: currentStatus,
            skipped: true,
            skip_reason: "run_already_terminal",
          };
        }
        if (step) await this.updateRunStepStatusBestEffort({
          step_id: step.id,
          run_id: running.id,
          space_id: running.space_id,
          status: "succeeded",
          ended_at: completedAt,
          output_summary: "Waiting for room agent results.",
        });
        await this.appendRunEventBestEffort({
          run_id: running.id,
          space_id: running.space_id,
          event_type: "adapter_completed",
          status: "warning",
          step_id: step?.id ?? null,
          summary: "Runtime adapter paused while waiting for room agent results.",
          project_folder_id: running.project_folder_id,
          metadata_json: {
            adapter_type: adapterResult.adapter_type,
            adapter_kind: adapterResult.adapter_kind,
            waiting_for_results: waitingForDependency,
          },
        });
        await this.recordLocalCliUsageBestEffort(
          effectiveRun,
          adapterResult,
          executionIdentity,
        );
        if (
          !retainedConversation
          || !this.repository.markRunWaitingForDependencyWithConversationSession
        ) {
          await this.syncConversationRuntimeSessionBestEffort(
            effectiveRun,
            adapterResult,
            Boolean(retainedConversation),
          );
        }
        await releaseExecutionAuthority();
        await this.delegationProjector?.reconcileWaitingRun?.(waitingRun);
        return {
          run_id: waitingRun.id,
          status: "waiting_for_dependency",
          metadata_json: { waiting_for_results: waitingForDependency } as RunJobResult["metadata_json"],
        };
      }
      const adapterTerminalStatus = terminalStatusFromAdapter(adapterResult);
      const currentAfterAdapter = await this.repository.getRun(running.space_id, running.id);
      // A tool call mid-run (e.g. `authorization.request`) can pause the Run
      // to `waiting_for_review` transactionally, independent of the adapter's
      // own terminal result. Report that pause instead of overwriting it with
      // a terminal status — the domain, not this transport-generic check, is
      // what set it.
      if (currentAfterAdapter?.status === "waiting_for_review") {
        return {
          run_id: running.id,
          status: "waiting_for_review",
          error_code: "authorization_request_pending",
        };
      }
      let verificationResults: VerificationResultRecord[] = [];
      let semanticFailure = semanticRunFailure(adapterResult, []);
      let validationStarted = false;
      // Delivery persists accumulated input taint after `effectiveRun` was
      // loaded. Carry the live values into every output-producing consumer so
      // materialization and patch collection cannot publish with stale
      // visibility authority.
      const materializationRun: RunRecord = currentAfterAdapter
        ? {
            ...effectiveRun,
            has_context_taint: currentAfterAdapter.has_context_taint,
            context_taint_json: currentAfterAdapter.context_taint_json,
          }
        : effectiveRun;
      const materialization = { items: [], errors: [] } as {
        items: RunMaterializationItemSummary[];
        errors: string[];
      };
      if (this.adapters.verificationEngine && adapterResult.success && !semanticFailure) {
        await this.appendRunEventBestEffort({
          run_id: running.id,
          space_id: running.space_id,
          event_type: "validation_started",
          status: "running",
          project_folder_id: running.project_folder_id,
          metadata_json: { verifier_version: "verification_engine.v1" },
        });
        validationStarted = true;
        verificationResults = await this.adapters.verificationEngine.verify({
          run: materializationRun,
          sandbox_cwd: preparedRuntime?.sandbox_cwd ?? null,
          base_commit_sha: preparedRuntime?.base_commit_sha ?? null,
          output_json: adapterResult.output_json,
          materialization_items: [],
          host_kind: preparedRuntime?.execution_port?.hostKind,
        }, "pre_materialization");
        semanticFailure = semanticRunFailure(adapterResult, verificationResults);
      }
      if (adapterResult.success && !semanticFailure) {
        if (this.adapters.materializer) {
          const persisted = await this.adapters.materializer.materializeAdapterResult({
            run: materializationRun,
            adapterResult,
            sandbox_cwd: preparedRuntime?.sandbox_cwd ?? null,
            exchange_output_cwd: preparedRuntime?.exchange?.output_dir ?? null,
          }, {
            proposal_status: "staged",
          });
          materialization.items.push(...persisted.items);
          materialization.errors.push(...persisted.errors);
        }
        const codePatch = await this.collectCodePatch(
          materializationRun,
          preparedRuntime,
          "staged",
        );
        if (codePatch) {
          materialization.items.push(codePatch.item);
          materialization.errors.push(...codePatch.errors);
        }
        if (this.adapters.verificationEngine) {
          const postMaterialization = await this.adapters.verificationEngine.verify({
            run: materializationRun,
            sandbox_cwd: preparedRuntime?.sandbox_cwd ?? null,
            base_commit_sha: preparedRuntime?.base_commit_sha ?? null,
            output_json: adapterResult.output_json,
            materialization_items: materialization.items,
            host_kind: preparedRuntime?.execution_port?.hostKind,
          }, "post_materialization");
          verificationResults.push(...postMaterialization);
          semanticFailure = semanticRunFailure(
            adapterResult,
            postMaterialization,
          );
        }
      }
      if (validationStarted) {
        await this.appendRunEventBestEffort({
          run_id: running.id,
          space_id: running.space_id,
          event_type: "validation_completed",
          status: verificationStatus(verificationResults),
          project_folder_id: running.project_folder_id,
          metadata_json: {
            verifier_version: "verification_engine.v1",
            result_count: verificationResults.length,
            failed_count: verificationResults.filter((result) => result.status === "failed" || result.status === "error").length,
          },
        });
      }
      const usageRecorded = await this.recordLocalCliUsageBestEffort(
        effectiveRun,
        adapterResult,
        executionIdentity,
      );
      const configuredMaxCost = recordValue(
        effectiveRun.contract_snapshot_json,
      ).max_cost;
      if (
        !usageRecorded
        && typeof configuredMaxCost === "number"
        && Number.isFinite(configuredMaxCost)
        && configuredMaxCost >= 0
      ) {
        semanticFailure = {
          error_code: "usage_recording_failed",
          error_message:
            "CLI usage could not be recorded, so automatic retry is held to preserve the Run cost cap.",
        };
      }
      const toolDegradation = adapterResult.success
        ? managedToolDegradation(adapterResult)
        : null;
      const terminalStatus = semanticFailure
        ? "failed"
        : adapterResult.success && (materialization.errors.length > 0 || toolDegradation)
          ? "degraded"
          : adapterTerminalStatus;

      await this.appendMaterializationEvents(running, materialization.items);
      if (step) await this.updateRunStepStatusBestEffort({
        step_id: step.id,
        run_id: running.id,
        space_id: running.space_id,
        status: adapterResult.success ? "succeeded" : "failed",
        ended_at: completedAt,
        output_summary: adapterResult.success ? summarizeOutput(adapterResult.output_text) : null,
        error_type: adapterResult.error_code ?? null,
        error_message: adapterResult.error_message ?? null,
      });
      await this.appendRunEventBestEffort({
        run_id: running.id,
        space_id: running.space_id,
        event_type: "adapter_completed",
        status: adapterResult.success ? "succeeded" : "failed",
        step_id: step?.id ?? null,
        summary: adapterResult.success
          ? "Runtime adapter completed successfully."
          : "Runtime adapter failed.",
        error_code: adapterResult.error_code ?? null,
        error_message: adapterResult.error_message ?? null,
        project_folder_id: running.project_folder_id,
        metadata_json: {
          adapter_type: adapterResult.adapter_type,
          adapter_kind: adapterResult.adapter_kind,
          exit_code: adapterResult.exit_code,
        },
      });
      if (toolDegradation) {
        await this.appendRunEventBestEffort({
          run_id: running.id,
          space_id: running.space_id,
          event_type: "warning",
          status: "warning",
          step_id: step?.id ?? null,
          summary: `Managed tools were unavailable and the Run answered without them: ${toolDegradation.tool_names.join(", ")}.`,
          error_code: "managed_tool_degraded",
          error_message: null,
          project_folder_id: running.project_folder_id,
          metadata_json: {
            event_code: "managed_tool_degraded",
            tool_names: toolDegradation.tool_names,
            error_codes: toolDegradation.error_codes,
          },
        });
      }
      await this.cleanupRuntimeContext(preparedRuntime, run);
      let terminalRun = await this.publishRunTerminalWithConversationRuntime({
        run_id: running.id,
        space_id: running.space_id,
        status: terminalStatus,
        output_text: adapterResult.output_text,
        output_json: canonicalRunOutput({
          success: adapterResult.success && !semanticFailure,
          outputText: adapterResult.output_text,
          outputJson: outputJsonWithVerification(
            outputJsonWithRuntimeUsage(adapterResult),
            materialization.items,
            materialization.errors,
            verificationResults,
          ),
        }),
        error_json: semanticFailureErrorJson(adapterResult, semanticFailure),
        exit_code: adapterResult.exit_code,
        completed_at: completedAt,
      }, effectiveRun, adapterResult, terminalStatus === "succeeded");
      if (!terminalRun) {
        // Cancellation can linearize before publication by moving the Run to
        // `cancelling`. The execution owner then publishes the cancellation;
        // public cancellation never removes an active execution lock.
        const current = await this.repository.getRun(running.space_id, running.id);
        if (current?.status === "cancelling") {
          terminalRun = await this.publishRunTerminalWithConversationRuntime({
            run_id: running.id,
            space_id: running.space_id,
            status: "cancelled",
            output_text: "",
            output_json: canonicalRunOutput({
              success: false,
              outputText: "",
              outputJson: { error_code: "run_cancelled" },
            }),
            error_json: {
              error_code: "run_cancelled",
              error_text: "Run cancellation won the terminal publication race.",
            },
            exit_code: 1,
            completed_at: completedAt,
          }, effectiveRun, null, false);
        }
        if (terminalRun) {
          executionLockHeld = false;
          return {
            run_id: running.id,
            status: "cancelled",
            error_code: "run_cancelled",
          };
        }
        // A hard terminal state published elsewhere owns the result.
        const currentStatus = protocolRunStatus(current?.status ?? "cancelled");
        if (step) await this.updateRunStepStatusBestEffort({
          step_id: step.id,
          run_id: running.id,
          space_id: running.space_id,
          status: "cancelled",
          ended_at: completedAt,
          error_type: "run_cancelled",
          error_message: "Adapter finished after the run was cancelled; result not applied.",
        });
        await this.appendRunEventBestEffort({
          run_id: running.id,
          space_id: running.space_id,
          event_type: "adapter_completed",
          status: "cancelled",
          step_id: step?.id ?? null,
          summary: "Adapter finished after the run was cancelled; result not applied.",
          error_code: "run_cancelled",
          project_folder_id: running.project_folder_id,
          metadata_json: {
            adapter_type: adapterResult.adapter_type,
            adapter_kind: adapterResult.adapter_kind,
            exit_code: adapterResult.exit_code,
          },
        });
        return {
          run_id: running.id,
          status: currentStatus,
          skipped: true,
          skip_reason: "run_already_terminal",
        };
      }
      executionLockHeld = false;
      let finalTerminalRun = terminalRun;
      let returnedStatus: RunJobResult["status"] = terminalStatus;
      let finalizationFailure: RunMaterializationItemSummary | null = null;
      if (this.adapters.materializer && isTerminalRunStatus(terminalStatus)) {
        const finalization = await this.adapters.materializer.finalizeRun(
          finalTerminalRun,
        );
        if (finalization.status !== "succeeded") {
          finalizationFailure = finalization;
          await this.appendFinalizationEvent(running, finalization);
        }
      }
      const currentAfterFinalization = this.adapters.materializer
        ? await this.repository.getRun(running.space_id, running.id)
        : finalTerminalRun;
      if (finalizationFailure) {
        return {
          run_id: running.id,
          status: protocolRunStatus(
            currentAfterFinalization?.status ?? returnedStatus,
          ),
          error_code: "finalization_failed",
          error_text:
            finalizationFailure.error_message ?? "Run finalization failed.",
        };
      }
      if (
        currentAfterFinalization
        && !isTerminalRunStatus(currentAfterFinalization.status)
      ) {
        returnedStatus = protocolRunStatus(currentAfterFinalization.status);
      } else {
        await this.markDelegatedRunTerminal(
          currentAfterFinalization && isTerminalRunStatus(currentAfterFinalization.status)
            ? currentAfterFinalization
            : finalTerminalRun,
        );
      }
      return {
        run_id: running.id,
        status: returnedStatus,
        error_code: semanticFailure?.error_code ?? adapterResult.error_code ?? null,
        error_text: semanticFailure?.error_message ?? adapterResult.error_message ?? null,
      };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = errorMessage(error);
      if (error instanceof RunApprovalRequiredError) {
        await this.repository.markRunWaitingForReview({
          run_id: run.id,
          space_id: run.space_id,
          approval_code: error.code,
          message,
          paused_at: completedAt,
        });
        return {
          run_id: run.id,
          status: "waiting_for_review",
          error_code: error.code,
        };
      }
      const errorCode =
        error instanceof RunPreparationError ? error.code : "run_orchestration_failed";
      if (step) {
        await this.updateRunStepStatusBestEffort({
          step_id: step.id,
          run_id: run.id,
          space_id: run.space_id,
          status: "failed",
          ended_at: completedAt,
          error_type: errorCode,
          error_message: message,
        });
      }
      await this.appendRunEventBestEffort({
        run_id: run.id,
        space_id: run.space_id,
        event_type: "adapter_completed",
        status: "failed",
        step_id: step?.id ?? null,
        summary: "Run orchestration failed before or during adapter execution.",
        error_code: errorCode,
        error_message: message,
        project_folder_id: run.project_folder_id,
        metadata_json: { orchestration_failure: true },
      });
      await this.cleanupRuntimeContext(preparedRuntime, run);
      let failedRun = await this.publishRunTerminalWithConversationRuntime({
        run_id: run.id,
        space_id: run.space_id,
        status: "failed",
        output_text: "",
        output_json: canonicalRunOutput({
          success: false,
          outputText: "",
          outputJson: { error_code: errorCode },
        }),
        error_json: {
          error_code: errorCode,
          error_text: message,
        },
        exit_code: 1,
        completed_at: completedAt,
      }, run, null, false);
      if (!failedRun) {
        const current = await this.repository.getRun(run.space_id, run.id);
        if (current?.status === "cancelling") {
          failedRun = await this.publishRunTerminalWithConversationRuntime({
            run_id: run.id,
            space_id: run.space_id,
            status: "cancelled",
            output_text: "",
            output_json: canonicalRunOutput({
              success: false,
              outputText: "",
              outputJson: { error_code: "run_cancelled" },
            }),
            error_json: {
              error_code: "run_cancelled",
              error_text: "Run cancellation won the terminal publication race.",
            },
            exit_code: 1,
            completed_at: completedAt,
          }, run, null, false);
        }
      }
      if (failedRun) executionLockHeld = false;
      const finalization = await this.finalizeTerminalRunBestEffort(
        failedRun ?? { ...run, status: "failed", ended_at: completedAt },
      );
      const current = this.adapters.materializer
        ? await this.repository.getRun(run.space_id, run.id)
        : failedRun;
      if (finalization?.status === "failed") {
        return {
          run_id: run.id,
          status: protocolRunStatus(current?.status ?? "failed"),
          error_code: "finalization_failed",
          error: finalization.error_message ?? "Run finalization failed.",
        };
      }
      if (current && isTerminalRunStatus(current.status)) {
        await this.markDelegatedRunTerminal(current);
      }
      return {
        run_id: run.id,
        status: protocolRunStatus(current?.status ?? "failed"),
        error_code: errorCode,
        error: message,
      };
    } finally {
      await releaseExecutionAuthority();
    }
  }

  async cancelRun(input: {
    run_id: string;
    space_id: string;
    requested_by_user_id?: string | null;
    reason?: string | null;
    terminate_process?: boolean;
  }): Promise<RunJobResult> {
    const requestedAt = new Date().toISOString();
    const run = await this.repository.getRun(input.space_id, input.run_id);
    if (!run) {
      return {
        run_id: input.run_id,
        status: "unknown",
        error_code: "run_not_found",
        error: "Run not found in this space.",
      };
    }
    // queued, running, waiting_for_review, and waiting_for_dependency runs are cancellable.
    // A previously-cancelled Run is terminal but may still need finalization
    // reconciliation after an earlier cancellation attempt failed there.
    if (isHardTerminalRunStatus(run.status)) {
      if (run.status === "cancelled") {
        const finalization = await this.finalizeTerminalRunBestEffort(run);
        if (finalization?.status === "failed") {
          return {
            run_id: run.id,
            status: "cancelled",
            error_code: "finalization_failed",
            error: finalization.error_message ?? "Run finalization failed.",
          };
        }
        await this.markDelegatedRunTerminal(run);
      }
      return {
        run_id: run.id,
        status: protocolRunStatus(run.status),
        skipped: true,
        skip_reason: "run_already_terminal",
      };
    }

    const cancellationRequested = this.repository.markRunCancelling
      ? await this.repository.markRunCancelling({
          run_id: run.id,
          space_id: run.space_id,
          requested_at: requestedAt,
          reason: input.reason,
          requested_by_user_id: input.requested_by_user_id,
        })
      : null;
    if (this.repository.markRunCancelling && !cancellationRequested) {
      const current = await this.repository.getRun(input.space_id, run.id);
      return {
        run_id: run.id,
        status: protocolRunStatus(current?.status ?? run.status),
        skipped: true,
        skip_reason: "run_already_terminal",
      };
    }

    // Cancellation is a two-phase state transition. The run remains
    // cancelling until the child process has confirmed exit or escalation has
    // been attempted, so a late adapter result cannot be mistaken for a clean
    // cancellation.
    let processTerminated = false;
    let confirmedExit = true;
    let forceKillEscalated = false;
    if (input.terminate_process !== false && this.adapters.processRegistry) {
      try {
        processTerminated = this.adapters.processRegistry.terminate(run.id);
        if (processTerminated && this.adapters.processRegistry.waitForExit) {
          confirmedExit = await this.adapters.processRegistry.waitForExit(run.id, 5_000);
          if (!confirmedExit) {
            forceKillEscalated = this.adapters.processRegistry.forceTerminate?.(run.id) ?? false;
            confirmedExit = await this.adapters.processRegistry.waitForExit(run.id, 2_000);
          }
        }
      } catch {
        processTerminated = false;
        confirmedExit = false;
      }
    }

    if (!confirmedExit) {
      return {
        run_id: run.id,
        status: "cancelling",
        error_code: "cancel_confirmation_timeout",
        error: "Cancellation was requested but the runtime process has not confirmed exit.",
      };
    }

    const updated = await this.markRunTerminalWithConversationRuntime({
      run_id: run.id,
      space_id: run.space_id,
      status: "cancelled",
      output_text: "",
      output_json: canonicalRunOutput({
        success: false,
        outputText: "",
        outputJson: { error_code: "run_cancelled" },
      }),
      error_json: {
        error_code: "run_cancelled",
        error_text: input.reason ?? "Run cancelled.",
        requested_by_user_id: input.requested_by_user_id ?? null,
        process_terminated: processTerminated,
        confirmed_exit: confirmedExit,
        force_kill_escalated: forceKillEscalated,
      },
      exit_code: 1,
      completed_at: new Date().toISOString(),
    }, run, null, false);
    if (!updated) {
      const current = await this.repository.getRun(input.space_id, run.id);
      return {
        run_id: run.id,
        status: protocolRunStatus(current?.status ?? run.status),
        skipped: true,
        skip_reason: "run_already_terminal",
      };
    }
    const finalization = await this.finalizeTerminalRunBestEffort(
      updated ?? { ...run, status: "cancelled", ended_at: new Date().toISOString() },
    );
    if (finalization?.status === "failed") {
      return {
        run_id: run.id,
        status: "cancelled",
        error_code: "finalization_failed",
        error: finalization.error_message ?? "Run finalization failed.",
      };
    }
    await this.markDelegatedRunTerminal(updated);
    // Cancellation evidence lives on the run row (error_json carries requester
    // + process_terminated); no run_event is appended (event_type has a closed
    // CHECK constraint with no cancel type).
    return { run_id: run.id, status: "cancelled", error_code: "run_cancelled" };
  }

  private async finalizeTerminalRunBestEffort(
    run: RunRecord,
  ): Promise<RunMaterializationItemSummary | null> {
    if (!this.adapters.materializer) return null;
    try {
      return await this.adapters.materializer.finalizeRun(run);
    } catch (error) {
      return {
        kind: "activity",
        status: "failed",
        error_code: "finalization_failed",
        error_message:
          error instanceof Error ? error.message : "Run finalization failed.",
      };
    }
  }

  /**
   * Enforce runtime.execute using the server policy service. Caller-supplied
   * adapter config is only a local base passed by trusted internal callers;
   * executable paths, permission bypass, and runtime policy never come from
   * the public request.
   * A non-allowed decision throws RunPreparationError (mapped to a terminal
   * failed run by the executeRun catch block).
   */
  private async enforceRuntimePolicy(
    run: RunRecord,
    input: RunExecutionInput,
    hostKind: HostKind,
  ): Promise<ResolvedRuntimePolicy> {
    const runtimeConfig = recordValue(run.runtime_config_json);
    const callerConfig = input.command_source === "http" ? {} : input.adapter_config ?? {};
    const contract = recordValue(run.contract_snapshot_json);
    const managedPolicy = managedExecutionPolicyFromContract(run.contract_snapshot_json);
    const policyContext = recordValue(contract.policy_context_json);
    const credentialMetadata = {
      ...credentialPolicyMetadata(managedPolicy),
      ...(run.trigger_origin === "autonomous"
        ? { automation_pre_authorized: policyContext.automation_pre_authorized === true }
        : {}),
    };
    // The immutable run contract is authoritative. An internal execution
    // caller may supply a fallback risk for legacy runs, but it can never
    // downgrade a critical contract to reach a weaker sandbox.
    const riskLevel = stringConfigValue(contract.risk_level) ?? input.risk_level ?? null;
    // ADR 0016 P3: sandbox escalation (ephemeral/read_only/worktree/docker) is
    // server-host policy for a workspace the server itself provisions. A
    // remote host's workspace is the daemon's own trusted-host directory —
    // the dispatch endpoint always creates the run at `none`, and that must
    // stand, not get escalated to a level the server never prepares.
    const requiredSandboxLevel = hostKind === "server"
      ? resolveSandboxLevelForRuntime({
          adapterType: run.adapter_type,
          configuredLevel: run.required_sandbox_level,
          riskLevel,
          projectFolderId: run.project_folder_id,
        })
      : run.required_sandbox_level;
    if (requiredSandboxLevel === "one_shot_docker" && isVendorCliAdapter(run.adapter_type)) {
      const spec = getRuntimeAdapterSpec(run.adapter_type);
      if (!spec?.sandbox.supports_one_shot_docker) {
        throw new RunPreparationError(
          "docker_sandbox_not_supported",
          `Runtime adapter '${run.adapter_type}' does not support one-shot Docker execution for critical risk.`,
        );
      }
    }
    const base: ResolvedRuntimePolicy = {
      adapter_type: run.adapter_type,
      adapter_config: { ...runtimeConfig, ...callerConfig },
      risk_level: riskLevel,
      required_sandbox_level: requiredSandboxLevel,
      policy_decision_record_ids: [],
    };
    const policyRequest: Parameters<typeof enforce>[2] = {
      action: "runtime.execute",
      actor_type: "run",
      actor_id: run.id,
      space_id: run.space_id,
      resource_type: "runtime",
      resource_id: run.adapter_type ?? "default",
      resource_space_id: run.space_id,
      run_id: run.id,
      context: {
        adapter_type: run.adapter_type,
        command_source: input.command_source,
        risk_level: base.risk_level,
        required_sandbox_level: base.required_sandbox_level,
      },
      metadata_json: {
        adapter_type: run.adapter_type,
        command_source: input.command_source,
        required_sandbox_level: base.required_sandbox_level,
      },
      force_record: false,
    };
    if (!this.hasGrantedApproval(run, "policy_requires_approval_runtime_execute")) {
      const decisionId = await this.enforcePolicyRequest(
        policyRequest,
        "policy_requires_approval_runtime_execute",
        "policy_denied_runtime_execute",
        "runtime.execute denied by policy.",
      );
      if (decisionId) base.policy_decision_record_ids.push(decisionId);
    }
    // D1: a remote host never gets a server-brokered credential, so this
    // check is structurally moot for it — gated explicitly rather than
    // relying only on `run.model_provider_id` staying unset for every
    // present and future remote code path.
    if (hostKind === "server" && run.model_provider_id && !this.hasGrantedApproval(run, "policy_requires_approval_runtime_use_credential")) {
      const decisionId = await this.enforcePolicyRequest(
        {
          action: "runtime.use_credential",
          actor_type: "run",
          actor_id: run.id,
          space_id: run.space_id,
          resource_type: "model_provider",
          resource_id: run.model_provider_id,
          resource_space_id: run.space_id,
          run_id: run.id,
          context: {
            adapter_type: run.adapter_type,
            command_source: input.command_source,
            trigger_origin: run.trigger_origin,
            ...credentialMetadata,
            risk_level: base.risk_level,
          },
          metadata_json: {
            adapter_type: run.adapter_type,
            command_source: input.command_source,
            trigger_origin: run.trigger_origin,
            ...credentialMetadata,
            credential_kind: "model_provider",
            provider_id: run.model_provider_id,
          },
          force_record: false,
        },
        "policy_requires_approval_runtime_use_credential",
        "policy_denied_runtime_use_credential",
        "runtime.use_credential denied by policy.",
      );
      if (decisionId) base.policy_decision_record_ids.push(decisionId);
    }
    // ADR 0016 P3 (D1): a remote host is never granted a server-brokered
    // credential and never runs a server-managed runtime-tool version — it
    // uses whatever the machine is already logged into and whatever CLI is
    // already on its PATH. Both concerns below (`runtime.use_credential`
    // policy, `resolveRuntimeToolVersion`) are about server-owned resources
    // that a remote run never touches, so neither applies to it. The
    // general `runtime.execute` gate above still applies to every run.
    if (isVendorCliAdapter(run.adapter_type) && hostKind === "server") {
      const credentialProfileId = stringConfigValue(base.adapter_config.credential_profile_id);
      const requestedRuntimeToolVersion = stringConfigValue(base.adapter_config.runtime_tool_version);
      try {
        base.adapter_config.runtime_tool_version = await this.resolveRuntimeToolVersion({
          spaceId: run.space_id,
          runtime: run.adapter_type ?? "",
          requestedVersion: requestedRuntimeToolVersion,
        });
      } catch (error) {
        throw new RunPreparationError(
          "runtime_tool_version_unavailable",
          error instanceof Error ? error.message : "Runtime tool version is unavailable.",
        );
      }
      if (!this.hasGrantedApproval(run, "policy_requires_approval_runtime_use_credential")) {
        const decisionId = await this.enforcePolicyRequest(
          {
            action: "runtime.use_credential",
            actor_type: "run",
            actor_id: run.id,
            space_id: run.space_id,
            resource_type: "cli_credential_profile",
            resource_id: credentialProfileId ?? `${run.adapter_type ?? "cli"}:default`,
            resource_space_id: run.space_id,
            run_id: run.id,
            context: {
              adapter_type: run.adapter_type,
              command_source: input.command_source,
              trigger_origin: run.trigger_origin,
              ...credentialMetadata,
              credential_profile_id: credentialProfileId,
              risk_level: base.risk_level,
            },
            metadata_json: {
              adapter_type: run.adapter_type,
              command_source: input.command_source,
              trigger_origin: run.trigger_origin,
              ...credentialMetadata,
              credential_kind: "cli_profile",
              credential_profile_id: credentialProfileId,
            },
            force_record: false,
          },
          "policy_requires_approval_runtime_use_credential",
          "policy_denied_runtime_use_credential",
          "runtime.use_credential denied by policy.",
        );
        if (decisionId) base.policy_decision_record_ids.push(decisionId);
      }
    }
    return base;
  }

  private async resolveRuntimeToolVersion(input: {
    spaceId: string;
    runtime: string;
    requestedVersion: string | null;
  }): Promise<string> {
    if (this.adapters.runtimeToolVersionResolver) {
      return this.adapters.runtimeToolVersionResolver(input);
    }
    if (!this.config.databaseUrl) {
      throw new Error("SERVER_DATABASE_URL is required");
    }
    return resolveRuntimeToolVersionForSpace(
      getDbPool(this.config.databaseUrl),
      new RuntimeToolRegistry(this.config),
      input.spaceId,
      input.runtime,
      input.requestedVersion,
    );
  }

  private async enforcePolicyRequest(
    policyRequest: Parameters<typeof enforce>[2],
    requiresApprovalCode: string,
    deniedCode: string,
    fallbackMessage: string,
  ): Promise<string | null> {
    const policy = this.adapters.policyEnforcer
      ? await this.adapters.policyEnforcer(policyRequest)
      : await enforce(this.config, await loadActionRegistry(), policyRequest);
    if (policy.status !== "allow") {
      if (policy.error_code === "policy_requires_approval") {
        throw new RunApprovalRequiredError(requiresApprovalCode, policy.message ?? fallbackMessage);
      }
      throw new RunPreparationError(deniedCode, policy.message ?? fallbackMessage);
    }
    return policy.policy_decision_record_id ?? null;
  }

  private hasGrantedApproval(run: RunRecord, approvalCode: string): boolean {
    const snap = recordValue(run.permission_snapshot_json);
    const grants = snap?.policy_grants;
    if (!Array.isArray(grants)) return false;
    return grants.some(
      (g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).approval_code === approvalCode,
    );
  }

  /**
   * ADR 0016 P1: a run with no Project Folder has always been server-host
   * (ephemeral/no-folder runs predate this topology), so it resolves to the
   * server port without a lookup. A Location-bound run resolves its
   * Location's Host; `remote` returns a `RemoteHostExecutionAdapter` carrying
   * both the daemon Host id and the physical Location id. Remote dispatch
   * uses `required_sandbox_level: "none"`, so local filesystem branches are
   * fail-closed and never touch a remote path.
   */
  private async resolveExecutionPort(run: RunRecord): Promise<HostExecutionPort> {
    if ((!run.project_folder_id && !run.workspace_location_id) || !this.hostKindResolver) return this.serverExecutionPort;
    const resolved = await this.hostKindResolver({
      workspaceLocationId: run.workspace_location_id ?? null,
      projectFolderId: run.project_folder_id ?? null,
      spaceId: run.space_id,
    });
    if (resolved.hostKind === "server") return this.serverExecutionPort;
    return new RemoteHostExecutionAdapter(resolved.hostId, resolved.workspaceLocationId);
  }

  private async prepareRuntimeContext(
    run: RunRecord,
    input: RunExecutionInput,
    control: ExecutionControlSnapshot | null,
    executionPort: HostExecutionPort,
    effectiveBindings?: EffectiveRunContextBindings,
  ): Promise<PreparedRuntimeContext> {
    const prepared: PreparedRuntimeContext = {
      prompt: input.prompt ?? run.prompt ?? null,
      sandbox_cwd: input.sandbox_cwd ?? null,
      context_cwd: input.sandbox_cwd ?? null,
      context_text: input.context_text ?? null,
      adapter_config: { ...(input.adapter_config ?? {}) },
      risk_level: input.risk_level ?? null,
      cleanup: null,
      sandbox_kind: null,
      base_commit_sha: null,
      run_input: input.run_input ?? assembleRunInputEnvelope(run, {
        prompt: input.prompt,
        riskLevel: input.risk_level,
      }),
      exchange: null,
      invocation_delivery: null,
      invocation_attempts: null,
      cli_execution_lease: null,
      execution_port: null,
    };

    try {
      prepared.execution_port = executionPort;
      let cliBinding: Awaited<ReturnType<RuntimeContextCliContinuityService["prepareBinding"]>> | null = null;
      // ADR 0016 P3: CLI continuity is server-HOME-materialization
      // machinery (prepareBinding, conversation state directories) with no
      // meaning for a remote host — its session continuity is the vendor
      // CLI's own state on that machine, resumed via the task thread's
      // `vendor_session_id` instead (see executeRemoteHostCliAdapter).
      if (isVendorCliAdapter(run.adapter_type) && this.cliContinuity && prepared.execution_port?.hostKind === "server") {
        if (!control || !effectiveBindings?.workContextSetupRef) {
          throw new RunPreparationError(
            "runtime_context_authority_missing",
            "CLI execution requires a persisted Work Context authority and continuity service.",
          );
        }
        const userId = run.instructed_by_user_id ?? run.owner_user_id;
        const agentId = effectiveBindings.agentId ?? run.agent_id;
        const runtimeProfileId = effectiveBindings.runtimeProfileId ?? run.requested_runtime_profile_id;
        if (!userId || !agentId || !runtimeProfileId) {
          throw new RunPreparationError(
            "runtime_session_invalid",
            "CLI work-scope identity is incomplete.",
          );
        }
        cliBinding = await this.cliContinuity.prepareBinding({
          spaceId: run.space_id,
          workContextScopeId: effectiveBindings.workContextScopeId,
          setupId: effectiveBindings.workContextSetupRef.id,
          setupVersion: Number(effectiveBindings.workContextSetupRef.version),
          userId,
          agentId,
          runtimeProfileId,
          credentialProfileId: stringConfigValue(prepared.adapter_config.credential_profile_id),
          adapterType: run.adapter_type ?? "unknown",
          providerId: run.model_provider_id,
          model: resolvedRunModel(run, input.model),
          agentVersionId: run.agent_version_id,
          runtimeToolVersion: stringConfigValue(prepared.adapter_config.runtime_tool_version),
          control,
        });
        const cliLeaseId = await this.cliContinuity.acquireExecutionLease(cliBinding.id);
        prepared.cli_execution_lease = { binding_id: cliBinding.id, lease_id: cliLeaseId };
        cliBinding = await this.cliContinuity.bindingForExecutionLease(cliBinding.id, cliLeaseId);
        let state = await prepareConversationRuntimeState({
          rainver_home: this.config.rainverHome,
          sandbox_root: this.config.sandboxRoot,
          state_key: cliBinding.runtime_state_key,
          resume_requested: Boolean(cliBinding.vendor_session_id),
        });
        if (cliBinding.vendor_session_id && !state.resume) {
          cliBinding = await this.cliContinuity.rotateMissingVendorState(cliBinding.id);
          prepared.cli_execution_lease.binding_id = cliBinding.id;
          state = await prepareConversationRuntimeState({
            rainver_home: this.config.rainverHome,
            sandbox_root: this.config.sandboxRoot,
            state_key: cliBinding.runtime_state_key,
            resume_requested: false,
          });
        }
        if (workingDirScopeForLevel(run.required_sandbox_level) === "ephemeral") {
          prepared.sandbox_cwd = state.cwd;
          prepared.context_cwd = state.cwd;
          prepared.sandbox_kind = "conversation_session";
        }
        prepared.adapter_config.conversation_runtime = {
          binding_id: cliBinding.id,
          runtime_state_key: cliBinding.runtime_state_key,
          runtime_session_id: state.resume ? cliBinding.vendor_session_id : null,
          cli_known_cursor: cliBinding.cli_known_cursor,
          generation: cliBinding.generation,
          rotation_reason: cliBinding.rotation_reason,
        };
      }

      // ADR 0016 P3: none of these local-sandbox concepts apply to a remote
      // host — its "sandbox" is the daemon's own trusted-host workspace,
      // resolved entirely on that machine. Gated on host_kind rather than
      // trusting every caller to pass `required_sandbox_level: "none"` for
      // a remote-bound run (the dispatch endpoint does, but this is the
      // point of actual disk access, so it is where the guard belongs).
      // `=== "server"`, not `!== "remote"`: every other `hostKind` check in
      // this file is spelled positively (found during the plan's final
      // integration review as a latent drift trap — a future third
      // `HostKind` would silently fall into whichever spelling it doesn't
      // match).
      if (isVendorCliAdapter(run.adapter_type) && !prepared.sandbox_cwd && prepared.execution_port?.hostKind === "server") {
        const scope = workingDirScopeForLevel(run.required_sandbox_level);
        if (scope === "ephemeral") {
          // Run-scope sandbox: the server owns provisioning + teardown of a throwaway
          // working dir. No git, no persistent workspace.
          prepared.sandbox_cwd = await prepareEphemeralDir(
            this.config.sandboxRoot,
            run.space_id,
            run.id,
          );
          prepared.cleanup = {
            cleanup_kind: EPHEMERAL_CLEANUP_KIND,
            sandbox_cwd: prepared.sandbox_cwd,
            project_folder_root: null,
          };
          prepared.sandbox_kind = "ephemeral";
          await this.appendRunEventBestEffort({
            run_id: run.id,
            space_id: run.space_id,
            event_type: "sandbox_created",
            status: "succeeded",
            project_folder_id: run.project_folder_id,
            metadata_json: {
              required_sandbox_level: run.required_sandbox_level,
              sandbox_kind: "ephemeral",
            },
          });
        } else if (scope === "read_only" || scope === "worktree") {
          const manager = prepared.execution_port?.workspaceManager;
          if (!manager) {
            throw new RunPreparationError(
              "workspace_prepare_failed",
              "server run execution requires a native workspace manager for worktree sandbox.",
            );
          }
          const workspaceResult = await manager.prepareRunWorkspace(run);
          prepared.sandbox_cwd = workspaceResult.sandbox_cwd;
          prepared.context_cwd = workspaceResult.context_cwd;
          prepared.cleanup = {
            cleanup_kind: workspaceResult.cleanup_kind,
            sandbox_cwd: workspaceResult.context_cwd ?? prepared.sandbox_cwd,
            project_folder_root: workspaceResult.project_folder_root,
          };
          prepared.sandbox_kind = workspaceResult.sandbox_kind;
          prepared.base_commit_sha = workspaceResult.base_commit_sha;
          if (prepared.sandbox_cwd) {
            await this.appendRunEventBestEffort({
              run_id: run.id,
              space_id: run.space_id,
              event_type: "sandbox_created",
              status: "succeeded",
              project_folder_id: run.project_folder_id,
              metadata_json: {
                required_sandbox_level: run.required_sandbox_level,
                sandbox_kind: workspaceResult.sandbox_kind,
                base_commit_sha: workspaceResult.base_commit_sha,
                project_folder_is_dirty: workspaceResult.project_folder_is_dirty,
              },
            });
          }
        }
      }

      // ADR 0016 P3: a remote host gets no server-brokered Runtime Context —
      // no retrieval, no provider/model resolution, no MCP. It runs the
      // vendor CLI bare, using whatever the machine is already logged into.
      // Planning a Delivery here would also fail outright for any remote run
      // with no model_override/model_config, since there is no bound
      // provider to resolve a default model from.
      if (prepared.execution_port?.hostKind === "remote") {
        await this.prepareRunExchange(run, prepared);
        return prepared;
      }

      // Every managed or CLI execution enters the Gateway only after any required
      // workspace has been prepared, so the accepted Delivery cannot bypass
      // the adapter's sandbox and exchange prerequisites.
      if (this.runtimeContextGateway) {
        if (!control || !effectiveBindings?.workContextSetupRef) {
          throw new RunPreparationError(
            "runtime_context_authority_missing",
            "Managed execution requires a persisted control and Work Context Setup.",
          );
        }
        const attempts = createRunInvocationAttemptLifecycle({
          gateway: this.runtimeContextGateway,
          run,
          control,
          model: resolvedRunModel(run, input.model),
          turn: {
            work_context_scope_id: effectiveBindings.workContextScopeId,
            expected_setup_version: Number(effectiveBindings.workContextSetupRef.version),
            current_message_ref: currentRuntimeContextInputRef(run),
            one_off_refs: [],
            retrieval_intent: await retrievalIntentFor(input.retrieval_intent ?? input.prompt ?? run.prompt),
            invocation_purpose: "agent_task",
          },
          cliBinding,
        });
        prepared.invocation_attempts = attempts;
        prepared.invocation_delivery = await attempts.prepare();
        await this.prepareRunExchange(run, prepared);
        return prepared;
      }

      throw new RunPreparationError(
        "runtime_context_gateway_unavailable",
        "Managed execution requires the Runtime Context Gateway.",
      );
    } catch (error) {
      await this.cleanupRuntimeContext(prepared, run);
      throw toRunPreparationError(error, "runtime_context_delivery_failed");
    }
  }

  private async cleanupRuntimeContext(
    prepared: PreparedRuntimeContext | null,
    run: RunRecord,
  ): Promise<void> {
    if (prepared?.cli_execution_lease && this.cliContinuity) {
      const lease = prepared.cli_execution_lease;
      prepared.cli_execution_lease = null;
      await this.cliContinuity.releaseExecutionLease(lease.binding_id, lease.lease_id).catch(() => {});
    }
    const executionPort = prepared?.execution_port ?? this.serverExecutionPort;
    if (prepared?.exchange) {
      await executionPort.runExchange.cleanup(prepared.exchange).catch(() => {});
      prepared.exchange = null;
    }
    if (!prepared?.cleanup) return;
    // server-owned ephemeral dir: remove directly.
    if (prepared.cleanup.cleanup_kind === EPHEMERAL_CLEANUP_KIND) {
      try {
        await removeEphemeralDir(this.config.sandboxRoot, prepared.cleanup.sandbox_cwd);
      } catch {
        return;
      }
      prepared.cleanup = null;
      return;
    }
    if (!executionPort.workspaceManager) return;
    try {
      await executionPort.workspaceManager.cleanupRunWorkspace({
        runId: run.id,
        spaceId: run.space_id,
        cleanupKind: prepared.cleanup.cleanup_kind,
        sandboxCwd: prepared.cleanup.sandbox_cwd,
        workspaceRoot: prepared.cleanup.project_folder_root,
      });
    } catch {
      return;
    }
    prepared.cleanup = null;
  }

  private async prepareRunExchange(
    run: RunRecord,
    prepared: PreparedRuntimeContext,
  ): Promise<void> {
    if (!isVendorCliAdapter(run.adapter_type) || !prepared.sandbox_cwd) return;
    const executionPort = prepared.execution_port ?? this.serverExecutionPort;
    prepared.exchange = await executionPort.runExchange.prepare(
      run.space_id,
      run.id,
      prepared.run_input,
    );
    prepared.adapter_config.run_exchange_input_dir = prepared.exchange.input_dir;
    prepared.adapter_config.run_exchange_output_dir = prepared.exchange.output_dir;
    prepared.prompt = [
      prepared.prompt,
      "Run Exchange: read the runtime-neutral input manifest at " +
        "$RAINVER_EXCHANGE_INPUT. Write declared file outputs only beneath " +
        "$RAINVER_EXCHANGE_OUTPUT. Do not modify the input manifest.",
    ].filter((part): part is string => Boolean(part)).join("\n\n");
  }

  private async collectCodePatch(
    run: RunRecord,
    prepared: PreparedRuntimeContext | null,
    proposalStatus: "pending" | "staged" = "pending",
  ): Promise<{ item: RunMaterializationItemSummary; errors: string[] } | null> {
    const codePatchCollector = prepared?.execution_port?.codePatchCollector;
    if (
      prepared?.sandbox_kind !== "worktree" ||
      !prepared.sandbox_cwd ||
      !codePatchCollector
    ) {
      return null;
    }
    return codePatchCollector.collect({
      run,
      worktreePath: prepared.sandbox_cwd,
      baseCommitSha: prepared.base_commit_sha,
      proposalStatus,
    });
  }

  private async invokeAdapter(
    run: RunRecord,
    input: RunExecutionInput,
  ): Promise<RunAdapterResultEnvelope> {
    const contract = recordValue(run.contract_snapshot_json);
    const declaredDurationSeconds = positiveNumber(contract.max_duration_seconds);
    const contractTimeoutMs = declaredDurationSeconds === null
      ? null
      : declaredDurationSeconds * 1000;
    const requestedTimeoutMs = input.timeout_ms && input.timeout_ms > 0 ? input.timeout_ms : null;
    const timeoutMs = contractTimeoutMs === null
      ? requestedTimeoutMs
      : requestedTimeoutMs === null
        ? contractTimeoutMs
        : Math.min(requestedTimeoutMs, contractTimeoutMs);
    const spec = getRuntimeAdapterSpec(run.adapter_type);
    const timeoutSeconds = timeoutMs === null ? null : Math.max(1, Math.ceil(timeoutMs / 1000));
    // Managed requests need an AbortController even when no timeout is set:
    // the same signal is also the user's Stop control. Registering it in the
    // shared execution registry lets cancelRun abort the provider request and
    // wait until the adapter has actually unwound before publishing terminal.
    const controller = spec?.executor_family === "managed_api"
      ? new AbortController()
      : null;
    const adapterInput: RunExecutionInput = {
      ...input,
      ...(controller ? { abort_signal: controller.signal } : {}),
      ...(timeoutSeconds ? {
        adapter_config: {
          ...(input.adapter_config ?? {}),
          timeout: Math.min(
            positiveNumber(input.adapter_config?.timeout) ?? timeoutSeconds,
            timeoutSeconds,
          ),
        },
      } : {}),
    };
    if (controller && this.adapters.processRegistry?.registerRemote) {
      this.adapters.processRegistry.registerRemote(
        run.id,
        () => controller.abort(),
        () => controller.abort(),
      );
    }
    const promise = this.invokeAdapterUnbounded(run, adapterInput);
    const trackedPromise = controller && this.adapters.processRegistry?.registerRemote
      ? promise.finally(() => this.adapters.processRegistry?.deregister(run.id))
      : promise;
    if (!timeoutMs || timeoutMs <= 0) return trackedPromise;
    // Local CLI adapters own their deadline: the scoped Runner terminates
    // the process group and waits for exit. Racing that cleanup here would
    // release the Job while the child process was still alive.
    if (spec?.executor_family === "local_cli") return trackedPromise;
    return withTimeout(
      trackedPromise,
      timeoutMs,
      adapterTimeoutEnvelope(run, timeoutMs),
      () => controller?.abort(),
    );
  }

  private async invokeAdapterUnbounded(
    run: RunRecord,
    input: RunExecutionInput,
  ): Promise<RunAdapterResultEnvelope> {
    const spec = getRuntimeAdapterSpec(run.adapter_type);
    if (!spec) {
      return adapterFailureEnvelope(
        run,
        "runtime_adapter_not_implemented",
        `Runtime adapter '${run.adapter_type ?? "unknown"}' is not registered.`,
      );
    }
    if (input.execution_port && dispatchesToHostDaemon(run.adapter_type, input.execution_port.hostKind)) {
      const threadId = run.host_task_thread_id;
      const threadEvents = threadId && this.config.databaseUrl
        ? new PgHostThreadEventRepository(getDbPool(this.config.databaseUrl))
        : null;
      return executeRemoteHostCliAdapter(
        {
          run,
          prompt: input.prompt ?? null,
          model: input.model ?? null,
          resume_session_id: stringConfigValue(input.adapter_config?.remote_resume_session_id),
          timeout_seconds: input.timeout_ms && input.timeout_ms > 0 ? Math.ceil(input.timeout_ms / 1000) : null,
          runtime_event_sink: input.runtime_event_sink,
          // control-center-phase2-plan.md P1 (C2): persisted as frames
          // arrive, not batched — the thread's live read model. Serialized
          // per run (see createSerializedThreadEventSink) since stdout and
          // stderr chunks can arrive back-to-back through un-awaited
          // callbacks.
          thread_event_sink: threadEvents
            ? createSerializedThreadEventSink(threadEvents, threadId!, run.id)
            : undefined,
          process_registry: this.adapters.processRegistry,
        },
        input.execution_port.hostId!,
        input.execution_port.workspaceLocationId!,
        // The remote adapter resolves this run's model backend itself: the
        // Runtime Context gateway is skipped for a remote run, so nothing
        // upstream has done it.
        { config: this.config },
      );
    }
    return RUNTIME_EXECUTORS[spec.executor_family](this.config, run, input, this.adapters);
  }

  private async appendMaterializationEvents(
    run: RunRecord,
    items: RunMaterializationItemSummary[],
  ): Promise<void> {
    for (const item of items) {
      if (item.kind === "artifact") {
        await this.appendRunEventBestEffort({
          run_id: run.id,
          space_id: run.space_id,
          event_type: "artifact_ingested",
          status: materializationEventStatus(item),
          artifact_id: item.artifact_id ?? null,
          project_folder_id: run.project_folder_id,
          error_code: item.error_code ?? null,
          error_message: item.error_message ?? null,
          metadata_json: {
            source: "adapter_output",
            ...recordValue(item.metadata_json),
          },
        });
      } else if (item.kind === "code_patch") {
        await this.appendRunEventBestEffort({
          run_id: run.id,
          space_id: run.space_id,
          event_type: "patch_collected",
          status: materializationEventStatus(item),
          proposal_id: item.proposal_id ?? null,
          project_folder_id: run.project_folder_id,
          error_code: item.error_code ?? null,
          error_message: item.error_message ?? null,
          metadata_json: {
            source: "worktree",
            ...recordValue(item.metadata_json),
          },
        });
        if (item.proposal_id) {
          await this.appendRunEventBestEffort({
            run_id: run.id,
            space_id: run.space_id,
            event_type: "proposal_created",
            status: materializationEventStatus(item),
            proposal_id: item.proposal_id,
            project_folder_id: run.project_folder_id,
            error_code: item.error_code ?? null,
            error_message: item.error_message ?? null,
            metadata_json: {
              source: "worktree",
              kind: item.kind,
              ...recordValue(item.metadata_json),
            },
          });
        }
      } else if (item.kind === "proposal") {
        await this.appendRunEventBestEffort({
          run_id: run.id,
          space_id: run.space_id,
          event_type: "proposal_created",
          status: materializationEventStatus(item),
          proposal_id: item.proposal_id ?? null,
          project_folder_id: run.project_folder_id,
          error_code: item.error_code ?? null,
          error_message: item.error_message ?? null,
          metadata_json: {
            source: "adapter_output",
            kind: item.kind,
            ...recordValue(item.metadata_json),
          },
        });
      } else if (item.kind === "delegation") {
        const metadata = recordValue(item.metadata_json);
        if (metadata.service_event_written === true) continue;
        await this.appendRunEventBestEffort({
          run_id: run.id,
          space_id: run.space_id,
          event_type: "delegation_requested",
          status: materializationEventStatus(item),
          project_folder_id: run.project_folder_id,
          error_code: item.error_code ?? null,
          error_message: item.error_message ?? null,
          summary: "Runtime delegation materialization failed",
          metadata_json: {
            source: "adapter_output",
            kind: item.kind,
            ...metadata,
          },
        });
      } else {
        await this.appendRunEventBestEffort({
          run_id: run.id,
          space_id: run.space_id,
          event_type: "artifact_ingested",
          status: materializationEventStatus(item),
          project_folder_id: run.project_folder_id,
          error_code: item.error_code ?? null,
          error_message: item.error_message ?? null,
          summary: "Output activity materialization failed",
          metadata_json: {
            kind: item.kind,
            source: "adapter_output",
            ...recordValue(item.metadata_json),
          },
        });
      }
    }
  }

  private async appendFinalizationEvent(
    run: RunRecord,
    item: RunMaterializationItemSummary,
  ): Promise<void> {
    await this.appendRunEventBestEffort({
      run_id: run.id,
      space_id: run.space_id,
      event_type: "run_finalized",
      status: materializationEventStatus(item),
      error_code: item.error_code ?? null,
      error_message: item.error_message ?? null,
      summary: item.status === "succeeded" ? "Run finalized." : "Run finalization failed.",
      metadata_json: recordValue(item.metadata_json),
    });
  }

  private async createRunStepBestEffort(input: RunStepInput): Promise<RunStepRecord | null> {
    try {
      return await this.repository.createRunStep(input);
    } catch {
      return null;
    }
  }

  private async updateRunStepStatusBestEffort(
    input: Parameters<RunExecutionRepositoryPort["updateRunStepStatus"]>[0],
  ): Promise<boolean> {
    try {
      return await this.repository.updateRunStepStatus(input);
    } catch {
      return false;
    }
  }

  private async appendRunEventBestEffort(input: RunEventInput): Promise<void> {
    try {
      await this.repository.appendRunEvent(input);
    } catch {
      return;
    }
  }

  private async appendRuntimeSemanticEvents(
    run: RunRecord,
    adapterResult: RunAdapterResultEnvelope,
  ): Promise<void> {
    for (const event of runtimeSemanticEvents(adapterResult)) {
      await this.appendRuntimeSemanticEvent(run, event);
    }
  }

  private async recordLocalCliUsage(
    run: RunRecord,
    adapterResult: RunAdapterResultEnvelope,
    executionIdentity: string,
  ): Promise<void> {
    if (
      !this.usageRecorder
      || adapterResult.adapter_kind !== "local_cli"
      || !adapterResult.usage
    ) {
      return;
    }
    const metadata = recordValue(adapterResult.metadata_json);
    const auditRefs = recordValue(metadata.runtime_context_audit_refs);
    const usageSourceId = stringConfigValue(auditRefs.usage_source_id);
    if (
      stringConfigValue(metadata.runtime_provider_id)
      || !stringConfigValue(metadata.credential_profile_id)
    ) {
      // Provider-backed CLI runs are metered at the provider proxy. Recording
      // the CLI envelope as well would double count the same generation.
      return;
    }
    const observations = adapterResult.model_usage?.length
      ? adapterResult.model_usage
      : adapterResult.usage
        ? [{
            model: stringConfigValue(metadata.runtime_provider_model),
            usage: adapterResult.usage,
          }]
        : [];
    for (const [index, observation] of observations.entries()) {
      const usage = observation.usage;
      const details: Record<string, number> = {};
      if (usage.input_tokens !== undefined) details.input = usage.input_tokens;
      if (usage.output_tokens !== undefined) details.output = usage.output_tokens;
      if (usage.total_tokens !== undefined) details.total = usage.total_tokens;
      if (usage.cache_creation_input_tokens !== undefined) {
        details.input_cache_creation = usage.cache_creation_input_tokens;
      }
      if (usage.cache_creation_1h_input_tokens !== undefined) {
        details.input_cache_creation_1h = usage.cache_creation_1h_input_tokens;
      }
      if (usage.cache_read_input_tokens !== undefined) {
        details.input_cache_read = usage.cache_read_input_tokens;
      }
      if (usage.reasoning_tokens !== undefined) {
        details.output_reasoning = usage.reasoning_tokens;
      }
      await this.usageRecorder({
        space_id: run.space_id,
        event_type: "llm.generation",
        source_type: "local_run",
        source_resource_type: "run",
        source_resource_id: run.id,
        execution_channel: "local_cli",
        adapter_type: adapterResult.adapter_type,
        runtime_tool_version: stringConfigValue(metadata.runtime_tool_version),
        vendor: cliVendor(adapterResult.adapter_type),
        model: observation.model,
        run_id: run.id,
        root_run_id: run.root_run_id ?? null,
        parent_run_id: run.parent_run_id ?? null,
        run_group_id: run.run_group_id ?? null,
        session_id: run.session_id,
        external_session_id: stringConfigValue(metadata.external_session_id),
        agent_id: run.agent_id,
        project_id: run.project_id,
        project_folder_id: run.project_folder_id,
        trigger_origin: run.trigger_origin,
        occurred_at: adapterResult.completed_at ?? new Date().toISOString(),
        usage_details: details,
        usage_accuracy: "provider_reported",
        dedupe_confidence: "high",
        idempotency_key: usageSourceId
          ? `${usageSourceId}:${index}`
          : `local-cli:${executionIdentity}:${index}`,
        metadata: usageSourceId ? { runtime_context_audit_refs: auditRefs } : {},
        dimensions: {
          runtime_profile_id: run.runtime_profile_id ?? null,
          ...(usageSourceId
            ? {
                delivery_id: stringConfigValue(auditRefs.delivery_id),
                invocation_snapshot_id: stringConfigValue(auditRefs.invocation_snapshot_id),
                execution_control_snapshot_id: stringConfigValue(auditRefs.execution_control_snapshot_id),
                usage_source_id: usageSourceId,
              }
            : {}),
        },
      });
    }
  }

  private async recordLocalCliUsageBestEffort(
    run: RunRecord,
    adapterResult: RunAdapterResultEnvelope,
    executionIdentity: string,
  ): Promise<boolean> {
    try {
      await this.recordLocalCliUsage(run, adapterResult, executionIdentity);
      return true;
    } catch {
      return false;
    }
  }

  private async markRunTerminalWithConversationRuntime(
    input: RunTerminalUpdate,
    run: RunRecord,
    adapterResult: RunAdapterResultEnvelope | null,
    keepSession: boolean,
  ): Promise<RunRecord | null> {
    const conversation = conversationRuntimeTerminalSync(
      run,
      adapterResult,
      keepSession,
    );
    if (!conversation) return this.repository.markRunTerminal(input);
    const terminal = await this.repository.markRunTerminalWithConversationSession(
      input,
      conversation,
    );
    if (!conversation.keep_session) {
      try {
        await removeConversationRuntimeState({
          rainver_home: this.config.rainverHome,
          sandbox_root: this.config.sandboxRoot,
          state_key: conversation.runtime_state_key,
        });
      } catch {
        // PostgreSQL state is already authoritative and atomically detached.
        // The retention sweep removes an interrupted filesystem orphan.
      }
    }
    return terminal;
  }

  private async publishRunTerminalWithConversationRuntime(
    input: RunTerminalUpdate,
    run: RunRecord,
    adapterResult: RunAdapterResultEnvelope | null,
    keepSession: boolean,
  ): Promise<RunRecord | null> {
    const conversation = conversationRuntimeTerminalSync(
      run,
      adapterResult,
      keepSession,
    );
    if (!conversation) return this.repository.publishRunTerminal(input);
    const terminal =
      await this.repository.publishRunTerminalWithConversationSession(
        input,
        conversation,
      );
    if (!conversation.keep_session) {
      try {
        await removeConversationRuntimeState({
          rainver_home: this.config.rainverHome,
          sandbox_root: this.config.sandboxRoot,
          state_key: conversation.runtime_state_key,
        });
      } catch {
        // PostgreSQL state is already authoritative and atomically detached.
      }
    }
    return terminal;
  }

  private async syncConversationRuntimeSessionBestEffort(
    run: RunRecord,
    adapterResult: RunAdapterResultEnvelope,
    keepSession: boolean,
  ): Promise<void> {
    if (!this.conversationRuntimeSessions) return;
    const runtime = recordValue(recordValue(run.model_override_json).conversation_runtime);
    if (runtime.schema_version !== "conversation_runtime.v1") return;
    const bindingId = stringConfigValue(runtime.binding_id);
    const stateKey = stringConfigValue(runtime.runtime_state_key);
    const contextFingerprint = stringConfigValue(runtime.context_fingerprint);
    if (!bindingId || !stateKey || !contextFingerprint) return;
    try {
      const externalSessionId = stringConfigValue(
        recordValue(adapterResult.metadata_json).external_session_id,
      );
      if (keepSession && externalSessionId) {
        await this.conversationRuntimeSessions.record({
          binding_id: bindingId,
          runtime_state_key: stateKey,
          runtime_session_id: externalSessionId,
          context_fingerprint: contextFingerprint,
          message_cursor_id: stringConfigValue(runtime.message_cursor_id),
        });
        return;
      }
      await this.invalidateConversationRuntimeSessionBestEffort(run);
    } catch {
      return;
    }
  }

  private async syncCliContinuityVendorSessionBestEffort(
    delivery: InvocationDelivery | null,
    adapterResult: RunAdapterResultEnvelope,
  ): Promise<void> {
    if (!this.cliContinuity || !delivery?.cli_session || !adapterResult.success) return;
    const externalSessionId = stringConfigValue(
      recordValue(adapterResult.metadata_json).external_session_id,
    );
    if (!externalSessionId) return;
    try {
      await this.cliContinuity.recordVendorSession({
        bindingId: delivery.cli_session.binding_ref.id,
        runtimeStateKey: delivery.cli_session.runtime_state_key,
        vendorSessionId: externalSessionId,
      });
    } catch {
      // The accepted Delivery and canonical Context Event ledger remain the
      // authority; a stale vendor cache binding is reconstructed next turn.
    }
  }

  private async invalidateConversationRuntimeSessionBestEffort(
    run: RunRecord,
  ): Promise<void> {
    if (!this.conversationRuntimeSessions) return;
    const runtime = recordValue(recordValue(run.model_override_json).conversation_runtime);
    if (runtime.schema_version !== "conversation_runtime.v1") return;
    const bindingId = stringConfigValue(runtime.binding_id);
    const stateKey = stringConfigValue(runtime.runtime_state_key);
    if (!bindingId || !stateKey) return;
    try {
      const invalidated = await this.conversationRuntimeSessions.invalidate({
        binding_id: bindingId,
        runtime_state_key: stateKey,
      });
      if (invalidated) {
        await removeConversationRuntimeState({
          rainver_home: this.config.rainverHome,
          sandbox_root: this.config.sandboxRoot,
          state_key: stateKey,
        });
      }
    } catch {
      return;
    }
  }

  private async appendRuntimeSemanticEvent(
    run: RunRecord,
    event: RuntimeSemanticEvent,
  ): Promise<void> {
    const critical = /^(policy_checked|tool_call_|approval_)/.test(event.type);
    let canonical: unknown = null;
    try {
      canonical = await this.repository.appendRunEvent({
      run_id: run.id,
      space_id: run.space_id,
      event_type: event.type,
      status: semanticEventStatus(event),
      summary: event.summary ?? null,
      project_folder_id: run.project_folder_id,
      metadata_json: {
        schema_version: event.schema_version,
        call_id: event.call_id ?? null,
        ...recordValue(event.metadata_json),
      },
      });
    } catch (error) {
      if (critical) throw error;
      try {
        await this.runtimeContextGateway?.recordRuntimeEventGap?.({
          invocation_id: run.id,
          event_type: event.type,
          canonical_ref: { type: "run", id: run.id },
          semantic_role: "reference_data",
          token_estimate: 0,
        }, error instanceof Error ? error.message : String(error));
      } catch {
        // A shared database outage can prevent both canonical and gap writes;
        // terminal reconciliation remains the final detector.
      }
      return;
    }
    const canonicalId = stringConfigValue(recordValue(canonical).id);
    if (!canonicalId || !this.runtimeContextGateway?.ingestRuntimeEvent) {
      if (critical && this.runtimeContextGateway && !this.runtimeContextGateway.ingestRuntimeEvent) {
        throw new Error("Critical runtime event capture is unavailable");
      }
      return;
    }
    try {
      await this.runtimeContextGateway.ingestRuntimeEvent({
        invocation_id: run.id,
        event_type: event.type,
        canonical_ref: { type: "run_event", id: canonicalId },
        semantic_role: "reference_data",
        token_estimate: Math.ceil((event.summary?.length ?? 0) / 4),
      });
    } catch (error) {
      if (critical) throw error;
    }
  }

  private async markDelegatedRunRunningBestEffort(run: RunRecord): Promise<void> {
    try {
      await this.delegationProjector?.markDelegatedRunRunning(run);
    } catch {
      return;
    }
  }

  private async markDelegatedRunTerminal(run: RunRecord): Promise<void> {
    if (!run.run_group_id) return;
    await this.delegationProjector?.markDelegatedRunTerminal(run);
  }

  async reconcileTerminalDelegation(run: RunRecord): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    await this.markDelegatedRunTerminal(run);
  }

}

function conversationRuntimeTerminalSync(
  run: RunRecord,
  adapterResult: RunAdapterResultEnvelope | null,
  keepSession: boolean,
): ConversationRuntimeTerminalSync | null {
  const runtime = recordValue(recordValue(run.model_override_json).conversation_runtime);
  if (runtime.schema_version !== "conversation_runtime.v1") return null;
  const bindingId = stringConfigValue(runtime.binding_id);
  const stateKey = stringConfigValue(runtime.runtime_state_key);
  if (!bindingId || !stateKey) return null;
  const contextFingerprint = stringConfigValue(runtime.context_fingerprint);
  const externalSessionId = adapterResult
    ? stringConfigValue(recordValue(adapterResult.metadata_json).external_session_id)
    : null;
  const canKeep = keepSession && Boolean(contextFingerprint && externalSessionId);
  return {
    binding_id: bindingId,
    runtime_state_key: stateKey,
    keep_session: canKeep,
    runtime_session_id: canKeep ? externalSessionId : null,
    context_fingerprint: canKeep ? contextFingerprint : null,
    message_cursor_id: canKeep
      ? stringConfigValue(runtime.message_cursor_id)
      : null,
  };
}

function applyEffectiveWorkContextBindings(
  run: RunRecord,
  bindings: EffectiveRunContextBindings | undefined,
): RunRecord {
  if (!bindings) return run;
  return {
    ...run,
    project_id: bindings.projectId,
    project_folder_id: bindings.projectFolderId,
    ...(bindings.agentId ? { agent_id: bindings.agentId } : {}),
    ...(bindings.runtimeProfileId
      ? {
          requested_runtime_profile_id: bindings.runtimeProfileId,
          runtime_profile_selection_source: "explicit" as const,
        }
      : {}),
  };
}

function workContextSetupRef(
  value: Record<string, unknown>,
): { type: "work_context_setup"; id: string; version: string } | null {
  const id = typeof value.id === "string" ? value.id : null;
  const version = typeof value.version === "number" || typeof value.version === "string"
    ? String(value.version)
    : null;
  return id && version ? { type: "work_context_setup", id, version } : null;
}

function isChatTurnRun(run: RunRecord): boolean {
  return recordValue(recordValue(run.model_override_json).chat_turn).schema_version === "chat_turn.v1";
}

function currentRuntimeContextInputRef(run: RunRecord): TurnContextRequest["current_message_ref"] {
  const chatTurn = recordValue(recordValue(run.model_override_json).chat_turn);
  const messageId = stringConfigValue(chatTurn.user_message_id);
  if (chatTurn.schema_version === "chat_turn.v1" && messageId) {
    return { type: "message", id: messageId };
  }
  return { type: "run_request", id: run.id };
}

function isManagedApiAdapter(adapterType: string | null): boolean {
  return getRuntimeAdapterSpec(adapterType)?.executor_family === "managed_api";
}

function resolvedRunModel(run: RunRecord, requested: string | null | undefined): string | null {
  return requested
    ?? stringConfigValue(recordValue(run.model_override_json).model);
}

function outputJsonWithVerification(
  outputJson: unknown,
  items: RunMaterializationItemSummary[],
  errors: string[],
  results: VerificationResultRecord[],
): unknown {
  const output = recordValue(outputJsonWithMaterialization(outputJson, items, errors));
  if (results.length > 0) {
    output.verification_results = results.map((result) => ({
      id: result.id,
      verifier_type: result.verifier_type,
      verifier_version: result.verifier_version,
      status: result.status,
      summary: result.summary,
      evidence_refs_json: result.evidence_refs_json,
      completed_at: result.completed_at,
    }));
  }
  return output;
}

function outputJsonWithRuntimeUsage(
  adapterResult: RunAdapterResultEnvelope,
): Record<string, unknown> {
  const output = recordValue(adapterResult.output_json);
  if (adapterResult.adapter_kind !== "local_cli" || !adapterResult.usage) return output;
  const metadata = recordValue(adapterResult.metadata_json);
  output.runtime_usage = {
    adapter_type: adapterResult.adapter_type,
    external_session_id: stringConfigValue(metadata.external_session_id),
    usage: adapterResult.usage,
    model_usage: adapterResult.model_usage ?? [],
  };
  return output;
}

function verificationStatus(
  results: VerificationResultRecord[],
): "succeeded" | "failed" | "warning" | "skipped" {
  if (results.length === 0) return "skipped";
  if (results.some((result) => result.status === "failed" || result.status === "error")) return "failed";
  if (results.some((result) => result.status === "skipped")) return "warning";
  return "succeeded";
}

function runtimeSemanticEvents(
  result: RunAdapterResultEnvelope,
): RuntimeSemanticEvent[] {
  const events = (result as { runtime_events?: unknown }).runtime_events;
  return Array.isArray(events)
    ? events.filter((event): event is RuntimeSemanticEvent =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { schema_version?: unknown }).schema_version === "runtime_event.v1")
    : [];
}

function semanticEventStatus(
  event: RuntimeSemanticEvent,
): "pending" | "succeeded" | "failed" | "warning" {
  if (event.type === "approval_requested" || event.type === "tool_call_started") return "pending";
  if (event.type === "error" || event.type === "tool_call_failed") return "failed";
  if (event.type === "warning") return "warning";
  return "succeeded";
}

function stringConfigValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function cliVendor(adapterType: string): string {
  if (adapterType === "claude_code") return "anthropic";
  if (adapterType === "codex_cli") return "openai";
  return adapterType;
}

/**
 * `retrieval_intent` is the turn's retrieval query, not its instruction. A
 * managed run's prompt can be a whole rendered batch — Source screening sends
 * sixteen items in one prompt — and the protocol bounds the query, so a long
 * prompt used to fail envelope validation and take the entire run with it.
 * Truncate into a query rather than rejecting the turn; the bound comes from
 * the protocol schema so the two cannot drift. Truncation is the fallback for
 * callers with nothing better — a caller that knows its real query passes
 * `retrieval_intent` and never reaches the slice.
 */
export async function retrievalIntentFor(prompt: string | null | undefined): Promise<string | null> {
  const trimmed = prompt?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= RETRIEVAL_INTENT_MAX_CHARS) return trimmed;
  return trimmed.slice(0, RETRIEVAL_INTENT_MAX_CHARS).trim();
}
