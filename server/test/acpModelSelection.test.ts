import { describe, expect, it } from "vitest";
import { acpSessionConfigFromRunOverride, createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";

import { conversationConfigOptions, resolveSessionConfig } from "../src/modules/sessions/sessionConfig.js";

const canonicalModel = "claude-fable-5-1";
const modelOption = (currentValue: string, choices = [canonicalModel, "opus"]) => ({
  id: "model", category: "model", type: "select", currentValue,
  options: choices.map((value) => ({ value })),
});

function open(input: {
  resume?: boolean;
  allowResumedModelChange?: boolean;
  runtime?: "claude_code" | "codex_cli";
  value?: string;
  current?: string;
  choices?: string[];
  saved?: boolean;
  onModel?: (model: string | null) => void;
} = {}) {
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const send = (message: Record<string, unknown>) => { sent.push(message); };
  const close = () => { closed = true; };
  const controller = createCliConversationController({
    runtime_key: input.runtime ?? "claude_code", cwd: "/workspace", prompt: "continue",
    ...(input.resume ? { runtime_session_id: "session-1" } : {}),
    allow_resumed_model_change: input.allowResumedModelChange,
    on_model_selected: input.onModel,
    session_config: [{
      id: "model", category: "model", type: "select", value: input.value ?? "fable",
      ...(input.saved ? { fallback_to_default: true } : {}),
    }],
  })!;
  const receive = (message: Record<string, unknown>) => controller.receive(message, send, close);
  controller.start(send);
  receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  receive({ jsonrpc: "2.0", id: 2, result: {
    sessionId: "session-1", configOptions: [modelOption(input.current ?? canonicalModel, input.choices)],
  } });
  return { controller, sent, receive, closed: () => closed };
}

describe("ACP model selection", () => {
  it("uses Rainver's Claude default independently of the Host's current model", async () => {
    const advertised = [{
      id: "model", category: "model", name: "Model", description: null, type: "select" as const,
      current_value: "fable",
      options: ["default", "fable", "opus"].map(value => ({ value, name: value, description: null, group: null })),
    }];
    const options = conversationConfigOptions("claude_code", advertised);
    expect(options[0]?.current_value).toBe("opus");
    expect(advertised[0]?.current_value).toBe("fable");
    expect(conversationConfigOptions("codex_cli", advertised)).toBe(advertised);

    const saved = [{ id: "model", category: "model", type: "select", value: "claude-retired" }];
    await expect(resolveSessionConfig(undefined, async () => saved, options, "claude_code"))
      .resolves.toEqual({ selections: saved, dropped: [], source: "saved" });
  });

  it("reports the resolved model only after its selection is acknowledged", () => {
    const observed: Array<string | null> = [];
    const { receive } = open({ onModel: model => { observed.push(model); } });
    expect(observed).toEqual([]);
    receive({ jsonrpc: "2.0", id: 3, result: { configOptions: [modelOption(canonicalModel)] } });
    expect(observed).toEqual([canonicalModel]);
    receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
      sessionUpdate: "config_option_update", configOptions: [modelOption("opus")],
    } } });
    expect(observed).toEqual([canonicalModel, "opus"]);
  });

  it("does not report a failed model selection as the selected model", () => {
    const observed: Array<string | null> = [];
    const { receive } = open({ onModel: model => { observed.push(model); } });
    receive({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid model" } });
    expect(observed).toEqual([]);
  });

  it("treats the default policy as an unknown model, rather than an identity", () => {
    const observed: Array<string | null> = [];
    open({ value: "default", current: "default", choices: ["default"], onModel: model => { observed.push(model); } });
    expect(observed).toEqual([null]);
  });

  it.each([false, true])("lets the adapter resolve a model alias (resume=%s)", (resume) => {
    const { controller, sent, receive } = open({ resume });
    expect(sent.at(-1)).toMatchObject({ method: "session/set_config_option", params: { value: "fable" } });
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
    receive({ jsonrpc: "2.0", id: 3, result: { configOptions: [modelOption(canonicalModel)] } });
    expect(sent.at(-1)?.method).toBe("session/prompt");
    receive({ jsonrpc: "2.0", id: 4, result: {
      stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    } });
    expect(controller.result()).toMatchObject({ completed: true, error: null });
    expect(controller.result().model_usage).toMatchObject([{ model: canonicalModel }]);
  });

  it("holds a model switch before prompting when the resumed context needs a handoff", () => {
    const { controller, sent, closed } = open({ resume: true, allowResumedModelChange: false, value: "opus" });
    expect(controller.result().error).toContain("Model not switched");
    expect(controller.result().resume_handshake_failed).toBeUndefined();
    expect(closed()).toBe(true);
    expect(sent.map(message => message.method)).toEqual(["initialize", "session/resume"]);
  });

  it("still prompts a resumed session on its current model when a switch would be held", () => {
    const { controller, sent } = open({ resume: true, allowResumedModelChange: false, value: canonicalModel });
    expect(controller.result().error).toBeNull();
    expect(sent.at(-1)?.method).toBe("session/prompt");
  });

  it("resumes a session that may not switch as it is when it already stands on the one choice the picker alias names", () => {
    // The alias was resolved to its canonical value on an earlier turn; the full session reports that value on resume.
    const observed: Array<string | null> = [];
    const { controller, sent, receive } = open({ resume: true, allowResumedModelChange: false, value: "fable", current: canonicalModel,
      onModel: model => { observed.push(model); } });
    expect(controller.result().error).toBeNull();
    expect(sent.map(message => message.method)).toEqual(["initialize", "session/resume", "session/prompt"]);
    receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } });
    expect(controller.result()).toMatchObject({ completed: true, error: null });
    expect(controller.result().model_usage).toMatchObject([{ model: canonicalModel }]);
  });

  it.each([
    ["names two advertised choices", ["claude-fable-4-0", canonicalModel], canonicalModel],
    ["names another choice than the current one", [canonicalModel, "claude-opus-5-5"], canonicalModel, "opus"],
  ])("still holds a resumed switch when the alias %s", (_case, choices, current, value = "fable") => {
    const { controller, sent } = open({ resume: true, allowResumedModelChange: false, value, current, choices });
    expect(controller.result().error).toContain("Model not switched");
    expect(sent.map(message => message.method)).toEqual(["initialize", "session/resume"]);
  });

  it("stops without prompting when the runtime rejects the alias", () => {
    const { controller, sent, receive, closed } = open({ value: "unavailable-model" });
    receive({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid model alias" } });
    expect(controller.result().error).toContain("Invalid model alias");
    expect(closed()).toBe(true);
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it.each([
    { configOptions: [] },
    { configOptions: [modelOption("unadvertised-model")] },
    { configOptions: [{ ...modelOption(canonicalModel), category: "mode" }] },
    { configOptions: [{ ...modelOption(canonicalModel), type: "boolean" }] },
  ])("rejects an invalid alias acknowledgement: %j", (result) => {
    const { controller, sent, receive } = open();
    receive({ jsonrpc: "2.0", id: 3, result });
    expect(controller.result().error).toContain("did not apply session option");
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("does not accept another model in place of an explicitly advertised selection", () => {
    const { controller, sent, receive } = open({ value: canonicalModel, current: "opus" });
    receive({ jsonrpc: "2.0", id: 3, result: { configOptions: [modelOption("opus")] } });
    expect(controller.result().error).toContain("did not apply session option");
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("keeps exact model validation for runtimes that do not declare alias support", () => {
    const { controller, sent } = open({ runtime: "codex_cli" });
    expect(controller.result().error).toContain("did not advertise value 'fable'");
    expect(sent.some((message) => message.method === "session/set_config_option")).toBe(false);
  });

  it("preserves an already-current model even when it is outside the picker", () => {
    const { controller, sent } = open({ value: canonicalModel, choices: ["opus"] });
    expect(controller.result().error).toBeNull();
    expect(sent.at(-1)?.method).toBe("session/prompt");
    expect(sent.some((message) => message.method === "session/set_config_option")).toBe(false);
  });

  it("does not permit aliases for permission modes", () => {
    const sent: Record<string, unknown>[] = [];
    const send = (message: Record<string, unknown>) => { sent.push(message); };
    const controller = createCliConversationController({
      runtime_key: "claude_code", cwd: "/workspace", prompt: "continue",
      session_config: [{ id: "mode", category: "mode", type: "select", value: "unknown" }],
    })!;
    controller.start(send);
    controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, () => {});
    controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1", configOptions: [{
      id: "mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default" }],
    }] } }, send, () => {});
    expect(controller.result().error).toContain("did not advertise value 'unknown'");
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("accepts an alias when the session moves to the model it names", () => {
    const { controller, sent, receive } = open({ current: "opus" });
    receive({ jsonrpc: "2.0", id: 3, result: { configOptions: [modelOption(canonicalModel)] } });
    expect(controller.result().error).toBeNull();
    expect(sent.at(-1)?.method).toBe("session/prompt");
  });

  it("refuses an alias the adapter ignored and answered with its unchanged default", () => {
    const { controller, sent, receive } = open({ value: "unknown-model", current: "opus" });
    expect(sent.at(-1)).toMatchObject({ method: "session/set_config_option", params: { value: "unknown-model" } });
    receive({ jsonrpc: "2.0", id: 3, result: { configOptions: [modelOption("opus")] } });
    expect(controller.result().error).toContain("did not apply session option");
    expect(sent.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("keeps the runtime default for a saved alias the adapter did not apply, and says so", () => {
    const { controller, sent, receive } = open({ value: "unknown-model", current: "opus", saved: true });
    receive({ jsonrpc: "2.0", id: 3, result: { configOptions: [modelOption("opus")] } });
    expect(controller.result().error).toBeNull();
    expect(sent.at(-1)?.method).toBe("session/prompt");
    expect(controller.result().dropped_session_config).toEqual([
      { id: "model", category: "model", value: "unknown-model", reason: "not_applied" },
    ]);
  });

  it("drops a saved model the live session no longer advertises instead of failing the turn", () => {
    const { controller, sent } = open({ runtime: "codex_cli", value: "retired-model", current: "opus", saved: true });
    expect(controller.result().error).toBeNull();
    expect(sent.some((message) => message.method === "session/set_config_option")).toBe(false);
    expect(sent.at(-1)?.method).toBe("session/prompt");
    expect(controller.result().dropped_session_config).toEqual([
      { id: "model", category: "model", value: "retired-model", reason: "value_unavailable" },
    ]);
  });

  it("marks only saved Run selections as falling back to the runtime default", () => {
    const selection = { id: "model", category: "model", type: "select", value: "opus" };
    expect(acpSessionConfigFromRunOverride({ acp_session_config: [selection] })).toEqual([selection]);
    expect(acpSessionConfigFromRunOverride({ acp_session_config: [selection], acp_session_config_source: "saved" }))
      .toEqual([{ ...selection, fallback_to_default: true }]);
  });
});
