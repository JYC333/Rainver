import { describe, expect, it } from "vitest";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";

describe("Run-local tool directory negotiation", () => {
  for (const resumed of [false, true]) {
    it(`requests Host-local access only when the Agent advertises directory support (${resumed ? "resume" : "new"})`, () => {
      for (const supported of [false, true]) {
        const sent: Record<string, unknown>[] = [];
        const acp = createCliConversationController({ runtime_key: "codex_cli", prompt: "hello", cwd: "/workspace",
          local_tool_directory: true, runtime_session_id: resumed ? "existing-session" : null })!;
        acp.start((m) => sent.push(m));
        acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: supported ? { additionalDirectories: {} } : {} } } }, (m) => sent.push(m), () => {});
        const setup = sent.find((m) => m.id === 2)!;
        expect(setup.method).toBe(resumed ? "session/resume" : "session/new");
        if (supported) expect(setup.params).toHaveProperty("additionalDirectories", []);
        else expect(setup.params).not.toHaveProperty("additionalDirectories");
        expect(setup.params).toHaveProperty("mcpServers", []);
      }
    });
  }
});

/**
 * `codex-acp` announces `_auth/status_update` immediately after `initialize`.
 * An inbound shape this controller does not list is ignored. Do not fail the
 * turn on it. The underscore is ACP's marker for a vendor extension.
 */
describe("an ACP notification the controller does not recognise", () => {
  const controller = () => createCliConversationController({
    runtime_key: "codex_cli",
    prompt: "hello",
    cwd: "/workspace",
  })!;

  it("is ignored rather than failing the turn", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = controller();
    acp.start((message) => sent.push(message));
    acp.receive({ jsonrpc: "2.0", method: "_auth/status_update", params: { status: "ok" } }, (m) => sent.push(m), () => {});
    expect(acp.result().error).toBeNull();
    expect(acp.result().completed).toBe(false);
  });

  it("still answers and then stops on an interactive request, which the peer does wait on", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = controller();
    acp.start((message) => sent.push(message));
    acp.receive({ jsonrpc: "2.0", id: 99, method: "fs/write_text_file", params: {} }, (m) => sent.push(m), () => {});
    const refusal = sent.find((message) => message.id === 99);
    expect((refusal?.error as { code: number } | undefined)?.code).toBe(-32601);
    // Deliberately still terminal: a runtime blocked on an interactive method
    // Rainver will not serve has nowhere to go, unlike a notification nobody
    // is waiting on.
    expect(acp.result().error).toContain("unsupported interactive method");
  });

  it("still fails on a response carrying an id nothing asked for", () => {
    const acp = controller();
    acp.start(() => {});
    acp.receive({ jsonrpc: "2.0", id: 4242, result: {} }, () => {}, () => {});
    expect(acp.result().error).toContain("unexpected response id");
  });
});

describe("structured conversation prompt content", () => {
  it("sends ACP image and resource blocks without stringifying or rewriting them", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = createCliConversationController({
      runtime_key: "codex_cli",
      cwd: "/workspace",
      prompt_blocks: [[
        { type: "text", text: "Describe this" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource_link", uri: "rainver:conversation-input:part-1", name: "README.md", mimeType: "text/markdown", size: 12 },
      ]],
    });
    expect(acp).toBeDefined();
    acp!.start((message) => sent.push(message));
    acp!.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, (message) => sent.push(message), () => {});
    acp!.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1", configOptions: [] } }, (message) => sent.push(message), () => {});

    expect(sent.find((message) => message.method === "session/prompt")).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [
          { type: "text", text: "Describe this" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "resource_link", uri: "rainver:conversation-input:part-1", name: "README.md", mimeType: "text/markdown", size: 12 },
        ],
      },
    });
  });
});

/**
 * Which options a session has depends on the ones already set. Codex offers
 * `fast-mode` at `session/new` and withdraws it once the model is one that
 * does not support it, and `model` is set first. Do not send back every
 * option the composer was shown. A withdrawn one would be fatal.
 * `fast-mode: false` asks for nothing.
 */
