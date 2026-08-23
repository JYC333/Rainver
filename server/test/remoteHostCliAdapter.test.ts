import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../src/modules/runs/repository";
import type { RuntimeSemanticEvent } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { executeRemoteHostCliAdapter } from "../src/modules/runs/remoteHostCliAdapter";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry";
import type { CliProcessRegistry } from "../src/modules/runs/localCliExecution";
import type { ThreadEventDraft } from "../src/modules/hosts/threadEventNormalization";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    status: "queued",
    mode: "live",
    prompt: "fix the failing test",
    instruction: null,
    project_folder_id: "folder-1",
    session_id: null,
    project_id: null,
    adapter_type: "claude_code",
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    owner_user_id: "user-1",
    started_at: null,
    ended_at: null,
    ...overrides,
  } as RunRecord;
}

/** Captures every frame the adapter sends to "the daemon" and lets a test script replies back through the same registry, exactly as the real WS route handler would on a real connection. */
class FakeSink implements HostFrameSink {
  sent: Record<string, unknown>[] = [];
  send(frame: Record<string, unknown>): void {
    this.sent.push(frame);
  }
  close(): void {}
}

describe("executeRemoteHostCliAdapter", () => {
  it("rejects an unimplemented adapter (gemini_cli) before ever dispatching a frame, but still emits a terminal thread event", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    // control-center-phase2-plan.md P3 (closure review): every early-return
    // failure path above the ordinary `run_started`/.../`run_failed` event
    // sequence used to skip `thread_event_sink` entirely, leaving a Run
    // terminal in the database with zero thread events — the frontend
    // conversation view's only signal that a run finished. This is one of
    // four such early returns (all now routed through the same
    // `remoteFailureWithEvent` helper); asserting it here covers the
    // mechanism for all four.
    // ACP runtime replatform P3: codex_cli is remote-eligible now (it speaks
    // ACP, like opencode), so gemini_cli (still implementation_status
    // "planned") is the adapter that exercises this particular early return.
    const threadEventSink = vi.fn().mockResolvedValue(undefined);
    const result = await executeRemoteHostCliAdapter(
      { run: run({ adapter_type: "gemini_cli" }), prompt: "hi", model: null, resume_session_id: null, thread_event_sink: threadEventSink },
      "host-1",
      "folder-1",
      { connectionRegistry: registry },
    );
    expect(result).toMatchObject({ success: false, error_code: "runtime_adapter_not_implemented" });
    expect(sink.sent).toEqual([]);
    expect(threadEventSink).toHaveBeenCalledWith([{ event_type: "status", status: "run_failed" }]);
  });

  it("drives opencode's ACP controller over the daemon's duplex stdin frames and reports success (ACP runtime replatform P2)", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const runtimeEvents: RuntimeSemanticEvent[] = [];
    const threadDrafts: ThreadEventDraft[] = [];

    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({ adapter_type: "opencode", prompt: "add a test" }),
        prompt: "add a test",
        model: null,
        resume_session_id: null,
        runtime_event_sink: (event) => { runtimeEvents.push(event); },
        thread_event_sink: (drafts) => { threadDrafts.push(...drafts); },
      },
      "host-1",
      "folder-1",
      { connectionRegistry: registry },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sent).toHaveLength(1);
    const launchFrame = sink.sent[0]!;
    expect(launchFrame).toMatchObject({ type: "launch", run_id: "run-1", keep_stdin_open: true, stdin: null });
    expect(launchFrame.argv as string[]).toContain("agent-space:remote-workspace-cwd");

    // The controller must not write its `initialize` request until the
    // daemon confirms the run is registered.
    expect(sink.sent).toHaveLength(1);
    registry.receiveLaunched("host-1", "run-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sent).toHaveLength(2);
    expect(JSON.parse((sink.sent[1] as { value: string }).value)).toMatchObject({ method: "initialize" });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[2] as { value: string }).value)).toMatchObject({ method: "session/new" });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[3] as { value: string }).value)).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "session-1" },
    });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done\n" } },
      },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    // The controller closes stdin itself once its turn completes.
    expect(sink.sent.at(-1)).toEqual({ type: "stdin_close", run_id: "run-1" });

    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });

    const result = await executePromise;
    expect(result).toMatchObject({
      success: true,
      exit_code: 0,
      adapter_type: "opencode",
      output_text: "done\n",
    });
    // Text arrives via the coalesced thread draft, not a duplicate from the
    // raw protocol-event path (threadEventNormalization.ts's
    // pushAcpProtocolEvent deliberately ignores agent_message_chunk).
    expect(threadDrafts).toContainEqual({ event_type: "assistant_text", text: "done" });
    expect(threadDrafts.filter((d) => d.event_type === "assistant_text")).toHaveLength(1);
    // The initialize-response echo (forwarded for diagnostics by
    // AcpController) must not produce a spurious runtime event.
    expect(runtimeEvents).toEqual([]);
  });

  it("records a permission pre-authorization as a human-readable diagnostic thread event (P0.4/D7)", async () => {
    const registry = new HostConnectionRegistry();
    const sink = new FakeSink();
    registry.registerConnection("host-1", sink);
    const threadDrafts: ThreadEventDraft[] = [];

    const executePromise = executeRemoteHostCliAdapter(
      {
        run: run({ adapter_type: "opencode", prompt: "add a test" }),
        prompt: "add a test",
        model: null,
        resume_session_id: null,
        thread_event_sink: (drafts) => { threadDrafts.push(...drafts); },
      },
      "host-1",
      "folder-1",
      { connectionRegistry: registry },
    );

    await Promise.resolve();
    await Promise.resolve();
    registry.receiveLaunched("host-1", "run-1");
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } })}\n`);
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
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();

    expect(threadDrafts).toContainEqual({
      event_type: "diagnostic",
      text: "Permission pre-authorized (execute): allowed",
    });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });
    await executePromise;
  });

  it("reports the host offline without hanging when no connection is registered", async () => {
    const registry = new HostConnectionRegistry();
    const result = await executeRemoteHostCliAdapter(
      { run: run(), prompt: "hi", model: null, resume_session_id: null },
      "host-never-connected",
      "folder-1",
      { connectionRegistry: registry },
    );
    expect(result.success).toBe(false);
  });

  it("drives Claude ACP resume over duplex stdin and reports success on a clean exit", async () => {
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
      { connectionRegistry: registry },
    );

    // Let the microtask queue run so dispatchLaunch has sent the frame.
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sent).toHaveLength(1);
    const launchFrame = sink.sent[0]!;
    expect(launchFrame).toMatchObject({
      type: "launch",
      run_id: "run-1",
      workspace_location_id: "folder-1",
      project_folder_id: "folder-1",
    });
    const argv = launchFrame.argv as string[];
    expect(argv).toEqual(["claude-agent-acp"]);

    registry.receiveLaunched("host-1", "run-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[1] as { value: string }).value)).toMatchObject({ method: "initialize" });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse((sink.sent[2] as { value: string }).value)).toMatchObject({
      method: "session/resume",
      params: { sessionId: "vendor-session-abc", cwd: "agent-space:remote-workspace-cwd" },
    });

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "vendor-session-abc" } })}\n`);
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
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();

    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "vendor-session-abc",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });

    const result = await executePromise;
    expect(result).toMatchObject({
      success: true,
      exit_code: 0,
      adapter_type: "claude_code",
      output_text: "done",
      metadata_json: {
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
      { connectionRegistry: registry },
    );
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null });
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
      { connectionRegistry: registry },
    );
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveLaunched("host-1", "run-1");
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "Session not found" },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });

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
      { connectionRegistry: registry },
    );
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveLaunched("host-1", "run-1");
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 2, result: { sessionId: "valid-session" },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 4, error: { code: -32000, message: "provider unavailable" },
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    registry.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null });

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
      { connectionRegistry: registry },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateCalls).toHaveLength(1);
    terminateCalls[0]!.terminate();
    expect(sink.sent).toContainEqual({ type: "terminate", run_id: "run-1", force: false });

    registry.receiveComplete("host-1", "run-1", { exit_code: 130, timed_out: false, error: null });
    await executePromise;
  });

  afterEach(() => {
    vi.useRealTimers();
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
      { connectionRegistry: registry },
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

  it("queues a stdin frame sent while the host is briefly offline and redelivers it in order on reconnect (P2 discovery review fix)", async () => {
    const registry = new HostConnectionRegistry();
    const sink1 = new FakeSink();
    registry.registerConnection("host-1", sink1);
    const completion = registry.dispatchLaunch("host-1", "run-x", { argv: ["opencode"] });
    expect(sink1.sent).toEqual([{ type: "launch", run_id: "run-x", argv: ["opencode"] }]);

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

    registry.receiveComplete("host-1", "run-x", { exit_code: 0, timed_out: false, error: null });
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
