import { describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  RunOrchestrationService,
  retrievalIntentFor,
  type RunDelegationLifecycleProjectorPort,
  type RunExecutionRepositoryPort,
  type RunPolicyEnforcer,
} from "../src/modules/runs/orchestrationService.js";
import type { RunMaterializationService } from "../src/modules/runs/materializationService.js";
import type {
  RunEventInput,
  RunRecord,
  RunStepInput,
  RunStepRecord,
  RunTerminalUpdate,
  ConversationRuntimeTerminalSync,
} from "../src/modules/runs/repository.js";
import type { ExecutionControlSnapshot, InvocationDelivery, RunAdapterResultEnvelope } from "@rainver/protocol";
import type { RuntimeToolResolverPort } from "../src/modules/runtimeTools/index.js";
import type { PreparedRunSandbox, RunSandboxManagerPort } from "../src/modules/projectFolders/index.js";
import { LocalCliProcessRegistry, type CliStdioController } from "../src/modules/runs/localCliExecution.js";
import type { UsageObservation } from "../src/modules/usage/types.js";

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
    adapter_type: "model_api",
    provider_id: "provider-1",
    model: "gpt-4o-mini",
    renderer_version: "managed.v1",
    mode: "full",
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
 * ACP runtime replatform P3: codex_cli drives the general AcpController now
 * (CodexAppServerController's bespoke NDJSON-RPC handshake is deleted) — this
 * helper drives a single ACP turn to completion, same as it did for the old
 * protocol, just speaking session/new + session/prompt instead.
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

function run(overrides: Partial<RunRecord> = {}): RunRecord {
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
    adapter_type: "model_api",
    model_provider_id: "provider-1",
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
  run: RunRecord | null = run();
  lockAcquired = true;
  dispatchAllowed = true;
  executionAllowed = true;
  dispatchHook: (() => Promise<void>) | null = null;
  failEvents = false;
  failSteps = false;
  executionLocked = false;
  authorizationRuns: Array<Pick<RunRecord, "project_id" | "project_folder_id" | "agent_id">> = [];

  async getRun(spaceId: string, runId: string): Promise<RunRecord | null> {
    this.calls.push(`get:${spaceId}:${runId}`);
    return this.run;
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
  }): Promise<RunRecord | null> {
    this.calls.push(`running:${input.run_id}`);
    if (!this.run || this.run.status !== "queued") return null;
    this.run = { ...this.run, status: "running", started_at: input.started_at };
    return this.run;
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
  }): Promise<RunRecord | null> {
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

  async markRunTerminalWithConversationSession(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null> {
    this.calls.push(
      conversation.keep_session ? "runtime:record" : "runtime:invalidate",
    );
    return this.markRunTerminal(input);
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

  async publishRunTerminalWithConversationSession(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null> {
    this.calls.push(
      conversation.keep_session ? "runtime:record" : "runtime:invalidate",
    );
    return this.publishRunTerminal(input);
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

  async markRunWaitingForDependency(input: {
    run_id: string;
    space_id: string;
    output_json: unknown;
    paused_at: string;
  }): Promise<RunRecord | null> {
    this.calls.push(`waiting_for_dependency:${input.run_id}`);
    if (!this.run || this.run.status !== "running") return null;
    this.run = {
      ...this.run,
      status: "waiting_for_dependency",
      output_json: input.output_json,
      updated_at: input.paused_at,
    };
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
    status: "succeeded" | "failed" | "skipped" | "cancelled";
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

class FakeTools implements RuntimeToolResolverPort {
  async resolveForExecution(runtime: string) {
    return {
      runtime,
      executable_path: process.execPath,
      version: "test-version",
      source: "npm" as const,
      package_name: runtime === "claude_code" ? "@anthropic-ai/claude-code" : "@openai/codex",
    };
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

function orchestration(
  repo: RunExecutionRepositoryPort,
  adapters: ConstructorParameters<typeof RunOrchestrationService>[2] = {},
): RunOrchestrationService {
  const { managedApi, ...adapterOverrides } = adapters;
  return new RunOrchestrationService(config(), repo, {
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
    ...adapterOverrides,
    managedApi: {
      agentDelegationTools: {
        targets: [],
        service: { spawnChildRun: async () => { throw new Error("unexpected delegation"); } } as never,
      },
      ...managedApi,
    },
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
  fail = false;

  async markDelegatedRunRunning(run: RunRecord): Promise<void> {
    if (this.fail) throw new Error("delegation projection failed");
    this.running.push(run);
  }

  async markDelegatedRunTerminal(run: RunRecord): Promise<void> {
    if (this.fail) throw new Error("delegation projection failed");
    this.terminal.push(run);
  }
}

describe("RunOrchestrationService", () => {
  it("executes a managed API run with setup writes before adapter invocation and terminal writes after", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      system_prompt: "You are the space assistant.",
      instruction: null,
      owner_user_id: "user-1",
      session_id: "session-1",
      model_override_json: {
        execution_mode: "conversation_lightweight.v1",
        chat_turn: {
          schema_version: "chat_turn.v1",
          user_message_id: "message-1",
        },
      },
    });
    const adapterCalls: string[] = [];
    const adapterRequests: Array<{ system_prompt?: string | null }> = [];
    let snapshotInputs: { cliCredentialProfileId: string | null; policyDecisionRecordIds: string[] } | null = null;
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
      managedApi: {
        executeRuntimeHost: async (_config, request) => {
          adapterCalls.push(`adapter_after:${repo.calls.join("|")}`);
          adapterRequests.push(request);
          return {
            success: true,
            stdout: "done",
            stderr: "",
            output_text: "done",
            output_json: { adapter_type: "ts_agent_host" },
            exit_code: 0,
            error_text: null,
            error_code: null,
            started_at: "2026-06-12T10:00:00.000Z",
            completed_at: "2026-06-12T10:00:01.000Z",
            model: "gpt-4o-mini",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            events: [],
            adapter_metadata: { adapter_type: "ts_agent_host" },
            adapter_log_json: null,
          };
        },
      },
    });

    const execution = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      job_id: "job-1",
      command_source: "job",
    });
    expect(execution).toMatchObject({ run_id: "run-1", status: "succeeded" });

    expect(adapterCalls[1]).toContain("running:run-1");
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
    expect(adapterCalls).toEqual([
      "control_snapshot",
      expect.stringContaining("event:adapter_invoked:running"),
    ]);
    expect(snapshotInputs).toEqual({
      cliCredentialProfileId: null,
      policyDecisionRecordIds: ["decision-runtime.execute", "decision-runtime.use_credential"],
      // A server-host run's provider is decided here; only a remote run
      // resolves its own at launch, so the preflight must not treat this
      // run's provider as a prediction.
      executesRemotely: false,
    });
    expect(adapterRequests[0]).toMatchObject({
      system_prompt: "System prompt for agent-from-setup",
      prompt: "Say hello",
      invocation_audit_refs: { delivery_id: "delivery-1" },
    });
    expect(prepareInvocation).toHaveBeenCalledTimes(1);
    expect(prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "run-1",
      turn: expect.objectContaining({
        work_context_scope_id: "session-1",
        current_message_ref: { type: "message", id: "message-1" },
      }),
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
    expect(finalizeInvocation).toHaveBeenCalledTimes(1);
    expect(repo.calls).toEqual([
      "get:space-1:run-1",
      "lock:run-1:worker-1:job-1",
      "running:run-1",
      "actor:user-1",
      "step:adapter_started:running",
      "event:adapter_invoked:running",
      "get:space-1:run-1",
      "step_done:succeeded",
      "event:adapter_completed:succeeded",
      "terminal:succeeded",
      "unlock:run-1",
    ]);
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "succeeded",
      output_text: "done",
    });
  });

  it("marks a managed API run waiting when the adapter pauses for agent results", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      run_group_id: "group-1",
      root_run_id: "run-root",
      parent_run_id: "run-root",
      system_prompt: "You are the manager.",
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "",
          stderr: "",
          output_text: "",
          output_json: {
            waiting_for_results: {
              status: "waiting",
              scope: "current_turn",
              depends_on_run_ids: ["run-reviewer"],
              pending_run_ids: ["run-reviewer"],
            },
          },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
    });

    const waitingResult = await service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        job_id: "job-1",
        command_source: "job",
      });
    expect(waitingResult, JSON.stringify(waitingResult)).toMatchObject({ run_id: "run-1", status: "waiting_for_dependency" });

    expect(repo.terminalUpdates).toEqual([]);
    expect(repo.calls).toEqual([
      "get:space-1:run-1",
      "lock:run-1:worker-1:job-1",
      "running:run-1",
      "actor:user-1",
      "step:adapter_started:running",
      "event:adapter_invoked:running",
      "waiting_for_dependency:run-1",
      "step_done:succeeded",
      "event:adapter_completed:warning",
      "unlock:run-1",
    ]);
    expect(repo.run).toMatchObject({
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          depends_on_run_ids: ["run-reviewer"],
        },
      },
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
    let adapterCalled = false;
    const service = orchestration(repo, {
      delegationProjector,
      managedApi: {
        executeRuntimeHost: async () => {
          adapterCalled = true;
          throw new Error("adapter must not execute");
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
      skip_reason: "execution_authorization_revoked",
    });
    expect(adapterCalled).toBe(false);
    expect(delegationProjector.terminal).toHaveLength(0);
  });

  it("prevents duplicate execution before adapter invocation", async () => {
    const repo = new FakeRepo();
    repo.lockAcquired = false;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async () => {
          throw new Error("adapter should not run");
        },
      },
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

  it("maps adapter failures and orchestration exceptions to terminal failed runs", async () => {
    const repo = new FakeRepo();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async () => ({
          success: false,
          stdout: "",
          stderr: "bad",
          output_text: "",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 1,
          error_text: "token=secret failed",
          error_code: "provider_invocation_failed",
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: null,
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
      error_code: "provider_invocation_failed",
      error_text: "[REDACTED_SECRET] failed",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: {
        error_code: "provider_invocation_failed",
        error_text: "[REDACTED_SECRET] failed",
      },
    });
  });

  it("maps orchestration-level adapter timeout to a terminal failed run", async () => {
    const repo = new FakeRepo();
    let adapterAborted = false;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async (_config, _request, options) =>
          new Promise(() => {
            options?.signal?.addEventListener("abort", () => {
              adapterAborted = true;
            }, { once: true });
          }),
      },
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
        timeout_ms: 1,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error_code: "adapter_timeout",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: {
        error_code: "adapter_timeout",
      },
    });
    expect(repo.calls).toContain("unlock:run-1");
    expect(adapterAborted).toBe(true);
  });

  it("routes CLI runs through the vendor CLI adapter and supports cancellation", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const executorResults: RunAdapterResultEnvelope[] = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree",
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            await completeCodexProtocol(input.stdio_controller, "cli ok");
            return {
              returncode: 0,
              stdout: "cli ok",
              stderr: "",
              timed_out: false,
            };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      sandbox_cwd: "/tmp",
      context_text: "context",
    });
    executorResults.push(repo.terminalUpdates[0].output_json as RunAdapterResultEnvelope);

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
    expect(executorResults.length).toBe(1);
  });

  it("does not overwrite a CLI run paused by a governed tool approval", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const runtimeContextGateway = new FakeRuntimeContextGateway();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: runtimeContextGateway as never,
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree",
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand() {
            repo.run = { ...repo.run!, status: "waiting_for_review" };
            return { returncode: 0, stdout: "paused", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
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

  it("validates declared CLI Exchange output before completing the Run", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "folder-1",
      contract_snapshot_json: {
        required_outputs_json: [{
          name: "report",
          path: "report.json",
          required: true,
          json_schema: {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "string" } },
          },
        }],
      },
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree",
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            const output = input.env.RAINVER_EXCHANGE_OUTPUT;
            expect(output).toBeTruthy();
            await mkdir(dirname(`${output}/report.json`), { recursive: true });
            await writeFile(`${output}/report.json`, JSON.stringify({ answer: "ok" }));
            await completeCodexProtocol(input.stdio_controller, "done");
            return { returncode: 0, stdout: "done", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      sandbox_cwd: "/tmp",
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(repo.terminalUpdates[0].output_json).toMatchObject({
      output_manifest: [expect.objectContaining({ name: "report", status: "valid" })],
    });
  });

  it("prepares CLI sandbox and context natively", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const runtimeContextGateway = new FakeRuntimeContextGateway();
    const workspaceManager = new FakeWorkspaceManager();
    const executorCalls: Array<{ command: string[]; cwd: string | null }> = [];
    const usageObservations: Array<Record<string, unknown>> = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: runtimeContextGateway as never,
      workspaceManager,
      usageRecorder: async (observation) => {
        usageObservations.push(observation as unknown as Record<string, unknown>);
        throw new Error("usage ledger unavailable");
      },
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree",
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            executorCalls.push({ command: input.command, cwd: input.cwd });
            await completeCodexProtocol(input.stdio_controller, "cli ok");
            return {
              returncode: 0,
              stdout: "cli ok",
              stderr: "",
              timed_out: false,
            };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        job_id: "11111111-1111-4111-8111-111111111111",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    expect(workspaceManager.calls).toEqual([
      "prepare:run-1",
      "cleanup:run-1:git_worktree:/tmp/rainver-prepared-run:/tmp/workspace-root",
    ]);
    expect(runtimeContextGateway.calls[0]).toMatchObject({
      invocationId: "run-1",
      adapterType: "codex_cli",
      executionControlSnapshotId: "control-1",
      identity: { spaceId: "space-1", userId: "user-1" },
    });
    expect(executorCalls[0]).toEqual({
      command: [process.execPath],
      cwd: "/tmp/rainver-prepared-run",
    });
    expect(repo.calls).toContain("event:sandbox_created:succeeded");
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "succeeded",
      output_text: "cli ok",
    });
    expect(usageObservations).toEqual([
      expect.objectContaining({
        space_id: "space-1",
        source_type: "local_run",
        execution_channel: "local_cli",
        adapter_type: "codex_cli",
        run_id: "run-1",
        external_session_id: "session-1",
        usage_accuracy: "provider_reported",
        idempotency_key: "usage-delivery-1:0",
        usage_details: {
          input: 12,
          output: 3,
          total: 20,
          input_cache_creation: 0,
          input_cache_read: 4,
          output_reasoning: 1,
        },
      }),
    ]);
  });

  it("never touches the local workspace manager for a run bound to a remote-host Folder, regardless of its sandbox level (ADR 0016 P2/P3)", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "remote-workspace-1",
    });
    const workspaceManager = new FakeWorkspaceManager();
    const hostKindCalls: Array<{ projectFolderId: string; spaceId: string }> = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      workspaceManager,
      hostKindResolver: async ({ projectFolderId, spaceId }) => {
        hostKindCalls.push({ projectFolderId: projectFolderId ?? "", spaceId });
        return { hostKind: "remote", hostId: "host-1", workspaceLocationId: "location-1" };
      },
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            throw new Error("must not resolve a credential grant for a remote run (D1: no server-brokered credentials)");
          },
        },
        executor: {
          async runCommand() {
            throw new Error("must not spawn a process through the server-host executor for a remote run");
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      job_id: "11111111-1111-4111-8111-111111111111",
      command_source: "job",
    });

    // ACP runtime replatform P3: codex_cli is now remote-eligible (its
    // protocol is "acp", driven through the same general AcpController as
    // opencode) — no live daemon connection is registered anywhere in this
    // process during this test, so it fails the same way the argv_template
    // remote test below does (host offline), not via a protocol-rejection
    // error_code. That failure mode is itself proof the call reached the
    // remote branch rather than falling through to the server-host mocks
    // above, which would have thrown instead.
    expect(result).toMatchObject({ status: "failed" });
    expect(hostKindCalls).toEqual([{ projectFolderId: "remote-workspace-1", spaceId: "space-1" }]);
    // Never reached the workspace manager — a remote-bound run skips every
    // local-sandbox branch unconditionally, even though this run explicitly
    // requested "worktree", precisely because the Folder's real path lives
    // on a different machine and required_sandbox_level cannot be trusted
    // to always be "none" for a remote-bound run.
    expect(workspaceManager.calls).toEqual([]);
  });

  it("routes a supported (ACP) adapter's remote-host run to the remote branch with no local sandbox prep (ADR 0016 P3)", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "claude_code",
      model_provider_id: null,
      required_sandbox_level: "none",
      project_folder_id: "remote-workspace-2",
      prompt: "fix the failing test",
    });
    const workspaceManager = new FakeWorkspaceManager();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
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
    // No live daemon connection is registered anywhere in this process
    // during this test, so `RemoteWsCliCommandExecutor` (constructed inside
    // `executeRemoteHostCliAdapter` itself — this layer has no injection
    // seam for it, by design; see remoteHostCliAdapter.test.ts for
    // wire-level coverage with a fake connection registry) reports the
    // host offline rather than crashing or falling through to a local
    // path. That failure mode is itself proof the call reached the remote
    // branch: a local_cli run with no execution_port override would
    // instead have failed on a missing vendor credential grant.
    expect(result).toMatchObject({ status: "failed" });
    expect(workspaceManager.calls).toEqual([]);
  });

  it("tells the execution preflight a managed-API run on a remote Location is not a remote run", async () => {
    // Only a local_cli adapter is dispatched to a daemon. A model_api run
    // inside a Folder whose active Location is remote still executes on
    // the server, against exactly the provider it recorded — so telling the
    // preflight otherwise strips that provider and fails the run.
    //
    // This asserts the value the orchestrator *computes*, which is what the
    // corrected predicate lives in; the snapshot repository's own branch on
    // the flag is covered separately.
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "model_api",
      model_provider_id: "provider-1",
      required_sandbox_level: "none",
      project_folder_id: "remote-workspace-2",
      prompt: "summarize",
    });
    let observed: { executesRemotely?: boolean } | null = null;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      workspaceManager: new FakeWorkspaceManager(),
      hostKindResolver: async () => ({ hostKind: "remote", hostId: "host-2", workspaceLocationId: "location-2" }),
      executionControlSnapshotWriter: async (_run, inputs) => {
        observed = inputs;
        return { id: "control-1" } as ExecutionControlSnapshot;
      },
    });
    await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      job_id: "22222222-2222-4222-8222-222222222222",
      command_source: "job",
    });
    expect(observed).not.toBeNull();
    expect(observed!.executesRemotely).toBe(false);
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: {
            adapter_type: "ts_agent_host",
            artifacts: [{ title: "A" }],
            proposed_changes: [{ proposal_type: "memory_create" }],
          },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
        adapter_type: "model_api",
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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

  it("marks a successful adapter run degraded when a managed tool was unavailable", async () => {
    const repo = new FakeRepo();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "answered",
          stderr: "",
          output_text: "answered",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: {
            adapter_type: "ts_agent_host",
            // One tool loop means one summary key: delegation calls report
            // here alongside retrieval ones rather than under a second key.
            managed_tool_calls: [
              { tool_name: "retrieval.search", ok: true, result_count: 3 },
              { tool_name: "memory.retrieval.search", ok: false, error_code: "system_action_policy_denied" },
              { tool_name: "agent.delegate", ok: false, error_code: "delegation_policy_denied" },
            ],
          },
          adapter_log_json: null,
        }),
      },
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ status: "degraded" });
    expect(repo.terminalUpdates[0]).toMatchObject({ status: "degraded" });
    const degraded = repo.runEvents.find((event) => event.error_code === "managed_tool_degraded");
    expect(degraded).toMatchObject({
      event_type: "warning",
      status: "warning",
      metadata_json: {
        event_code: "managed_tool_degraded",
        tool_names: ["memory.retrieval.search", "agent.delegate"],
        error_codes: ["system_action_policy_denied", "delegation_policy_denied"],
      },
    });
  });

  it("leaves a successful adapter run succeeded when every managed tool call worked", async () => {
    const repo = new FakeRepo();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "answered",
          stderr: "",
          output_text: "answered",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: {
            adapter_type: "ts_agent_host",
            managed_tool_calls: [{ tool_name: "retrieval.search", ok: true, result_count: 3 }],
          },
          adapter_log_json: null,
        }),
      },
    });

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(repo.runEvents.some((event) => event.error_code === "managed_tool_degraded")).toBe(false);
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: { adapter_type: "ts_agent_host" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
    let adapterInvoked = false;
    const finalized: string[] = [];
    const service = orchestration(repo, {
      policyEnforcer: denyPolicy,
      materializer: {
        async finalizeRun(finalizedRun: RunRecord) {
          finalized.push(`${finalizedRun.id}:${finalizedRun.status}`);
          return { kind: "activity", status: "succeeded", activity_id: "finalization-1", metadata_json: {} };
        },
      } as unknown as RunMaterializationService,
      managedApi: {
        executeRuntimeHost: async () => {
          adapterInvoked = true;
          throw new Error("adapter must not run after policy denial");
        },
      },
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
    expect(adapterInvoked).toBe(false);
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

  it("upgrades every critical CLI run to one-shot Docker at the shared policy boundary", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
      contract_snapshot_json: {
        risk_level: "critical",
        source: { kind: "direct", id: null },
      },
    });
    const workspaceManager = new FakeWorkspaceManager();
    const executorModes: string[] = [];
    const executorInputs: Array<{ read_only?: unknown }> = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
      workspaceManager,
      vendorCli: {
        credentialBroker: {
          async grantForRun(
            _runId,
            _spaceId,
            _runtime,
            executorMode,
          ) {
            executorModes.push(executorMode);
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: executorMode,
              readonly: true,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            executorInputs.push({ read_only: input.read_only });
            await completeCodexProtocol(input.stdio_controller, "critical cli ok");
            return { returncode: 0, stdout: "critical cli ok", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      risk_level: "low",
    })).resolves.toMatchObject({ status: "succeeded" });

    expect(repo.calls).toContain("sandbox_level:one_shot_docker");
    expect(executorModes).toEqual(["worktree"]);
    expect(executorInputs[0]?.read_only).toBeUndefined();
    expect(workspaceManager.calls).toContain("prepare:run-1");
  });

  it("ignores caller-supplied executable path overrides", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const adapterConfigs: Array<Record<string, unknown>> = [];
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
      workspaceManager: new FakeWorkspaceManager(),
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree" as const,
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            adapterConfigs.push({ command: input.command });
            await completeCodexProtocol(input.stdio_controller, "ok");
            return { returncode: 0, stdout: "ok", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
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
    expect(adapterConfigs[0].command).toEqual([process.execPath]);
  });

  it("uses the run row adapter type as authoritative and fails closed for unknown adapters", async () => {
    const repo = new FakeRepo();
    repo.run = run({ adapter_type: "legacy_removed", required_sandbox_level: "none" });
    let hostCalled = false;
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
      managedApi: {
        executeRuntimeHost: async () => {
          hostCalled = true;
          return {
            success: true,
            stdout: "",
            stderr: "",
            output_text: "resolved-adapter ok",
            output_json: { adapter_type: "ts_agent_host" },
            exit_code: 0,
            error_text: null,
            error_code: null,
            started_at: "2026-06-12T10:00:00.000Z",
            completed_at: "2026-06-12T10:00:01.000Z",
            model: "gpt-4o-mini",
            usage: null,
            events: [],
            adapter_metadata: { adapter_type: "ts_agent_host" },
            adapter_log_json: null,
          };
        },
      },
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
    expect(hostCalled).toBe(false);
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: { error_code: "runtime_adapter_not_implemented" },
    });
  });

  it("records a successful conversation runtime session before publishing terminal status", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "none",
      session_id: "session-1",
      system_prompt: "System",
      model_override_json: {
        execution_mode: "conversation_lightweight.v1",
        conversation_runtime: {
          schema_version: "conversation_runtime.v1",
          binding_id: "binding-1",
          runtime_state_key: "33333333-3333-4333-8333-333333333333",
          runtime_session_id: null,
          context_fingerprint: "fingerprint-1",
          replay_prompt: "Full replay",
        },
      },
    });
    const runtimeContextGateway = new FakeRuntimeContextGateway();
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: runtimeContextGateway as never,
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree" as const,
              readonly: false,
              temp_home: null,
              persistent_home: true,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            await completeCodexProtocol(input.stdio_controller, "ok");
            return { returncode: 0, stdout: "ok", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });
    expect(result).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(runtimeContextGateway.calls[0]).toMatchObject({
      invocationId: "run-1",
      adapterType: "codex_cli",
      executionControlSnapshotId: "control-1",
    });
    expect(repo.calls.indexOf("runtime:record"))
      .toBeLessThan(repo.calls.indexOf("terminal:succeeded"));
  });

  it("terminates the registered CLI process on cancel", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      status: "running",
      adapter_type: "codex_cli",
      model_provider_id: null,
      model_override_json: {
        conversation_runtime: {
          schema_version: "conversation_runtime.v1",
          binding_id: "binding-1",
          runtime_state_key: "11111111-1111-4111-8111-111111111111",
        },
      },
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
    expect(repo.calls.indexOf("runtime:invalidate"))
      .toBeLessThan(repo.calls.indexOf("terminal:cancelled"));
    expect(repo.run?.status).toBe("cancelled");
  });

  it("aborts an in-flight managed API request before confirming cancellation", async () => {
    const repo = new FakeRepo();
    repo.run = run({ status: "queued", adapter_type: "model_api" });
    const processRegistry = new LocalCliProcessRegistry();
    let signalSeen: AbortSignal | undefined;
    let started!: () => void;
    const adapterStarted = new Promise<void>((resolve) => { started = resolve; });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      processRegistry,
      managedApi: {
        executeRuntimeHost: async (_config, _request, options) => {
          signalSeen = options?.signal;
          started();
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("managed request aborted")),
              { once: true },
            );
          });
        },
      },
    });

    const execution = service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });
    await adapterStarted;

    const cancellation = await service.cancelRun({
      run_id: "run-1",
      space_id: "space-1",
      requested_by_user_id: "user-1",
      reason: "stop the provider request",
    });
    const executionResult = await execution;

    expect(signalSeen?.aborted).toBe(true);
    // The executing worker still owns terminal publication at this instant,
    // so the cancelling caller may observe the intermediate state; what must
    // already be true is that the provider signal fired and the owner then
    // publishes cancelled rather than a late success/failure.
    expect(cancellation).toMatchObject({ status: "cancelling" });
    expect(executionResult).toMatchObject({ status: "cancelled" });
    expect(repo.run?.status).toBe("cancelled");
    expect(processRegistry.terminate("run-1")).toBe(false);
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

  it("does not overwrite a concurrent cancel when the adapter finishes", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const usageObservations: UsageObservation[] = [];
    const service: RunOrchestrationService = orchestration(repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
      workspaceManager: new FakeWorkspaceManager(),
      usageRecorder: async (observation) => {
        usageObservations.push(observation);
      },
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree" as const,
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            await completeCodexProtocol(input.stdio_controller, "late ok");
            // A stop lands while the CLI is still running.
            await service.cancelRun({
              run_id: "run-1",
              space_id: "space-1",
              reason: "stop requested",
            });
            return { returncode: 0, stdout: "late ok", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    const result = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "http",
      sandbox_cwd: "/tmp",
      context_text: "context",
    });

    expect(result).toMatchObject({
      status: "cancelled",
      error_code: "run_cancelled",
    });
    expect(repo.run?.status).toBe("cancelled");
    expect(repo.terminalUpdates.map((update) => update.status)).toEqual(["cancelled"]);
    expect(usageObservations).toHaveLength(1);
    expect(usageObservations[0]).toMatchObject({
      run_id: "run-1",
      usage_details: {
        input: 12,
        output: 3,
        total: 20,
        input_cache_creation: 0,
        input_cache_read: 4,
        output_reasoning: 1,
      },
    });
    expect(repo.calls).toContain("unlock:run-1");
  });

  it("turns an explicit semantic rejection into a failed Run", async () => {
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "cannot complete",
          stderr: "",
          output_text: "cannot complete",
          output_json: { status: "rejected", rejection: { reason: "missing evidence" } },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
    });

    const semanticResult = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });
    expect(semanticResult).toMatchObject({
      status: "failed",
      error_code: "semantic_rejection",
    });
    expect(repo.terminalUpdates[0]).toMatchObject({
      status: "failed",
      error_json: { error_code: "semantic_rejection" },
      output_json: {
        schema_version: "run_output.v1",
        status: "rejected",
      },
    });
    expect(materializationCalls).toBe(0);
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "done",
          stderr: "",
          output_text: "done",
          output_json: { status: "succeeded" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
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

  it("holds capped CLI retries when durable usage recording fails", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      contract_snapshot_json: { max_cost: 1 },
    });
    const service = orchestration(repo, {
      policyEnforcer: allowPolicy,
      usageRecorder: async () => {
        throw new Error("usage ledger unavailable");
      },
      runtimeToolVersionResolver: async () => "test-version",
      runtimeContextGateway: new FakeRuntimeContextGateway() as never,
      workspaceManager: new FakeWorkspaceManager(),
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree",
              readonly: false,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            await completeCodexProtocol(input.stdio_controller, "done");
            return { returncode: 0, stdout: "done", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    await expect(service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
      sandbox_cwd: "/tmp",
    })).resolves.toMatchObject({
      status: "failed",
      error_code: "usage_recording_failed",
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
      managedApi: {
        executeRuntimeHost: async () => ({
          success: true,
          stdout: "cannot complete",
          stderr: "",
          output_text: "cannot complete",
          output_json: { status: "rejected" },
          exit_code: 0,
          error_text: null,
          error_code: null,
          started_at: "2026-06-12T10:00:00.000Z",
          completed_at: "2026-06-12T10:00:01.000Z",
          model: "gpt-4o-mini",
          usage: null,
          events: [],
          adapter_metadata: { adapter_type: "ts_agent_host" },
          adapter_log_json: null,
        }),
      },
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
// retrieval query and is bounded by the protocol. An unbounded prompt used to
// fail envelope validation and fail the whole run with a Zod error.
describe("retrievalIntentFor", () => {
  it("passes short prompts through untouched", async () => {
    expect(await retrievalIntentFor("  compare memory architectures  ")).toBe("compare memory architectures");
  });

  it("returns null for empty or missing prompts", async () => {
    expect(await retrievalIntentFor(null)).toBeNull();
    expect(await retrievalIntentFor("   ")).toBeNull();
  });

  it("keeps an explicit intent whole, so a batch caller never relies on truncation", async () => {
    const { RETRIEVAL_INTENT_MAX_CHARS } = await import("@rainver/protocol");
    const goal = "How do long-term memory architectures compare in personalization quality?";
    const renderedBatch = "ITEM 1\n".repeat(RETRIEVAL_INTENT_MAX_CHARS);
    expect(await retrievalIntentFor(goal ?? renderedBatch)).toBe(goal);
    expect(goal.length).toBeLessThan(RETRIEVAL_INTENT_MAX_CHARS);
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
