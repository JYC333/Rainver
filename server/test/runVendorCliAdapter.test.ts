import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildSubprocessEnv,
  executeVendorCliAdapter,
  type CliCommandExecutor,
  type CliCredentialBrokerPort,
  type CliExecutionResult,
} from "../src/modules/runs/vendorCliAdapter.js";
import { ProviderProxyLeaseRegistry } from "../src/modules/providers/proxy/lease.js";
import { materializeRunCredentialHome } from "../src/modules/providers/cli/credentialBroker.js";
import type { RuntimeToolResolverPort } from "../src/modules/runtimeTools/index.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { assembleRunInputEnvelope } from "../src/modules/runs/runInputEnvelope.js";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";
import type { InvocationDelivery } from "@rainver/protocol";
import type { RunInvocationAttemptLifecycle } from "../src/modules/runs/runtimeContextAttempts.js";

const tmpPaths: string[] = [];

afterEach(async () => {
  for (const path of tmpPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    status: "running",
    mode: "headless",
    prompt: "Fix the bug",
    instruction: null,
    project_folder_id: "workspace-1",
    session_id: null,
    project_id: null,
    adapter_type: "codex_cli",
    model_provider_id: null,
    required_sandbox_level: "worktree",
    trigger_origin: "manual",
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

class FakeBroker implements CliCredentialBrokerPort {
  grants: Array<{
    runId: string;
    spaceId: string;
    runtime: string;
    executorMode: string;
    profileId?: string | null;
  }> = [];
  cleanups: string[] = [];
  granted = true;
  liveQuotas: Array<{ runtime: string; profileId: string; quota: Record<string, unknown> }> = [];

  async prepareRunHome(runId: string): Promise<string> {
    return `/tmp/runtime-home/${runId}`;
  }

  async grantForRun(
    runId: string,
    spaceId: string,
    runtime: string,
    executorMode: "worktree" | "docker",
    profileId?: string | null,
  ) {
    this.grants.push({ runId, spaceId, runtime, executorMode, profileId });
    const env: Record<string, string> = this.granted
      ? {
          HOME: `/tmp/runtime-home/${runId}`,
          SHOULD_NOT_PASS: "no",
        }
      : {};
    return {
      granted: this.granted,
      profile_id: this.granted ? profileId ?? "default-profile-id" : null,
      runtime,
      executor_mode: executorMode,
      readonly: false,
      temp_home: this.granted ? `/tmp/runtime-home/${runId}` : null,
      host_source_path: null,
      target_path: null,
      env,
      network_profile_id: null,
      fallback_reason: this.granted ? null : "no_profile_configured",
    };
  }

  async cleanupRunHome(runId: string): Promise<void> {
    this.cleanups.push(runId);
  }

  async recordLiveQuota(
    runtime: string,
    profileId: string,
    quota: Record<string, unknown>,
  ): Promise<void> {
    this.liveQuotas.push({ runtime, profileId, quota });
  }
}

class TempCodexBroker extends FakeBroker {
  tempHome: string | null = null;
  profileDir: string | null = null;

  async grantForRun(
    runId: string,
    spaceId: string,
    runtime: string,
    executorMode: "worktree" | "docker",
    profileId?: string | null,
  ) {
    this.grants.push({ runId, spaceId, runtime, executorMode, profileId });
    const root = await mkdtemp(join(tmpdir(), "rainver-runtime-home-"));
    tmpPaths.push(root);
    this.tempHome = join(root, "home");
    this.profileDir = join(root, "profile");
    await mkdir(this.tempHome, { recursive: true });
    await mkdir(this.profileDir, { recursive: true });
    await writeFile(join(this.profileDir, "auth.json"), "{\"token\":\"login-state\"}", "utf8");
    await writeFile(join(this.profileDir, "config.toml"), "shared = true", "utf8");
    await mkdir(join(this.profileDir, "sessions"), { recursive: true });
    await writeFile(join(this.profileDir, "sessions", "shared.jsonl"), "shared session", "utf8");
    await symlink(this.profileDir, join(this.tempHome, ".codex"));
    return {
      granted: true,
      profile_id: profileId ?? "default-profile-id",
      runtime,
      executor_mode: executorMode,
      readonly: false,
      temp_home: this.tempHome,
      host_source_path: null,
      target_path: null,
      env: { HOME: this.tempHome },
      network_profile_id: null,
      fallback_reason: null,
    };
  }
}

class FakeExecutor implements CliCommandExecutor {
  protocolMessages: Record<string, unknown>[] = [];
  calls: Array<{
    command: string[];
    cwd: string | null;
    timeout_seconds: number;
    env: Record<string, string>;
    run_id: string;
    stdin: string | null;
    docker?: {
      image: string;
      sandbox_cwd: string;
      cli_tools_root: string;
      credential_source_path: string | null;
      credential_target_path: string | null;
    };
    read_only?: {
      workspace_cwd: string;
      context_cwd: string;
      sandbox_root: string;
      rainver_home: string;
      cli_tools_root: string;
      readable_paths: string[];
      writable_paths: string[];
    };
  }> = [];
  result: CliExecutionResult = {
    returncode: 0,
    // Empty by default: every ACP-protocol test that needs extra session/update
    // content overrides this explicitly with valid `jsonrpc: "2.0"`-shaped
    // NDJSON lines (see e.g. "runs OpenCode with a sandbox config..."); a
    // non-ACP (claude_code) test overrides it with realistic stream-json.
    stdout: "",
    stderr: "",
    timed_out: false,
  };
  /**
   * ACP context-priming delivery (context bootstrap turn + current-user
   * turn) sends a second `session/prompt`; set to feed extra session/update
   * lines before responding to it. Empty by default — a no-op for every
   * single-prompt test, since the controller only ever asks for a second
   * prompt when it was given more than one.
   */
  secondTurnStdout = "";
  sessionModelOptions: Array<Record<string, unknown>> | null = null;
  /**
   * Simulates a `session/resume` RPC rejection (e.g. "Session not found") —
   * the controller's own `resume_handshake_failed` path, distinct from the
   * process-exit/stderr-text heuristic other failure tests below exercise.
   */
  simulateResumeRejection = false;

  async runCommand(input: {
    command: string[];
    cwd: string | null;
    timeout_seconds: number;
    env: Record<string, string>;
    run_id: string;
    stdin: string | null;
    docker?: {
      image: string;
      sandbox_cwd: string;
      cli_tools_root: string;
      credential_source_path: string | null;
      credential_target_path: string | null;
    };
    on_stdout_chunk?: (chunk: string) => void;
  }): Promise<CliExecutionResult> {
    this.calls.push(input);
    const controller = (input as Parameters<CliCommandExecutor["runCommand"]>[0]).stdio_controller;
    if (controller) {
      // ACP runtime replatform P1/P3: opencode and codex_cli both drive the
      // general AcpController now (CodexAppServerController's bespoke
      // NDJSON-RPC handshake is deleted); this fake only needs to speak ACP.
      const send = (message: Record<string, unknown>) => { this.protocolMessages.push(message); };
      const close = () => {};
      controller.start(send);
      controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
      if (this.simulateResumeRejection) {
        controller.receive({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: "Session not found" },
        }, send, close);
        return { returncode: 0, stdout: "", stderr: "", timed_out: false };
      }
      controller.receive({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          ...(this.sessionModelOptions ? { configOptions: this.sessionModelOptions } : {}),
        },
      }, send, close);
      // The controller only asks for session/set_config_option when a model
      // was supplied (codex_cli never supplies one) — replying to it
      // unconditionally would arrive as an unexpected id 3 once the
      // controller has already moved straight to session/prompt.
      const setConfigOption = this.protocolMessages.at(-1);
      if (setConfigOption?.method === "session/set_config_option") {
        // Echo back whatever model was actually requested — the controller
        // fails closed if the applied value doesn't match what it asked for.
        const requestedModel = (setConfigOption.params as { value?: unknown } | undefined)?.value;
        controller.receive({
          jsonrpc: "2.0",
          id: 3,
          result: {
            configOptions: [{ id: "model", currentValue: requestedModel }],
          },
        }, send, close);
      }
      for (const line of this.result.stdout.split(/\r?\n/).filter(Boolean)) {
        input.on_stdout_chunk?.(`${line}\n`);
        controller.receive(JSON.parse(line) as Record<string, unknown>, send, close);
      }
      controller.receive(
        {
          jsonrpc: "2.0",
          id: 4,
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
        },
        send,
        close,
      );
      // Context-priming delivery: before_next_prompt is async, so the
      // controller's second session/prompt (id 5) lands a couple of
      // microtasks after id 4's response resolves.
      await Promise.resolve();
      await Promise.resolve();
      if (this.protocolMessages.some((m) => m.id === 5 && m.method === "session/prompt")) {
        for (const line of this.secondTurnStdout.split(/\r?\n/).filter(Boolean)) {
          input.on_stdout_chunk?.(`${line}\n`);
          controller.receive(JSON.parse(line) as Record<string, unknown>, send, close);
        }
        controller.receive(
          {
            jsonrpc: "2.0",
            id: 5,
            result: {
              stopReason: "end_turn",
              usage: {
                inputTokens: 24,
                outputTokens: 6,
                totalTokens: 39,
                cachedReadTokens: 8,
                cachedWriteTokens: 0,
                thoughtTokens: 1,
              },
            },
          },
          send,
          close,
        );
      }
    } else {
      input.on_stdout_chunk?.(this.result.stdout);
    }
    return this.result;
  }
}

class FakeTools implements RuntimeToolResolverPort {
  async resolveForExecution(runtime: string) {
    return {
      runtime,
      executable_path: process.execPath,
      version: "test-version",
      source: "npm" as const,
      package_name: runtime === "claude_code"
        ? "@agentclientprotocol/claude-agent-acp"
        : runtime === "codex_cli"
          ? "@agentclientprotocol/codex-acp"
          : "@openai/codex",
    };
  }
}

describe("executeVendorCliAdapter", () => {
  it("materializes OpenCode auth at its nested HOME path without shared session state", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-opencode-home-"));
    tmpPaths.push(root);
    const source = join(root, "profile");
    const home = join(root, "run-home");
    await mkdir(source, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(source, "auth.json"), '{"token":"owned"}', "utf8");
    await writeFile(join(source, "opencode.db"), "shared session state", "utf8");

    await materializeRunCredentialHome({
      tempHome: home,
      runtime: "opencode",
      sourcePath: source,
    });

    await expect(
      readFile(join(home, ".local", "share", "opencode", "auth.json"), "utf8"),
    ).resolves.toContain("owned");
    await expect(
      readFile(join(home, ".local", "share", "opencode", "opencode.db"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects a vendor-created symlink in a persistent credential HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-opencode-home-link-"));
    tmpPaths.push(root);
    const source = join(root, "profile");
    const home = join(root, "conversation-home");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(source, "auth.json"), '{"token":"owned"}', "utf8");
    await symlink(outside, join(home, ".local"));

    await expect(materializeRunCredentialHome({
      tempHome: home,
      runtime: "opencode",
      sourcePath: source,
    })).rejects.toThrow("credential target contains a symlink");
    await expect(readFile(join(outside, "share", "opencode", "auth.json"), "utf8"))
      .rejects.toThrow();
  });

  it("runs codex_cli with credential grant, safe env, and no vendor instruction file", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run(),
        sandbox_cwd: sandbox,
        context_text: "Repo instructions",
        adapter_config: {
          credential_profile_id: "11111111-1111-4111-8111-111111111111",
          timeout: 120,
        },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    await expect(readFile(join(sandbox, "AGENTS.md"), "utf8")).rejects.toThrow();
    expect(broker.grants).toEqual([
      {
        runId: "run-1",
        spaceId: "space-1",
        runtime: "codex_cli",
        executorMode: "worktree",
        profileId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    expect(broker.cleanups).toEqual(["run-1"]);
    expect(executor.calls[0]).toMatchObject({
      command: [process.execPath],
      cwd: sandbox,
      timeout_seconds: 120,
      run_id: "run-1",
      stdin: null,
    });
    expect(executor.calls[0].env.OPENAI_API_KEY).toBeUndefined();
    expect(executor.calls[0].env.CODEX_HOME).toBe("/tmp/runtime-home/run-1/.codex");
    expect(executor.calls[0].env.SHOULD_NOT_PASS).toBeUndefined();
    expect(result).toMatchObject({
      adapter_type: "codex_cli",
      adapter_kind: "local_cli",
      success: true,
      output_text: "",
      error_code: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4,
        reasoning_tokens: 1,
      },
      metadata_json: {
        credential_profile_id: "11111111-1111-4111-8111-111111111111",
        external_session_id: "session-1",
      },
      adapter_log_json: {
        command: [process.execPath],
        timeout_seconds: 120,
      },
    });
  });

  it("renders scoped CLI bootstrap before the current user item without a vendor context file", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-delivery-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();
    const capturedEvents: Array<{ type: string; metadata_json?: unknown }> = [];
    const invocationAttempts: RunInvocationAttemptLifecycle = {
      prepare: async () => { throw new Error("not used"); },
      acknowledge: async () => ({} as never),
      finalize: async () => ({} as never),
      acknowledgeContext: vi.fn(async () => undefined),
    };
    const delivery: InvocationDelivery = {
      id: "delivery-1",
      invocation_id: "run-1",
      delivery_kind: "agent_task",
      adapter_type: "codex_cli",
      provider_id: null,
      model: null,
      renderer_version: "runtime-context-managed.v1",
      mode: "full",
      planned_items: [
        { item_id: "context-1", semantic_role: "reference_data", required: true },
        { item_id: "current-1", semantic_role: "user_input", required: true },
      ],
      message_blocks: [
        {
          semantic_role: "reference_data",
          content: "Validated checkpoint and canonical tail.",
          source_item_ids: ["context-1"],
          delivery_phase: "bootstrap_context",
        },
        {
          semantic_role: "user_input",
          content: "Continue the task.",
          source_item_ids: ["current-1"],
          delivery_phase: "current_user",
        },
      ],
      cli_session: {
        binding_ref: { type: "runtime_context_cli_binding", id: "binding-1", version: "1" },
        runtime_state_key: "state-1",
        vendor_session_id: null,
        cursor_from: 0,
        cursor_through: 2,
        generation: 1,
        rotation_reason: "new_scope",
      },
      control_ref: { type: "execution_control_snapshot", id: "control-1" },
      sandbox_ref: null,
      tool_grant_refs: [],
      output_contract_ref: null,
      expected_prompt_tokens: 20,
      max_output_tokens: null,
      snapshot_draft_ref: { type: "invocation_snapshot", id: "snapshot-1" },
      audit_refs: {
        delivery_id: "delivery-1",
        invocation_snapshot_id: "snapshot-1",
        execution_control_snapshot_id: "control-1",
        usage_source_id: "usage-1",
      },
    };

    executor.result.stdout = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "bootstrap-call", title: "bootstrap command" },
      },
    });
    executor.secondTurnStdout = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "current-call", title: "current command" },
      },
    });

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run(),
        sandbox_cwd: sandbox,
        invocation_delivery: delivery,
        invocation_attempts: invocationAttempts,
        adapter_config: { credential_profile_id: "11111111-1111-4111-8111-111111111111" },
        runtime_event_sink: (event) => { capturedEvents.push(event); },
      },
      { credentialBroker: new FakeBroker(), executor, toolRegistry: new FakeTools() },
    );

    expect(result.success).toBe(true);
    const turns = executor.protocolMessages.filter((message) => message.method === "session/prompt") as Array<{
      params: { prompt: Array<{ text: string }> };
    }>;
    expect(turns).toHaveLength(2);
    expect(turns[0]?.params.prompt[0]?.text).toContain("[Rainver context bootstrap — ordinary context message]");
    expect(turns[0]?.params.prompt[0]?.text).toContain("Validated checkpoint and canonical tail.");
    expect(turns[0]?.params.prompt[0]?.text).not.toContain("Continue the task.");
    expect(turns[1]?.params.prompt[0]?.text).toBe("Continue the task.");
    expect(invocationAttempts.acknowledgeContext).toHaveBeenCalledWith(delivery, "session-1");
    expect(capturedEvents.map((event) => event.type)).toEqual(["tool_call_started"]);
    expect(JSON.stringify(capturedEvents)).toContain("current command");
    expect(JSON.stringify(capturedEvents)).not.toContain("bootstrap command");
    await expect(readFile(join(sandbox, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("does not leak Claude Code ACP bootstrap tool events into the current turn", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-claude-delivery-"));
    tmpPaths.push(sandbox);
    const sessionId = "session-1";
    const executor = new FakeExecutor();
    executor.result.stdout = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "bootstrap-tool", title: "BootstrapTool" },
      },
    });
    executor.secondTurnStdout = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "current-tool", title: "CurrentTool" },
      },
    });
    const capturedEvents: Array<{ type: string; metadata_json?: unknown }> = [];
    const delivery: InvocationDelivery = {
      id: "delivery-claude",
      invocation_id: "run-1",
      delivery_kind: "agent_task",
      adapter_type: "claude_code",
      provider_id: null,
      model: null,
      renderer_version: "runtime-context-managed.v1",
      mode: "full",
      planned_items: [
        { item_id: "context-1", semantic_role: "reference_data", required: true },
        { item_id: "current-1", semantic_role: "user_input", required: true },
      ],
      message_blocks: [
        {
          semantic_role: "reference_data",
          content: "Bootstrap context.",
          source_item_ids: ["context-1"],
          delivery_phase: "bootstrap_context",
        },
        {
          semantic_role: "user_input",
          content: "Current request.",
          source_item_ids: ["current-1"],
          delivery_phase: "current_user",
        },
      ],
      cli_session: {
        binding_ref: { type: "runtime_context_cli_binding", id: "binding-claude", version: "1" },
        runtime_state_key: "state-claude",
        vendor_session_id: null,
        cursor_from: 0,
        cursor_through: 1,
        generation: 1,
        rotation_reason: "new_scope",
      },
      control_ref: { type: "execution_control_snapshot", id: "control-1" },
      sandbox_ref: null,
      tool_grant_refs: [],
      output_contract_ref: null,
      expected_prompt_tokens: 10,
      max_output_tokens: null,
      snapshot_draft_ref: { type: "invocation_snapshot", id: "snapshot-claude" },
      audit_refs: {
        delivery_id: "delivery-claude",
        invocation_snapshot_id: "snapshot-claude",
        execution_control_snapshot_id: "control-1",
        usage_source_id: "usage-claude",
      },
    };

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code" }),
        sandbox_cwd: sandbox,
        invocation_delivery: delivery,
        adapter_config: { credential_profile_id: "11111111-1111-4111-8111-111111111111" },
        runtime_event_sink: (event) => { capturedEvents.push(event); },
      },
      { credentialBroker: new FakeBroker(), executor, toolRegistry: new FakeTools() },
    );

    expect(result.success).toBe(true);
    expect(capturedEvents.map((event) => event.type)).toEqual(["tool_call_started"]);
    expect(JSON.stringify(capturedEvents)).toContain("CurrentTool");
    expect(JSON.stringify(capturedEvents)).not.toContain("BootstrapTool");
  });

  it("stages context outside a read-only Project Folder and passes one write-scoped HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-cli-read-only-"));
    tmpPaths.push(root);
    const workspace = join(root, "workspaces", "project");
    const contextCwd = join(root, "sandboxes", "read-only-context", "run-1");
    const runtimeHome = join(root, "cache", "cli-run-homes", "run-1");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(contextCwd, { recursive: true }),
      mkdir(runtimeHome, { recursive: true }),
    ]);
    await writeFile(join(workspace, "source.txt"), "project source");
    const broker = new FakeBroker();
    broker.grantForRun = async (runId, spaceId, runtime, executorMode, profileId) => {
      broker.grants.push({ runId, spaceId, runtime, executorMode, profileId });
      return {
        granted: true,
        profile_id: profileId ?? "default-profile-id",
        runtime,
        executor_mode: executorMode,
        readonly: false,
        temp_home: runtimeHome,
        host_source_path: null,
        target_path: null,
        env: { HOME: runtimeHome },
        network_profile_id: null,
        fallback_reason: null,
      };
    };
    const executor = new FakeExecutor();
    const readOnlyConfig = loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
      SERVER_INTERNAL_TOKEN: "internal-token",
      RAINVER_HOME: root,
      SANDBOX_ROOT: join(root, "sandboxes"),
      WORKSPACE_ROOT: join(root, "workspaces"),
    });

    const result = await executeVendorCliAdapter(
      readOnlyConfig,
      {
        run: run({ required_sandbox_level: "read_only" }),
        sandbox_cwd: workspace,
        context_text: "Generated read-only instructions",
        adapter_config: {
          credential_profile_id: "11111111-1111-4111-8111-111111111111",
          read_only_workspace: {
            workspace_cwd: workspace,
            context_cwd: contextCwd,
          },
        },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    await expect(readFile(join(contextCwd, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("project source");
    expect(executor.calls[0]).toMatchObject({
      cwd: workspace,
      read_only: {
        workspace_cwd: workspace,
        context_cwd: contextCwd,
        sandbox_root: join(root, "sandboxes"),
        rainver_home: root,
        cli_tools_root: readOnlyConfig.cliToolsRoot,
        readable_paths: [],
        writable_paths: [runtimeHome],
      },
    });
    expect(result).toMatchObject({ success: true, error_code: null });
  });

  it("runs an ephemeral (no-workspace) CLI in the prepared working dir", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-eph-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ required_sandbox_level: "ephemeral", project_folder_id: null }),
        sandbox_cwd: sandbox,
        context_text: "Daily organize",
        adapter_config: { credential_profile_id: "11111111-1111-4111-8111-111111111111", timeout: 60 },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(result).toMatchObject({
      adapter_type: "codex_cli",
      success: true,
      error_code: null,
    });
    expect(executor.calls[0]).toMatchObject({ cwd: sandbox, run_id: "run-1" });
    await expect(readFile(join(sandbox, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("writes run-scoped Codex provider config for an OpenAI-compatible provider", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-codex-provider-"));
    tmpPaths.push(sandbox);
    const broker = new TempCodexBroker();
    const executor = new FakeExecutor();
    const leases = new ProviderProxyLeaseRegistry();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({
          model_provider_id: "provider-openai",
        }),
        sandbox_cwd: sandbox,
        context_text: "Codex instructions",
        adapter_config: { credential_profile_id: "11111111-1111-4111-8111-111111111111" },
      },
      {
        credentialBroker: broker,
        executor,
        toolRegistry: new FakeTools(),
        providerLeaseRegistry: leases,
        providerProxyBaseUrl: "http://127.0.0.1:49152",
        providerResolver: {
          async getProvider(_spaceId, providerId) {
            return {
              id: providerId,
              space_id: "space-1",
              name: "MiniMax",
              provider_type: "minimax",
              base_url: "https://api.minimaxi.com/anthropic",
              openai_compatible_base_url: "https://api.minimaxi.com/v1",
              claude_compatible_base_url: "https://api.minimaxi.com/anthropic",
              default_model: "MiniMax-M3",
              available_models: ["MiniMax-M3", "MiniMax-M2.7"],
              enabled: true,
              is_default: false,
            };
          },
        },
      },
    );

    expect(result.success).toBe(true);
    // The bound provider's model reaches codex the same way as any other ACP
    // adapter — via session/set_config_option — not only through the
    // CODEX_HOME provider config written below (supports_model_override:
    // false gates only the retired argv --model flag, not ACP).
    expect(executor.protocolMessages).toContainEqual(expect.objectContaining({
      method: "session/set_config_option",
      params: expect.objectContaining({ configId: "model", value: "MiniMax-M3" }),
    }));
    expect(broker.tempHome).toBeTruthy();
    expect(executor.calls[0].env.HOME).toBe(broker.tempHome);
    expect(executor.calls[0].env.CODEX_HOME).toBe(join(broker.tempHome!, ".codex"));
    expect(executor.calls[0].env.OPENAI_API_KEY).toBeUndefined();
    expect(executor.calls[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    const codexDir = executor.calls[0].env.CODEX_HOME;
    expect((await lstat(codexDir)).isSymbolicLink()).toBe(false);
    const configToml = await readFile(join(codexDir, "config.toml"), "utf8");
    expect(executor.calls[0].command).toEqual([process.execPath]);
    expect(configToml).toContain('model = "MiniMax-M3"');
    expect(configToml).toContain('model_provider = "rainver_provider"');
    expect(configToml).toContain(
      `model_catalog_json = "${join(codexDir, "model-catalogs", "rainver-provider.json")}"`,
    );
    expect(configToml).toContain('base_url = "http://127.0.0.1:49152/openai/');
    expect(configToml).toContain('wire_api = "responses"');
    expect(configToml).toContain('experimental_bearer_token = "');
    expect(configToml).not.toContain("provider-secret");
    await expect(readFile(join(codexDir, "auth.json"), "utf8")).resolves.toContain("login-state");
    await expect(readFile(join(codexDir, "sessions", "shared.jsonl"), "utf8")).rejects.toThrow();
    const catalog = JSON.parse(
      await readFile(join(codexDir, "model-catalogs", "rainver-provider.json"), "utf8"),
    ) as {
      models: Array<{
        slug: string;
        default_reasoning_level: string;
        supported_reasoning_levels: Array<{ effort: string; description: string }>;
        base_instructions: string;
        supports_reasoning_summaries: boolean;
        truncation_policy: { mode: string; limit: number };
      }>;
    };
    expect(catalog.models.map((model) => model.slug)).toEqual(["MiniMax-M3", "MiniMax-M2.7"]);
    // Real levels, not "none". Codex resolves a bound model's effort from this
    // list and sends it upstream as a request parameter, so declaring only
    // "none" pinned every bound model to `model[none]` — deciding on the
    // provider's behalf that its model cannot reason.
    expect(catalog.models[0]).toMatchObject({
      default_reasoning_level: "medium",
      supports_reasoning_summaries: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
    });
    expect(catalog.models[0].supported_reasoning_levels.map((level) => level.effort))
      .toEqual(["low", "medium", "high"]);
    expect(catalog.models[0].base_instructions).toContain("using MiniMax-M3 through MiniMax");
    expect(leases.size()).toBe(0);
    expect(result.metadata_json).toMatchObject({
      runtime_provider_id: "provider-openai",
      runtime_provider_model: "MiniMax-M3",
      runtime_provider_protocol: "openai_responses",
      runtime_provider_proxy: true,
    });
  });

  it("injects Claude-compatible provider env only for a configured claude_code provider", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-claude-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();
    const leases = new ProviderProxyLeaseRegistry();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({
          adapter_type: "claude_code",
          model_provider_id: "provider-claude",
          model_override_json: { model: "MiniMax-M2.7", source: "agent_default" },
        }),
        sandbox_cwd: sandbox,
        context_text: "Claude instructions",
        adapter_config: { credential_profile_id: "22222222-2222-4222-8222-222222222222" },
      },
      {
        credentialBroker: new FakeBroker(),
        executor,
        toolRegistry: new FakeTools(),
        providerLeaseRegistry: leases,
        providerProxyBaseUrl: "http://127.0.0.1:49152",
        providerResolver: {
          async getProvider(_spaceId, providerId) {
            return {
              id: providerId,
              space_id: "space-1",
              name: "MiniMax",
              provider_type: "minimax",
              base_url: "https://api.minimaxi.com/v1",
              openai_compatible_base_url: null,
              claude_compatible_base_url: "https://api.minimaxi.com/anthropic",
              default_model: "MiniMax-M2.7",
              available_models: ["MiniMax-M2.7"],
              enabled: true,
              is_default: false,
            };
          },
        },
      },
    );

    expect(result.success).toBe(true);
    expect(executor.calls[0].env.ANTHROPIC_BASE_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:49152\/anthropic\/[-0-9a-f]+$/,
    );
    expect(executor.calls[0].env.ANTHROPIC_AUTH_TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(executor.calls[0].env).toMatchObject({
      ANTHROPIC_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.7",
    });
    expect(leases.size()).toBe(0);
    expect(result.metadata_json).toMatchObject({
      claude_compatible_provider_id: "provider-claude",
      claude_compatible_model: "MiniMax-M2.7",
      claude_compatible_provider_proxy: true,
    });
  });

  it("fails closed when a selected Claude provider has no compatible URL", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-claude-missing-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code", model_provider_id: "provider-plain" }),
        sandbox_cwd: sandbox,
        adapter_config: { credential_profile_id: "22222222-2222-4222-8222-222222222222" },
      },
      {
        credentialBroker: new FakeBroker(),
        executor,
        toolRegistry: new FakeTools(),
        providerResolver: {
          async getProvider(_spaceId, providerId) {
            return {
              id: providerId,
              space_id: "space-1",
              name: "Plain",
              provider_type: "anthropic",
              base_url: "https://api.anthropic.com",
              openai_compatible_base_url: null,
              claude_compatible_base_url: null,
              default_model: "claude-sonnet-4-6",
              available_models: ["claude-sonnet-4-6"],
              enabled: true,
              is_default: false,
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      error_code: "claude_compatible_base_url_required",
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("fails closed when a selected Codex provider has no OpenAI-compatible URL", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-codex-missing-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "codex_cli", model_provider_id: "provider-plain" }),
        sandbox_cwd: sandbox,
        adapter_config: { credential_profile_id: "11111111-1111-4111-8111-111111111111" },
      },
      {
        credentialBroker: new FakeBroker(),
        executor,
        toolRegistry: new FakeTools(),
        providerResolver: {
          async getProvider(_spaceId, providerId) {
            return {
              id: providerId,
              space_id: "space-1",
              name: "Plain",
              provider_type: "openai",
              base_url: "https://api.example.test/v1",
              openai_compatible_base_url: null,
              claude_compatible_base_url: null,
              default_model: "example-model",
              available_models: ["example-model"],
              enabled: true,
              is_default: false,
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      error_code: "openai_compatible_base_url_required",
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("fails closed for an ephemeral CLI without a prepared working dir", async () => {
    const broker = new FakeBroker();
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ required_sandbox_level: "ephemeral", project_folder_id: null }),
        sandbox_cwd: null,
        adapter_config: { credential_profile_id: "11111111-1111-4111-8111-111111111111" },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(result).toMatchObject({
      success: false,
      error_code: "workspace_prepare_failed",
    });
    expect(executor.calls).toEqual([]);
    expect(broker.grants).toEqual([]);
  });

  it("records precise Claude subscription usage and live quota from the run stream", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-claude-usage-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();
    executor.result.stdout = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          _meta: {
            "_claude/rateLimit": {
              status: "allowed_warning",
              rateLimitType: "seven_day",
              utilization: 0.42,
              resetsAt: 1_785_427_200,
              isUsingOverage: false,
            },
          },
        },
      },
    });

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code", model_provider_id: null }),
        sandbox_cwd: sandbox,
        model: "claude-opus-5",
        adapter_config: {
          credential_profile_id: "22222222-2222-4222-8222-222222222222",
        },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(result.usage).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4,
      reasoning_tokens: 1,
    });
    expect(result.model_usage).toEqual([{
      model: "claude-opus-5",
      usage: result.usage,
    }]);
    expect(result.metadata_json).toMatchObject({
      external_session_id: "session-1",
      subscription_quota: {
        rate_limit_type: "seven_day",
        utilization: 0.42,
      },
    });
    expect(broker.liveQuotas).toEqual([{
      runtime: "claude_code",
      profileId: "22222222-2222-4222-8222-222222222222",
      quota: expect.objectContaining({
        rate_limit_type: "seven_day",
        utilization: 0.42,
      }),
    }]);
  });

  it("renders claude_code model and permission-bypass args only when policy allows", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-claude-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code" }),
        sandbox_cwd: sandbox,
        model: "claude-sonnet",
        risk_level: "high",
      adapter_config: {
          permission_bypass: true,
          runtime_policy_json: { allow_permission_bypass: true },
        },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(executor.calls[0].command).toEqual([
      process.execPath,
    ]);
    expect(executor.protocolMessages).toContainEqual(expect.objectContaining({
      method: "session/set_config_option",
      params: expect.objectContaining({ configId: "model", value: "claude-sonnet" }),
    }));
    expect(result.metadata_json).toMatchObject({
      adapter_type: "claude_code",
      permission_bypass_requested: true,
      permission_bypass_used: true,
    });
    const claudeSettings = JSON.parse(await readFile(join(sandbox, ".claude", "settings.json"), "utf8")) as {
      permissions?: { deny?: string[] };
    };
    expect(claudeSettings.permissions?.deny).toContain("Task");
  });

  it("normalizes a concrete Claude model to the ACP family option", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-claude-model-normalize-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();
    executor.sessionModelOptions = [{
      id: "model",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "sonnet", name: "Sonnet" },
      ],
    }];

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code" }),
        sandbox_cwd: sandbox,
        model: "claude-sonnet-4-6",
      },
      { credentialBroker: new FakeBroker(), executor, toolRegistry: new FakeTools() },
    );

    expect(result.success).toBe(true);
    expect(executor.protocolMessages).toContainEqual(expect.objectContaining({
      method: "session/set_config_option",
      params: expect.objectContaining({ configId: "model", value: "sonnet" }),
    }));
  });

  it("renders Claude's explicit resume command for a bound conversation session", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-claude-resume-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code" }),
        sandbox_cwd: sandbox,
        adapter_config: {
          conversation_runtime: {
            binding_id: "binding-1",
            runtime_state_key: "11111111-1111-4111-8111-111111111111",
            runtime_session_id: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(executor.calls[0].command).toEqual([
      process.execPath,
    ]);
    expect(executor.protocolMessages).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: {
        sessionId: "22222222-2222-4222-8222-222222222222",
        cwd: expect.any(String),
        mcpServers: [],
      },
    });
    expect(result.metadata_json).toMatchObject({
      conversation_binding_id: "binding-1",
      runtime_session_resumed: true,
    });
  });

  it("classifies a missing resumed Claude session for replay retry", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-claude-stale-resume-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();
    executor.result = {
      returncode: 1,
      stdout: "",
      stderr: "Session not found",
      timed_out: false,
    };

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code" }),
        sandbox_cwd: sandbox,
        adapter_config: {
          conversation_runtime: {
            binding_id: "binding-1",
            runtime_state_key: "11111111-1111-4111-8111-111111111111",
            runtime_session_id: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
      {
        credentialBroker: new FakeBroker(),
        executor,
        toolRegistry: new FakeTools(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error_code: "runtime_session_invalid",
    });
  });

  it("clears the stale requested session id when the ACP resume handshake itself is rejected", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-claude-resume-rejected-"));
    tmpPaths.push(sandbox);
    const executor = new FakeExecutor();
    executor.simulateResumeRejection = true;

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run({ adapter_type: "claude_code" }),
        sandbox_cwd: sandbox,
        adapter_config: {
          conversation_runtime: {
            binding_id: "binding-1",
            runtime_state_key: "11111111-1111-4111-8111-111111111111",
            runtime_session_id: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
      {
        credentialBroker: new FakeBroker(),
        executor,
        toolRegistry: new FakeTools(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error_code: "runtime_session_invalid",
      metadata_json: { external_session_id: null },
    });
  });

  it("configures and revokes a short-lived MCP identity for granted CLI tools", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-tools-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();
    const toolRun = run({
      adapter_type: "claude_code",
      permission_snapshot_json: {
        tool_grants: [{
          action_id: "retrieval.search",
          capability_id: "retrieval.search",
          approval_behavior: "none",
          side_effecting: false,
        }],
      },
    });
    const result = await executeVendorCliAdapter(
      config(),
      {
        run: toolRun,
        run_input: assembleRunInputEnvelope(toolRun),
        sandbox_cwd: sandbox,
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );
    expect(result.success).toBe(true);
    expect(executor.calls[0].env.RAINVER_MCP_URL)
      .toBe("http://server:8010/internal/runs/run-1/mcp");
    expect(executor.calls[0].env.RAINVER_TOOL_TOKEN).toBeTruthy();
    expect(executor.calls[0].command).toContain("--mcp-config");
    const configPath = executor.calls[0].command[
      executor.calls[0].command.indexOf("--mcp-config") + 1
    ]!;
    const mcpConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: { "rainver": { url: string; headers: { Authorization: string } } };
    };
    expect(mcpConfig.mcpServers["rainver"].url).toBe(executor.calls[0].env.RAINVER_MCP_URL);
    expect(mcpConfig.mcpServers["rainver"].headers.Authorization)
      .toBe(`Bearer ${executor.calls[0].env.RAINVER_TOOL_TOKEN}`);
  });

  it("fails closed when the credential profile is missing", async () => {
    const broker = new FakeBroker();
    broker.granted = false;
    const executor = new FakeExecutor();

    const result = await executeVendorCliAdapter(
      config(),
      {
        run: run(),
        sandbox_cwd: "/tmp/worktree",
        adapter_config: { credential_profile_id: "33333333-3333-4333-8333-333333333333" },
      },
      { credentialBroker: broker, executor },
    );

    expect(executor.calls).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      error_code: "runtime_credential_profile_required",
      metadata_json: {
        fallback_reason: "no_profile_configured",
      },
    });
  });

  it("routes critical CLI runs through the same scoped Runner credential mode", async () => {
    const broker = new FakeBroker();
    const executor = new FakeExecutor();

    await expect(
      executeVendorCliAdapter(
        config(),
        { run: run({ required_sandbox_level: "none" }), sandbox_cwd: "/tmp/worktree" },
        { credentialBroker: broker, executor },
      ),
    ).resolves.toMatchObject({
      success: false,
      error_code: "file_access_adapter_requires_worktree_policy",
    });

    const sandbox = await mkdtemp(join(tmpdir(), "rainver-docker-") );
    tmpPaths.push(sandbox);
    const result = await executeVendorCliAdapter(
      config(),
      { run: run({ required_sandbox_level: "one_shot_docker" }), sandbox_cwd: sandbox },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );
    expect(result).toMatchObject({ success: true });
    expect(broker.grants[0]?.executorMode).toBe("worktree");
    expect(executor.calls[0]?.read_only).toBeUndefined();
  });

  it("runs OpenCode with a sandbox config that denies Task and locks tools", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-opencode-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();
    executor.result.stdout = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"structured answer"}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"more"}}}}',
    ].join("\n");
    const result = await executeVendorCliAdapter(
      config(),
      { run: run({ adapter_type: "opencode" }), sandbox_cwd: sandbox, model: "provider/model" },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );
    expect(result).toMatchObject({
      success: true,
      adapter_type: "opencode",
      output_text: "structured answermore",
      output_json: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4,
        reasoning_tokens: 1,
      },
      metadata_json: {
        external_session_id: "session-1",
      },
    });
    expect(executor.calls[0]?.command).toEqual([
      process.execPath,
      "acp",
      "--cwd",
      sandbox,
    ]);
    expect(executor.calls[0]?.env.HOME).toBe("/tmp/runtime-home/run-1");
    expect(broker.cleanups).toEqual(["run-1"]);
    const configJson = JSON.parse(await readFile(join(sandbox, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(configJson).toMatchObject({
      default_agent: "rainver-locked",
      subagent_depth: 0,
      agent: {
        "rainver-locked": {
          mode: "primary",
          permission: {
            task: { "*": "deny" },
            edit: { "*": "allow" },
            bash: { "*": "allow" },
            webfetch: "deny",
          },
        },
      },
    });
  });

  it("maps nonzero and timeout results to CLI adapter failures", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-cli-failure-"));
    tmpPaths.push(sandbox);
    const broker = new FakeBroker();
    const executor = new FakeExecutor();
    executor.result = {
      returncode: 7,
      stdout: "",
      stderr: "token=secret failed",
      timed_out: false,
    };

    const failed = await executeVendorCliAdapter(
      config(),
      {
        run: run(),
        sandbox_cwd: sandbox,
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(failed).toMatchObject({
      success: false,
      error_code: "cli_adapter_nonzero_exit",
      error_message: "[REDACTED_SECRET] failed",
      exit_code: 7,
    });

    executor.result = {
      returncode: -1,
      stdout: "",
      stderr: "too slow",
      timed_out: true,
    };
    const timedOut = await executeVendorCliAdapter(
      config(),
      {
        run: run(),
        sandbox_cwd: sandbox,
      },
      { credentialBroker: broker, executor, toolRegistry: new FakeTools() },
    );

    expect(timedOut).toMatchObject({
      success: false,
      error_code: "cli_adapter_timeout",
      exit_code: -1,
    });
  });
});