describe("a session option that disappears once the model is chosen", () => {
  const withConfig = (config: Parameters<typeof createCliConversationController>[0]["session_config"]) =>
    createCliConversationController({ runtime_key: "codex_cli", prompt: "hello", cwd: "/workspace", session_config: config })!;

  const advertise = (ids: Array<{ id: string; type: "select" | "boolean"; category: string; current: unknown; choices?: string[] }>) => ({
    configOptions: ids.map((option) => ({
      id: option.id,
      type: option.type,
      category: option.category,
      currentValue: option.current,
      ...(option.choices ? { options: option.choices.map((value) => ({ value })) } : {}),
    })),
  });

  it("skips it instead of failing the turn", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = withConfig([
      { id: "model", type: "select", value: "spark", category: "model" },
      { id: "fast-mode", type: "boolean", value: false, category: "model_config" },
    ]);
    acp.start((m) => sent.push(m));
    acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, (m) => sent.push(m), () => {});
    // `session/new` still has fast-mode; the reply to setting the model does not.
    acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1", ...advertise([
      { id: "model", type: "select", category: "model", current: "other", choices: ["spark", "other"] },
      { id: "fast-mode", type: "boolean", category: "model_config", current: false },
    ]) } }, (m) => sent.push(m), () => {});
    acp.receive({ jsonrpc: "2.0", id: 3, result: advertise([
      { id: "model", type: "select", category: "model", current: "spark", choices: ["spark", "other"] },
    ]) }, (m) => sent.push(m), () => {});
    expect(acp.result().error).toBeNull();
    // It moved on to the prompt rather than stopping on the withdrawn option.
    expect(sent.some((m) => m.method === "session/prompt")).toBe(true);
  });
});

/**
 * A session the runtime never answered a prompt in has no transcript on disk,
 * so resuming it fails with "no rollout found" — reported as an opaque
 * "Internal error" one turn after the turn that failed. The rollout file
 * appears only for the turn that prompted.
 */
describe("the vendor session a failed turn leaves behind", () => {
  const reachSession = (config: Parameters<typeof createCliConversationController>[0]["session_config"]) => {
    const sent: Record<string, unknown>[] = [];
    const acp = createCliConversationController({
      runtime_key: "codex_cli", prompt: "hello", cwd: "/workspace", session_config: config,
    })!;
    acp.start((m) => sent.push(m));
    acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, (m) => sent.push(m), () => {});
    acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "s-1", configOptions: [
      { id: "mode", type: "select", category: "mode", currentValue: "agent", options: [{ value: "agent" }] },
    ] } }, (m) => sent.push(m), () => {});
    return { acp, sent };
  };

  it("is not reported when the turn died before prompting", () => {
    // A selection whose shape the session contradicts: fatal, and before any prompt.
    const { acp, sent } = reachSession([{ id: "mode", type: "boolean", value: true, category: "mode" }]);
    expect(acp.result().error).toContain("different shape");
    expect(sent.some((m) => m.method === "session/prompt")).toBe(false);
    expect(acp.result().external_session_id).toBeNull();
  });

  it("is reported once a prompt has gone out, which is when a transcript exists", () => {
    const { acp, sent } = reachSession([{ id: "mode", type: "select", value: "agent", category: "mode" }]);
    expect(sent.some((m) => m.method === "session/prompt")).toBe(true);
    expect(acp.result().external_session_id).toBe("s-1");
  });
});

