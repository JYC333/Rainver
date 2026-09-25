import { describe, expect, it } from "vitest";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";
import type { VendorCliRuntimeKey } from "../src/modules/runtimeAdapters/specs.js";

/**
 * `modules/runtime-adapters.md`, "Interactive requests from the runtime": a vendor CLI's own interactive question is
 * translated into the turn's reply — the prompt is cancelled, the Run
 * completes, and the question is reported as `asked_user`.
 *
 * The frames are the shapes the pinned adapters build, read from their
 * source on 2026-09-24: claude-agent-acp 0.70 (`askUserQuestionsToCreateRequest`)
 * and codex-acp 1.12 (`buildUserInputRequest`). A real-host run of each is
 * tracked in `tasks/deferred-register.md`.
 */
function promptingController(runtime_key: VendorCliRuntimeKey) {
  const sent: Record<string, unknown>[] = [];
  let stdinClosed = false;
  const acp = createCliConversationController({ runtime_key, prompt: "Refactor the parser.", cwd: "/workspace" })!;
  const send = (message: Record<string, unknown>) => { sent.push(message); };
  const close = () => { stdinClosed = true; };
  acp.start(send);
  void acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
  void acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } }, send, close);
  expect(sent.some((message) => message.method === "session/prompt")).toBe(true);
  return {
    acp,
    sent,
    stdinClosed: () => stdinClosed,
    receive: (message: Record<string, unknown>) => void acp.receive(message, send, close),
  };
}

const CLAUDE_ASK_ONE = {
  jsonrpc: "2.0",
  id: 0,
  method: "elicitation/create",
  params: {
    mode: "form",
    sessionId: "session-1",
    toolCallId: "toolu_01",
    message: "Which parser should I keep?",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: {
          type: "string",
          title: "Parser",
          oneOf: [
            { const: "Recursive descent", title: "Recursive descent", description: "Simpler, slower" },
            { const: "Pratt", title: "Pratt" },
          ],
        },
        question_0_custom: {
          type: "string",
          title: "Other",
          description: "Type your own answer instead of choosing an option above (optional).",
          _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
        },
      },
    },
  },
};

const CODEX_REQUEST_USER_INPUT = {
  jsonrpc: "2.0",
  id: 7,
  method: "elicitation/create",
  params: {
    sessionId: "session-1",
    toolCallId: "item-3",
    mode: "form",
    message: "Codex needs your input to continue.",
    requestedSchema: {
      type: "object",
      properties: {
        storage: {
          title: "Which database should the cache use?",
          description: "Storage",
          _meta: { codex: { isOther: true, isSecret: false } },
          type: "string",
          oneOf: [
            { const: "SQLite", title: "SQLite" },
            { const: "Postgres", title: "Postgres", description: "Shared with the app" },
            { const: "None of the above", title: "None of the above", description: "Provide a different answer in the note field." },
          ],
        },
        storage_note: {
          type: "string",
          title: "Additional answer or note",
          _meta: { codex: { questionId: "storage", role: "user_note", isSecret: false } },
        },
      },
      required: ["storage"],
    },
    _meta: { codex: { autoResolutionMs: null } },
  },
};

