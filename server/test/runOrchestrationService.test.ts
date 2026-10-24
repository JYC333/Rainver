import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  RunOrchestrationService,
  currentRuntimeContextInputRef,
  retrievalIntentFor,
  type RunDelegationLifecycleProjectorPort,
  type RunExecutionRepositoryPort,
  type RunPolicyEnforcer,
} from "../src/modules/runs/orchestrationService.js";
import type { RunMaterializationService } from "../src/modules/runs/materializationService.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import type {
  RunEventInput,
  RunRecord,
  AgentRunRecord,
  RunStepInput,
  RunStepRecord,
  RunTerminalUpdate,
} from "../src/modules/runs/repository.js";
import type { ExecutionControlSnapshot, InvocationDelivery } from "@rainver/protocol";
import type { PreparedRunSandbox, RunSandboxManagerPort } from "../src/modules/projectFolders/index.js";
import { LocalCliProcessRegistry, type CliCommandExecutor, type CliStdioController } from "../src/modules/runs/localCliExecution.js";
import { explicitRunTimeLimit, invokeWithinTimeLimit } from "../src/modules/runs/runTimeLimit.js";
import { isRetryableRunErrorCode } from "../src/modules/runs/retryPolicy.js";
import { NO_PROVIDER_BINDINGS, type RemoteHostCliAdapterDeps } from "../src/modules/runs/remoteHostCliAdapter.js";
import type { TaskRunSettlementInput } from "../src/modules/runs/taskRunSettlement.js";

function config(withDatabase = false) {
  return loadConfig({
    ...(withDatabase ? { SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver" } : {}),
    SERVER_INTERNAL_TOKEN: "internal-token",
    RAINVER_HOME: "/tmp/rainver-run-orchestration-tests-home",
    SANDBOX_ROOT: "/tmp/rainver-run-orchestration-tests",
  });
}

const allowPolicy: RunPolicyEnforcer = async () => ({ status: "allow" });

function invocationDelivery(prompt = "Say hello"): InvocationDelivery {
  return {
    id: "delivery-1",
    invocation_id: "run-1",
    delivery_kind: "agent_task",
    runtime_key: "codex_cli",
    provider_id: null,
    model: "gpt-4o-mini",
    renderer_version: "acp.v1",
    planned_items: [
      { item_id: "system-item", semantic_role: "delegated_instruction", required: true },
      { item_id: "user-item", semantic_role: "user_input", required: true },
    ],
    message_blocks: [
      { semantic_role: "delegated_instruction", content: "System prompt for agent-from-setup", source_item_ids: ["system-item"] },
      { semantic_role: "user_input", content: prompt, source_item_ids: ["user-item"] },
    ],
    control_ref: { type: "execution_control_snapshot", id: "control-1" },
    sandbox_ref: null,
    tool_grant_refs: [],
    output_contract_ref: null,
    expected_prompt_tokens: 8,
    context_estimate: { instructions: 3, current_input: 5 },
    max_output_tokens: null,
    snapshot_draft_ref: { type: "invocation_snapshot", id: "snapshot-1" },
    audit_refs: {
      delivery_id: "delivery-1",
      invocation_snapshot_id: "snapshot-1",
      execution_control_snapshot_id: "control-1",
      usage_source_id: "usage-delivery-1",
    },
  };
}

/**
 * codex_cli drives the general AcpController. This helper drives a single
 * ACP turn to completion: session/new, then session/prompt.
 */
async function completeCodexProtocol(
  controller: CliStdioController | undefined,
  text: string,
  sessionId = "session-1",
): Promise<void> {
  if (!controller) throw new Error("expected ACP stdio controller");
  const sent: Record<string, unknown>[] = [];
  const send = (message: Record<string, unknown>) => { sent.push(message); };
  const close = () => {};
  controller.start(send);
  const initialize = sent.at(-1)!;
  if (initialize.method !== "initialize") throw new Error(`expected initialize request, got ${JSON.stringify(initialize)}`);
  await controller.receive({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: 1 } }, send, close);
  const session = sent.at(-1)!;
  if (session.method !== "session/new" && session.method !== "session/resume") {
    throw new Error(`expected session request, got ${JSON.stringify(session)}`);
  }
  const advertisedModels = [
    "gpt-4o-mini",
    "provider/model",
    "example-model",
  ];
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: advertisedModels[0],
    options: advertisedModels.map((value) => ({ value, name: value })),
  };
  const sessionResponse = {
    jsonrpc: "2.0",
    id: session.id,
    result: { sessionId, configOptions: [modelOption] },
  };
  await controller.receive(sessionResponse, send, close);
  if (controller.result().error) {
    throw new Error(`fake ACP session failed: ${JSON.stringify({ sessionResponse, result: controller.result() })}`);
  }
  const setConfigOption = sent.at(-1)!;
  if (setConfigOption?.method === "session/set_config_option") {
    const requestedModel = (setConfigOption.params as { value?: unknown } | undefined)?.value;
    await controller.receive({
      jsonrpc: "2.0",
      id: setConfigOption.id,
      result: {
        configOptions: [{ ...modelOption, currentValue: requestedModel }],
      },
    }, send, close);
  }
  const prompt = sent.at(-1)!;
  await controller.receive({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  }, send, close);
  await controller.receive({
    jsonrpc: "2.0",
    id: prompt.id,
    result: {
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 20,
        cachedReadTokens: 4,
        cachedWriteTokens: 0,
        thoughtTokens: 1,
      },
    },
  }, send, close);
  const result = controller.result();
  if (!result.completed || result.error) {
    throw new Error(`fake ACP turn did not complete: ${JSON.stringify({ result, sent })}`);
  }
}

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    status: "queued",
    mode: "live",
    prompt: "Say hello",
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    execution_kind: "agent",
    runtime_key: "codex_cli",
    runtime_profile_id: "runtime-profile-1",
    runtime_profile_selection_source: "default",
    runtime_profile_snapshot_json: DEFAULT_ACP_PROFILE_SNAPSHOT,
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    owner_user_id: "user-1",
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

class FakeRepo implements RunExecutionRepositoryPort {
  calls: string[] = [];
  terminalUpdates: RunTerminalUpdate[] = [];
  run: AgentRunRecord | null = run();
  lockAcquired = true;
  dispatchAllowed = true;
  executionAllowed = true;
  dispatchHook: (() => Promise<void>) | null = null;
  authorizationHook: (() => Promise<void>) | null = null;
  runningHook: (() => Promise<void>) | null = null;
  failEvents = false;
  failSteps = false;
  executionLocked = false;
  authorizationRuns: Array<Pick<RunRecord, "project_id" | "project_folder_id" | "agent_id">> = [];

  /**
   * Other Runs this one refers to, by id. A delegated Run's credential spend is
   * decided on the top of its parent chain, which the delegation tests name
   * `run-root` and model as a person's own Run.
   */
  runsById = new Map<string, RunRecord>([
    ["run-root", run({ id: "run-root", root_run_id: null, parent_run_id: null })],
    ["run-parent", run({ id: "run-parent", root_run_id: "run-root", parent_run_id: "run-root" })],
  ]);

  async getRun(spaceId: string, runId: string): Promise<RunRecord | null> {
    this.calls.push(`get:${spaceId}:${runId}`);
    return this.run?.id === runId ? this.run : this.runsById.get(runId) ?? this.run;
  }

  async resolveRunActorId(
    run: Pick<RunRecord, "space_id" | "instructed_by_user_id">,
    commandSource: string,
  ): Promise<string> {
    this.calls.push(`actor:${run.instructed_by_user_id ?? commandSource}`);
    return "actor-1";
  }

  async markRunRunning(input: {
    run_id: string;
    space_id: string;
    started_at: string;
    required_sandbox_level?: string | null;
  }): Promise<AgentRunRecord | null> {
    this.calls.push(`running:${input.run_id}`);
    if (!this.run || this.run.status !== "queued") return null;
    this.run = { ...this.run, status: "running", started_at: input.started_at };
    const running = this.run;
    await this.runningHook?.();
    return running;
  }

  async checkRunDispatchContract(): Promise<{ allowed: boolean; error_code?: string; error_message?: string }> {
    await this.dispatchHook?.();
    return this.dispatchAllowed
      ? { allowed: true }
      : { allowed: false, error_code: "dispatch_denied", error_message: "dispatch denied" };
  }

  async checkRunExecutionAuthorization(candidate: RunRecord): Promise<{
    allowed: boolean;
    error_code?: string;
    error_message?: string;
  }> {
    this.authorizationRuns.push(candidate);
    await this.authorizationHook?.();
    return this.executionAllowed
      ? { allowed: true }
      : {
          allowed: false,
          error_code: "run_execution_authorization_revoked",
          error_message: "authorization revoked",
        };
  }

  async bindRunToWorkContext(input: {
    run_id: string;
    space_id: string;
    project_id: string | null;
    project_folder_id: string | null;
    agent_id: string;
    runtime_profile_id: string | null;
  }): Promise<AgentRunRecord | null> {
    if (!this.run || this.run.id !== input.run_id || this.run.space_id !== input.space_id) return null;
    this.run = {
      ...this.run,
      project_id: input.project_id,
      project_folder_id: input.project_folder_id,
      agent_id: input.agent_id,
      agent_version_id: `${input.agent_id}-current-version`,
      system_prompt: `System prompt for ${input.agent_id}`,
      requested_runtime_profile_id: input.runtime_profile_id,
      runtime_profile_selection_source: input.runtime_profile_id ? "explicit" : "default",
    };
    return this.run;
  }

