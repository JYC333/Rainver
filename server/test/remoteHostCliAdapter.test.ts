import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../src/modules/runs/repository";
import type { RuntimeSemanticEvent } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { executeRemoteHostCliAdapter, remoteStallTimeoutSeconds } from "../src/modules/runs/remoteHostCliAdapter";
import { loadConfig } from "../src/config";
import { __setProvidersDbPortForTests } from "../src/modules/providers/dbReader";
import {
  ProviderProxyLeaseRegistry,
  setProviderProxyBaseUrlForProcess,
} from "../src/modules/providers/proxy/lease";
import { NO_PROVIDER_BINDINGS } from "../src/modules/runs/remoteHostCliAdapter";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry";
import type { CliProcessRegistry } from "../src/modules/runs/localCliExecution";
import type { ThreadEventDraft } from "../src/modules/hosts/threadEventNormalization";

// These tests exercise the remote protocol plumbing, not model backends, so
// they state outright that they have no binding subsystem. The adapter refuses
// to guess: a run whose binding it cannot determine fails rather than quietly
// executing on the machine's own login.

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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    // Waits for the frame rather than counting microtask ticks: how many the
    // adapter takes before dispatching is not part of its contract.
    await vi.waitUntil(() => sink.sent.length === 1);
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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );

    // Wait for the launch frame rather than counting microtask ticks: how many
    // awaits the adapter takes before dispatching is not part of its contract.
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveLaunched("host-1", "run-1");
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
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
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });
    await executePromise;
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
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveLaunched("host-1", "run-1");
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "Session not found" },
    })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveLaunched("host-1", "run-1");
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 },
    })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 2, result: { sessionId: "valid-session" },
    })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
    registry.receiveOutput("host-1", "run-1", `${JSON.stringify({
      jsonrpc: "2.0", id: 4, error: { code: -32000, message: "provider unavailable" },
    })}\n`);
    await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
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
      { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
    );
    await vi.waitUntil(() => terminateCalls.length === 1);
    terminateCalls[0]!.terminate();
    expect(sink.sent).toContainEqual({ type: "terminate", run_id: "run-1", force: false });

    registry.receiveComplete("host-1", "run-1", { exit_code: 130, timed_out: false, error: null });
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

