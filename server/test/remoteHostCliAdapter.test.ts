import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";
import type { InvocationDelivery, RunAdapterResultEnvelope, RuntimeSemanticEvent } from "@rainver/protocol";
import { executeRemoteHostCliAdapter, RemoteWsCliCommandExecutor, skillWorkSurface } from "../src/modules/runs/remoteHostCliAdapter.js";
import { invokeWithinTimeLimit } from "../src/modules/runs/runTimeLimit.js";
import { stallTimeoutSeconds } from "../src/modules/runs/stallTimeout.js";
import { loadConfig } from "../src/config.js";
import { __setProvidersDbPortForTests } from "../src/modules/providers/dbReader.js";
import {
  ProviderProxyLeaseRegistry,
  setProviderProxyBaseUrlForProcess,
} from "../src/modules/providers/proxy/lease.js";
import { NO_PROVIDER_BINDINGS } from "../src/modules/runs/remoteHostCliAdapter.js";
import { getRuntimeAdapterSpec } from "../src/modules/runtimeAdapters/specs.js";
import { setDynamicRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/dynamicSpecs.js";
import { buildUnboundRuntimeProfile } from "../src/modules/runs/remoteProviderBinding.js";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";
import { LocalCliProcessRegistry, type CliProcessRegistry } from "../src/modules/runs/localCliExecution.js";
import type { ThreadEventDraft } from "../src/modules/hosts/threadEventNormalization.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { renderConversationInputResourceDescriptors } from "../src/modules/sessions/conversationInputService.js";

/** The Run executor's policy seam, allowing: these tests cover the launch frame, not the decision. */
const allowCredentialSpend = async () => ({ status: "allow" as const, policy_decision_record_id: null });

// These tests exercise the remote protocol plumbing, not model backends, so
// they state outright that they have no binding subsystem. The adapter refuses
// to guess: a run whose binding it cannot determine fails rather than quietly
// executing on the machine's own login.

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    execution_kind: "agent",
    status: "queued",
    mode: "live",
    prompt: "fix the failing test",
    instruction: null,
    project_folder_id: "folder-1",
    session_id: null,
    project_id: null,
    runtime_key: "claude_code",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    owner_user_id: "user-1",
    started_at: null,
    ended_at: null,
    ...overrides,
  } as AgentRunRecord;
}

function runtimeContextDelivery(prompt: string): InvocationDelivery {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    invocation_id: "40000000-0000-4000-8000-000000000002",
    delivery_kind: "agent_task",
    runtime_key: "opencode",
    provider_id: null,
    model: null,
    renderer_version: "managed-semantic.v1",
    planned_items: [{ item_id: "current", semantic_role: "user_input", required: true }],
    message_blocks: [{ semantic_role: "user_input", content: prompt, source_item_ids: ["current"] }],
    control_ref: { type: "execution_control_snapshot", id: "40000000-0000-4000-8000-000000000003" },
    sandbox_ref: null,
    tool_grant_refs: [],
    output_contract_ref: null,
    expected_prompt_tokens: 64,
    max_output_tokens: null,
    snapshot_draft_ref: { type: "invocation_snapshot", id: "40000000-0000-4000-8000-000000000004" },
    audit_refs: {
      delivery_id: "40000000-0000-4000-8000-000000000001",
      invocation_snapshot_id: "40000000-0000-4000-8000-000000000004",
      execution_control_snapshot_id: "40000000-0000-4000-8000-000000000003",
      usage_source_id: "runtime-context:test",
    },
  };
}

/** Captures every frame the adapter sends to "the daemon" and lets a test script replies back through the same registry, exactly as the real WS route handler would on a real connection. */
class FakeSink implements HostFrameSink {
  sent: Record<string, unknown>[] = [];
  send(frame: Record<string, unknown>): void {
    this.sent.push(frame);
  }
  close(): void {}
}

/** The nonce the registry stamped on this run's launch frame; run frames must echo it. */
function launchIdOf(sink: FakeSink, runId = "run-1"): string {
  return String(sink.sent.find((f) => f.type === "launch" && f.run_id === runId)!.launch_id);
}

// Files share a worker: a fake clock left installed here would stall every
// file that runs after this one.
afterEach(() => {
  vi.useRealTimers();
  __setProvidersDbPortForTests(null);
});

describe("selected Skill work-surface transport", () => {
  it("transports only accepted package bytes and works without a tool-grant surface", () => {
    const delivery = runtimeContextDelivery("Read selected Skill");
    delivery.skill_packages = [{ source_item_id: "skill-item", content: {
      skill_package_id: "package-1", package_hash: "a".repeat(64), package_name: "Audit",
      files: [{ path: "assets/data.bin", content_base64: "AP+A", content_hash: "b".repeat(64), executable: false }],
    } }];
    expect(skillWorkSurface(delivery, null)).toEqual({ env: {}, dir_env: { RAINVER_SKILL_ROOT: "rainver/skills" },
      files: [{ relative_path: "rainver/skills/package-1/assets/data.bin", contents: "AP+A", encoding: "base64", content_hash: "b".repeat(64) }],
    });
    expect(skillWorkSurface(undefined, null)).toBeNull();
    const base = { env: { EXISTING: "yes" }, files: [], dir_env: {} };
    expect(skillWorkSurface(delivery, base)?.env).toEqual(base.env);
    expect(base.files).toEqual([]);
  });
});

