import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import {
  RunOrchestrationService,
  type RunDelegationLifecycleProjectorPort,
  type RunExecutionRepositoryPort,
  type RunPolicyEnforcer,
} from "../src/modules/runs/orchestrationService";
import type { RunMaterializationService } from "../src/modules/runs/materializationService";
import type {
  RunEventInput,
  RunRecord,
  RunStepInput,
  RunStepRecord,
  RunTerminalUpdate,
  ConversationRuntimeTerminalSync,
} from "../src/modules/runs/repository";
import type { RunAdapterResultEnvelope } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { RuntimeToolResolverPort } from "../src/modules/runtimeTools";
import type { PreparedRunSandbox, RunSandboxManagerPort } from "../src/modules/projectFolders";
import type { CliStdioController } from "../src/modules/runs/localCliExecution";
import type { UsageObservation } from "../src/modules/usage/types";
import { prepareConversationRuntimeState } from "../src/modules/runs/conversationRuntimeState";

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    SERVER_INTERNAL_TOKEN: "internal-token",
    AGENT_SPACE_HOME: "/tmp/agent-space-run-orchestration-tests-home",
    SANDBOX_ROOT: "/tmp/agent-space-run-orchestration-tests",
  });
}

const allowPolicy: RunPolicyEnforcer = async () => ({ status: "allow" });