  async updateRunSandboxLevel(input: {
    run_id: string;
    space_id: string;
    required_sandbox_level: string;
  }): Promise<void> {
    this.calls.push(`sandbox_level:${input.required_sandbox_level}`);
    if (this.run) this.run = { ...this.run, required_sandbox_level: input.required_sandbox_level };
  }

  async markRunTerminal(input: RunTerminalUpdate): Promise<RunRecord | null> {
    this.calls.push(`terminal:${input.status}`);
    if (this.executionLocked) return null;
    // Mirror the SQL guard: terminal runs are never overwritten.
    if (
      this.run &&
      ["succeeded", "failed", "degraded", "cancelled"].includes(this.run.status)
    ) {
      return null;
    }
    this.terminalUpdates.push(input);
    if (this.run) this.run = { ...this.run, status: input.status, ended_at: input.completed_at };
    return this.run;
  }

  async markRunCancelling(): Promise<RunRecord | null> {
    if (!this.run || ["succeeded", "failed", "degraded", "cancelled"].includes(this.run.status)) {
      return null;
    }
    this.run = { ...this.run, status: "cancelling" };
    return this.run;
  }

  async publishRunTerminal(input: RunTerminalUpdate): Promise<RunRecord | null> {
    this.calls.push(`terminal:${input.status}`);
    if (this.run?.status === "cancelling" && input.status !== "cancelled") {
      return null;
    }
    if (
      this.run &&
      ["succeeded", "failed", "degraded", "cancelled"].includes(this.run.status)
    ) {
      return null;
    }
    this.terminalUpdates.push(input);
    if (this.run) {
      this.run = {
        ...this.run,
        status: input.status,
        ended_at: input.completed_at,
        output_json: input.output_json ?? {},
        error_json: input.error_json ?? {},
      };
    }
    const terminal = this.run;
    if (terminal) this.calls.push(`unlock:${input.run_id}`);
    if (terminal) this.executionLocked = false;
    return terminal;
  }

  async markRunWaitingForReview(input: {
    run_id: string;
    space_id: string;
    approval_code: string;
    message: string;
    paused_at: string;
  }): Promise<RunRecord | null> {
    this.calls.push(`waiting_for_review:${input.approval_code}`);
    if (!this.run || this.run.status !== "running") return null;
    this.run = { ...this.run, status: "waiting_for_review" };
    return this.run;
  }

  async grantRunApprovalAndRequeue(input: {
    run_id: string;
    space_id: string;
    granted_by_user_id: string;
    granted_at: string;
  }): Promise<RunRecord | null> {
    this.calls.push(`grant_approval:${input.run_id}`);
    if (!this.run || this.run.status !== "waiting_for_review") return null;
    this.run = { ...this.run, status: "queued" };
    return this.run;
  }

  runEvents: RunEventInput[] = [];

  /**
   * Governed-tool evidence the System Action dispatcher writes outside this
   * service, which the terminal-status check reads back.
   */
  actionEvents: Array<{
    event_type: string;
    status: string;
    error_code: string | null;
    attempt_number: number | null;
    metadata_json: unknown;
  }> = [];

  async listRunEvents(spaceId: string, runId: string) {
    this.calls.push(`listEvents:${spaceId}:${runId}`);
    return this.actionEvents;
  }

  async appendRunEvent(input: RunEventInput): Promise<unknown> {
    if (this.failEvents) throw new Error("event write failed");
    this.calls.push(`event:${input.event_type}:${input.status}`);
    this.runEvents.push(input);
    return {};
  }

  async createRunStep(input: RunStepInput): Promise<RunStepRecord> {
    if (this.failSteps) throw new Error("step write failed");
    this.calls.push(`step:${input.step_type}:${input.status}`);
    return {
      id: "step-1",
      space_id: input.space_id,
      run_id: input.run_id,
      step_index: 0,
      step_type: input.step_type,
      status: input.status,
    };
  }

  async updateRunStepStatus(input: {
    step_id: string;
    run_id: string;
    space_id: string;
    status: "succeeded" | "failed" | "skipped" | "cancelled" | "waiting_for_dependency";
    ended_at: string;
    output_summary?: string | null;
    error_type?: string | null;
    error_message?: string | null;
  }): Promise<boolean> {
    if (this.failSteps) throw new Error("step update failed");
    this.calls.push(`step_done:${input.status}`);
    return true;
  }

  async tryAcquireExecutionLock(input: {
    run_id: string;
    worker_id: string;
    job_id?: string | null;
  }): Promise<boolean> {
    this.calls.push(`lock:${input.run_id}:${input.worker_id}:${input.job_id ?? "none"}`);
    if (this.lockAcquired) this.executionLocked = true;
    return this.lockAcquired;
  }

  async releaseExecutionLock(runId: string): Promise<void> {
    this.executionLocked = false;
    this.calls.push(`unlock:${runId}`);
  }
}

class FakeRuntimeContextGateway {
  calls: unknown[] = [];

  async preview(): Promise<never> { throw new Error("preview is not used by execution tests"); }

  async prepareInvocation(input: unknown): Promise<InvocationDelivery> {
    this.calls.push(input);
    return invocationDelivery();
  }

  async acknowledgeDelivery(): Promise<Record<string, never>> { return {}; }
  async finalizeInvocation(): Promise<Record<string, never>> { return {}; }
}

/**
 * A CLI run's adapter seams. Every CLI run is dispatched to a host daemon.
 * A copy's login lives with the copy. Do not inject a server-side credential
 * broker or a runtime-tool registry. These tests check the command's
 * result, plus a built-in host to dispatch to.
 */
/**
 * A Location on the instance's own host: the realistic shape for a CLI run
 * against a Project Folder, and the one that gives its runtime profile a
 * container to live in (B68).
 */
/**
 * What a CLI conversation with no Project Folder actually carries: a managed
 * workspace the daemon derives, named by Agent and Conversation. That pair is
 * the container its runtime profile lives in (B68) — a run with neither a
 * Location nor one of these has no container at all, and is refused.
 */
