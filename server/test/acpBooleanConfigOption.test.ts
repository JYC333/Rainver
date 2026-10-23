import { describe, expect, it } from "vitest";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";

// Codex advertises `fast-mode` as a boolean option because Rainver's
// `initialize` opts into boolean options. The protocol's set request for such
// an option is `{ type: "boolean", value }`; a bare boolean fails its schema.
function open(input: { value: boolean; current: boolean }) {
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const controller = createCliConversationController({
    runtime_key: "codex_cli", cwd: "/workspace", prompt: "continue",
    session_config: [
      { id: "model", category: "model", type: "select", value: "gpt-6.1-sol" },
      { id: "fast-mode", category: "model_config", type: "boolean", value: input.value },
    ],
  })!;
  const send = (message: Record<string, unknown>) => { sent.push(message); };
  const receive = (message: Record<string, unknown>) => controller.receive(message, send, () => { closed = true; });
  controller.start(send);
  receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  receive({ jsonrpc: "2.0", id: 2, result: {
    sessionId: "session-1",
    configOptions: [
      { id: "model", category: "model", type: "select", currentValue: "gpt-6.1-sol", options: [{ value: "gpt-6.1-sol" }] },
      { id: "fast-mode", category: "model_config", type: "boolean", currentValue: input.current },
    ],
  } });
  return { controller, sent, receive, closed: () => closed };
}

describe("ACP boolean session options", () => {
  it("sets a boolean option with the protocol's boolean discriminator", () => {
    const { sent, receive, controller, closed } = open({ value: true, current: false });
    const request = sent.at(-1) as { method: string; params: Record<string, unknown>; id: number };
    expect(request.method).toBe("session/set_config_option");
    expect(request.params).toEqual({ sessionId: "session-1", configId: "fast-mode", type: "boolean", value: true });
    expect(Object.keys(request.params)).not.toContain("options");
    receive({ jsonrpc: "2.0", id: request.id, result: { configOptions: [
      { id: "fast-mode", category: "model_config", type: "boolean", currentValue: true },
    ] } });
    expect(sent.at(-1)?.method).toBe("session/prompt");
    expect(controller.result().error).toBeNull();
    expect(closed()).toBe(false);
  });

  it("does not send a select option with the boolean discriminator", () => {
    const { sent } = open({ value: false, current: false });
    // Already at the requested value: nothing to set, straight to the prompt.
    expect(sent.at(-1)?.method).toBe("session/prompt");
    for (const message of sent) {
      if (message.method !== "session/set_config_option") continue;
      expect((message.params as Record<string, unknown>).type).toBeUndefined();
    }
  });
});
