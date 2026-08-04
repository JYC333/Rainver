import type {
  RunAdapterResultEnvelope,
  RunExecuteRequest,
  RunInputEnvelope,
  RunJobResult,
  RunMaterializationItemSummary,
  RuntimeSemanticEvent,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import {
  executeManagedApiNoToolAdapter,
  type ManagedApiNoToolAdapterDeps,
} from "./managedApiAdapter";
import {
  executeVendorCliAdapter,
  type VendorCliAdapterDeps,
} from "./vendorCliAdapter";
import { AgentGroupRunLifecycleProjector } from "../agentGroups/lifecycleProjector";
import type { CliProcessRegistry } from "./localCliExecution";
import { PgRunRepository } from "./repository";
import type {
  RunEventInput,
  RunRecord,
  RunStepInput,
  RunStepRecord,
  RunTerminalUpdate,
  ConversationRuntimeTerminalSync,
} from "./repository";
import {
  EPHEMERAL_CLEANUP_KIND,
  prepareEphemeralDir,
  removeEphemeralDir,
  workingDirScopeForLevel,
} from "./ephemeralSandbox";
import {
  prepareConversationRuntimeState,
  removeConversationRuntimeState,
} from "./conversationRuntimeState";
import type { RunSandboxManagerPort } from "../projectFolders";
import {
  getRuntimeAdapterSpec,
  isVendorCliAdapter,
  targetFormatForAdapter,
  type RuntimeExecutorFamily,
} from "../runtimeAdapters";
import type { RunMaterializationService } from "./materializationService";
import type { ContextPrepareInput, ContextPrepareResult } from "../context";
import { loadActionRegistry } from "../policy/actionRegistry";
import { enforce, type EnforceResult } from "../policy/service";
import { RuntimeToolRegistry } from "../runtimeTools";
import { resolveRuntimeToolVersionForSpace } from "../runtimeTools/policies";
import { PgRouteDecisionRepository } from "../routing/repository";
import { RunApprovalRequiredError, RunPreparationError } from "./orchestrationErrors";
import { resolveSandboxLevelForRuntime } from "./runRepositoryHelpers";
import {
  credentialPolicyMetadata,
  managedExecutionPolicyFromContract,
} from "../policy/managedExecutionPolicy";
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
  outputJsonWithMaterialization,
  protocolRunStatus,
  recordValue,
  summarizeOutput,
  terminalStatusFromAdapter,
  toRunPreparationError,
  waitingForDependencyFromAdapter,
  withTimeout,
} from "./orchestrationResults";
import type {
  VerificationEnginePort,
  VerificationResultRecord,
} from "./verification";
import { assembleRunInputEnvelope } from "./runInputEnvelope";
import { publishChatTextDelta } from "../streaming/conversationDeltaBus";
import { CliCredentialBroker } from "../providers/cli/credentialBroker";
import {
  RunExchangeManager,
  type RunExchangeHandle,
  type RunExchangePort,
} from "./runExchange";
import {
  recordUsageObservation,
} from "../usage/service";
import type { UsageObservation } from "../usage/types";
import { PgConversationRuntimeSessionRepository } from "../sessions/conversationRuntimeSessionRepository";

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
  contextPreparer?: RunContextPrepareClient;
  workspaceManager?: RunSandboxManagerPort;
  codePatchCollector?: RunCodePatchCollectorPort;
  verificationEngine?: VerificationEnginePort;
  policyEnforcer?: RunPolicyEnforcer;
  runtimeToolVersionResolver?: RunRuntimeToolVersionResolver;
  delegationProjector?: RunDelegationLifecycleProjectorPort;
  /**
   * Shared CLI process registry. Execute registers spawned CLI processes here;
   * cancelRun terminates them through it. Must be the same instance across the
   * HTTP routes and the job worker so a stop from another request can reach a
   * running process.
   */
  processRegistry?: CliProcessRegistry;
  routeResolver?: RunRouteResolverPort;
  runExchange?: RunExchangePort;
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

export interface RunContextPrepareClient {
  prepare(input: ContextPrepareInput): Promise<ContextPrepareResult>;
}