describe("buildSubprocessEnv", () => {
  it("keeps only safe ambient variables and broker injected HOME", () => {
    process.env.RAINVER_SHOULD_NOT_LEAK = "secret";
    process.env.LC_TEST_VALUE = "ok";

    const env = buildSubprocessEnv({
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/broker-codex-home",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_AUTH_TOKEN: "should-not-pass-from-broker",
      GEMINI_API_KEY: "gemini-test",
      OPENAI_API_KEY: "sk-should-not-pass",
      HTTPS_PROXY: "http://broker-proxy.invalid:8080",
      AWS_SECRET_ACCESS_KEY: "secret",
    }, {
      CODEX_HOME: "/tmp/home/.codex",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:49152/anthropic/lease-1",
      ANTHROPIC_AUTH_TOKEN: "lease-token",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1,::1",
      RAINVER_EXCHANGE_INPUT: "/tmp/exchange/input/run_input.json",
      RAINVER_EXCHANGE_OUTPUT: "/tmp/exchange/output",
    });

    expect(env.HOME).toBe("/tmp/home");
    expect(env.CODEX_HOME).toBe("/tmp/home/.codex");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:49152/anthropic/lease-1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("lease-token");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(env.RAINVER_EXCHANGE_INPUT).toBe("/tmp/exchange/input/run_input.json");
    expect(env.RAINVER_EXCHANGE_OUTPUT).toBe("/tmp/exchange/output");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LC_TEST_VALUE).toBe("ok");
    expect(env.RAINVER_SHOULD_NOT_LEAK).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    delete process.env.RAINVER_SHOULD_NOT_LEAK;
    delete process.env.LC_TEST_VALUE;
  });
});