const MANAGED_CONVERSATION_WORKSPACE = {
  workspace: {
    kind: "managed" as const,
    agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    container: { kind: "conversation" as const, conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  },
};

const DEFAULT_ACP_PROFILE_SNAPSHOT = {
  runtime_key: "codex_cli",
  backend_mode: "runtime_native",
  model_name: null,
  model_provider_id: null,
  runtime_config_json: {},
  runtime_policy_json: {},
  ...MANAGED_CONVERSATION_WORKSPACE,
};

const onBuiltinHost = async () => ({ hostKind: "server" as const, hostId: "host-builtin", workspaceLocationId: "location-1" });

function daemonCli(executor: CliCommandExecutor): {
  builtinHostResolver: () => Promise<string>;
  hostCli: RemoteHostCliAdapterDeps;
} {
  return {
    builtinHostResolver: async () => "host-builtin",
    hostCli: {
      executor,
      // No provider subsystem in a unit test of the run lifecycle; saying so
      // is required rather than implied, because guessing "unbound" would run
      // on the machine's own login while the control plane believed otherwise.
      //
      // The container is stated rather than resolved: `NO_PROVIDER_BINDINGS`
      // refuses a run with neither a host thread nor a Location, which is the
      // production rule and worth keeping strict — these tests are about the
      // run lifecycle, so they say which container they run in instead of
      // making the guard the subject.
      bindings: {
        ...NO_PROVIDER_BINDINGS,
        async profileScope(runRecord: { agent_id: string | null }) {
          return {
            agent_id: runRecord.agent_id!,
            container_kind: "conversation" as const,
            container_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          };
        },
      },
    },
  };
}

function orchestration(
  repo: RunExecutionRepositoryPort,
  adapters: ConstructorParameters<typeof RunOrchestrationService>[2] = {},
): RunOrchestrationService {
  const defaultExecutor: CliCommandExecutor = {
    async runCommand(input) {
      await completeCodexProtocol(input.stdio_controller, "ACP run completed");
      return { returncode: 0, stdout: "ACP run completed", stderr: "", timed_out: false };
    },
  };
  return new RunOrchestrationService(config(), repo, {
    ...daemonCli(defaultExecutor),
    hostKindResolver: onBuiltinHost,
    runtimeContextGateway: new FakeRuntimeContextGateway() as never,
    workContextResolver: async (run) => ({
      workContextScopeId: run.session_id ?? run.root_run_id ?? run.id,
      workContextSetupRef: { type: "work_context_setup", id: "setup-1", version: "1" },
      projectId: run.project_id,
      projectFolderId: run.project_folder_id,
      agentId: run.agent_id,
      runtimeProfileId: run.runtime_profile_id ?? null,
      projectBriefRef: null,
      projectInstructionRef: null,
    }),
    executionControlSnapshotWriter: async () => ({ id: "control-1" } as ExecutionControlSnapshot),
    ...adapters,
  });
}

class FakeWorkspaceManager implements RunSandboxManagerPort {
  calls: string[] = [];
  sandboxKind: PreparedRunSandbox["sandbox_kind"] = "worktree";

  async prepareRunWorkspace(run: RunRecord): Promise<PreparedRunSandbox> {
    this.calls.push(`prepare:${run.id}`);
    return {
      sandbox_cwd: "/tmp/rainver-prepared-run",
      context_cwd: "/tmp/rainver-prepared-run",
      cleanup_kind: "git_worktree",
      sandbox_kind: this.sandboxKind,
      project_folder_root: "/tmp/workspace-root",
      base_commit_sha: "abc123",
      project_folder_is_dirty: false,
    };
  }

  async cleanupRunWorkspace(input: {
    runId: string;
    spaceId: string;
    cleanupKind: string;
    sandboxCwd: string | null;
    workspaceRoot: string | null;
  }): Promise<void> {
    this.calls.push(`cleanup:${input.runId}:${input.cleanupKind}:${input.sandboxCwd}:${input.workspaceRoot}`);
  }

  async gcSandboxes(): Promise<{ removed: number; errors: number }> {
    this.calls.push("gc");
    return { removed: 0, errors: 0 };
  }
}

class FakeDelegationProjector implements RunDelegationLifecycleProjectorPort {
  running: RunRecord[] = [];
  terminal: RunRecord[] = [];
  reconciled: RunRecord[] = [];
  queued: RunRecord[] = [];
  fail = false;

  async queueDelegatedChildren(run: RunRecord): Promise<void> {
    if (this.fail) throw new Error("delegated child admission failed");
    this.queued.push(run);
  }

  async markDelegatedRunRunning(run: RunRecord): Promise<void> {
    if (this.fail) throw new Error("delegation projection failed");
    this.running.push(run);
  }

  async markDelegatedRunTerminal(run: RunRecord): Promise<void> {
    if (this.fail) throw new Error("delegation projection failed");
    this.terminal.push(run);
  }

  async reconcileWaitingRun(run: RunRecord): Promise<void> {
    if (this.fail) throw new Error("dependency-wait reconciliation failed");
    this.reconciled.push(run);
  }
}

describe("RunOrchestrationService", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks the database for the built-in host again after a transient failure", async () => {
    // The resolved id is cached for the worker's lifetime. Caching the
    // rejection too would fail every later unbound CLI Run in this process
    // until a restart, long after the database came back.
    const ensure = vi.spyOn(PgHostRepository.prototype, "ensureServerHostId")
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"))
      .mockResolvedValueOnce("host-builtin");
    try {
      const { builtinHostResolver: _unused, ...adapters } = daemonCli({
        async runCommand() {
          return { returncode: 0, stdout: "", stderr: "", timed_out: false };
        },
      });
      const service = new RunOrchestrationService(config(true), new FakeRepo(), adapters);
      const resolve = () => (service as unknown as { builtinHostId(): Promise<string> }).builtinHostId();
      await expect(resolve()).rejects.toThrow("connection terminated unexpectedly");
      await expect(resolve()).resolves.toBe("host-builtin");
      expect(ensure).toHaveBeenCalledTimes(2);
    } finally {
      ensure.mockRestore();
    }
  });

  it("admits delegated children and reconciles dependency waits after releasing the active execution lock", async () => {
    const repo = new FakeRepo();
    repo.run = run({ run_group_id: "group-1" });
    const delegationProjector = new FakeDelegationProjector();
    const reconcile = delegationProjector.reconcileWaitingRun.bind(delegationProjector);
    delegationProjector.reconcileWaitingRun = async (waitingRun) => {
      expect(repo.executionLocked).toBe(false);
      // A parent that delegated and then waited in one turn: its children
      // were created queued with no job, so the park has to admit them or
      // the two wait on each other for ever.
      expect(delegationProjector.queued).toMatchObject([{ id: "run-1", status: "waiting_for_dependency" }]);
      await reconcile(waitingRun);
    };
    const service = orchestration(repo, {
      delegationProjector,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "wait requested");
          repo.run = { ...repo.run!, status: "waiting_for_dependency" };
          return { returncode: 0, stdout: "wait requested", stderr: "", timed_out: false };
        },
      }),
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({
      run_id: "run-1",
      status: "waiting_for_dependency",
      skipped: true,
      skip_reason: "run_waiting_for_dependency",
    });

    expect(delegationProjector.reconciled).toMatchObject([
      { id: "run-1", status: "waiting_for_dependency" },
    ]);
    expect(repo.calls.slice(-2)).toEqual([
      "unlock:run-1",
      "get:space-1:run-1",
    ]);
    expect(repo.executionLocked).toBe(false);
  });

  it("dispatches an ACP Run after scope binding and snapshots policy before execution", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      system_prompt: "You are the space assistant.",
      instruction: null,
      owner_user_id: "user-1",
      session_id: "session-1",
    });
    const adapterCalls: string[] = [];
    let snapshotInputs: { runtimeInstallation: string | null; policyDecisionRecordIds: string[]; dispatchesToHostDaemon?: boolean } | null = null;
    let routedRequestedRuntimeProfileId: string | null | undefined;
    let routedBindings: Pick<RunRecord, "project_id" | "project_folder_id" | "agent_id"> | null = null;
    let snapshottedBindings: Pick<RunRecord, "project_id" | "project_folder_id" | "agent_id"> | null = null;
    const prepareInvocation = vi.fn(async () => invocationDelivery());
    const acknowledgeDelivery = vi.fn(async () => ({} as never));
    const finalizeInvocation = vi.fn(async () => ({} as never));
    const ensureWorkContextSetup = vi.fn(async () => ({ id: "setup-1", version: 1 }));
    const workContextResolver = vi.fn(async () => ({
      workContextScopeId: "session-1",
      workContextSetupRef: { type: "work_context_setup" as const, id: "setup-1", version: "1" },
      projectId: "project-from-setup",
      projectFolderId: "folder-from-setup",
      agentId: "agent-from-setup",
      runtimeProfileId: "runtime-profile-from-setup",
      projectBriefRef: null,
      projectInstructionRef: null,
    }));
    const service = orchestration(repo, {
      policyEnforcer: async (request) => ({
        status: "allow",
        policy_decision_record_id: `decision-${request.action}`,
      }),
      workContextResolver,
      ensureWorkContextSetup,
      routeResolver: {
        async routeRun(routed) {
          routedRequestedRuntimeProfileId = routed.requested_runtime_profile_id;
          routedBindings = routed;
          return routed;
        },
      },
      executionControlSnapshotWriter: async (snapshottedRun, inputs, bindings) => {
        adapterCalls.push("control_snapshot");
        snapshotInputs = inputs;
        snapshottedBindings = snapshottedRun;
        expect(bindings?.workContextSetupRef?.id).toBe("setup-1");
        return { id: "control-1" } as ExecutionControlSnapshot;
      },
      runtimeContextGateway: {
        preview: vi.fn(),
        prepareInvocation,
        acknowledgeDelivery,
        finalizeInvocation,
      },
    });

    const execution = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      job_id: "job-1",
      command_source: "job",
    });
    expect(execution, JSON.stringify(execution)).toMatchObject({ run_id: "run-1", status: "succeeded" });

    expect(routedRequestedRuntimeProfileId).toBe("runtime-profile-from-setup");
    expect(repo.authorizationRuns).toEqual([
      expect.objectContaining({
        project_id: "project-from-setup",
        project_folder_id: "folder-from-setup",
        agent_id: "agent-from-setup",
      }),
    ]);
    expect(routedBindings).toMatchObject({
      project_id: "project-from-setup",
      project_folder_id: "folder-from-setup",
      agent_id: "agent-from-setup",
    });
    expect(snapshottedBindings).toMatchObject({
      project_id: "project-from-setup",
      project_folder_id: "folder-from-setup",
      agent_id: "agent-from-setup",
    });
    expect(adapterCalls).toEqual(["control_snapshot"]);
    expect(snapshotInputs).toEqual({
      runtimeInstallation: null,
      policyDecisionRecordIds: ["decision-runtime.execute"],
      dispatchesToHostDaemon: true,
    });
    expect(prepareInvocation).toHaveBeenCalledTimes(1);
    expect(prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({
      identity: { spaceId: "space-1", userId: "user-1" },
      invocationId: "run-1",
      executionControlSnapshotId: "control-1",
      runtimeKey: "codex_cli",
      providerId: null,
    }));
    expect(ensureWorkContextSetup).toHaveBeenCalledTimes(1);
    expect(ensureWorkContextSetup).toHaveBeenCalledWith(
      { spaceId: "space-1", userId: "user-1" },
      "session-1",
      { agentId: "agent-1", runtimeProfileId: "runtime-profile-from-setup" },
    );
    expect(workContextResolver).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "run-1" }));
    expect(workContextResolver).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "run-1" }),
      { type: "work_context_setup", id: "setup-1", version: "1" },
    );
    expect(acknowledgeDelivery).toHaveBeenCalledTimes(1);
    // ACP reports aggregate internal usage, not the size of this one Delivery.
    expect(acknowledgeDelivery).toHaveBeenCalledWith(expect.objectContaining({ actualPromptTokens: null }));
    expect(finalizeInvocation).toHaveBeenCalledTimes(1);
    expect(repo.calls).toEqual([
      "get:space-1:run-1",
      "lock:run-1:worker-1:job-1",
      "running:run-1",
      "sandbox_level:worktree",
      "actor:user-1",
      "step:adapter_started:running",
      "event:adapter_invoked:running",
      // Re-read before dispatch: a stop that arrived while preparing is
      // published instead of running the turn.
      "get:space-1:run-1",
      "get:space-1:run-1",
      // Settling the turn reads the Run's own governed-tool evidence before it
      // decides between `succeeded` and `degraded`.
      "listEvents:space-1:run-1",
      "step_done:succeeded",
      "event:adapter_completed:succeeded",
      "terminal:succeeded",
      "unlock:run-1",
    ]);
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "succeeded",
      output_text: "ACP run completed",
    });
  });

  it("projects delegated child run running and final terminal status", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
    });
    const delegationProjector = new FakeDelegationProjector();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      delegationProjector,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ run_id: "run-1", status: "succeeded" });

    expect(delegationProjector.running.map((item) => item.status)).toEqual(["running"]);
    expect(delegationProjector.terminal.map((item) => item.status)).toEqual(["succeeded"]);
  });

  it("reconciles delegation projection when a terminal Run job is replayed", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      status: "succeeded",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
      parent_run_id: "run-parent",
      root_run_id: "run-root",
    });
    const delegationProjector = new FakeDelegationProjector();
    const service = orchestration(repo, {
      delegationProjector,
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({
      status: "succeeded",
      skipped: true,
      skip_reason: "run_already_terminal",
    });
    expect(delegationProjector.terminal).toHaveLength(1);
  });

  it("leaves authorization-rejected delegation projection to post-finalization handling", async () => {
    const repo = new FakeRepo();
    repo.executionAllowed = false;
    repo.run = run({
      run_group_id: "group-1",
      delegation_id: "delegation-1",
      parent_run_id: "run-parent",
      root_run_id: "run-root",
    });
    const delegationProjector = new FakeDelegationProjector();
    const service = orchestration(repo, {
      delegationProjector,
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({
      status: "failed",
      skip_reason: "execution_authorization_revoked",
    });
    expect(delegationProjector.terminal).toHaveLength(0);
  });

  it("prevents duplicate execution before adapter invocation", async () => {
    const repo = new FakeRepo();
    repo.lockAcquired = false;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({
      skipped: true,
      skip_reason: "duplicate_execution",
      error_code: "duplicate_execution",
    });

    // Duplicate execution returns the error result without writing run evidence.
    expect(repo.calls).toEqual([
      "get:space-1:run-1",
      "lock:run-1:worker-1:none",
    ]);
  });

  it("maps ACP daemon failures and redacts their terminal evidence", async () => {
    const repo = new FakeRepo();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      ...daemonCli({
        async runCommand(input) {
          input.stdio_controller?.reject("token=secret failed");
          return { returncode: 1, stdout: "", stderr: "", timed_out: false };
        },
      }),
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error_code: "runtime_nonzero_exit",
      error_text: "[REDACTED_SECRET] failed",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: {
        error_code: "runtime_nonzero_exit",
        error_text: "[REDACTED_SECRET] failed",
      },
    });
  });

  it("maps a Host daemon timeout to a terminal failed Run", async () => {
    const repo = new FakeRepo();
    let timeoutSeconds: number | undefined;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      ...daemonCli({
        async runCommand(input) {
          timeoutSeconds = input.timeout_seconds;
          return { returncode: 1, stdout: "", stderr: "", timed_out: true, failure_code: "timeout" };
        },
      }),
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error_code: "runtime_timeout",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: {
        error_code: "runtime_timeout",
      },
    });
    expect(repo.calls).toContain("unlock:run-1");
    expect(timeoutSeconds).toBe(0);
  });

  describe("explicit time limits", () => {
    // No default limit: only a limit someone set stops a Run, and it stops it
    // through the same terminate-then-force path an explicit stop uses.
    function stoppableExecutor(): { executor: CliCommandExecutor; registry: LocalCliProcessRegistry; terminations: string[]; launched: () => boolean } {
      const registry = new LocalCliProcessRegistry();
      const terminations: string[] = [];
      let started = false;
      return {
        registry,
        terminations,
        launched: () => started,
        executor: {
          runCommand(input) {
            started = true;
            return new Promise((resolve) => {
              input.process_registry?.registerRemote?.(
                input.run_id,
                () => {
                  terminations.push("terminate");
                  input.process_registry?.deregister(input.run_id);
                  resolve({ returncode: 143, stdout: "", stderr: "terminated", timed_out: false });
                },
                () => { terminations.push("force"); },
              );
            });
          },
        },
      };
    }

    it("stops a Run at its contract's max_duration_seconds and records run_timed_out", async () => {
      const repo = new FakeRepo();
      repo.run = run({ contract_snapshot_json: { max_duration_seconds: 0.05 } });
      const stoppable = stoppableExecutor();
      const service = orchestration(repo, {
        policyEnforcer: allowPolicy,
        processRegistry: stoppable.registry,
        ...daemonCli(stoppable.executor),
      });

      await expect(service.executeRun({
        run_id: "run-1", space_id: "space-1", worker_id: "worker-1", command_source: "job",
      })).resolves.toMatchObject({ status: "failed", error_code: "run_timed_out" });
      expect(stoppable.terminations).toEqual(["terminate"]);
      expect(repo.terminalUpdates[0]).toMatchObject({
        status: "failed",
        error_json: { error_code: "run_timed_out", error_text: expect.stringMatching(/time limit/) },
      });
      expect(repo.calls).toContain("unlock:run-1");
      expect(isRetryableRunErrorCode("run_timed_out")).toBe(false);
    });

    it("applies a dispatch timeout_ms when it is the shorter limit", async () => {
      const repo = new FakeRepo();
      repo.run = run({ contract_snapshot_json: { max_duration_seconds: 3600 } });
      const stoppable = stoppableExecutor();
      const service = orchestration(repo, {
        policyEnforcer: allowPolicy,
        processRegistry: stoppable.registry,
        ...daemonCli(stoppable.executor),
      });
      await expect(service.executeRun({
        run_id: "run-1", space_id: "space-1", worker_id: "worker-1", command_source: "job", timeout_ms: 50,
      })).resolves.toMatchObject({ status: "failed", error_code: "run_timed_out" });
      expect(stoppable.terminations).toEqual(["terminate"]);
    });

    it("never launches a command whose time limit passed while the dispatch was being prepared", async () => {
      // The stop finds no process while preparation is still awaiting; the
      // launch that would have followed must be refused, not sent late.
      const repo = new FakeRepo();
      repo.run = run({ contract_snapshot_json: { max_duration_seconds: 0.05 } });
      const stoppable = stoppableExecutor();
      // Preparation resumes only after the time limit's stop found nothing
      // to terminate, which is exactly the late-launch window.
      let stopReached!: () => void;
      const stopped = new Promise<void>((resolve) => { stopReached = resolve; });
      const terminate = stoppable.registry.terminate.bind(stoppable.registry);
      stoppable.registry.terminate = (runId: string) => {
        const signalled = terminate(runId);
        stopReached();
        return signalled;
      };
      const cli = daemonCli(stoppable.executor);
      cli.hostCli.bindings = {
        ...cli.hostCli.bindings!,
        observeModel: () => stopped,
      };
      const service = orchestration(repo, {
        policyEnforcer: allowPolicy,
        processRegistry: stoppable.registry,
        ...cli,
      });

      await expect(service.executeRun({
        run_id: "run-1", space_id: "space-1", worker_id: "worker-1", command_source: "job",
      })).resolves.toMatchObject({ status: "failed", error_code: "run_timed_out" });
      expect(stoppable.launched()).toBe(false);
      expect(stoppable.terminations).toEqual([]);
    });

    it("never launches a command stopped while the dispatch was being prepared", async () => {
      // The stop lands inside the adapter's preparation, before anything is
      // registered for it to terminate.
      const repo = new FakeRepo();
      const stoppable = stoppableExecutor();
      const cli = daemonCli(stoppable.executor);
      let service: RunOrchestrationService;
      cli.hostCli.bindings = {
        ...cli.hostCli.bindings!,
        observeModel: async () => {
          await service.cancelRun({ run_id: "run-1", space_id: "space-1", reason: "stopped while preparing" });
        },
      };
      service = orchestration(repo, {
        policyEnforcer: allowPolicy,
        processRegistry: stoppable.registry,
        ...cli,
      });

      await expect(service.executeRun({
        run_id: "run-1", space_id: "space-1", worker_id: "worker-1", command_source: "job",
      })).resolves.toMatchObject({ status: "cancelled" });
      expect(stoppable.launched()).toBe(false);
      expect(repo.run?.status).toBe("cancelled");
    });

    it("keeps and meters the usage a runtime reported before its time limit", async () => {
      const repo = new FakeRepo();
      repo.run = run({
        contract_snapshot_json: { max_duration_seconds: 0.05 },
        runtime_profile_snapshot_json: DEFAULT_ACP_PROFILE_SNAPSHOT,
        model_provider_id: null,
        required_sandbox_level: "none",
      });
      const usageObservations: Array<Record<string, unknown>> = [];
      const registry = new LocalCliProcessRegistry();
      const service = orchestration(repo, {
        policyEnforcer: allowPolicy,
        processRegistry: registry,
        usageRecorder: async (observation) => { usageObservations.push(observation as never); },
        hostKindResolver: onBuiltinHost,
        ...daemonCli({
          async runCommand(input) {
            // The turn answered with its usage; the process then kept going
            // until the stop reached it.
            await completeCodexProtocol(input.stdio_controller, "partial");
            return new Promise((resolve) => {
              input.process_registry?.registerRemote?.(input.run_id, () => {
                input.process_registry?.deregister(input.run_id);
                resolve({
                  returncode: 143, stdout: "", stderr: "terminated", timed_out: false,
                  task_worktree: { branch: "rainver/task-1", start_commit: "abc123" },
                });
              }, () => undefined);
            });
          },
        }),
      });

      await expect(service.executeRun({
        run_id: "run-1", space_id: "space-1", worker_id: "worker-1", command_source: "job",
      })).resolves.toMatchObject({ status: "failed", error_code: "run_timed_out" });
      expect(usageObservations).toHaveLength(1);
      expect(usageObservations[0]).toMatchObject({
        execution_channel: "local_cli",
        usage_details: { input: 12, output: 3, total: 20 },
        dimensions: { run_outcome: "failed" },
      });
    });

    it("waits out a limit longer than one timer can hold instead of firing at once", async () => {
      // setTimeout overflows past 2^31-1 ms (about 24.8 days) to 1 ms.
      vi.useFakeTimers();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const stops: string[] = [];
      let settled = false;
      const outcome = invokeWithinTimeLimit({
        run: { runtime_key: "managed_custom" },
        limit: { ms: thirtyDaysMs, seconds: thirtyDaysMs / 1000, source: "run_contract" },
        invoke: () => new Promise(() => undefined),
        stop: async () => {
          stops.push("stop");
          return { process_terminated: false, confirmed_exit: true, force_kill_escalated: false };
        },
        settleMs: 10,
      });
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2 ** 31);
      expect(stops).toEqual([]);
      await vi.advanceTimersByTimeAsync(thirtyDaysMs - 2 ** 31 - 1_000);
      expect(stops).toEqual([]);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stops).toEqual(["stop"]);
      await vi.advanceTimersByTimeAsync(10);
      await expect(outcome).resolves.toMatchObject({ success: false, error_code: "run_timed_out" });
    });

    it("sets no limit when none was set, and AgentVersion max_run_time_seconds is not one", () => {
      expect(explicitRunTimeLimit({}, null)).toBeNull();
      expect(explicitRunTimeLimit({ agent_constraints: { max_run_time_seconds: 1 }, max_duration_seconds: null }, undefined)).toBeNull();
      expect(explicitRunTimeLimit({ max_duration_seconds: 120 }, 30_000)).toEqual({ ms: 30_000, seconds: 30, source: "dispatch" });
      expect(explicitRunTimeLimit({ max_duration_seconds: 20 }, 30_000)).toEqual({ ms: 20_000, seconds: 20, source: "run_contract" });
    });

    it("bounds an adapter that ignores its stop, so the Run is not held forever", async () => {
      const stops: string[] = [];
      const result = await invokeWithinTimeLimit({
        run: { runtime_key: "managed_custom" },
        limit: { ms: 20, seconds: 1, source: "run_contract" },
        invoke: () => new Promise(() => undefined),
        stop: async () => {
          stops.push("stop");
          return { process_terminated: false, confirmed_exit: true, force_kill_escalated: false };
        },
        settleMs: 20,
      });
      expect(stops).toEqual(["stop"]);
      expect(result).toMatchObject({
        success: false,
        error_code: "run_timed_out",
        adapter_kind: "managed_api",
        metadata_json: { time_limit: { seconds: 1, source: "run_contract", adapter_settled: false } },
      });
    });
  });

  it("routes CLI runs through the vendor CLI adapter and supports cancellation", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
          async runCommand(input) {
            await completeCodexProtocol(input.stdio_controller, "cli ok");
            return {
              returncode: 0,
              stdout: "cli ok",
              stderr: "",
              timed_out: false,
            };
          },
        }),
    });

    await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      sandbox_cwd: "/tmp",
      context_text: "context",
    });

    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "succeeded",
      output_text: "cli ok",
    });

    repo.run = run({ status: "running" });
    await expect(
      service.cancelRun({
        run_id: "run-1",
        space_id: "space-1",
        requested_by_user_id: "user-1",
        reason: "stop requested",
      }),
    ).resolves.toMatchObject({ status: "cancelled", error_code: "run_cancelled" });
    expect(repo.terminalUpdates.at(-1)).toMatchObject({
      status: "cancelled",
      error_json: {
        error_code: "run_cancelled",
        requested_by_user_id: "user-1",
      },
    });
  });

  it("does not overwrite a CLI run paused by a governed tool approval", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const runtimeContextGateway = new FakeRuntimeContextGateway();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeContextGateway: runtimeContextGateway as never,
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
          async runCommand() {
            repo.run = { ...repo.run!, status: "waiting_for_review" };
            return { returncode: 0, stdout: "paused", stderr: "", timed_out: false };
          },
        }),
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      sandbox_cwd: "/tmp",
    })).resolves.toMatchObject({
      status: "waiting_for_review",
      error_code: "authorization_request_pending",
    });
    expect(repo.terminalUpdates).toEqual([]);
  });

  it("stages no Run Exchange for a CLI run, even when the caller supplies a working directory", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "folder-1",
      contract_snapshot_json: {
        required_outputs_json: [{ name: "report", path: "report.json", required: true }],
      },
    });
    const workspaceManager = new FakeWorkspaceManager();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      workspaceManager,
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "done");
          return { returncode: 0, stdout: "done", stderr: "", timed_out: false };
        },
      }),
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      // A path on *this* machine, which the run will never see. Do not send it
      // through Run Exchange: that port throws for a daemon run and fails
      // preparation.
      sandbox_cwd: "/tmp",
    });

    expect(result).toMatchObject({ status: "succeeded" });
    // Declared outputs settle. They arrive as the daemon's own uploads
    // (`recordOutputArtifacts`). Do not stage a directory pair the server
    // reads back. That pair has no meaning on another machine.
    expect(repo.terminalUpdates[0]?.status).toBe("succeeded");
  });

  it("never touches the local workspace manager for a run bound to a remote-host Folder, regardless of its sandbox level", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "remote-workspace-1",
    });
    const workspaceManager = new FakeWorkspaceManager();
    const hostKindCalls: Array<{ projectFolderId: string; spaceId: string }> = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      workspaceManager,
      hostKindResolver: async ({ projectFolderId, spaceId }) => {
        hostKindCalls.push({ projectFolderId: projectFolderId ?? "", spaceId });
        return { hostKind: "remote", hostId: "host-1", workspaceLocationId: "location-1" };
      },
      ...daemonCli({
          async runCommand() {
            throw new Error("must not spawn a process in the server for a daemon run");
          },
        }),
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      job_id: "11111111-1111-4111-8111-111111111111",
      command_source: "job",
    });

    // This fixture's executor deliberately throws if invoked. That keeps the
    // assertion focused on the remote host selection and the no-local-workspace
    // invariant rather than pretending an offline remote host can succeed.
    expect(result).toMatchObject({ status: "failed" });
    expect(hostKindCalls).toEqual([{ projectFolderId: "remote-workspace-1", spaceId: "space-1" }]);
    // Never reached the workspace manager — a remote-bound run skips every
    // local-sandbox branch unconditionally, even though this run explicitly
    // requested "worktree", precisely because the Folder's real path lives
    // on a different machine and required_sandbox_level cannot be trusted
    // to always be "none" for a remote-bound run.
    expect(workspaceManager.calls).toEqual([]);
  });

  it("routes a supported (ACP) adapter's remote-host run to the remote branch with no local sandbox prep", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "claude_code",
      model_provider_id: null,
      runtime_profile_snapshot_json: {
        ...DEFAULT_ACP_PROFILE_SNAPSHOT,
        runtime_key: "claude_code",
      },
      required_sandbox_level: "none",
      project_folder_id: "remote-workspace-2",
      prompt: "fix the failing test",
    });
    const workspaceManager = new FakeWorkspaceManager();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      workspaceManager,
      hostKindResolver: async () => ({ hostKind: "remote", hostId: "host-2", workspaceLocationId: "location-2" }),
    });
    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      job_id: "11111111-1111-4111-8111-111111111111",
      command_source: "job",
    });
    // The daemon executor is injected at the ACP boundary. A successful run
    // without local workspace preparation proves this reached the remote port.
    expect(result).toMatchObject({ status: "succeeded" });
    expect(workspaceManager.calls).toEqual([]);
  });

  describe("a host Task Run's Task branch (ADR 0016 §11)", () => {
    const START = "a".repeat(40);
    const taskRun = (over: Partial<AgentRunRecord> = {}) => run({
      runtime_key: "claude_code",
      runtime_profile_snapshot_json: {
        ...DEFAULT_ACP_PROFILE_SNAPSHOT,
        runtime_key: "claude_code",
        workspace: { kind: "location", workspace_location_id: "location-2" },
      },
      run_type: "agent",
      required_sandbox_level: "worktree",
      workspace_location_id: "location-2",
      contract_snapshot_json: { source: { kind: "task", id: "task-1" } },
      ...over,
    });
    const inWorktree: CliCommandExecutor = {
      async runCommand(input) {
        await completeCodexProtocol(input.stdio_controller, "Fixed the parser.");
        return {
          returncode: 0, stdout: "", stderr: "", timed_out: false,
          task_worktree: { branch: "rainver/task-task-1", start_commit: START },
        };
      },
    };
    const onPairedHost = async () => ({ hostKind: "remote" as const, hostId: "host-2", workspaceLocationId: "location-2" });
    const execute = (service: RunOrchestrationService) => service.executeRun({
      run_id: "run-1", space_id: "space-1", worker_id: "worker-1", command_source: "job",
    });

    it("verifies against the Run's start commit in the Task worktree, then settles, and records the commit", async () => {
      const repo = new FakeRepo();
      repo.run = taskRun();
      const order: string[] = [];
      const verified: Array<{ base: string | null; workspace: unknown }> = [];
      const settles: TaskRunSettlementInput[] = [];
      const service = orchestration(repo, {
        ...daemonCli(inWorktree),
        policyEnforcer: allowPolicy,
        hostKindResolver: onPairedHost,
        verificationEngine: {
          async verify(input) {
            order.push("verify");
            verified.push({ base: input.base_commit_sha, workspace: input.execution_target?.workspace });
            return [];
          },
        },
        taskRunSettler: {
          async settle(input) {
            order.push("settle");
            settles.push(input);
            return { branch: "rainver/task-task-1", commit: "c".repeat(40), error: null };
          },
        },
      });

      await expect(execute(service)).resolves.toMatchObject({ status: "succeeded" });
      expect(order.at(-1)).toBe("settle");
      expect(order.filter((step) => step === "verify").length).toBeGreaterThan(0);
      expect(verified[0]).toEqual({
        base: START,
        workspace: { kind: "location", workspace_location_id: "location-2", worktree: { task_id: "task-1" } },
      });
      expect(settles).toHaveLength(1);
      expect(settles[0]).toMatchObject({
        taskId: "task-1",
        hostId: "host-2",
        workspace: { kind: "location", workspace_location_id: "location-2", worktree: { task_id: "task-1" } },
        outcome: "succeeded",
        summary: "Fixed the parser.",
      });
      expect(repo.terminalUpdates[0]?.output_json).toMatchObject({
        result: { task_branch: { branch: "rainver/task-task-1", commit: "c".repeat(40), error: null } },
      });
    });

    it("records a failed settle as a warning without failing the Run", async () => {
      const repo = new FakeRepo();
      repo.run = taskRun();
      const service = orchestration(repo, {
        ...daemonCli(inWorktree),
        policyEnforcer: allowPolicy,
        hostKindResolver: onPairedHost,
        taskRunSettler: { async settle() { return { branch: null, commit: null, error: "host_offline" }; } },
      });

      await expect(execute(service)).resolves.toMatchObject({ status: "succeeded" });
      expect(repo.runEvents.some((event) => event.error_code === "task_run_settle_failed")).toBe(true);
      expect(repo.terminalUpdates[0]?.output_json).toMatchObject({
        result: { task_branch: { commit: null, error: "host_offline" } },
      });
    });

    it("settles a Task Run whose host never said where it ran, and records nothing when it ran in place", async () => {
      const silent: CliCommandExecutor = {
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "Done.");
          return { returncode: 0, stdout: "", stderr: "", timed_out: false };
        },
      };
      const repo = new FakeRepo();
      repo.run = taskRun();
      const settles: TaskRunSettlementInput[] = [];
      const service = orchestration(repo, {
        ...daemonCli(silent),
        policyEnforcer: allowPolicy,
        hostKindResolver: onPairedHost,
        taskRunSettler: { async settle(input) { settles.push(input); return { branch: null, commit: null, error: null }; } },
      });

      await expect(execute(service)).resolves.toMatchObject({ status: "succeeded" });
      expect(settles).toHaveLength(1);
      expect(repo.terminalUpdates[0]?.output_json).not.toMatchObject({ result: { task_branch: expect.anything() } });
    });

    it("settles nothing for a Run that did not execute in a Task worktree", async () => {
      const repo = new FakeRepo();
      repo.run = taskRun({ run_type: "planning" });
      const settles: unknown[] = [];
      const service = orchestration(repo, {
        ...daemonCli(inWorktree),
        policyEnforcer: allowPolicy,
        hostKindResolver: onPairedHost,
        taskRunSettler: { async settle(input) { settles.push(input); return { branch: null, commit: null, error: null }; } },
      });

      await expect(execute(service)).resolves.toMatchObject({ status: "succeeded" });
      expect(settles).toEqual([]);
      expect(repo.terminalUpdates[0]?.output_json).not.toMatchObject({ result: { task_branch: expect.anything() } });
    });
  });

  it("writes materialization summaries and finalizes after terminal state", async () => {
    const repo = new FakeRepo();
    const finalizations: Array<{
      runId: string;
      spaceId: string;
      executionLockReleased: boolean;
    }> = [];
    const materializer = {
      async materializeAdapterResult() {
        return {
          items: [
            { kind: "artifact", status: "succeeded", artifact_id: "artifact-1" },
            { kind: "artifact", status: "succeeded", artifact_id: "artifact-2" },
            { kind: "proposal", status: "succeeded", proposal_id: "proposal-1" },
          ],
          errors: [],
        };
      },
      async finalizeRun(run: RunRecord) {
        finalizations.push({
          runId: run.id,
          spaceId: run.space_id,
          executionLockReleased: repo.calls.includes("unlock:run-1"),
        });
        return {
          kind: "activity",
          status: "succeeded",
          activity_id: "finalization-1",
          metadata_json: { operation: "finalization.finalize" },
        };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      materializer,
    });

    await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });

    expect(repo.terminalUpdates[0].output_json).toMatchObject({
      schema_version: "run_output.v1",
      result: {
        runtime_key: "codex_cli",
        materialization: [
          { kind: "artifact", status: "succeeded", artifact_id: "artifact-1" },
          { kind: "artifact", status: "succeeded", artifact_id: "artifact-2" },
          { kind: "proposal", status: "succeeded", proposal_id: "proposal-1" },
        ],
      },
    });
    expect(repo.calls).toContain("event:artifact_ingested:succeeded");
    expect(repo.calls).toContain("event:proposal_created:succeeded");
    // The server finalization service owns the successful run_finalized event.
    // Orchestration only appends a finalization event when finalization fails.
    expect(repo.calls).not.toContain("event:run_finalized:succeeded");
    expect(finalizations).toEqual([{
      runId: "run-1",
      spaceId: "space-1",
      executionLockReleased: true,
    }]);
  });

  it("withholds delegated terminal projection until failed finalization is reconciled", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
    });
    const delegationProjector = new FakeDelegationProjector();
    const materializer = {
      async materializeAdapterResult() {
        return { items: [], errors: [] };
      },
      async finalizeRun() {
        return {
          kind: "activity",
          status: "failed",
          activity_id: "finalization-1",
          error_code: "finalization_failed",
          error_message: "finalizer failed",
          metadata_json: { operation: "finalization.finalize" },
        };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      delegationProjector,
      materializer,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      error_code: "finalization_failed",
    });

    expect(repo.calls).not.toContain("degraded:finalization_failed");
    expect(delegationProjector.terminal).toEqual([]);
  });

  it("marks a successful adapter run degraded when materialization partially fails", async () => {
    const repo = new FakeRepo();
    const materializer = {
      async materializeAdapterResult() {
        return {
          items: [
            {
              kind: "artifact",
              status: "failed",
              error_code: "output_artifact_materialization_error",
              error_message: "artifact denied",
            },
          ],
          errors: ["artifact:output_artifact_materialization_error:artifact denied"],
        };
      },
      async finalizeRun() {
        return {
          kind: "activity",
          status: "succeeded",
          activity_id: "finalization-1",
          metadata_json: { operation: "finalization.finalize" },
        };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      materializer,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ status: "degraded" });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "degraded",
      output_json: {
        result: {
          materialization_errors: ["artifact:output_artifact_materialization_error:artifact denied"],
        },
      },
    });
  });

  it("records failed runtime delegation materialization as run event evidence", async () => {
    const repo = new FakeRepo();
    const materializer = {
      async materializeAdapterResult() {
        return {
          items: [
            {
              kind: "delegation",
              status: "failed",
              error_code: "invalid_runtime_delegations",
              error_message: "invalid delegations",
              metadata_json: { label: "output_delegations", operation: "run.spawn_child" },
            },
          ],
          errors: ["delegation:invalid_runtime_delegations:invalid delegations"],
        };
      },
      async finalizeRun() {
        return {
          kind: "activity",
          status: "succeeded",
          activity_id: "finalization-1",
          metadata_json: { operation: "finalization.finalize" },
        };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      materializer,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ status: "degraded" });
    expect(repo.calls).toContain("event:delegation_requested:failed");
    expect(repo.terminalUpdates[0]).toMatchObject({
      output_json: {
        result: {
          materialization_errors: ["delegation:invalid_runtime_delegations:invalid delegations"],
        },
      },
    });
  });

  it("treats run step and event writes as best-effort around terminal status", async () => {
    const repo = new FakeRepo();
    repo.failEvents = true;
    repo.failSteps = true;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(repo.terminalUpdates[0]).toMatchObject({ status: "succeeded" });
  });

  it("fails closed before adapter invocation when policy denies the run", async () => {
    const repo = new FakeRepo();
    const denyPolicy: RunPolicyEnforcer = async () => ({
      status: "blocked",
      error_code: "policy_denied",
      message: "Runtime execution denied by policy: blocked by rule",
    });
    const finalized: string[] = [];
    const service = orchestration(repo, {
      policyEnforcer: denyPolicy,
      materializer: {
        async finalizeRun(finalizedRun: RunRecord) {
          finalized.push(`${finalizedRun.id}:${finalizedRun.status}`);
          return { kind: "activity", status: "succeeded", activity_id: "finalization-1", metadata_json: {} };
        },
      } as unknown as RunMaterializationService,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "http",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error_code: "policy_denied_runtime_execute",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: { error_code: "policy_denied_runtime_execute" },
    });
    expect(finalized).toEqual(["run-1:failed"]);
    expect(repo.calls).toContain("unlock:run-1");
  });

  it("publishes cancellation atomically when it races with dispatch denial", async () => {
    const repo = new FakeRepo();
    repo.dispatchAllowed = false;
    let service: RunOrchestrationService;
    repo.dispatchHook = async () => {
      await service.cancelRun({
        run_id: "run-1",
        space_id: "space-1",
        reason: "operator stop during dispatch",
      });
    };
    service = orchestration(repo, {
      policyEnforcer: allowPolicy,
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "cancelled" });
    expect(repo.run?.status).toBe("cancelled");
    expect(repo.executionLocked).toBe(false);
    expect(repo.terminalUpdates.map((update) => update.status)).toEqual([
      "cancelled",
    ]);
  });

  it("publishes a cancellation that arrived while the Run was being prepared", async () => {
    // Stop lands after the worker took the execution lock and before the Run
    // went running: the public cancel cannot publish under that lock, and the
    // Run is no longer queued, so only the execution owner can end it.
    const repo = new FakeRepo();
    let service: RunOrchestrationService;
    repo.dispatchHook = async () => {
      await service.cancelRun({ run_id: "run-1", space_id: "space-1", reason: "stopped while routing" });
    };
    service = orchestration(repo, { policyEnforcer: allowPolicy });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "cancelled" });
    expect(repo.run?.status).toBe("cancelled");
    expect(repo.executionLocked).toBe(false);
  });

  it("does not dispatch a turn stopped while its runtime was being prepared", async () => {
    // Stop lands after the Run went running and before the adapter registered
    // anything to terminate. The cancel cannot reach a process and cannot
    // publish under the lock. Do not dispatch anyway. That would run the
    // whole turn.
    const repo = new FakeRepo();
    let dispatched = false;
    let service: RunOrchestrationService;
    repo.runningHook = async () => {
      await service.cancelRun({ run_id: "run-1", space_id: "space-1", reason: "stopped while preparing" });
    };
    service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      ...daemonCli({
        async runCommand(input) {
          dispatched = true;
          await completeCodexProtocol(input.stdio_controller, "ACP run completed");
          return { returncode: 0, stdout: "ACP run completed", stderr: "", timed_out: false };
        },
      }),
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "cancelled" });
    expect(dispatched).toBe(false);
    expect(repo.run?.status).toBe("cancelled");
    expect(repo.executionLocked).toBe(false);
  });

  it("publishes a cancellation that raced a revoked execution authorization", async () => {
    const repo = new FakeRepo();
    repo.executionAllowed = false;
    let service: RunOrchestrationService;
    repo.authorizationHook = async () => {
      await service.cancelRun({ run_id: "run-1", space_id: "space-1", reason: "stopped while authorizing" });
    };
    service = orchestration(repo, { policyEnforcer: allowPolicy });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "cancelled" });
    expect(repo.run?.status).toBe("cancelled");
    expect(repo.executionLocked).toBe(false);
  });

  it("still resolves a CLI run's sandbox level from risk, and provisions nothing for it", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
      contract_snapshot_json: { risk_level: "critical", source: { kind: "direct", id: null } },
    });
    const workspaceManager = new FakeWorkspaceManager();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      workspaceManager,
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "cli ok");
          return { returncode: 0, stdout: "cli ok", stderr: "", timed_out: false };
        },
      }),
    });

    await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });

    // Isolation comes from the dispatch's `isolation` policy. The level the
    // run was created at stands. The server provisions nothing for a daemon
    // run. Do not escalate `one_shot_docker` here.
    expect(workspaceManager.calls).toEqual([]);
    // Risk decides the level, and the level travels. Do not
    // skip the resolution for daemon runs. Every CLI run would stay at the
    // creation-time `none`, so a critical Folder-bound run would get a
    // read-write workspace with nothing recording that risk had stopped
    // mattering.
    expect(repo.run.required_sandbox_level).toBe("one_shot_docker");
    expect(repo.terminalUpdates[0]?.status).toBe("succeeded");
  });

  it("ignores caller-supplied executable path overrides", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const adapterConfigs: Array<Record<string, unknown>> = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
      workspaceManager: new FakeWorkspaceManager(),
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
          async runCommand(input) {
            adapterConfigs.push({ command: input.command });
            await completeCodexProtocol(input.stdio_controller, "ok");
            return { returncode: 0, stdout: "ok", stderr: "", timed_out: false };
          },
        }),
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "http",
        adapter_config: { executable_path: "/tmp/attacker-binary" },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    // The argv is rendered from the adapter spec, and the daemon resolves the
    // executable from the copy it installed — so a caller-supplied path has
    // no place to take effect.
    expect(adapterConfigs[0].command).toEqual(["codex-acp"]);
  });

  it("uses the run row adapter type as authoritative and fails closed for unknown adapters", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_key: "legacy_removed",
      runtime_profile_snapshot_json: { ...DEFAULT_ACP_PROFILE_SNAPSHOT, runtime_key: "legacy_removed" },
      required_sandbox_level: "none",
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error_code: "runtime_adapter_not_implemented",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: { error_code: "runtime_adapter_not_implemented" },
    });
  });

  it("terminates the registered CLI process on cancel", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      status: "running",
      runtime_key: "codex_cli",
      model_provider_id: null,
    });
    const terminated: string[] = [];
    const service = orchestration(repo, {
      processRegistry: {
        register() {},
        deregister() {},
        terminate(runId: string) {
          terminated.push(runId);
          return true;
        },
      },
    });

    await expect(
      service.cancelRun({
        run_id: "run-1",
        space_id: "space-1",
        requested_by_user_id: "user-1",
        reason: "stop requested",
      }),
    ).resolves.toMatchObject({ status: "cancelled", error_code: "run_cancelled" });
    expect(terminated).toEqual(["run-1"]);
    expect(repo.calls).toContain("terminal:cancelled");
    expect(repo.run?.status).toBe("cancelled");
  });

  it("retries finalization when cancel is repeated for a cancelled Run", async () => {
    const repo = new FakeRepo();
    repo.run = run({ status: "cancelled", run_group_id: "group-1" });
    const projector = new FakeDelegationProjector();
    let attempts = 0;
    const materializer = {
      async finalizeRun() {
        attempts += 1;
        return attempts === 1
          ? { kind: "activity", status: "failed", error_code: "finalization_failed", error_message: "temporary finalizer failure" }
          : { kind: "activity", status: "succeeded", activity_id: "finalization-1" };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, { materializer, delegationProjector: projector });

    await expect(service.cancelRun({ run_id: "run-1", space_id: "space-1" }))
      .resolves.toMatchObject({ status: "cancelled", error_code: "finalization_failed" });
    await expect(service.cancelRun({ run_id: "run-1", space_id: "space-1" }))
      .resolves.toMatchObject({ status: "cancelled", skipped: true, skip_reason: "run_already_terminal" });

    expect(attempts).toBe(2);
    expect(projector.terminal).toHaveLength(1);
  });

  it("closes a cancelled delegated Run whose settlement is only owed, without reporting a failed finalization", async () => {
    const repo = new FakeRepo();
    repo.run = run({ status: "cancelled", run_group_id: "group-1" });
    const projector = new FakeDelegationProjector();
    const materializer = {
      async finalizeRun() {
        return { kind: "activity", status: "failed", error_code: "settlement_pending", error_message: "settlement owed" };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, { materializer, delegationProjector: projector });

    const result = await service.cancelRun({ run_id: "run-1", space_id: "space-1" });
    expect(result).toMatchObject({ status: "cancelled" });
    expect(result).not.toMatchObject({ error_code: "finalization_failed" });
    // The sweep settles the rest; the delegation is closed now, once.
    expect(projector.terminal).toHaveLength(1);
  });

  it("does not overwrite a concurrent cancel when the adapter finishes", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      runtime_profile_snapshot_json: DEFAULT_ACP_PROFILE_SNAPSHOT,
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "none",
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "late ok");
          // The cancel lands while the adapter is still finishing: the run is
          // already terminal by the time the result arrives.
          await service.cancelRun({
            run_id: "run-1",
            space_id: "space-1",
            requested_by_user_id: "user-1",
            reason: "stop requested",
          });
          return { returncode: 0, stdout: "late ok", stderr: "", timed_out: false };
        },
      }),
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });

    expect(result).toMatchObject({ status: "cancelled", error_code: "run_cancelled" });
    expect(repo.run?.status).toBe("cancelled");
    expect(repo.terminalUpdates.map((update) => update.status)).toEqual(["cancelled"]);
  });

  it("turns deterministic verification failure into a failed Run", async () => {
    const repo = new FakeRepo();
    let materializationCalls = 0;
    const materializer = {
      async materializeAdapterResult() {
        materializationCalls += 1;
        return { items: [], errors: [] };
      },
      async finalizeRun() {
        return {
          kind: "activity",
          status: "succeeded",
          activity_id: "finalization-1",
          metadata_json: {},
        };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      materializer,
      verificationEngine: {
        async verify() {
          return [{
            id: "verification-1",
            space_id: "space-1",
            run_id: "run-1",
            attempt_number: 1,
            verifier_type: "output_schema",
            verifier_version: "test.v1",
            status: "failed" as const,
            summary: "Acceptance contract failed.",
            evidence_refs_json: [],
            details_json: {},
            started_at: "2026-06-12T10:00:00.000Z",
            completed_at: "2026-06-12T10:00:01.000Z",
            created_at: "2026-06-12T10:00:01.000Z",
          }];
        },
      },
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({
      status: "failed",
      error_code: "verification_failed",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: { error_code: "verification_failed" },
      output_json: {
        schema_version: "run_output.v1",
        status: "failed",
      },
    });
    expect(materializationCalls).toBe(0);
  });

  it("meters a subscription CLI run without letting a failing ledger hold it", async () => {
    const repo = new FakeRepo();
    const usageObservations: unknown[] = [];
    repo.run = run({
      runtime_profile_snapshot_json: DEFAULT_ACP_PROFILE_SNAPSHOT,
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "none",
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      usageRecorder: async (observation) => {
        usageObservations.push(observation);
        throw new Error("usage ledger unavailable");
      },
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "cli ok");
          return { returncode: 0, stdout: "cli ok", stderr: "", timed_out: false };
        },
      }),
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });

    // A run on the copy's own subscription is metered nowhere else — the
    // provider proxy sees nothing, because there is no provider. Meter it
    // here. Do not gate the observation on a brokered credential profile id.
    expect(usageObservations).toHaveLength(1);
    expect(usageObservations[0]).toMatchObject({
      execution_channel: "local_cli",
      runtime_key: "codex_cli",
      event_type: "llm.generation",
      metadata: {
        // codex-acp reports its last model request, not the turn (`usage.acp_prompt_usage`).
        cli_usage: { acp_turns: 1, usage_scope: "last_model_request", estimated_total: 8, estimate_instructions: 3, estimate_current_input: 5 },
      },
      dimensions: { run_outcome: "succeeded", run_purpose: "task" },
    });
    // Recording is best-effort: a ledger that throws must not fail the run.
    expect(result).toMatchObject({ status: "succeeded" });
  });

  it("degrades a successful Run that answered without a governed tool it was granted", async () => {
    const repo = new FakeRepo();
    repo.actionEvents = [
      {
        event_type: "action_completed",
        status: "succeeded",
        error_code: null,
        attempt_number: 1,
        metadata_json: { action_id: "retrieval.search", ok: true },
      },
      {
        event_type: "action_completed",
        status: "failed",
        error_code: "system_action_policy_denied",
        attempt_number: 1,
        metadata_json: { action_id: "memory.retrieval.search", ok: false },
      },
      {
        event_type: "action_completed",
        status: "failed",
        error_code: "delegation_policy_denied",
        attempt_number: 1,
        metadata_json: { action_id: "agent.delegate", ok: false },
      },
    ];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "answered without it");
          return { returncode: 0, stdout: "answered without it", stderr: "", timed_out: false };
        },
      }),
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "degraded" });
    expect(repo.terminalUpdates[0]).toMatchObject({ status: "degraded" });

    // The Always-on gate (tasks/deferred-register.md) reads this event as its
    // evidence that an unattended Run did not silently answer without a tool
    // it was granted.
    expect(repo.runEvents.find((event) => event.error_code === "managed_tool_degraded")).toMatchObject({
      event_type: "warning",
      status: "warning",
      metadata_json: {
        event_code: "managed_tool_degraded",
        tool_names: ["memory.retrieval.search", "agent.delegate"],
        error_codes: ["system_action_policy_denied", "delegation_policy_denied"],
      },
    });
  });

  it("leaves a successful Run succeeded when every governed tool call worked", async () => {
    const repo = new FakeRepo();
    repo.actionEvents = [
      {
        event_type: "action_completed",
        status: "succeeded",
        error_code: null,
        attempt_number: 1,
        metadata_json: { action_id: "retrieval.search", ok: true },
      },
      // A refusal from the attempt this Run already retried past is not a
      // statement about the answer it is settling now.
      {
        event_type: "action_completed",
        status: "failed",
        error_code: "system_action_policy_denied",
        attempt_number: 0,
        metadata_json: { action_id: "memory.retrieval.search", ok: false },
      },
    ];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "answered with it");
          return { returncode: 0, stdout: "answered with it", stderr: "", timed_out: false };
        },
      }),
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(repo.runEvents.some((event) => event.error_code === "managed_tool_degraded")).toBe(false);
  });

  it("meters the turn that parked a Run on a delegated dependency", async () => {
    const repo = new FakeRepo();
    const usageObservations: unknown[] = [];
    repo.run = run({
      run_group_id: "group-1",
      runtime_profile_snapshot_json: DEFAULT_ACP_PROFILE_SNAPSHOT,
      runtime_key: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "none",
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      delegationProjector: new FakeDelegationProjector(),
      usageRecorder: async (observation) => {
        usageObservations.push(observation);
      },
      hostKindResolver: onBuiltinHost,
      ...daemonCli({
        async runCommand(input) {
          await completeCodexProtocol(input.stdio_controller, "delegated and waiting");
          repo.run = { ...repo.run!, status: "waiting_for_dependency" };
          return { returncode: 0, stdout: "delegated and waiting", stderr: "", timed_out: false };
        },
      }),
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({
      run_id: "run-1",
      status: "waiting_for_dependency",
      skipped: true,
    });

    // Parking is not a free turn: the prompt that produced the delegation
    // spent tokens, and a Run that resumes later must carry that cost.
    expect(usageObservations).toHaveLength(1);
    expect(usageObservations[0]).toMatchObject({
      execution_channel: "local_cli",
      runtime_key: "codex_cli",
      event_type: "llm.generation",
    });
  });

  it("keeps delegated Room work nonterminal when finalization schedules a retry", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      run_group_id: "group-1",
      delegation_id: "delegation-1",
    });
    const delegationProjector = new FakeDelegationProjector();
    const materializer = {
      async materializeAdapterResult() {
        return { items: [], errors: [] };
      },
      async finalizeRun() {
        if (repo.run) {
          repo.run = {
            ...repo.run,
            status: "queued",
            error_json: {
              error_code: "supervisor_retry_scheduled",
              reason_code: "semantic_rejection",
              attempt_number: 2,
            },
          };
        }
        return {
          kind: "activity",
          status: "succeeded",
          activity_id: "finalization-1",
          metadata_json: {},
        };
      },
    } as unknown as RunMaterializationService;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      delegationProjector,
      materializer,
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    })).resolves.toMatchObject({ status: "queued" });
    expect(delegationProjector.running).toHaveLength(1);
    expect(delegationProjector.terminal).toEqual([]);
  });

});