export interface RunCodePatchCollectorPort {
  collect(input: {
    run: RunRecord;
    worktreePath: string | null;
    baseCommitSha: string | null;
    proposalStatus?: "pending" | "staged";
  }): Promise<{ item: RunMaterializationItemSummary; errors: string[] } | null>;
}

export interface RunExecutionInput extends RunExecuteRequest {
  run_input?: RunInputEnvelope;
  prompt?: string | null;
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
          contextSnapshotId: run.context_snapshot_id,
          riskLevel: input.risk_level,
        }),
        model: input.model ?? null,
        system_prompt: input.system_prompt ?? run.system_prompt ?? null,
        prompt: input.prompt ?? null,
        context_text: input.context_text ?? null,
        context_snapshot_id: run.context_snapshot_id,
        max_tokens: input.max_tokens ?? null,
        text_delta_sink: input.text_delta_sink,
        abort_signal: input.abort_signal,
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
          contextSnapshotId: run.context_snapshot_id,
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
}

interface ResolvedRuntimePolicy {
  adapter_type: string | null;
  adapter_config: Record<string, unknown>;
  risk_level: string | null;
  required_sandbox_level: string | null;
}

export class RunOrchestrationService {
  private readonly delegationProjector: RunDelegationLifecycleProjectorPort | null;
  private readonly routeResolver: RunRouteResolverPort | null;
  private readonly runExchange: RunExchangePort;
  private readonly usageRecorder: ((observation: UsageObservation) => Promise<void>) | null;
  private readonly conversationRuntimeSessions:
    NonNullable<RunExecutionAdapterDeps["conversationRuntimeSessions"]> | null;

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
    this.usageRecorder = adapters.usageRecorder
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? (observation) => recordUsageObservation(config, observation)
        : null);
    this.conversationRuntimeSessions = adapters.conversationRuntimeSessions
      ?? (repository instanceof PgRunRepository && config.databaseUrl
        ? new PgConversationRuntimeSessionRepository(getDbPool(config.databaseUrl))
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
      const currentAuthorization =
        await this.repository.checkRunExecutionAuthorization?.(run)
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
      const routedRun = this.routeResolver ? await this.routeResolver.routeRun(run) : run;
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
      await this.markDelegatedRunRunningBestEffort(running);

      // Policy gate + server-owned adapter resolution first. The run row and
      // agent/runtime configuration own the adapter and sandbox level; request
      // bodies never override executable paths, permissions, or runtime policy.
      const resolved = await this.enforceRuntimePolicy(running, input);
      const effectiveRun: RunRecord = {
        ...running,
        adapter_type: resolved.adapter_type,
        // Honor the policy-resolved sandbox level (e.g. ephemeral for a
        // no-workspace CLI run); the stored row level is the creation-time
        // default and is not re-derived under server authority.
        required_sandbox_level:
          resolved.required_sandbox_level ?? running.required_sandbox_level,
      };
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
      const effectiveInput: RunExecutionInput = {
        ...input,
        adapter_config: resolved.adapter_config,
        risk_level: resolved.risk_level,
        runtime_event_sink: (event) => this.appendRuntimeSemanticEvent(effectiveRun, event),
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
          command_source: input.command_source,
          worker_id: input.worker_id,
        },
      });

      preparedRuntime = await this.prepareRuntimeContext(effectiveRun, effectiveInput);
      let adapterResult = await this.invokeAdapter(
        effectiveRun,
        inputWithPreparedRuntime(effectiveInput, preparedRuntime),
      );
      if (preparedRuntime.exchange) {
        const exchange = await this.runExchange.collect(
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
      if (currentAfterAdapter?.status === "waiting_for_review") {
        return {
          run_id: running.id,
          status: "waiting_for_review",
          error_code: "cli_tool_approval_required",
        };
      }
      let verificationResults: VerificationResultRecord[] = [];
      let semanticFailure = semanticRunFailure(adapterResult, []);
      let validationStarted = false;
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
          run: effectiveRun,
          sandbox_cwd: preparedRuntime?.sandbox_cwd ?? null,
          base_commit_sha: preparedRuntime?.base_commit_sha ?? null,
          output_json: adapterResult.output_json,
          materialization_items: [],
        }, "pre_materialization");
        semanticFailure = semanticRunFailure(adapterResult, verificationResults);
      }
      if (adapterResult.success && !semanticFailure) {
        if (this.adapters.materializer) {
          const persisted = await this.adapters.materializer.materializeAdapterResult({
            run: running,
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
          effectiveRun,
          preparedRuntime,
          "staged",
        );
        if (codePatch) {
          materialization.items.push(codePatch.item);
          materialization.errors.push(...codePatch.errors);
        }
        if (this.adapters.verificationEngine) {
          const postMaterialization = await this.adapters.verificationEngine.verify({
            run: effectiveRun,
            sandbox_cwd: preparedRuntime?.sandbox_cwd ?? null,
            base_commit_sha: preparedRuntime?.base_commit_sha ?? null,
            output_json: adapterResult.output_json,
            materialization_items: materialization.items,
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
      const terminalStatus = semanticFailure
        ? "failed"
        : adapterResult.success && materialization.errors.length > 0
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
    // queued, running, waiting_for_review, and waiting_for_dependency runs are cancellable;
    // hard-terminal runs are a no-op.
    if (isHardTerminalRunStatus(run.status)) {
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
    const requiredSandboxLevel = resolveSandboxLevelForRuntime({
      adapterType: run.adapter_type,
      configuredLevel: run.required_sandbox_level,
      riskLevel,
      projectFolderId: run.project_folder_id,
    });
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
      await this.enforcePolicyRequest(
        policyRequest,
        "policy_requires_approval_runtime_execute",
        "policy_denied_runtime_execute",
        "runtime.execute denied by policy.",
      );
    }
    if (run.model_provider_id && !this.hasGrantedApproval(run, "policy_requires_approval_runtime_use_credential")) {
      await this.enforcePolicyRequest(
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
    }
    if (isVendorCliAdapter(run.adapter_type)) {
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
        await this.enforcePolicyRequest(
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
  ): Promise<void> {
    const policy = this.adapters.policyEnforcer
      ? await this.adapters.policyEnforcer(policyRequest)
      : await enforce(this.config, await loadActionRegistry(), policyRequest);
    if (policy.status !== "allow") {
      if (policy.error_code === "policy_requires_approval") {
        throw new RunApprovalRequiredError(requiresApprovalCode, policy.message ?? fallbackMessage);
      }
      throw new RunPreparationError(deniedCode, policy.message ?? fallbackMessage);
    }
  }

  private hasGrantedApproval(run: RunRecord, approvalCode: string): boolean {
    const snap = recordValue(run.permission_snapshot_json);
    const grants = snap?.policy_grants;
    if (!Array.isArray(grants)) return false;
    return grants.some(
      (g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).approval_code === approvalCode,
    );
  }

  private async prepareRuntimeContext(
    run: RunRecord,
    input: RunExecutionInput,
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
        contextSnapshotId: run.context_snapshot_id,
        riskLevel: input.risk_level,
      }),
      exchange: null,
    };

    try {
      let conversationPromptOverride: string | null = null;
      if (isResumableCliConversation(run)) {
        const runtime = recordValue(recordValue(run.model_override_json).conversation_runtime);
        if (runtime.schema_version !== "conversation_runtime.v1") {
          throw new RunPreparationError(
            "runtime_session_invalid",
            "CLI conversation is missing its runtime-session snapshot.",
          );
        }
        const stateKey = stringConfigValue(runtime.runtime_state_key);
        const bindingId = stringConfigValue(runtime.binding_id);
        const contextFingerprint = stringConfigValue(runtime.context_fingerprint);
        const replayPrompt = stringConfigValue(runtime.replay_prompt);
        if (!stateKey || !bindingId || !contextFingerprint || !replayPrompt) {
          throw new RunPreparationError(
            "runtime_session_invalid",
            "CLI conversation has an invalid runtime-session snapshot.",
          );
        }
        const externalSessionId = stringConfigValue(runtime.runtime_session_id);
        const state = await prepareConversationRuntimeState({
          agent_space_home: this.config.agentSpaceHome,
          sandbox_root: this.config.sandboxRoot,
          state_key: stateKey,
          resume_requested: Boolean(externalSessionId),
        });
        if (
          isLightweightCliConversation(run)
          || workingDirScopeForLevel(run.required_sandbox_level) === "ephemeral"
        ) {
          prepared.sandbox_cwd = state.cwd;
          prepared.context_cwd = state.cwd;
          prepared.sandbox_kind = "conversation_session";
        }
        prepared.adapter_config.conversation_runtime = {
          binding_id: bindingId,
          runtime_state_key: stateKey,
          runtime_session_id: state.resume ? externalSessionId : null,
          context_fingerprint: contextFingerprint,
        };
        if (!state.resume) {
          prepared.prompt = replayPrompt;
          conversationPromptOverride = replayPrompt;
        }
      }

      if (isVendorCliAdapter(run.adapter_type) && !prepared.sandbox_cwd) {
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
          const manager = this.adapters.workspaceManager;
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

      if (isLightweightCliConversation(run)) {
        const runtime = recordValue(prepared.adapter_config.conversation_runtime);
        const resumed = Boolean(stringConfigValue(runtime.runtime_session_id));
        prepared.prompt = [
          ...(resumed ? [] : [run.system_prompt]),
          prepared.context_text,
          prepared.prompt,
        ].filter((part): part is string => Boolean(part?.trim())).join("\n\n");
        prepared.context_text = null;
        prepared.adapter_config.context_file_already_rendered = true;
        prepared.run_input = {
          ...prepared.run_input,
          tool_grants: [],
        };
        this.applySupervisorRetryContext(run, prepared);
        return prepared;
      }

      if (prepared.sandbox_kind === "read_only_project") {
        prepared.adapter_config.read_only_workspace = {
          workspace_cwd: prepared.sandbox_cwd,
          context_cwd: prepared.context_cwd,
        };
      }
      const contextPreparer = this.adapters.contextPreparer;
      if (!contextPreparer) {
        this.applySupervisorRetryContext(run, prepared);
        await this.prepareRunExchange(run, prepared);
        return prepared;
      }
      const contextResult = await contextPreparer.prepare({
        runId: run.id,
        spaceId: run.space_id,
        adapterType: run.adapter_type,
        sandboxCwd: prepared.context_cwd,
        targetFormat: targetFormatForAdapter(run.adapter_type),
        workspacePath: prepared.cleanup?.project_folder_root ?? null,
        ...(conversationPromptOverride !== null
          ? { promptOverride: conversationPromptOverride }
          : {}),
      });
      prepared.prompt = contextResult.runtime_prompt ?? prepared.prompt;
      prepared.context_text = contextResult.runtime_context_text ?? prepared.context_text;
      if (contextResult.context_rendered) {
        prepared.context_text = null;
        prepared.adapter_config.context_file_already_rendered = true;
        prepared.adapter_config.context_target_format = contextResult.target_format ?? null;
      }
      prepared.run_input = assembleRunInputEnvelope(run, {
        prompt: prepared.prompt,
        contextSnapshotId: contextResult.context_snapshot_id,
        riskLevel: prepared.risk_level,
      });
      this.applySupervisorRetryContext(run, prepared);
      await this.prepareRunExchange(run, prepared);
      return prepared;
    } catch (error) {
      await this.cleanupRuntimeContext(prepared, run);
      throw toRunPreparationError(error, "context_prepare_failed");
    }
  }

  private applySupervisorRetryContext(
    run: RunRecord,
    prepared: PreparedRuntimeContext,
  ): void {
    const error = recordValue(run.error_json);
    if (error.error_code !== "supervisor_retry_scheduled") return;
    const reasonCode = stringConfigValue(error.reason_code);
    const attemptNumber =
      typeof error.attempt_number === "number"
      && Number.isInteger(error.attempt_number)
      && error.attempt_number > 0
        ? error.attempt_number
        : null;
    if (!reasonCode || attemptNumber === null) return;
    const retryContext = [
      "[Supervisor retry]",
      `This is physical attempt ${attemptNumber}.`,
      `The previous attempt did not complete acceptably (${reasonCode}).`,
      "Re-attempt the original task and correct that failure; do not merely repeat the prior response.",
    ].join("\n");
    prepared.prompt = [prepared.prompt, retryContext]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
    prepared.run_input = {
      ...prepared.run_input,
      task_goal: prepared.prompt,
      inputs: {
        ...prepared.run_input.inputs,
        direct: {
          ...recordValue(prepared.run_input.inputs.direct),
          prompt: prepared.prompt,
          supervisor_retry: {
            reason_code: reasonCode,
            attempt_number: attemptNumber,
          },
        },
      },
    };
  }

  private async cleanupRuntimeContext(
    prepared: PreparedRuntimeContext | null,
    run: RunRecord,
  ): Promise<void> {
    if (prepared?.exchange) {
      await this.runExchange.cleanup(prepared.exchange).catch(() => {});
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
    if (!this.adapters.workspaceManager) return;
    try {
      await this.adapters.workspaceManager.cleanupRunWorkspace({
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
    prepared.exchange = await this.runExchange.prepare(
      run.space_id,
      run.id,
      prepared.run_input,
    );
    prepared.adapter_config.run_exchange_input_dir = prepared.exchange.input_dir;
    prepared.adapter_config.run_exchange_output_dir = prepared.exchange.output_dir;
    prepared.prompt = [
      prepared.prompt,
      "Run Exchange: read the runtime-neutral input manifest at " +
        "$AGENT_SPACE_EXCHANGE_INPUT. Write declared file outputs only beneath " +
        "$AGENT_SPACE_EXCHANGE_OUTPUT. Do not modify the input manifest.",
    ].filter((part): part is string => Boolean(part)).join("\n\n");
  }

  private async collectCodePatch(
    run: RunRecord,
    prepared: PreparedRuntimeContext | null,
    proposalStatus: "pending" | "staged" = "pending",
  ): Promise<{ item: RunMaterializationItemSummary; errors: string[] } | null> {
    if (
      prepared?.sandbox_kind !== "worktree" ||
      !prepared.sandbox_cwd ||
      !this.adapters.codePatchCollector
    ) {
      return null;
    }
    return this.adapters.codePatchCollector.collect({
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
    const controller = timeoutMs && spec?.executor_family === "managed_api"
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
    const promise = this.invokeAdapterUnbounded(run, adapterInput);
    if (!timeoutMs || timeoutMs <= 0) return promise;
    // Local CLI adapters own their deadline: LocalCliCommandExecutor terminates
    // the process group and waits for exit. Racing that cleanup here would
    // release the Job while the child process was still alive.
    if (spec?.executor_family === "local_cli") return promise;
    return withTimeout(
      promise,
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
        idempotency_key: `local-cli:${executionIdentity}:${index}`,
        dimensions: {
          runtime_profile_id: run.runtime_profile_id ?? null,
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
          agent_space_home: this.config.agentSpaceHome,
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
          agent_space_home: this.config.agentSpaceHome,
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
          agent_space_home: this.config.agentSpaceHome,
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
    await this.appendRunEventBestEffort({
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

function isLightweightCliConversation(run: RunRecord): boolean {
  return (
    isVendorCliAdapter(run.adapter_type) &&
    recordValue(run.model_override_json).execution_mode === "conversation_lightweight.v1"
  );
}

function isResumableCliConversation(run: RunRecord): boolean {
  if (!isVendorCliAdapter(run.adapter_type)) return false;
  const executionMode = recordValue(run.model_override_json).execution_mode;
  return (
    executionMode === "conversation_lightweight.v1"
    || executionMode === "room_conversation.v1"
  );
}

function isChatTurnRun(run: RunRecord): boolean {
  return recordValue(recordValue(run.model_override_json).chat_turn).schema_version === "chat_turn.v1";
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