describe("vendor structured event normalization", () => {
  it("drives OpenCode ACP and emits agent_message_chunk updates", () => {
    const deltas: string[] = [];
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: "provider/model",
      on_text_delta: (delta) => deltas.push(delta),
    })!;
    const sent: Record<string, unknown>[] = [];
    let closed = false;
    const send = (message: Record<string, unknown>) => sent.push(message);
    controller.start(send);
    expect(sent[0]).toMatchObject({
      method: "initialize",
      params: {
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    });
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {
      closed = true;
    });
    controller.receive(
      { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
      send,
      () => { closed = true; },
    );
    controller.receive({
      jsonrpc: "2.0",
      id: 3,
      result: {
        configOptions: [{ id: "model", currentValue: "provider/model" }],
      },
    }, send, () => {
      closed = true;
    });

    expect(sent.map((message) => message.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(sent[2]).toMatchObject({
      params: {
        sessionId: "session-1",
        configId: "model",
        value: "provider/model",
      },
    });
    for (const delta of ["hel", "lo"]) {
      controller.receive(
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: delta },
            },
          },
        },
        send,
        () => { closed = true; },
      );
    }
    expect(deltas).toEqual(["hel", "lo"]);

    controller.receive(
      {
        jsonrpc: "2.0",
        id: 4,
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
      },
      send,
      () => { closed = true; },
    );
    expect(closed).toBe(true);
    expect(controller.result()).toEqual({
      completed: true,
      error: null,
      text: "hello",
      external_session_id: "session-1",
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4,
        reasoning_tokens: 1,
      },
      model_usage: [],
      subscription_quota: null,
    });
  });

  it("resumes an opaque OpenCode session before prompting", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "continue",
      cwd: "/workspace",
      model: null,
      runtime_session_id: "ses_existing-opaque",
    })!;
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;
    const close = () => { closed = true; };

    controller.start(send);
    controller.receive(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
      send,
      close,
    );
    expect(sent[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: {
        sessionId: "ses_existing-opaque",
        cwd: "/workspace",
        mcpServers: [],
      },
    });
    controller.receive(
      { jsonrpc: "2.0", id: 2, result: { configOptions: [] } },
      send,
      close,
    );
    expect(sent[2]).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "ses_existing-opaque",
        prompt: [{ type: "text", text: "continue" }],
      },
    });
    controller.receive({
      jsonrpc: "2.0",
      id: 4,
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 6,
          outputTokens: 2,
          totalTokens: 9,
          thoughtTokens: 1,
        },
      },
    }, send, close);

    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: true,
      external_session_id: "ses_existing-opaque",
      usage: {
        input_tokens: 6,
        output_tokens: 2,
        total_tokens: 9,
        reasoning_tokens: 1,
      },
    });
  });

  it("auto-approves an OpenCode ACP permission request for the active session", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => { closed = true; });
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, () => { closed = true; });

    controller.receive(
      {
        jsonrpc: "2.0",
        id: 92,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          options: [
            { optionId: "reject", kind: "reject_once" },
            { optionId: "allow", kind: "allow_once" },
          ],
        },
      },
      send,
      () => { closed = true; },
    );

    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 92,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(closed).toBe(false);
    expect(controller.result()).toMatchObject({ completed: false, error: null });
  });

  it("fails closed when an OpenCode ACP permission request offers no allow option", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => { closed = true; });
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, () => { closed = true; });

    controller.receive(
      {
        jsonrpc: "2.0",
        id: 92,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          options: [{ optionId: "reject", kind: "reject_once" }],
        },
      },
      send,
      () => { closed = true; },
    );

    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 92,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: false,
      error: "OpenCode ACP requested permission with no allow option offered",
    });
  });

  it("fails closed when an OpenCode ACP permission request's allow option has no optionId", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => { closed = true; });
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, () => { closed = true; });

    controller.receive(
      {
        jsonrpc: "2.0",
        id: 92,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          options: [{ kind: "allow_once" }],
        },
      },
      send,
      () => { closed = true; },
    );

    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 92,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: false,
      error: "OpenCode ACP requested permission with no allow option offered",
    });
  });

  it("fails closed on an OpenCode ACP permission request with no session established yet", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => { closed = true; });

    controller.receive(
      {
        jsonrpc: "2.0",
        id: 92,
        method: "session/request_permission",
        params: {
          options: [{ optionId: "allow", kind: "allow_once" }],
        },
      },
      send,
      () => { closed = true; },
    );

    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 92,
      error: expect.objectContaining({ code: -32600 }),
    });
    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: false,
      error: "OpenCode ACP requested permission for an out-of-scope session",
    });
  });

  it("fails closed when OpenCode ACP requests an unsupported interactive method", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const sent: Record<string, unknown>[] = [];
    let closed = false;

    controller.receive(
      {
        jsonrpc: "2.0",
        id: 92,
        method: "fs/read_text_file",
        params: {},
      },
      (message) => sent.push(message),
      () => { closed = true; },
    );

    expect(sent).toEqual([{
      jsonrpc: "2.0",
      id: 92,
      error: expect.objectContaining({ code: -32601 }),
    }]);
    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: false,
      error: "OpenCode ACP requested unsupported interactive method 'fs/read_text_file'",
      text: "",
    });
  });

  it("captures agentCapabilities from initialize without gating behavior on their shape", () => {
    const events: Record<string, unknown>[] = [];
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
      on_protocol_event: (event) => events.push(event),
    })!;
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;

    controller.start(send);
    controller.receive(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: ["close", "fork", "list", "resume"] },
        },
      },
      send,
      () => { closed = true; },
    );

    expect(closed).toBe(false);
    expect(sent.map((message) => message.method)).toEqual(["initialize", "session/new"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: { agentCapabilities: { sessionCapabilities: ["close", "fork", "list", "resume"] } },
    });
  });

  it("rejects incomplete OpenCode ACP prompt usage", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const send = () => {};
    let closed = false;
    const close = () => { closed = true; };
    controller.start(send);
    controller.receive(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
      send,
      close,
    );
    controller.receive(
      { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
      send,
      close,
    );
    controller.receive({
      jsonrpc: "2.0",
      id: 4,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 1 },
      },
    }, send, close);

    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: false,
      error: "OpenCode ACP returned invalid token usage",
      usage: null,
    });
  });

  it("accepts a Codex turn whose total counts reasoning inside output", () => {
    // Real numbers from a Codex run on a paired host: OpenAI's total already
    // includes reasoning in `output`, so adding the bucket again overcounts by
    // 946 and the turn was failed despite having answered.
    const controller = createCliConversationController({
      adapter_type: "codex_cli",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const send = () => {};
    const close = () => {};
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, close);
    controller.receive({
      jsonrpc: "2.0",
      id: 4,
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 24620,
          cachedReadTokens: 87808,
          outputTokens: 1312,
          thoughtTokens: 946,
          totalTokens: 113740,
        },
      },
    }, send, close);

    const result = controller.result();
    expect(result.error).toBeNull();
    expect(result.completed).toBe(true);
    expect(result.usage).toMatchObject({
      input_tokens: 24620,
      output_tokens: 1312,
      reasoning_tokens: 946,
      total_tokens: 113740,
    });
  });

  it("still rejects a total that matches neither reasoning convention", () => {
    // Guards the widened check: it admits exactly two self-consistent shapes,
    // not any total at all.
    const controller = createCliConversationController({
      adapter_type: "codex_cli",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const send = () => {};
    const close = () => {};
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, close);
    controller.receive({
      jsonrpc: "2.0",
      id: 4,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2, totalTokens: 99 },
      },
    }, send, close);

    expect(controller.result().error).toBe("Codex CLI ACP returned invalid token usage");
  });

  it("rejects invalid optional OpenCode ACP usage buckets", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    const send = () => {};
    let closed = false;
    const close = () => { closed = true; };
    controller.start(send);
    controller.receive(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
      send,
      close,
    );
    controller.receive(
      { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
      send,
      close,
    );
    controller.receive({
      jsonrpc: "2.0",
      id: 4,
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedReadTokens: -1,
        },
      },
    }, send, close);

    expect(closed).toBe(true);
    expect(controller.result().error).toBe(
      "OpenCode ACP returned invalid token usage",
    );
  });

  it("fails closed when OpenCode ACP does not apply the requested model", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: "provider/model",
    })!;
    const send = () => {};
    let closed = false;
    const close = () => { closed = true; };
    controller.receive(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
      send,
      close,
    );
    controller.receive(
      { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
      send,
      close,
    );
    controller.receive(
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          configOptions: [{ id: "model", currentValue: "different/model" }],
        },
      },
      send,
      close,
    );

    expect(closed).toBe(true);
    // Both sides named: a rejection is nearly always a mismatch between the
    // runtime's identifier space and ours, and reporting neither leaves
    // nothing to compare.
    expect(controller.result().error).toContain("OpenCode ACP did not apply the requested model");
    expect(controller.result().error).toContain("asked for 'provider/model'");
    expect(controller.result().error).toContain("runtime is on 'different/model'");
  });

  it("asks for a reasoning effort as its own request, in the runtime's vocabulary", () => {
    // ACP exposes model and effort as two options and each runtime names its
    // own — `reasoning_effort` for Codex, `effort` for Claude. They are chosen
    // independently: the model is which brain, the effort is how long it gets.
    const sent: Record<string, unknown>[] = [];
    const controller = createCliConversationController({
      adapter_type: "codex_cli",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
      reasoning_effort: "high",
    })!;
    const send = (value: Record<string, unknown>) => { sent.push(value); };
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, () => {});

    const effortRequest = sent.find((frame) => frame.method === "session/set_config_option");
    expect(effortRequest).toMatchObject({
      params: { configId: "reasoning_effort", value: "high" },
    });
    // The prompt waits until the effort has been answered.
    expect(sent.some((frame) => frame.method === "session/prompt")).toBe(false);
  });

  it("keeps the turn when a runtime will not take the requested effort", () => {
    // The model is already right and the answer still arrives — just with the
    // runtime's own effort. Losing the turn over it would cost more than the
    // setting is worth.
    const sent: Record<string, unknown>[] = [];
    const controller = createCliConversationController({
      adapter_type: "codex_cli",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
      reasoning_effort: "high",
    })!;
    const send = (value: Record<string, unknown>) => { sent.push(value); };
    let closed = false;
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, () => {});
    controller.receive({
      jsonrpc: "2.0",
      id: 3.5,
      result: { configOptions: [{ id: "reasoning_effort", currentValue: "medium" }] },
    }, send, () => { closed = true; });

    expect(controller.result().error).toBeNull();
    expect(closed).toBe(false);
    expect(sent.some((frame) => frame.method === "session/prompt")).toBe(true);
  });

  it("asks for no effort when the runtime exposes none", () => {
    // OpenCode has no effort option; sending one would be an invalid_params
    // rejection for a setting it never offered.
    const sent: Record<string, unknown>[] = [];
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
      reasoning_effort: "high",
    })!;
    const send = (value: Record<string, unknown>) => { sent.push(value); };
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, () => {});

    expect(sent.some((frame) => frame.method === "session/set_config_option")).toBe(false);
    expect(sent.some((frame) => frame.method === "session/prompt")).toBe(true);
  });

  it("rejects malformed OpenCode ACP protocol envelopes", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    let closed = false;
    controller.receive(
      { jsonrpc: "2.0", foo: 1 },
      () => {},
      () => { closed = true; },
    );
    expect(closed).toBe(true);
    expect(controller.result().error).toBe(
      "OpenCode ACP returned an unsupported protocol message",
    );
  });

  it("rejects an out-of-order OpenCode prompt response", () => {
    const controller = createCliConversationController({
      adapter_type: "opencode",
      prompt: "hello",
      cwd: "/workspace",
      model: null,
    })!;
    let closed = false;

    controller.receive(
      { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } },
      () => {},
      () => { closed = true; },
    );

    expect(closed).toBe(true);
    expect(controller.result()).toMatchObject({
      completed: false,
      error: "OpenCode ACP returned unexpected response id '4' during initialize",
      text: "",
    });
  });

});