describe("a vendor CLI's own question", () => {
  it("advertises form elicitation only to runtimes whose question tool needs it", () => {
    const initialize = (runtime_key: VendorCliRuntimeKey) => {
      const sent: Record<string, unknown>[] = [];
      createCliConversationController({ runtime_key, prompt: "hi", cwd: "/w" })!.start((m) => sent.push(m));
      return (sent[0]!.params as { clientCapabilities: Record<string, unknown> }).clientCapabilities;
    };
    expect(initialize("claude_code").elicitation).toEqual({ form: {} });
    expect(initialize("codex_cli").elicitation).toEqual({ form: {} });
    expect(initialize("opencode").elicitation).toBeUndefined();
  });

  it("cancels a Claude Code AskUserQuestion and completes the turn with the question", () => {
    const run = promptingController("claude_code");
    run.receive({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Both parsers pass the tests." } },
    } });
    run.receive(CLAUDE_ASK_ONE);

    const cancelIndex = run.sent.findIndex((message) => message.method === "session/cancel");
    const answerIndex = run.sent.findIndex((message) => message.id === 0 && "result" in message);
    expect(run.sent[cancelIndex]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "session-1" } });
    // Cancel first, so the runtime never reads the answer as "declined, carry on".
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(cancelIndex);
    expect(run.sent[answerIndex]).toEqual({ jsonrpc: "2.0", id: 0, result: { action: "cancel" } });
    expect(run.acp.result().completed).toBe(false);

    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
    const result = run.acp.result();
    expect(result).toMatchObject({
      completed: true,
      error: null,
      text: "Both parsers pass the tests.",
      external_session_id: "session-1",
      asked_user: {
        question: "Which parser should I keep?",
        options: ["Recursive descent — Simpler, slower", "Pratt"],
      },
    });
    expect(result.usage).not.toBeNull();
    expect(run.stdinClosed()).toBe(true);
  });

  it("reads several Claude Code questions as one question with each choice kept", () => {
    const run = promptingController("claude_code");
    run.receive({
      ...CLAUDE_ASK_ONE,
      params: {
        ...CLAUDE_ASK_ONE.params,
        message: "Please answer the following questions.",
        requestedSchema: {
          type: "object",
          properties: {
            question_0: { type: "string", title: "Parser", description: "Which parser should I keep?", oneOf: [{ const: "Pratt", title: "Pratt" }] },
            question_0_custom: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } } },
            question_1: { type: "array", title: "Targets", description: "Which targets matter?", items: { anyOf: [{ const: "wasm", title: "wasm" }, { const: "native", title: "native" }] } },
          },
        },
      },
    });
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } });
    expect(run.acp.result().asked_user).toEqual({
      question: "Please answer the following questions.\n\n1. Which parser should I keep?\n   - Pratt\n\n2. Which targets matter?\n   - wasm\n   - native",
      options: [],
    });
  });

  it("cancels a Codex request_user_input and takes the question from the field, not the generic message", () => {
    const run = promptingController("codex_cli");
    run.receive(CODEX_REQUEST_USER_INPUT);
    expect(run.sent.find((message) => message.id === 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { action: "cancel" } });
    expect(run.sent.some((message) => message.method === "session/cancel")).toBe(true);
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } });
    expect(run.acp.result()).toMatchObject({
      completed: true,
      error: null,
      asked_user: {
        question: "Which database should the cache use?",
        options: [
          "SQLite",
          "Postgres — Shared with the app",
          "None of the above — Provide a different answer in the note field.",
        ],
      },
    });
  });

  it("treats a Claude Code permission request that names no tool call as a question", () => {
    const run = promptingController("claude_code");
    run.receive({
      jsonrpc: "2.0",
      id: 11,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        options: [
          { optionId: "a", kind: "allow_once", name: "Keep both" },
          { optionId: "b", kind: "allow_once", name: "Delete the old one" },
        ],
      },
    });
    expect(run.sent.find((message) => message.id === 11)).toEqual({
      jsonrpc: "2.0", id: 11, result: { outcome: { outcome: "cancelled" } },
    });
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } });
    expect(run.acp.result()).toMatchObject({
      completed: true,
      error: null,
      asked_user: { options: ["Keep both", "Delete the old one"] },
    });
  });

  it("still auto-approves a tool permission and ends the turn normally", () => {
    const run = promptingController("claude_code");
    run.receive({
      jsonrpc: "2.0",
      id: 12,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "toolu_02", kind: "execute", title: "pnpm test", rawInput: { command: "pnpm test" } },
        options: [
          { kind: "reject_once", name: "Deny", optionId: "reject" },
          { kind: "allow_once", name: "Allow Once", optionId: "allow" },
          { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        ],
      },
    });
    expect(run.sent.find((message) => message.id === 12)).toEqual({
      jsonrpc: "2.0", id: 12, result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(run.sent.some((message) => message.method === "session/cancel")).toBe(false);
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
    expect(run.acp.result()).toMatchObject({ completed: true, error: null, asked_user: null });
  });

  it("still fails a turn that ends early without having asked anything", () => {
    const run = promptingController("claude_code");
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } });
    expect(run.acp.result().error).toContain("stop reason 'cancelled'");
  });

  it("keeps the first question and cancels whatever the runtime asks while the cancel lands", () => {
    const run = promptingController("codex_cli");
    run.receive(CODEX_REQUEST_USER_INPUT);
    run.receive({
      jsonrpc: "2.0",
      id: 13,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "call-1", kind: "execute" },
        options: [{ optionId: "allow", kind: "allow_once" }],
      },
    });
    expect(run.sent.find((message) => message.id === 13)).toEqual({
      jsonrpc: "2.0", id: 13, result: { outcome: { outcome: "cancelled" } },
    });
    expect(run.sent.filter((message) => message.method === "session/cancel")).toHaveLength(1);
    // A runtime that answers the cancelled prompt with an error still completes.
    run.receive({ jsonrpc: "2.0", id: 4, error: { code: -32800, message: "Request cancelled" } });
    expect(run.acp.result()).toMatchObject({
      completed: true,
      error: null,
      asked_user: { question: "Which database should the cache use?" },
    });
  });

  it("treats any other interactive method as a question, on any runtime", () => {
    const run = promptingController("opencode");
    run.receive({ jsonrpc: "2.0", id: 21, method: "_opencode/question", params: { sessionId: "session-1", message: "Overwrite the lockfile?" } });
    const refusal = run.sent.find((message) => message.id === 21) as { error?: { code: number } } | undefined;
    expect(refusal?.error?.code).toBe(-32601);
    run.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } });
    expect(run.acp.result()).toMatchObject({
      completed: true,
      error: null,
      asked_user: { question: "Overwrite the lockfile?", options: [] },
    });
  });

  it("still refuses and fails a client-capability method the runtime was never offered", () => {
    const run = promptingController("claude_code");
    run.receive({ jsonrpc: "2.0", id: 22, method: "terminal/create", params: { sessionId: "session-1", command: "ls" } });
    expect(run.acp.result().error).toContain("unsupported interactive method 'terminal/create'");
    expect(run.acp.result().asked_user).toBeNull();
  });
});