describe("ACP session updates between Delivery phases", () => {
  it.each([
    { sessionUpdate: "available_commands_update", availableCommands: [] },
    { sessionUpdate: "config_option_update", configOptions: [] },
    { sessionUpdate: "current_mode_update", currentModeId: "default" },
    { sessionUpdate: "session_info_update", title: "Resumed session" },
    { sessionUpdate: "usage_update", used: 100, size: 200_000 },
  ])("accepts $sessionUpdate before resume is acknowledged and completes the turn", async (update) => {
    const sent: Record<string, unknown>[] = [];
    const projected: Record<string, unknown>[] = [];
    let closed = false;
    const close = () => { closed = true; };
    const send = (message: Record<string, unknown>) => sent.push(message);
    const acp = createCliConversationController({
      runtime_key: "claude_code", cwd: "/workspace", prompt: "continue",
      runtime_session_id: "session-1",
      on_protocol_event: (event) => projected.push(event),
    })!;
    acp.start(send);
    await acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
    expect(sent.at(-1)?.method).toBe("session/resume");
    await acp.receive({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "session-1", update,
    } }, send, close);
    expect(acp.result().error).toBeNull();
    expect(closed).toBe(false);
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
    expect(projected).toHaveLength(1); // Initialization only, no prior-turn output.

    await acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1", configOptions: [] } }, send, close);
    expect(sent.at(-1)?.method).toBe("session/prompt");
    await acp.receive({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
    } }, send, close);
    await acp.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } }, send, close);
    expect(acp.result()).toMatchObject({ completed: true, error: null, text: "done", external_session_id: "session-1" });
    expect(closed).toBe(true);
  });

  it.each([
    { sessionId: "another-session", update: { sessionUpdate: "available_commands_update", availableCommands: [] }, error: "out-of-scope session update" },
    { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale answer" } }, error: "out-of-order agent-message chunk" },
    { sessionId: "session-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "stale thought" } }, error: "out-of-order agent-thought chunk" },
  ])("rejects $error during resume", async ({ sessionId, update, error }) => {
    let closed = false;
    const close = () => { closed = true; };
    const acp = createCliConversationController({
      runtime_key: "claude_code", cwd: "/workspace", prompt: "continue", runtime_session_id: "session-1",
    })!;
    acp.start(() => {});
    await acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, () => {}, close);
    await acp.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }, () => {}, close);
    expect(acp.result()).toMatchObject({ completed: false, text: "" });
    expect(acp.result().error).toContain(error);
    expect(closed).toBe(true);
  });

  it("still reports a refused resume after receiving session metadata", async () => {
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => sent.push(message);
    const acp = createCliConversationController({
      runtime_key: "claude_code", cwd: "/workspace", prompt: "continue", runtime_session_id: "session-1",
    })!;
    acp.start(send);
    await acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    await acp.receive({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "session-1", update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } }, send, () => {});
    await acp.receive({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Session not found" } }, send, () => {});
    expect(acp.result()).toMatchObject({ completed: false, resume_handshake_failed: true });
    expect(acp.result().error).toContain("Session not found");
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("accepts session metadata while acknowledging a prompt and after the final response", async () => {
    const sent: Record<string, unknown>[] = [];
    const projected: Record<string, unknown>[] = [];
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
    const acp = createCliConversationController({
      runtime_key: "opencode",
      cwd: "/workspace",
      prompts: ["context", "current user request"],
      before_next_prompt: () => acknowledgement,
      on_protocol_event: (event) => projected.push(event),
    })!;
    const send = (message: Record<string, unknown>) => sent.push(message);
    let closed = false;
    const close = () => { closed = true; };
    const update = (sessionId: string) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } },
    });

    acp.start(send);
    await acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
    await acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1", configOptions: [] } }, send, close);
    await acp.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } }, send, close);
    await acp.receive(update("session-1"), send, close);
    expect(acp.result().error).toBeNull();
    expect(projected).toHaveLength(1); // initialize response only
    expect(sent.filter((message) => message.method === "session/prompt")).toHaveLength(1);

    acknowledge();
    await Promise.resolve();
    expect(sent.filter((message) => message.method === "session/prompt")).toHaveLength(2);
    await acp.receive({ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } }, send, close);
    await acp.receive(update("session-1"), send, close);
    expect(acp.result().error).toBeNull();
    expect(acp.result().completed).toBe(true);
    expect(closed).toBe(true);
    expect(projected).toHaveLength(1);
  });

  it("still rejects an out-of-scope update while waiting for a prompt", async () => {
    const sent: Record<string, unknown>[] = [];
    const acp = createCliConversationController({ runtime_key: "opencode", cwd: "/workspace", prompt: "hello" })!;
    const send = (message: Record<string, unknown>) => sent.push(message);
    acp.start(send);
    await acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    await acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1", configOptions: [] } }, send, () => {});
    await acp.receive({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "another-session", update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } }, send, () => {});
    expect(acp.result().error).toContain("out-of-scope session update");
  });
});