// A managed run's prompt can be an entire rendered batch (Source screening
// sends sixteen items at once), while `retrieval_intent` is only the turn's
// retrieval query and is bounded by the protocol. A prompt that does not fit
// is truncated. Do not fail the whole run with a Zod error.
describe("retrievalIntentFor", () => {
  it("passes short prompts through untouched", async () => {
    expect(await retrievalIntentFor("  compare memory architectures  ")).toBe("compare memory architectures");
  });

  it("returns null for empty or missing prompts", async () => {
    expect(await retrievalIntentFor(null)).toBeNull();
    expect(await retrievalIntentFor("   ")).toBeNull();
  });

  it("truncates a batch-sized prompt to something the turn schema accepts", async () => {
    const { RETRIEVAL_INTENT_MAX_CHARS, TurnContextRequestSchema } = await import("@rainver/protocol");
    const intent = await retrievalIntentFor("x".repeat(RETRIEVAL_INTENT_MAX_CHARS * 4));
    expect(intent!.length).toBeLessThanOrEqual(RETRIEVAL_INTENT_MAX_CHARS);
    const parsed = TurnContextRequestSchema.safeParse({
      work_context_scope_id: "11111111-1111-4111-8111-111111111111",
      expected_setup_version: 1,
      current_message_ref: { type: "message", id: "22222222-2222-4222-8222-222222222222" },
      one_off_refs: [],
      retrieval_intent: intent,
      invocation_purpose: "agent_task",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

// The current input is what the Delivery labels as the message to answer. A
// Room child carries its parent's turn record (the same conversation, the
// same user message) and must still be handed its delegation instruction,
// never the person's message its parent is answering.
describe("currentRuntimeContextInputRef", () => {
  const chatTurn = (extra: Record<string, unknown> = {}) => ({
    chat_turn: {
      schema_version: "chat_turn.v1",
      user_message_id: "22222222-2222-4222-8222-222222222222",
      ...extra,
    },
  });
  const run = (overrides: Record<string, unknown>) => ({
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    status: "queued",
    prompt: "Review the implementation.",
    ...overrides,
  }) as never;

  it("answers the canonical user message on an ordinary chat turn", () => {
    expect(currentRuntimeContextInputRef(run({ model_override_json: chatTurn() })))
      .toEqual({ type: "message", id: "22222222-2222-4222-8222-222222222222" });
  });

  it("gives a delegated child its own request even though it inherits the parent's turn", () => {
    expect(currentRuntimeContextInputRef(run({
      model_override_json: chatTurn({ assigned_task: "Review the implementation." }),
      parent_run_id: "run-parent",
      delegation_id: "delegation-1",
    }))).toEqual({ type: "run_request", id: "run-1" });
  });

  it("gives a session handoff and a run without a chat turn their own request", () => {
    expect(currentRuntimeContextInputRef(run({ model_override_json: chatTurn({ kind: "handoff" }) })))
      .toEqual({ type: "run_request", id: "run-1" });
    expect(currentRuntimeContextInputRef(run({ model_override_json: null })))
      .toEqual({ type: "run_request", id: "run-1" });
  });
});