describe("executeRemoteHostCliAdapter", () => {
  it("rejects an unimplemented adapter (gemini_cli) before ever dispatching a frame, but still emits a terminal thread event", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    // Every early-return failure path above the ordinary `run_started` /
    // `run_failed` event
    // sequence writes `thread_event_sink`. A Run that ends with zero thread
    // events leaves the conversation with no signal that it finished. Do not
    // skip the sink on an early return. These early returns share
    // `remoteFailureWithEvent`.
    // codex_cli is remote-eligible (it speaks ACP, like opencode).
    // gemini_cli is `implementation_status: "planned"`, so it is the adapter
    // that exercises this early return.
    const threadEventSink = vi.fn().mockResolvedValue(undefined);
    const result = await executeRemoteHostCliAdapter(
      { run: run({ runtime_key: "gemini_cli" }), prompt: "hi", model: null, resume_session_id: null, thread_event_sink: threadEventSink },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    expect(result).toMatchObject({ success: false, error_code: "runtime_adapter_not_implemented" });
    expect(sink.sent).toEqual([]);
    expect(threadEventSink).toHaveBeenCalledWith([{ event_type: "status", status: "run_failed" }]);
  });

  it("keeps a pending user message's attachments out of a session handoff", async () => {
    const runCommand = vi.fn(async () => ({
      returncode: 0, stdout: "", stderr: "", timed_out: false,
    }));
    const result = await executeRemoteHostCliAdapter(
      {
        run: run({
          runtime_key: "opencode",
          prompt: "Write the session handoff",
          model_override_json: {
            chat_turn: {
              schema_version: "chat_turn.v1",
              kind: "handoff",
              user_message_id: "pending-message-with-attachments",
            },
          },
        }),
        prompt: "Write the session handoff",
        invocation_delivery: runtimeContextDelivery("Write the session handoff"),
        model: null,
        resume_session_id: null,
      },
      "host-1",
      "folder-1",
      { executor: { runCommand }, bindings: NO_PROVIDER_BINDINGS },
    );
    // No database was provided: the handoff must not try to hydrate the
    // following person's message before it reaches that person's own Run.
    expect(runCommand).toHaveBeenCalledOnce();
    expect(result.error_code).not.toBe("conversation_input_unavailable");
  });

  it("keeps the parent's message attachments out of a delegated child's own request", async () => {
    const runCommand = vi.fn(async () => ({
      returncode: 0, stdout: "", stderr: "", timed_out: false,
    }));
    const result = await executeRemoteHostCliAdapter(
      {
        run: run({
          runtime_key: "opencode",
          delegation_id: "delegation-1",
          prompt: "Review only the assigned change",
          model_override_json: {
            chat_turn: {
              schema_version: "chat_turn.v1",
              user_message_id: "parent-message-with-attachments",
            },
          },
        }),
        prompt: "Review only the assigned change",
        invocation_delivery: runtimeContextDelivery("Review only the assigned change"),
        model: null,
        resume_session_id: null,
      },
      "host-1",
      "folder-1",
      { executor: { runCommand }, bindings: NO_PROVIDER_BINDINGS },
    );
    // The child's Delivery names its delegation request. Inherited chat-turn
    // metadata must not trigger an extra fetch of the parent's current input.
    expect(runCommand).toHaveBeenCalledOnce();
    expect(result.error_code).not.toBe("conversation_input_unavailable");
  });

  it("drives opencode's ACP controller over the daemon's duplex stdin frames and reports success", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const runtimeEvents: RuntimeSemanticEvent[] = [];
    const threadDrafts: ThreadEventDraft[] = [];

    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({ runtime_key: "opencode", prompt: "add a test" }),
        prompt: "add a test",
        invocation_delivery: runtimeContextDelivery("Use the authorized current request only."),
        model: null,
        resume_session_id: null,
        runtime_event_sink: (event) => { runtimeEvents.push(event); },
        thread_event_sink: (drafts) => { threadDrafts.push(...drafts); },
      },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    // Waits for the frame rather than counting microtask ticks: how many the
    // adapter takes before dispatching is not part of its contract.
    await vi.waitUntil(() => sink.sent.length === 1);
    const launchFrame = sink.sent[0]!;
    expect(launchFrame).toMatchObject({
      type: "launch",
      run_id: "run-1",
      keep_stdin_open: true,
      stdin: null,
      egress_transport: { mode: "direct" },
    });
    expect(launchFrame.argv as string[]).toContain("rainver:remote-workspace-cwd");

    // The controller must not write its `initialize` request until the
    // daemon confirms the run is registered.
    expect(sink.sent).toHaveLength(1);
    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sent).toHaveLength(2);
    expect(JSON.parse((sink.sent[1] as { value: string }).value)).toMatchObject({ method: "initialize" });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[2] as { value: string }).value)).toMatchObject({ method: "session/new" });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    const promptRequest = JSON.parse((sink.sent[3] as { value: string }).value) as {
      method: string;
      params: { sessionId: string; prompt: Array<{ type: string; text?: string }> };
    };
    expect(promptRequest).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "session-1" },
    });
    const promptText = promptRequest.params.prompt
      .flatMap((block) => block.type === "text" && block.text ? [block.text] : [])
      .join("\n");
    expect(promptText).toContain("Use the authorized current request only.");
    expect(promptText.split("Use the authorized current request only.")).toHaveLength(2);
    // A turn that carries only the current message is sent verbatim: no
    // channel notice, no section label (acpRuntimeContextPrompt.ts).
    expect(promptText).not.toContain("## Current user input");
    expect(promptText).not.toContain("ACP has one user-prompt channel");
    expect(promptText).not.toContain("add a test");

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done\n" } },
      },
    })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    // The controller closes stdin itself once its turn completes.
    expect(sink.sent.at(-1)).toEqual({ type: "stdin_close", run_id: "run-1" });

    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));

    const result = await executePromise;
    expect(result).toMatchObject({
      success: true,
      exit_code: 0,
      runtime_key: "opencode",
      output_text: "done\n",
    });
    // Text arrives via the coalesced thread draft, not a duplicate from the
    // raw protocol-event path (threadEventNormalization.ts's
    // pushAcpProtocolEvent deliberately ignores agent_message_chunk).
    expect(threadDrafts).toContainEqual({ event_type: "assistant_text", text: "done\n" });
    expect(threadDrafts.filter((d) => d.event_type === "assistant_text")).toHaveLength(1);
    // The initialize-response echo (forwarded for diagnostics by
    // AcpController) must not produce a spurious runtime event.
    expect(runtimeEvents).toEqual([]);
  });

  it("sends an input-resource descriptor once through Delivery and keeps its ACP resource link", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const descriptorText = renderConversationInputResourceDescriptors([{
      resource_id: "resource-1",
      source_state: "draft",
      display_name: "README.md",
      media_type: "text/markdown",
      relative_path: "README.md",
      byte_size: 12,
      sha256: "a".repeat(64),
      captured_at: "2026-09-18T12:00:00.000Z",
    }]);
    const resourcePart = {
      part_id: "part-1", kind: "input_resource", media_id: null, resource_id: "resource-1",
      display_name: "README.md", media_type: "text/markdown", byte_size: 12,
      storage_path: null, relative_path: null, workspace_location_id: null, snapshot_id: null,
      resource_source_state: "draft", resource_sha256: "a".repeat(64),
      resource_captured_at: "2026-09-18T12:00:00.000Z",
      resource_relative_path: "README.md",
      resource_workspace_location_id: "location-1", resource_selection_start_line: null,
      resource_selection_start_column: null, resource_selection_end_line: null,
      resource_selection_end_column: null, location_root_path: null,
      location_host_id: null, location_host_kind: null,
    };
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(sql: string) {
        const rows: unknown[] = sql.startsWith("SELECT part.id AS part_id")
          ? [resourcePart]
          : sql.startsWith("SELECT kind FROM hosts") ? [{ kind: "remote" }]
            : sql.startsWith("UPDATE run_attempts") ? [{ id: "attempt-1" }] : [];
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };
    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({
          runtime_key: "opencode",
          model_override_json: {
            chat_turn: { schema_version: "chat_turn.v1", user_message_id: "message-1" },
          },
        }),
        prompt: "Use the draft.",
        invocation_delivery: runtimeContextDelivery(`Use the draft.\n\n${descriptorText}`),
        model: null,
        resume_session_id: null,
      },
      "host-1",
      "folder-1",
      {
        connectionRegistry: registry,
        bindings: NO_PROVIDER_BINDINGS,
        config: loadConfig({
          SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
          SERVER_INTERNAL_TOKEN: "internal-token",
        }),
        db,
      },
    );

    await vi.waitUntil(() => sink.sent.length >= 1);
    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink));
    await vi.waitUntil(() => sink.sent.length >= 2);
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink));
    await vi.waitUntil(() => sink.sent.length >= 3);
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } })}\n`, launchIdOf(sink));
    await vi.waitUntil(() => sink.sent.length >= 4);
    const promptRequest = JSON.parse((sink.sent[3] as { value: string }).value) as {
      method: string;
      params: { prompt: Array<{ type: string; text?: string }> };
    };
    expect(promptRequest.method).toBe("session/prompt");
    const promptText = promptRequest.params.prompt
      .flatMap((block) => block.type === "text" && block.text ? [block.text] : [])
      .join("\n");
    expect(promptText.split("[Attached immutable input resources]")).toHaveLength(2);
    expect(promptText.split('"resource_id":"resource-1"')).toHaveLength(2);
    expect(promptRequest.params.prompt).toContainEqual({
      type: "resource_link",
      uri: "rainver:conversation-input-resource:resource-1",
      name: "README.md",
      mimeType: "text/markdown",
      size: 12,
    });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`, launchIdOf(sink));
    await vi.waitUntil(() => sink.sent.at(-1)?.type === "stdin_close");
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink));
    expect(await executePromise).toMatchObject({ success: true, exit_code: 0 });
  });

  it("dispatches a native Server Agent Run without a Host thread or Location using stable Agent-scoped state", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("server-host", sink);
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const execution = executeRemoteHostCliAdapter(
      {
        run: run({
          agent_id: agentId,
          runtime_key: "opencode",
          project_folder_id: null,
          runtime_profile_snapshot_json: { runtime_installation: "managed:1.18.31" },
        }),
        prompt: "summarize the request",
        model: null,
        resume_session_id: null,
      },
      "server-host",
      null,
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    await vi.waitUntil(() => sink.sent.some((frame) => frame.type === "launch"));
    const launch = sink.sent.find((frame) => frame.type === "launch") as Record<string, unknown>;
    expect(launch.workspace_location_id).toBeUndefined();
    expect(launch.workspace).toBeUndefined();
    expect(launch.installation).toBe("managed:1.18.31");
    expect(launch.provider_binding).toMatchObject({
      profile_key: `agents/${agentId}/agent/${agentId}/opencode/ambient`,
      credential_source: "host_login",
      env: {},
      files: [],
    });

    const launchId = launchIdOf(sink);
    registry.receiveLaunched("server-host", "run-1", launchId);
    await vi.waitUntil(() => sink.sent.some((frame) => frame.type === "stdin"));
    registry.receiveOutput("server-host", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 },
    })}\n`, launchId);
    await vi.waitUntil(() => sink.sent.some((frame) =>
      frame.type === "stdin" && JSON.parse(String(frame.value)).method === "session/new"));
    registry.receiveOutput("server-host", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 2, result: { sessionId: "server-run-session" },
    })}\n`, launchId);
    await vi.waitUntil(() => sink.sent.some((frame) =>
      frame.type === "stdin" && JSON.parse(String(frame.value)).method === "session/prompt"));
    registry.receiveOutput("server-host", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" },
    })}\n`, launchId);
    registry.receiveComplete("server-host", "run-1", { exit_code: 0, timed_out: false, error: null }, launchId);
    await expect(execution).resolves.toMatchObject({ success: true, exit_code: 0 });
  });

  it("records a permission pre-authorization as a human-readable diagnostic thread event", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const threadDrafts: ThreadEventDraft[] = [];

    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({ runtime_key: "opencode", prompt: "add a test" }),
        prompt: "add a test",
        model: null,
        resume_session_id: null,
        thread_event_sink: (drafts) => { threadDrafts.push(...drafts); },
      },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    // Wait for the launch frame rather than counting microtask ticks: how many
    // awaits the adapter takes before dispatching is not part of its contract.
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 92,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { kind: "execute" },
        options: [
          { optionId: "reject", kind: "reject_once" },
          { optionId: "allow", kind: "allow_once" },
        ],
      },
    })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();

    expect(threadDrafts).toContainEqual({
      event_type: "diagnostic",
      text: "Permission pre-authorized (execute): allowed",
    });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
    await executePromise;
  });

  it("reports a turn cancelled on the runtime's own question as a success carrying the question", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const executePromise = executeRemoteHostCliAdapter(
      { run: run({ prompt: "tidy the parser" }), prompt: "tidy the parser", model: null, resume_session_id: null },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    const launchId = launchIdOf(sink, "run-1");
    const stdin = () => sink.sent.filter((f) => f.type === "stdin").map((f) => JSON.parse(String(f.value)) as Record<string, unknown>);
    registry.receiveLaunched("host-1", "run-1", launchId);
    await vi.waitUntil(() => stdin().some((m) => m.method === "initialize"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchId);
    await vi.waitUntil(() => stdin().some((m) => m.method === "session/new"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-q" } })}\n`, launchId);
    await vi.waitUntil(() => stdin().some((m) => m.method === "session/prompt"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "elicitation/create",
      params: {
        mode: "form",
        sessionId: "session-q",
        message: "Keep the old parser?",
        requestedSchema: { type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "Yes", title: "Yes" }] } } },
      },
    })}\n`, launchId);
    await vi.waitUntil(() => stdin().some((m) => m.method === "session/cancel"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } })}\n`, launchId);
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchId);

    await expect(executePromise).resolves.toMatchObject({
      success: true,
      error_code: null,
      output_json: {
        external_session_id: "session-q",
        asked_user: { question: "Keep the old parser?", options: ["Yes"] },
      },
    });
  });

  it("fails closed when the host's trust mode cannot be read, instead of running as if on a trusted machine", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(sql: string) {
        if (sql.startsWith("SELECT kind FROM hosts")) throw new Error("connection terminated unexpectedly");
        return { rows: [] as Row[], rowCount: 0 };
      },
    };
    const result = await executeRemoteHostCliAdapter(
      { run: run({ runtime_key: "opencode" }), prompt: "hi", model: null, resume_session_id: null },
      "host-1",
      "folder-1",
      {
        connectionRegistry: registry,
        bindings: NO_PROVIDER_BINDINGS,
        config: loadConfig({
          SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
          SERVER_INTERNAL_TOKEN: "internal-token",
        }),
        db,
      },
    );
    // Do not launch when the built-in host's kind went unread. That would use
    // a paired machine's settings: no strict session config and direct egress (B62).
    expect(result).toMatchObject({ success: false, error_code: "host_trust_unavailable" });
    expect(sink.sent.some((f) => f.type === "launch")).toBe(false);
  });

  it("reports the host offline without hanging when no connection is registered", async () => {
    const registry = new HostConnectionRegistry();
    const result = await executeRemoteHostCliAdapter(
      { run: run(), prompt: "hi", model: null, resume_session_id: null },
      "host-never-connected",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    expect(result.success).toBe(false);
  });

  it("drives Claude Code ACP resume with early session metadata over duplex stdin and reports success on a clean exit", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({ prompt: "continue where we left off" }),
        prompt: "continue where we left off",
        model: null,
        resume_session_id: "vendor-session-abc",
      },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    // Let the microtask queue run so dispatchLaunch has sent the frame.
    // Waits for the frame rather than counting microtask ticks: how many the
    // adapter takes before dispatching is not part of its contract.
    await vi.waitUntil(() => sink.sent.length === 1);
    const launchFrame = sink.sent[0]!;
    expect(launchFrame).toMatchObject({
      type: "launch",
      run_id: "run-1",
      workspace_location_id: "folder-1",
    });
    const argv = launchFrame.argv as string[];
    expect(argv).toEqual(["claude-agent-acp"]);

    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[1] as { value: string }).value)).toMatchObject({ method: "initialize" });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[2] as { value: string }).value)).toMatchObject({
      method: "session/resume",
      params: { sessionId: "vendor-session-abc", cwd: "rainver:remote-workspace-cwd" },
    });

    // A session-scoped notification may precede the resume response. It must
    // not close the transport or be mistaken for a completed handshake.
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "vendor-session-abc",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sent).toHaveLength(3);

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "vendor-session-abc" } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[3] as { value: string }).value)).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "vendor-session-abc" },
    });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "vendor-session-abc",
        update: {
          sessionUpdate: "usage_update",
          used: 9_000,
          size: 1_000_000,
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
    })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "vendor-session-abc",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      },
    })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));

    const result = await executePromise;
    expect(result).toMatchObject({
      success: true,
      exit_code: 0,
      runtime_key: "claude_code",
      output_text: "done",
      metadata_json: {
        cli_usage: { acp_turns: 1, occupancy_used: 9_000, occupancy_size: 1_000_000, usage_updates: 1, usage_updates_used_total: 9_000 },
        subscription_quota: {
          rate_limit_type: "seven_day",
          utilization: 0.42,
        },
      },
    });
  });

  it("reports failure on a non-zero exit code without treating it as a timeout", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const executePromise = executeRemoteHostCliAdapter(
      { run: run(), prompt: "hi", model: null, resume_session_id: null },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
    const result = await executePromise;
    expect(result).toMatchObject({ success: false, exit_code: 1, error_code: "runtime_nonzero_exit" });
  });

  it("clears a stale remote ACP session when resume is rejected", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const executePromise = executeRemoteHostCliAdapter(
      { run: run(), prompt: "retry", model: null, resume_session_id: "stale-session" },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "Session not found" },
    })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));

    await expect(executePromise).resolves.toMatchObject({
      success: false,
      error_code: "runtime_session_invalid",
      output_json: { external_session_id: null },
      metadata_json: { external_session_id: null },
    });
  });

  it("preserves a resumed ACP session when a later turn fails", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const executePromise = executeRemoteHostCliAdapter(
      { run: run(), prompt: "retry", model: null, resume_session_id: "valid-session" },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 },
    })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 2, result: { sessionId: "valid-session" },
    })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 4, error: { code: -32000, message: "provider unavailable" },
    })}\n`, launchIdOf(sink, "run-1"));
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null }, launchIdOf(sink, "run-1"));

    await expect(executePromise).resolves.toMatchObject({
      success: false,
      error_code: "runtime_nonzero_exit",
      output_json: { external_session_id: "valid-session" },
      metadata_json: { external_session_id: "valid-session" },
    });
  });

  it("registers a cancel closure that sends a terminate frame over the same connection", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const terminateCalls: Array<{ runId: string; terminate: () => void; forceTerminate: () => void }> = [];
    const processRegistry: CliProcessRegistry = {
      register: () => { throw new Error("must use registerRemote for a remote run"); },
      registerRemote: (runId, terminate, forceTerminate) => {
        terminateCalls.push({ runId, terminate, forceTerminate });
      },
      deregister: () => {},
      terminate: () => false,
    };

    const executePromise = executeRemoteHostCliAdapter(
      { run: run(), prompt: "hi", model: null, resume_session_id: null, process_registry: processRegistry },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => terminateCalls.length === 1);
    terminateCalls[0]!.terminate();
    // Names its attempt, so it cannot stop a retry of the same run id.
    expect(sink.sent).toContainEqual({ type: "terminate", run_id: "run-1", force: false, launch_id: launchIdOf(sink, "run-1") });

    registry.receiveComplete("host-1", "run-1", { exit_code: 130, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
    await executePromise;
  });

  afterEach(() => {
    vi.useRealTimers();
    setProviderProxyBaseUrlForProcess(null, null);
  });

  it("keeps a run pending across a brief reconnect, but resolves it as disconnected once the grace period lapses with no reconnect", async () => {
    vi.useFakeTimers();
    const registry = new HostConnectionRegistry();
    let currentSink = new FakeSink();
    registry.registerConnection("host-1", currentSink);
    const executePromise = executeRemoteHostCliAdapter(
      { run: run(), prompt: "hi", model: null, resume_session_id: null },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.advanceTimersByTimeAsync(0);
    registry.unregisterConnection("host-1", currentSink);

    // A reconnect within the grace period must not fail the run.
    await vi.advanceTimersByTimeAsync(30_000);
    currentSink = new FakeSink();
    registry.registerConnection("host-1", currentSink);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.isOnline("host-1")).toBe(true);

    // A second, sustained disconnect past the full grace period does fail it.
    registry.unregisterConnection("host-1", currentSink);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await executePromise;
    expect(result.success).toBe(false);
  });

  it("queues a stdin frame sent while the host is briefly offline and redelivers it in order on reconnect", async () => {
    const registry = new HostConnectionRegistry();
    const sink1 = new FakeSink();
    registry.registerConnection("host-1", sink1);
    const completion = registry.dispatchLaunch("host-1", "run-x", { argv: ["opencode"] });
    expect(sink1.sent).toEqual([{ type: "launch", run_id: "run-x", launch_id: expect.any(String), argv: ["opencode"] }]);

    registry.unregisterConnection("host-1", sink1);
    expect(registry.sendStdin("host-1", "run-x", "first")).toBe(false);
    expect(registry.sendStdin("host-1", "run-x", "second")).toBe(false);
    expect(registry.sendStdinClose("host-1", "run-x")).toBe(false);

    const sink2 = new FakeSink();
    registry.registerConnection("host-1", sink2);
    expect(sink2.sent).toEqual([
      { type: "stdin", run_id: "run-x", value: "first" },
      { type: "stdin", run_id: "run-x", value: "second" },
      { type: "stdin_close", run_id: "run-x" },
    ]);

    // Delivered once, not redelivered on a later, unrelated reconnect.
    const sink3 = new FakeSink();
    registry.registerConnection("host-1", sink3);
    expect(sink3.sent).toEqual([]);

    registry.receiveComplete("host-1", "run-x", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink1, "run-x"));
    await completion;
  });

  it("does not queue a stdin frame for a run that was never dispatched or has already completed", () => {
    const registry = new HostConnectionRegistry();
    expect(registry.sendStdin("host-never-dispatched", "run-y", "ignored")).toBe(false);
    const sink = new FakeSink();
    registry.registerConnection("host-never-dispatched", sink);
    expect(sink.sent).toEqual([]);
  });
});

describe("which runs get a runtime profile at all", () => {
  it("uses Claude's native credential store while keeping sessions in each Agent's profile", () => {
    const scope = { agent_id: "agent-1", container_kind: "conversation" as const, container_id: "conv-1" };
    const frame = buildUnboundRuntimeProfile("claude_code", scope);
    expect(frame.env).toEqual({});
    expect(frame.profile_env).toEqual({ CLAUDE_CONFIG_DIR: ".claude" });
    expect(frame.login_link).toEqual({
      home_subdir: ".claude", credential_file: ".credentials.json",
      shared_credential_env: "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    });
    expect(buildUnboundRuntimeProfile("codex_cli", scope).login_link).not.toHaveProperty("shared_credential_env");
  });

  it("fails closed when a runtime cannot isolate its login and state", () => {
    setDynamicRuntimeAdapterSpecs([{
      ...getRuntimeAdapterSpec("claude_code")!,
      runtime_key: "acp_registry_agent",
      credentials: { credential_mode: "cli_profile", credential_runtime_name: "acp_registry_agent", supports_oauth_login_state: false },
    }]);
    try {
      const scope = { agent_id: "agent-1", container_kind: "conversation" as const, container_id: "conv-1" };
      expect(() => buildUnboundRuntimeProfile("acp_registry_agent", scope)).toThrowError(
        expect.objectContaining({ code: "runtime_profile_isolation_unsupported" }),
      );
      // claude_code, codex_cli, and opencode declare isolation and get a profile.
      for (const adapter of ["claude_code", "codex_cli", "opencode"]) {
        const frame = buildUnboundRuntimeProfile(adapter, scope);
        expect(frame?.credential_source, adapter).toBe("host_login");
        expect(frame?.login_link, adapter).not.toBeNull();
        // Never `HOME`: an unbound run keeps the machine's, so a Task run that
        // commits still has `~/.gitconfig` and `~/.ssh/config`.
        expect(frame?.profile_env, adapter).not.toHaveProperty("HOME");
      }
    } finally {
      setDynamicRuntimeAdapterSpecs([]);
    }
  });
});

describe("executeRemoteHostCliAdapter with a bound run", () => {
  // What the server puts on the wire, and whether the lease it issued stops
  // working when the run ends.
  it("fails closed when the selected Runtime Profile provider is no longer available", async () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://control-plane:8021");
    // A removed Profile provider must not silently substitute the host's
    // ambient login; the immutable Profile snapshot is authoritative.
    __setProvidersDbPortForTests({ async getProvider() { return null; } } as never);
    try {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const threadEvents: unknown[] = [];

      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ runtime_key: "claude_code" }),
          prompt: "hi", model: null, resume_session_id: null,
          thread_event_sink: (events) => { threadEvents.push(...events); },
        },
        "host-1",
        "folder-1",
        {
          connectionRegistry: registry,
          config: loadConfig({}),
          bindings: {
            resolve: async () => ({ provider_id: "prov-gone", model: null }),
            record: async () => {},
            profileScope: NO_PROVIDER_BINDINGS.profileScope,
          },
        },
      );
      await expect(execution).resolves.toMatchObject({ success: false, error_code: "model_provider_not_found" });
      expect(sink.sent.some((frame) => frame.type === "launch")).toBe(false);
      expect(threadEvents).toContainEqual(expect.objectContaining({ event_type: "status", status: "run_failed" }));
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("carries the binding on the launch frame and revokes its lease at terminal", async () => {
    const leases = new ProviderProxyLeaseRegistry();
    // No instance-wide external URL: this exercises the common path, where the
    // address is derived from FRONTEND_URL plus the proxy's port.
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    const hostRow = {
      query: async () => ({ rows: [{ provider_proxy_base_url: null, kind: "remote" }], rowCount: 1 }),
    };
    const sink = new FakeSink();
    const connections = new HostConnectionRegistry();
    connections.registerConnection("host-1", sink);

    const providers = {
      async getProvider() {
        return { id: "prov-1", name: "MiniMax", claude_compatible_base_url: "https://api.minimaxi.com/anthropic", default_model: "M2" };
      },
    };
    __setProvidersDbPortForTests(providers as never);
    try {
      const execution = executeRemoteHostCliAdapter(
        { run: run({ runtime_key: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          // Derivation needs a fixed port: an OS-assigned one moves on
          // restart, so there would be nothing stable to hand a host.
          config: loadConfig({ PROVIDER_PROXY_PORT: "8021", FRONTEND_URL: "http://192.168.1.5:3000" }),
          db: hostRow as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "M2" }),
            record: async () => {},
            profileScope: NO_PROVIDER_BINDINGS.profileScope,
          },
          leaseRegistry: leases,
          policyEnforcer: allowCredentialSpend,
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      const launch = sink.sent.find((f) => f.type === "launch") as Record<string, unknown>;
      const binding = launch.provider_binding as { env: Record<string, string>; profile_env: Record<string, string> };
      // Derived: the daemon's own control-plane host, the proxy's port.
      expect(binding.env.ANTHROPIC_BASE_URL).toContain("http://192.168.1.5:8021/anthropic/");
      expect(binding.env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
      expect(binding.profile_env).toEqual({ HOME: ".", CLAUDE_CONFIG_DIR: ".claude" });
      expect(leases.size()).toBe(1);

      connections.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
      await execution;
      // Whatever happened to the run, the token the host holds stops working.
      expect(leases.size()).toBe(0);
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("renews a short-lived provider lease while a run remains active", async () => {
    // Runtime duration is unbounded; credentials remain short-lived and renewable.
    const leases = new ProviderProxyLeaseRegistry();
    const issue = vi.spyOn(leases, "create");
    const renew = vi.spyOn(leases, "renew");
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    const sink = new FakeSink();
    const connections = new HostConnectionRegistry();
    connections.registerConnection("host-1", sink);
    __setProvidersDbPortForTests({
      async getProvider() {
        return { id: "prov-1", name: "MiniMax", claude_compatible_base_url: "https://api.minimaxi.com/anthropic", default_model: "M2" };
      },
    } as never);
    try {
      vi.useFakeTimers();
      const execution = executeRemoteHostCliAdapter(
        { run: run({ runtime_key: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          config: loadConfig({ PROVIDER_PROXY_PORT: "8021", FRONTEND_URL: "http://192.168.1.5:3000" }),
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, kind: "remote" }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "M2" }),
            record: async () => {},
            profileScope: NO_PROVIDER_BINDINGS.profileScope,
          },
          leaseRegistry: leases,
          policyEnforcer: allowCredentialSpend,
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      expect(issue).toHaveBeenCalledTimes(1);
      expect(issue.mock.calls[0]![1].ttl_ms).toBe(900_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalled();
      connections.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
      await execution;
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("tells the runtime which model, in the identifier space that runtime uses", async () => {
    // The remote run is told the model the binding resolved, translated,
    // rather than the router's. Do not send the router's identifier.
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://control-plane:8021");
    const sink = new FakeSink();
    const connections = new HostConnectionRegistry();
    connections.registerConnection("host-1", sink);
    __setProvidersDbPortForTests({
      async getProvider() {
        return { id: "prov-1", name: "MiniMax", provider_type: "openai", openai_compatible_base_url: "https://api.minimaxi.com/v1", default_model: "MiniMax-M3" };
      },
    } as never);
    try {
      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ runtime_key: "opencode" }),
          prompt: "hi",
          // The router's idea of a model. It must not be what goes on the wire.
          model: "some-router-model",
          resume_session_id: null,
        },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          config: loadConfig({}),
          // The lease URL is resolved per host from the hosts row.
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, kind: "remote" }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "MiniMax-M3" }),
            record: async () => {},
            profileScope: NO_PROVIDER_BINDINGS.profileScope,
          },
          leaseRegistry: new ProviderProxyLeaseRegistry(),
          policyEnforcer: allowCredentialSpend,
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      connections.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 2);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 3);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          configOptions: [{
            id: "model", name: "Model", category: "model", type: "select",
            currentValue: "opencode/big-pickle", options: [{ value: "rainver_provider/MiniMax-M3", name: "MiniMax M3" }],
          }],
        },
      })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 4);

      const setConfig = JSON.parse((sink.sent[3] as { value: string }).value) as Record<string, unknown>;
      expect(setConfig).toMatchObject({
        method: "session/set_config_option",
        params: { configId: "model", value: "rainver_provider/MiniMax-M3" },
      });

      connections.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
      await execution;
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("does not ask Claude for a model, whose model the environment already decides", async () => {
    // Do not ask Claude for a model. `boundAcpModelId("claude_code", m)`
    // returning `m` looks right at the helper, and the controller then
    // reconciles it against Claude's own alias space, where a third-party
    // provider's model name does not exist — resolving to whatever the
    // session is already on. On a resumed thread that is the previous turn's
    // model, so a model switch would silently keep running on the old one.
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://control-plane:8021");
    const sink = new FakeSink();
    const connections = new HostConnectionRegistry();
    connections.registerConnection("host-1", sink);
    __setProvidersDbPortForTests({
      async getProvider() {
        return { id: "prov-1", name: "MiniMax", claude_compatible_base_url: "https://api.minimaxi.com/anthropic", default_model: "MiniMax-M3" };
      },
    } as never);
    try {
      const execution = executeRemoteHostCliAdapter(
        { run: run({ runtime_key: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          config: loadConfig({}),
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, kind: "remote" }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "MiniMax-M3" }),
            record: async () => {},
            profileScope: NO_PROVIDER_BINDINGS.profileScope,
          },
          leaseRegistry: new ProviderProxyLeaseRegistry(),
          policyEnforcer: allowCredentialSpend,
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      const launch = sink.sent.find((f) => f.type === "launch") as Record<string, unknown>;
      // The model does reach the runtime — by the channel that decides it.
      expect((launch.provider_binding as { env: Record<string, string> }).env.ANTHROPIC_MODEL).toBe("MiniMax-M3");

      connections.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 2);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 3);
      // A resumed Claude session reports the previous turn's model here.
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          configOptions: [{ id: "model", currentValue: "MiniMax-M2.7", options: [{ value: "default" }, { value: "sonnet" }, { value: "opus" }] }],
        },
      })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 4);

      // Straight to the prompt: no set_config_option, so nothing re-asserts
      // the stale MiniMax-M2.7.
      const next = JSON.parse((sink.sent[3] as { value: string }).value) as Record<string, unknown>;
      expect(next.method).toBe("session/prompt");
      expect(sink.sent.some((f) => (f as { value?: string }).value?.includes("set_config_option"))).toBe(false);

      connections.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null }, launchIdOf(sink, "run-1"));
      await execution;
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("attributes usage to the model the server chose, not the runtime's echo of it", async () => {
    // For Claude the runtime is told no model at all, and its own echo is an
    // alias (`default`) or, on a resumed session, the previous turn's model.
    // The server wrote ANTHROPIC_MODEL, so it already knows the answer and has
    // no reason to ask the host for it.
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://control-plane:8021");
    const sink = new FakeSink();
    const connections = new HostConnectionRegistry();
    connections.registerConnection("host-1", sink);
    __setProvidersDbPortForTests({
      async getProvider() {
        return { id: "prov-1", name: "MiniMax", claude_compatible_base_url: "https://api.minimaxi.com/anthropic", default_model: "MiniMax-M3" };
      },
    } as never);
    try {
      const execution = executeRemoteHostCliAdapter(
        { run: run({ runtime_key: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          config: loadConfig({}),
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, kind: "remote" }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "MiniMax-M3" }),
            record: async () => {},
            profileScope: NO_PROVIDER_BINDINGS.profileScope,
          },
          leaseRegistry: new ProviderProxyLeaseRegistry(),
          policyEnforcer: allowCredentialSpend,
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      connections.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 2);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 3);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          // What a resumed session reports: the model the *previous* turn ran on.
          configOptions: [{ id: "model", currentValue: "MiniMax-M2.7", options: [{ value: "default" }] }],
        },
      })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.length >= 4);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      })}\n`, launchIdOf(sink, "run-1"));
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "stdin_close"));
      connections.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));

      const result = await execution;
      expect(result.model_usage).toEqual([
        expect.objectContaining({ model: "MiniMax-M3" }),
      ]);
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  describe("a runtime that stops saying anything", () => {
    // Quiet work is not evidence of failure.

    async function launched(sink: FakeSink, registry: HostConnectionRegistry) {
      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ runtime_key: "opencode" }),
          prompt: "hi",
          model: null,
          resume_session_id: null,
          // Dispatch setting. The default is five minutes, which no test wants
          // to wait for.
          adapter_config: { stall_timeout_seconds: 5 },
        },
        "host-1",
        "folder-1",
        { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
      // Wrapped: returning the promise bare would let the caller's `await`
      // unwrap it and run the whole turn before the test sends anything.
      return { execution };
    }

    it("defaults to a 300s informational silence notice", () => {
      // A third of the run budget (100s by default) would kill a legitimate
      // turn in the middle of a long tool call, which emits nothing until it
      // returns. The default is 300s of a 900s run.
      expect(stallTimeoutSeconds(undefined)).toBe(300);
      expect(stallTimeoutSeconds({ stall_timeout_seconds: 60 })).toBe(60);
      expect(stallTimeoutSeconds({ stall_timeout_seconds: 5 })).toBe(5);
    });

    it("notifies once during silence, keeps running, and accepts eventual success", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const notices: string[] = [];
      const execution = executeRemoteHostCliAdapter({
        run: run({ runtime_key: "opencode" }), prompt: "hi", model: null,
        resume_session_id: null, adapter_config: { stall_timeout_seconds: 5 },
        thread_event_sink: async events => {
          // A code the reader's client words, never server-side prose.
          for (const event of events) if (event.event_type === "status" && event.status === "run_quiet") notices.push(event.status);
          expect(events.some(event => event.event_type === "diagnostic" && /暂未收到|No new output/.test(event.text ?? ""))).toBe(false);
        },
      }, "host-1", "folder-1", { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS });
      let settled = false;
      void execution.then(() => { settled = true; });
      await vi.waitUntil(() => sink.sent.some(frame => frame.type === "launch"));
      const launchId = launchIdOf(sink, "run-1");
      registry.receiveLaunched("host-1", "run-1", launchId);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toBe(false);
      expect(notices).toHaveLength(1);
      expect(sink.sent.some(frame => frame.type === "terminate")).toBe(false);
      for (const frame of [
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
        { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
        { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } },
      ]) {
        registry.receiveOutput("host-1", "run-1", `${JSON.stringify(frame)}\n`, launchId);
        await vi.advanceTimersByTimeAsync(0);
      }
      registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchId);
      expect((await execution).success).toBe(true);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(notices).toHaveLength(1);
    });

    it("gives a Run up at its explicit time limit when the host never confirms the stop", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const statuses: string[] = [];
      const deadline = new AbortController();
      const execution = executeRemoteHostCliAdapter({
        run: run({ runtime_key: "opencode" }), prompt: "hi", model: null, resume_session_id: null,
        deadline_signal: deadline.signal,
        thread_event_sink: async events => {
          for (const event of events) if (event.event_type === "status" && event.status) statuses.push(event.status);
        },
      }, "host-1", "folder-1", { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS });
      let settled = false;
      void execution.then(() => { settled = true; });
      await vi.waitUntil(() => sink.sent.some(frame => frame.type === "launch"));
      const launchId = launchIdOf(sink, "run-1");
      registry.receiveLaunched("host-1", "run-1", launchId);
      deadline.abort();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await execution;
      expect(result).toMatchObject({ success: false, error_code: "run_timed_out" });
      expect(sink.sent).toContainEqual(expect.objectContaining({ type: "terminate", run_id: "run-1", force: true, launch_id: launchId }));
      expect(statuses.at(-1)).toBe("run_timeout");
      // The dispatch is settled: the daemon's late completion matches nothing.
      registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchId);
    });

    it("never dispatches a launch once the time limit passed during preparation, even after the Run settled", async () => {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const processes = new LocalCliProcessRegistry();
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
      let adapter: Promise<RunAdapterResultEnvelope> | undefined;
      const wrapper = await invokeWithinTimeLimit({
        run: { runtime_key: "opencode" },
        limit: { ms: 20, seconds: 1, source: "run_contract" },
        invoke: (deadline) => {
          adapter = executeRemoteHostCliAdapter({
            run: run({ runtime_key: "opencode" }), prompt: "hi", model: null, resume_session_id: null,
            deadline_signal: deadline, process_registry: processes,
          }, "host-1", "folder-1", {
            connectionRegistry: registry,
            // Preparation outlasts the settle grace below.
            bindings: { ...NO_PROVIDER_BINDINGS, observeModel: () => preparation },
          });
          return adapter;
        },
        stop: async () => ({ process_terminated: processes.terminate("run-1"), confirmed_exit: true, force_kill_escalated: false }),
        settleMs: 20,
      });
      expect(wrapper).toMatchObject({ success: false, error_code: "run_timed_out", metadata_json: { time_limit: { adapter_settled: false } } });

      releasePreparation();
      await expect(adapter!).resolves.toMatchObject({ success: false, error_code: "run_timed_out" });
      expect(sink.sent.some((frame) => frame.type === "launch")).toBe(false);
    });

    it("never dispatches a launch for a Run stopped while its dispatch was being prepared", async () => {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const processes = new LocalCliProcessRegistry();
      const invocation = processes.openInvocation("run-1");
      const statuses: string[] = [];
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
      let preparing = false;
      const execution = executeRemoteHostCliAdapter({
        run: run({ runtime_key: "opencode" }), prompt: "hi", model: null, resume_session_id: null,
        cancel_signal: invocation.signal, process_registry: processes,
        thread_event_sink: async (events) => {
          for (const event of events) if (event.event_type === "status" && event.status) statuses.push(event.status);
        },
      }, "host-1", "folder-1", {
        connectionRegistry: registry,
        bindings: { ...NO_PROVIDER_BINDINGS, observeModel: () => { preparing = true; return preparation; } },
      });
      await vi.waitUntil(() => preparing);
      // The normal stop path: nothing is registered yet, so no process is reached.
      expect(processes.terminate("run-1")).toBe(false);
      releasePreparation();

      await expect(execution).resolves.toMatchObject({ success: false, error_code: "run_cancelled" });
      expect(sink.sent.some((frame) => frame.type === "launch")).toBe(false);
      expect(statuses.at(-1)).toBe("run_failed");
      invocation.close();
    });

    it("refuses to dispatch through the executor when the Run was already stopped", async () => {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const stop = new AbortController();
      stop.abort();
      const result = await new RemoteWsCliCommandExecutor("host-1", "folder-1", registry).runCommand({
        command: ["opencode", "acp"], cwd: null, timeout_seconds: 0, env: {}, run_id: "run-1", stdin: null,
        cancel_signal: stop.signal,
      });
      expect(result).toMatchObject({ timed_out: false, returncode: 1 });
      expect(sink.sent).toEqual([]);
    });

    it("refuses to dispatch through the executor when the deadline has already passed", async () => {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const processes = new LocalCliProcessRegistry();
      const deadline = new AbortController();
      deadline.abort();
      const result = await new RemoteWsCliCommandExecutor("host-1", "folder-1", registry).runCommand({
        command: ["opencode", "acp"], cwd: null, timeout_seconds: 0, env: {}, run_id: "run-1", stdin: null,
        deadline_signal: deadline.signal, process_registry: processes,
      });
      expect(result).toMatchObject({ timed_out: true, returncode: 1 });
      expect(sink.sent).toEqual([]);
      expect(processes.terminate("run-1")).toBe(false);
    });

    it("keeps the usage and host completion metadata collected before the time limit", async () => {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const deadline = new AbortController();
      const execution = executeRemoteHostCliAdapter({
        run: run({ runtime_key: "opencode" }), prompt: "hi", model: null, resume_session_id: null,
        deadline_signal: deadline.signal,
      }, "host-1", "folder-1", { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS });
      await vi.waitUntil(() => sink.sent.some((frame) => frame.type === "launch"));
      const launchId = launchIdOf(sink, "run-1");
      registry.receiveLaunched("host-1", "run-1", launchId);
      for (const [index, frame] of [
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
        { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
        { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } },
      ].entries()) {
        await vi.waitUntil(() => sink.sent.filter((sent) => sent.type === "stdin").length > index);
        registry.receiveOutput("host-1", "run-1", `${JSON.stringify(frame)}\n`, launchId);
      }
      // The limit lands after the turn reported its usage, while the host is
      // still capturing the diff; the host then confirms the stop.
      deadline.abort();
      registry.receiveComplete("host-1", "run-1", {
        exit_code: 143, timed_out: false, error: null,
        task_worktree: { branch: "rainver/task-1", start_commit: "abc123" },
      }, launchId);

      const result = await execution;
      expect(result).toMatchObject({
        success: false,
        error_code: "run_timed_out",
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        metadata_json: {
          runtime_installation: "own",
          task_worktree: { branch: "rainver/task-1", start_commit: "abc123" },
          cli_usage: { acp_turns: 1 },
        },
      });
    });

    it("does not invalidate a stored session merely because resume is quiet", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const execution = executeRemoteHostCliAdapter({
        run: run({ prompt: "continue" }), prompt: "continue", model: null,
        resume_session_id: "vendor-session-abc", adapter_config: { stall_timeout_seconds: 5 },
      }, "host-1", "folder-1", { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS });
      let settled = false;
      void execution.then(() => { settled = true; });
      await vi.waitUntil(() => sink.sent.some(frame => frame.type === "launch"));
      const launchId = launchIdOf(sink, "run-1");
      registry.receiveLaunched("host-1", "run-1", launchId);
      registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchId);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toBe(false);
      expect(sink.sent.some(frame => frame.type === "terminate")).toBe(false);
      // A real process failure still settles the run and clears observation.
      registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: "process failed" }, launchId);
      expect((await execution).success).toBe(false);
    });

    it("allows a queued run to outlive legacy duration settings", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ runtime_key: "opencode" }),
          prompt: "hi",
          model: null,
          resume_session_id: null,
          adapter_config: { stall_timeout_seconds: 5 },
        },
        "host-1",
        "folder-1",
        { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
      );
      let settled = false;
      void execution.then(() => { settled = true; });
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      const launchId = launchIdOf(sink, "run-1");
      registry.receiveWaitingForWorkspace("host-1", "run-1", launchId);
      // Queued for 12s: past the stall budget and most of the run budget.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      registry.receiveLaunched("host-1", "run-1", launchId);
      // Then a 12s turn: 24s after dispatch, 12s after launch.
      for (const frame of [
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
        { jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } } },
        { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } },
      ]) {
        await vi.advanceTimersByTimeAsync(3_000);
        registry.receiveOutput("host-1", "run-1", `${JSON.stringify(frame)}\n`, launchId);
        await Promise.resolve();
        await Promise.resolve();
      }
      registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchId);
      expect((await execution).success).toBe(true);

    }, 30_000);

    it("lets a slow but talking run keep going past the stall budget", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const { execution } = await launched(sink, registry);

      let settled = false;
      void execution.then(() => { settled = true; });
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(3_000);
        registry.receiveOutput("host-1", "run-1", "\n", launchIdOf(sink, "run-1"));
      }
      expect(settled).toBe(false);
      expect(sink.sent.find(frame => frame.type === "launch")).toMatchObject({ timeout_seconds: null });
      // A real turn, paced at 3s a step across 12s: every gap is inside the
      // 5s budget while the total is well past it. A deadline measured from
      // launch rather than from the last output would kill this run.
      const step = async (frame: Record<string, unknown>) => {
        await vi.advanceTimersByTimeAsync(3_000);
        registry.receiveOutput("host-1", "run-1", `${JSON.stringify(frame)}\n`, launchIdOf(sink, "run-1"));
        await Promise.resolve();
        await Promise.resolve();
      };
      await step({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
      await step({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } });
      await step({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
        },
      });
      await step({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
      registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launchIdOf(sink, "run-1"));

      const result = await execution;
      expect(result.error_code).not.toBe("runtime_stall_timeout");
      expect(result.success).toBe(true);
    }, 30_000);
  });
  it("carries the host's egress refusals on the envelope, for the Run event", async () => {
    // The refusal is the thing nobody can otherwise explain: the CLI saw a 403
    // from a proxy it did not choose, and the reason lives on the host. It
    // becomes an `egress_refused` Run event only by riding out on this
    // envelope.
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);

    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({ runtime_key: "opencode", prompt: "install a package" }),
        prompt: "install a package",
        model: null,
        resume_session_id: null,
      },
      "host-1",
      "folder-1",
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    await vi.waitUntil(() => sink.sent.length === 1);
    registry.receiveLaunched("host-1", "run-1", launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`, launchIdOf(sink, "run-1"));
    await Promise.resolve();
    await Promise.resolve();

    const refusal = {
      allowed: false,
      host: "registry.npmjs.org",
      port: 443,
      reason: "Package installs are not allowed for this Run.",
      at: "2026-09-09T02:00:00.000Z",
    };
    registry.receiveComplete(
      "host-1",
      "run-1",
      { exit_code: 0, timed_out: false, error: null, egress: [refusal] },
      launchIdOf(sink, "run-1"),
    );

    const result = await executePromise;
    expect((result.metadata_json as { egress?: unknown[] } | undefined)?.egress).toEqual([refusal]);
  });

});
it('refuses a collector missing its bound context before any Host command or permission request',async()=>{
 const runCommand=vi.fn();await expect(executeRemoteHostCliAdapter({run:run({runtime_key:'claude_code',contract_snapshot_json:{workflow_input_json:{source_goal:{purpose:'collect'}}}}),prompt:'Collect',invocation_delivery:runtimeContextDelivery('Collect'),model:null,resume_session_id:null},'host-1','folder-1',{executor:{runCommand},bindings:NO_PROVIDER_BINDINGS})).rejects.toThrow('source_native_context_refused');expect(runCommand).not.toHaveBeenCalled();
});