function completeCodexProtocol(
  controller: CliStdioController | undefined,
  text: string,
  observeSend: (message: Record<string, unknown>) => void = () => {},
  threadId = "thread-1",
  resumed = false,
): void {
  if (!controller) throw new Error("expected Codex stdio controller");
  const send = observeSend;
  const close = () => {};
  controller.start(send);
  controller.receive({ id: 1, result: {} }, send, close);
  controller.receive({ id: 2, result: { thread: { id: threadId } } }, send, close);
  if (resumed) {
    controller.receive({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        tokenUsage: {
          total: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
      },
    }, send, close);
  }
  controller.receive({ id: 3, result: { turn: { id: "turn-1" } } }, send, close);
  controller.receive({
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: text,
    },
  }, send, close);
  controller.receive({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId: "turn-1",
      tokenUsage: {
        last: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 1,
        },
        total: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 1,
        },
      },
    },
  }, send, close);
  controller.receive({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: "turn-1", status: "completed" },
    },
  }, send, close);
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

  async checkRunExecutionAuthorization(): Promise<{
    allowed: boolean;
    error_code?: string;
    error_message?: string;
  }> {
    return this.executionAllowed
      ? { allowed: true }
      : {
          allowed: false,
          error_code: "run_execution_authorization_revoked",
          error_message: "authorization revoked",
        };
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

  async appendRunEvent(input: RunEventInput): Promise<unknown> {
    if (this.failEvents) throw new Error("event write failed");
    this.calls.push(`event:${input.event_type}:${input.status}`);
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

class FakeContextPreparer {
  contextRendered = true;
  runtimeContextText: string | null = null;
  calls: Array<{
    runId: string;
    spaceId: string;
    adapterType: string | null;
    sandboxCwd: string | null;
    targetFormat: string | null;
    workspacePath: string | null;
    promptOverride?: string | null;
  }> = [];

  async prepare(input: {
    runId: string;
    spaceId: string;
    adapterType: string | null;
    sandboxCwd: string | null;
    targetFormat: string | null;
    workspacePath: string | null;
    promptOverride?: string | null;
  }) {
    this.calls.push(input);
    return {
      runtime_prompt: input.promptOverride ?? "prepared prompt",
      runtime_context_text: this.runtimeContextText,
      context_snapshot_id: "snapshot-1",
      context_rendered: this.contextRendered,
      target_format: input.targetFormat,
      instruction_file_path: input.sandboxCwd
        ? `${input.sandboxCwd}/AGENTS.md`
        : null,
      total_chars: 100,
      budget_chars: 128000,
      dropped_sections: [],
    };
  }
}

class FakeWorkspaceManager implements RunSandboxManagerPort {
  calls: string[] = [];
  sandboxKind: PreparedRunSandbox["sandbox_kind"] = "worktree";

  async prepareRunWorkspace(run: RunRecord): Promise<PreparedRunSandbox> {
    this.calls.push(`prepare:${run.id}`);
    return {
      sandbox_cwd: "/tmp/aspace-prepared-run",
      context_cwd: "/tmp/aspace-prepared-run",
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
    repo.run = run({ system_prompt: "You are the space assistant.", instruction: null });
    const adapterCalls: string[] = [];
    const adapterRequests: Array<{ system_prompt?: string | null }> = [];
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
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

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        job_id: "job-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ run_id: "run-1", status: "succeeded" });

    expect(adapterCalls[0]).toContain("running:run-1");
    expect(adapterCalls[0]).toContain("event:adapter_invoked:running");
    expect(adapterRequests[0]).toMatchObject({
      system_prompt: "You are the space assistant.",
      prompt: "Say hello",
    });
    expect(repo.calls).toEqual([
      "get:space-1:run-1",
      "lock:run-1:worker-1:job-1",
      "running:run-1",
      "actor:job",
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
    const service = new RunOrchestrationService(config(), repo, {
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

    await expect(
      service.executeRun({
        run_id: "run-1",
        space_id: "space-1",
        worker_id: "worker-1",
        job_id: "job-1",
        command_source: "job",
      }),
    ).resolves.toMatchObject({ run_id: "run-1", status: "waiting_for_dependency" });

    expect(repo.terminalUpdates).toEqual([]);
    expect(repo.calls).toEqual([
      "get:space-1:run-1",
      "lock:run-1:worker-1:job-1",
      "running:run-1",
      "actor:job",
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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

  it("passes prepared digest context to managed API system context", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      system_prompt: "You are the space assistant.",
      prompt: "Original prompt",
    });
    const contextPreparer = new FakeContextPreparer();
    contextPreparer.contextRendered = false;
    contextPreparer.runtimeContextText = "[digest:policy_bundle:v3]\nUse safe defaults.";
    const adapterRequests: Array<{ system_prompt?: string | null; prompt?: string | null }> = [];
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      contextPreparer,
      managedApi: {
        executeRuntimeHost: async (_config, request) => {
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
    ).resolves.toMatchObject({ run_id: "run-1", status: "succeeded" });

    expect(contextPreparer.calls[0]).toMatchObject({
      adapterType: "model_api",
      targetFormat: "generic",
    });
    expect(adapterRequests[0]?.prompt).toBe("prepared prompt");
    expect(adapterRequests[0]?.system_prompt).toContain("You are the space assistant.");
    expect(adapterRequests[0]?.system_prompt).toContain("[digest:policy_bundle:v3]");
    expect(adapterRequests[0]?.system_prompt).toContain("Use safe defaults.");
  });

  it("prevents duplicate execution before adapter invocation", async () => {
    const repo = new FakeRepo();
    repo.lockAcquired = false;
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
            completeCodexProtocol(input.stdio_controller, "cli ok");
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
    const service = new RunOrchestrationService(config(), repo, {
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
      error_code: "cli_tool_approval_required",
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
    const service = new RunOrchestrationService(config(), repo, {
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
            const output = input.env.AGENT_SPACE_EXCHANGE_OUTPUT;
            expect(output).toBeTruthy();
            await mkdir(dirname(`${output}/report.json`), { recursive: true });
            await writeFile(`${output}/report.json`, JSON.stringify({ answer: "ok" }));
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
    const contextPreparer = new FakeContextPreparer();
    const workspaceManager = new FakeWorkspaceManager();
    const executorCalls: Array<{ command: string[]; cwd: string | null }> = [];
    const usageObservations: Array<Record<string, unknown>> = [];
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer,
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
            completeCodexProtocol(input.stdio_controller, "cli ok");
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
      "cleanup:run-1:git_worktree:/tmp/aspace-prepared-run:/tmp/workspace-root",
    ]);
    expect(contextPreparer.calls).toEqual([
      {
        runId: "run-1",
        spaceId: "space-1",
        adapterType: "codex_cli",
        sandboxCwd: "/tmp/aspace-prepared-run",
        targetFormat: "codex_cli",
        workspacePath: "/tmp/workspace-root",
      },
    ]);
    expect(executorCalls[0]).toEqual({
      command: [
        process.execPath,
        "app-server",
        "--stdio",
      ],
      cwd: "/tmp/aspace-prepared-run",
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
        external_session_id: "thread-1",
        usage_accuracy: "provider_reported",
        idempotency_key:
          "local-cli:11111111-1111-4111-8111-111111111111:0",
        usage_details: {
          input: 8,
          output: 2,
          total: 15,
          input_cache_creation: 0,
          input_cache_read: 4,
          output_reasoning: 1,
        },
      }),
    ]);
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    service = new RunOrchestrationService(config(), repo, {
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
    const executorInputs: Array<{ docker?: unknown }> = [];
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer: new FakeContextPreparer(),
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
            executorInputs.push({ docker: input.docker });
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
    expect(executorModes).toEqual(["docker"]);
    expect(executorInputs[0]?.docker).toMatchObject({ image: "agent-space-sandbox" });
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
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer: new FakeContextPreparer(),
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
            completeCodexProtocol(input.stdio_controller, "ok");
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
    expect(adapterConfigs[0].command).toEqual([
      process.execPath,
      "app-server",
      "--stdio",
    ]);
  });

  it("uses the run row adapter type as authoritative and fails closed for unknown adapters", async () => {
    const repo = new FakeRepo();
    repo.run = run({ adapter_type: "legacy_removed", required_sandbox_level: "none" });
    let hostCalled = false;
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      contextPreparer: new FakeContextPreparer(),
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
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
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
            completeCodexProtocol(input.stdio_controller, "ok");
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
    expect(repo.calls.indexOf("runtime:record"))
      .toBeLessThan(repo.calls.indexOf("terminal:succeeded"));
  });

  it("resumes a Room CLI conversation while retaining project context and tool grants", async () => {
    const stateKey = "77777777-7777-4777-8777-777777777777";
    await prepareConversationRuntimeState({
      agent_space_home: config().agentSpaceHome,
      sandbox_root: config().sandboxRoot,
      state_key: stateKey,
      resume_requested: false,
    });
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "read_only",
      project_folder_id: "workspace-1",
      session_id: "room-session-1",
      system_prompt: "Room system",
      permission_snapshot_json: {
        tool_grants: [{
          action_id: "source.search",
          approval_behavior: "none",
          side_effecting: false,
        }],
      },
      model_override_json: {
        execution_mode: "room_conversation.v1",
        conversation_runtime: {
          schema_version: "conversation_runtime.v1",
          binding_id: "binding-room-1",
          runtime_state_key: stateKey,
          runtime_session_id: "vendor-room-session-1",
          context_fingerprint: "room-fingerprint-1",
          replay_prompt: "Full Room replay",
          message_cursor_id: "message-2",
        },
      },
    });
    const contextPreparer = new FakeContextPreparer();
    const workspaceManager = new FakeWorkspaceManager();
    workspaceManager.sandboxKind = "read_only_project";
    const protocolMessages: Record<string, unknown>[] = [];
    let manifest: Record<string, unknown> | null = null;
    let invokedCwd: string | null = null;
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer,
      workspaceManager,
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "codex_cli",
              executor_mode: "worktree" as const,
              readonly: true,
              temp_home: `${config().agentSpaceHome}/cache/conversation-runtime-homes/${stateKey}`,
              persistent_home: true,
              host_source_path: null,
              target_path: null,
              env: {
                HOME: `${config().agentSpaceHome}/cache/conversation-runtime-homes/${stateKey}`,
              },
              network_profile_id: null,
              fallback_reason: null,
            };
          },
        },
        executor: {
          async runCommand(input) {
            invokedCwd = input.cwd;
            manifest = JSON.parse(
              await readFile(input.env.AGENT_SPACE_EXCHANGE_INPUT!, "utf8"),
            ) as Record<string, unknown>;
            completeCodexProtocol(
              input.stdio_controller,
              "ok",
              message => {
                protocolMessages.push(message);
              },
              "vendor-room-session-1",
              true,
            );
            return { returncode: 0, stdout: "ok", stderr: "", timed_out: false };
          },
        },
        toolRegistry: new FakeTools(),
      },
    });

    const execution = await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });
    expect({
      execution,
      terminal: repo.terminalUpdates[0],
    }).toMatchObject({
      execution: { status: "succeeded" },
    });

    expect(workspaceManager.calls).toContain("prepare:run-1");
    expect(contextPreparer.calls[0]).toMatchObject({
      sandboxCwd: "/tmp/aspace-prepared-run",
      workspacePath: "/tmp/workspace-root",
    });
    expect(invokedCwd).toBe("/tmp/aspace-prepared-run");
    expect(manifest).toMatchObject({
      tool_grants: [{ action_id: "source.search" }],
    });
    expect(protocolMessages).toContainEqual(expect.objectContaining({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "vendor-room-session-1" }),
    }));
  });

  it("replays a Room turn in Claude's stable conversation cwd when resume state is absent", async () => {
    const stateKey = randomUUID();
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "claude_code",
      model_provider_id: null,
      required_sandbox_level: "none",
      project_folder_id: null,
      session_id: "room-session-1",
      prompt: "Increment only",
      model_override_json: {
        execution_mode: "room_conversation.v1",
        conversation_runtime: {
          schema_version: "conversation_runtime.v1",
          binding_id: "binding-room-2",
          runtime_state_key: stateKey,
          runtime_session_id: "stale-vendor-session",
          context_fingerprint: "room-fingerprint-2",
          replay_prompt: "Full Room replay with assigned segment",
          message_cursor_id: "message-3",
        },
      },
    });
    const contextPreparer = new FakeContextPreparer();
    const invocations: Array<{ cwd: string | null; command: string[] }> = [];
    const claudeOutput = await readFile(
      join(__dirname, "fixtures", "cliRuntimeOutput", "claude_code.turn.jsonl"),
      "utf8",
    );
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer,
      vendorCli: {
        credentialBroker: {
          async grantForRun() {
            return {
              granted: true,
              profile_id: "11111111-1111-4111-8111-111111111111",
              runtime: "claude_code",
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
            invocations.push({ cwd: input.cwd, command: input.command });
            return {
              returncode: 0,
              stdout: claudeOutput,
              stderr: "",
              timed_out: false,
            };
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
    expect({ result, terminal: repo.terminalUpdates[0] }).toMatchObject({
      result: { status: "succeeded" },
      terminal: { status: "succeeded" },
    });

    expect(invocations[0]?.cwd).toContain(stateKey);
    expect(invocations[0]?.command).not.toContain("--resume");
    expect(invocations[0]?.command.at(-1)).toContain(
      "Full Room replay with assigned segment",
    );
    expect(contextPreparer.calls[0]).toMatchObject({
      sandboxCwd: invocations[0]?.cwd,
      promptOverride: "Full Room replay with assigned segment",
    });
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
    const service = new RunOrchestrationService(config(), repo, {
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

  it("does not overwrite a concurrent cancel when the adapter finishes", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "worktree",
      project_folder_id: "workspace-1",
    });
    const usageObservations: UsageObservation[] = [];
    const service: RunOrchestrationService = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer: new FakeContextPreparer(),
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
            completeCodexProtocol(input.stdio_controller, "late ok");
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
        input: 8,
        output: 2,
        total: 15,
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
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
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      usageRecorder: async () => {
        throw new Error("usage ledger unavailable");
      },
      runtimeToolVersionResolver: async () => "test-version",
      contextPreparer: new FakeContextPreparer(),
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
            completeCodexProtocol(input.stdio_controller, "done");
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
    const service = new RunOrchestrationService(config(), repo, {
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

  it("adds bounded failure context to a Supervisor retry attempt", async () => {
    const repo = new FakeRepo();
    repo.run = run({
      error_json: {
        error_code: "supervisor_retry_scheduled",
        reason_code: "verification_failed",
        attempt_number: 2,
      },
    });
    const requests: Array<{ prompt?: string | null; run_input?: unknown }> = [];
    const service = new RunOrchestrationService(config(), repo, {
      policyEnforcer: allowPolicy,
      managedApi: {
        executeRuntimeHost: async (_config, request) => {
          requests.push(request);
          return {
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
          };
        },
      },
    });

    await service.executeRun({
      run_id: "run-1",
      space_id: "space-1",
      worker_id: "worker-1",
      command_source: "job",
    });

    expect(requests[0]?.prompt).toContain("physical attempt 2");
    expect(requests[0]?.prompt).toContain("verification_failed");
    expect(requests[0]?.run_input).toMatchObject({
      inputs: {
        direct: {
          supervisor_retry: {
            reason_code: "verification_failed",
            attempt_number: 2,
          },
        },
      },
    });
  });
});