describe("executeRemoteHostCliAdapter with a bound run", () => {
  // The other end of the path that shipped inert: what the server actually
  // puts on the wire, and whether the lease it issued stops working when the
  // run ends.
  it("runs on the machine's own login when a host default is unusable here, but fails a dispatch that asked for one", async () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://control-plane:8021");
    // A Host is user-scoped and can back Locations in several Spaces, so its
    // default may name a provider granted in a different one. Before bindings
    // existed such a run used the machine's own login and succeeded; failing
    // it now would be a regression nobody asked for.
    __setProvidersDbPortForTests({ async getProvider() { return null; } } as never);
    try {
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const recorded: Array<{ provider_id: string } | null> = [];
      const warnings: RuntimeSemanticEvent[] = [];

      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ adapter_type: "claude_code" }),
          prompt: "hi", model: null, resume_session_id: null,
          // Deliberately no `thread_event_sink`: this branch is only reachable
          // for a run with no dispatch message, and a run with no message has
          // no thread — so the warning has to reach the channel every run has.
          runtime_event_sink: (event) => { warnings.push(event); },
        },
        "host-1",
        "folder-1",
        {
          connectionRegistry: registry,
          config: loadConfig({}),
          bindings: {
            resolve: async () => ({ provider_id: "prov-gone", model: null, origin: "host_default" as const }),
            record: async (_runId, used) => { recorded.push(used); },
          },
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      const launch = sink.sent.find((f) => f.type === "launch") as Record<string, unknown>;
      expect(launch.provider_binding).toBeUndefined();
      // Recorded as unbound, and said out loud rather than silently.
      expect(recorded).toEqual([null]);
      expect(warnings).toContainEqual(expect.objectContaining({
        type: "warning",
        metadata_json: { reason: "host_default_binding_unusable" },
      }));

      registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });
      // The run reaches the daemon and completes on its own terms; what
      // matters here is that it was not failed *for the binding*.
      const result = await execution;
      expect(result.error_code).not.toBe("model_provider_not_found");

      // The same unusable provider, asked for by the dispatch, still fails.
      const dispatched = await executeRemoteHostCliAdapter(
        { run: run({ adapter_type: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: registry,
          config: loadConfig({}),
          bindings: {
            resolve: async () => ({ provider_id: "prov-gone", model: null, origin: "dispatch" as const }),
            record: async () => {},
          },
        },
      );
      expect(dispatched).toMatchObject({ success: false, error_code: "model_provider_not_found" });
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("carries the binding on the launch frame and revokes its lease at terminal", async () => {
    const leases = new ProviderProxyLeaseRegistry();
    // No instance-wide external URL: this exercises the common path, where the
    // address is derived from what the daemon reported it connects to.
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    const hostRow = {
      query: async () => ({ rows: [{ provider_proxy_base_url: null, daemon_server_url: "http://192.168.1.5:3000" }], rowCount: 1 }),
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
        { run: run({ adapter_type: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          // Derivation needs a fixed port: an OS-assigned one moves on
          // restart, so there would be nothing stable to hand a host.
          config: loadConfig({ PROVIDER_PROXY_PORT: "8021" }),
          db: hostRow as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "M2", origin: "dispatch" as const }),
            record: async () => {},
          },
          leaseRegistry: leases,
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

      connections.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });
      await execution;
      // Whatever happened to the run, the token the host holds stops working.
      expect(leases.size()).toBe(0);
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("tells the runtime which model, in the identifier space that runtime uses", async () => {
    // Nothing threaded a model into a remote run before, so this path is new:
    // the model the *binding* resolved, translated, rather than the router's.
    setProviderProxyBaseUrlForProcess("http://server:8021", "http://control-plane:8021");
    const sink = new FakeSink();
    const connections = new HostConnectionRegistry();
    connections.registerConnection("host-1", sink);
    __setProvidersDbPortForTests({
      async getProvider() {
        return { id: "prov-1", name: "MiniMax", openai_compatible_base_url: "https://api.minimaxi.com/v1", default_model: "MiniMax-M3" };
      },
    } as never);
    try {
      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ adapter_type: "opencode" }),
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
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, daemon_server_url: null }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "MiniMax-M3", origin: "dispatch" as const }),
            record: async () => {},
          },
          leaseRegistry: new ProviderProxyLeaseRegistry(),
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      connections.receiveLaunched("host-1", "run-1");
      await vi.waitUntil(() => sink.sent.length >= 2);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
      await vi.waitUntil(() => sink.sent.length >= 3);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          configOptions: [{ id: "model", currentValue: "opencode/big-pickle", options: [{ value: "agent_space_provider/MiniMax-M3" }] }],
        },
      })}\n`);
      await vi.waitUntil(() => sink.sent.length >= 4);

      const setConfig = JSON.parse((sink.sent[3] as { value: string }).value) as Record<string, unknown>;
      expect(setConfig).toMatchObject({
        method: "session/set_config_option",
        params: { configId: "model", value: "agent_space_provider/MiniMax-M3" },
      });

      connections.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null });
      await execution;
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  it("does not ask Claude for a model, whose model the environment already decides", async () => {
    // The gap that made this worth a test: `boundAcpModelId("claude_code", m)`
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
        { run: run({ adapter_type: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          config: loadConfig({}),
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, daemon_server_url: null }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "MiniMax-M3", origin: "dispatch" as const }),
            record: async () => {},
          },
          leaseRegistry: new ProviderProxyLeaseRegistry(),
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      const launch = sink.sent.find((f) => f.type === "launch") as Record<string, unknown>;
      // The model does reach the runtime — by the channel that decides it.
      expect((launch.provider_binding as { env: Record<string, string> }).env.ANTHROPIC_MODEL).toBe("MiniMax-M3");

      connections.receiveLaunched("host-1", "run-1");
      await vi.waitUntil(() => sink.sent.length >= 2);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
      await vi.waitUntil(() => sink.sent.length >= 3);
      // A resumed Claude session reports the previous turn's model here.
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          configOptions: [{ id: "model", currentValue: "MiniMax-M2.7", options: [{ value: "default" }, { value: "sonnet" }, { value: "opus" }] }],
        },
      })}\n`);
      await vi.waitUntil(() => sink.sent.length >= 4);

      // Straight to the prompt: no set_config_option, so nothing re-asserts
      // the stale MiniMax-M2.7.
      const next = JSON.parse((sink.sent[3] as { value: string }).value) as Record<string, unknown>;
      expect(next.method).toBe("session/prompt");
      expect(sink.sent.some((f) => (f as { value?: string }).value?.includes("set_config_option"))).toBe(false);

      connections.receiveComplete("host-1", "run-1", { exit_code: 1, timed_out: false, error: null });
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
        { run: run({ adapter_type: "claude_code" }), prompt: "hi", model: null, resume_session_id: null },
        "host-1",
        "folder-1",
        {
          connectionRegistry: connections,
          config: loadConfig({}),
          db: { query: async () => ({ rows: [{ provider_proxy_base_url: null, daemon_server_url: null }], rowCount: 1 }) } as never,
          bindings: {
            resolve: async () => ({ provider_id: "prov-1", model: "MiniMax-M3", origin: "dispatch" as const }),
            record: async () => {},
          },
          leaseRegistry: new ProviderProxyLeaseRegistry(),
        },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      connections.receiveLaunched("host-1", "run-1");
      await vi.waitUntil(() => sink.sent.length >= 2);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
      await vi.waitUntil(() => sink.sent.length >= 3);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          sessionId: "session-1",
          // What a resumed session reports: the model the *previous* turn ran on.
          configOptions: [{ id: "model", currentValue: "MiniMax-M2.7", options: [{ value: "default" }] }],
        },
      })}\n`);
      await vi.waitUntil(() => sink.sent.length >= 4);
      connections.receiveOutput("host-1", "run-1", `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      })}\n`);
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "stdin_close"));
      connections.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });

      const result = await execution;
      expect(result.model_usage).toEqual([
        expect.objectContaining({ model: "MiniMax-M3" }),
      ]);
    } finally {
      __setProvidersDbPortForTests(null);
    }
  });

  describe("a runtime that stops saying anything", () => {
    // A stalled OpenCode turn burned the full run timeout in silence and then
    // reported only "Remote Run timed out", which is equally true of a run
    // that worked the whole time. The remote path accepted a
    // `stall_timeout_seconds` option and never implemented it.

    async function launched(sink: FakeSink, registry: HostConnectionRegistry, timeoutSeconds: number) {
      const execution = executeRemoteHostCliAdapter(
        {
          run: run({ adapter_type: "opencode" }),
          prompt: "hi",
          model: null,
          resume_session_id: null,
          timeout_seconds: timeoutSeconds,
        },
        "host-1",
        "folder-1",
        { connectionRegistry: registry, bindings: NO_PROVIDER_BINDINGS },
      );
      await vi.waitUntil(() => sink.sent.some((f) => f.type === "launch"));
      registry.receiveLaunched("host-1", "run-1");
      // Wrapped: returning the promise bare would let the caller's `await`
      // unwrap it and run the whole turn before the test sends anything.
      return { execution };
    }

    it("scales the silence budget to the run's own deadline", () => {
      expect(remoteStallTimeoutSeconds(900)).toBe(120);
      expect(remoteStallTimeoutSeconds(300)).toBe(100);
      // Never larger than the deadline it lives inside.
      expect(remoteStallTimeoutSeconds(30)).toBe(10);
      expect(remoteStallTimeoutSeconds(3)).toBe(5);
    });

    it("gives up on a silent run well before the run timeout, and says how long it was silent", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      // 5s of silence allowed, 15s before the run's own deadline.
      const { execution } = await launched(sink, registry, 15);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await execution;

      expect(result).toMatchObject({ success: false, error_code: "runtime_stall_timeout" });
      expect(result.error_message).toMatch(/produced no output for \d+s/);
      expect(sink.sent.some((f) => f.type === "terminate")).toBe(true);
    }, 20_000);

    it("lets a slow but talking run keep going past the stall budget", async () => {
      vi.useFakeTimers();
      const registry = new HostConnectionRegistry();
      const sink = new FakeSink();
      registry.registerConnection("host-1", sink);
      const { execution } = await launched(sink, registry, 15);

      // A real turn, paced at 3s a step across 12s: every gap is inside the
      // 5s budget while the total is well past it. A deadline measured from
      // launch rather than from the last output would kill this run.
      const step = async (frame: Record<string, unknown>) => {
        await vi.advanceTimersByTimeAsync(3_000);
        registry.receiveOutput("host-1", "run-1", `${JSON.stringify(frame)}\n`);
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
      registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null });

      const result = await execution;
      expect(result.error_code).not.toBe("runtime_stall_timeout");
      expect(result.success).toBe(true);
    }, 30_000);
  });
});
