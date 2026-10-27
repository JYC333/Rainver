import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageFromAcp } from "../src/modules/runs/cliRuntimeMeasurement.js";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";

import { setDynamicRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/dynamicSpecs.js";
import { getRuntimeAdapterSpec } from "../src/modules/runtimeAdapters/specs.js";

beforeAll(() => setDynamicRuntimeAdapterSpecs([{
  ...getRuntimeAdapterSpec("codex_cli")!, runtime_key: "acp_antigravity_acp",
}]));
afterAll(() => setDynamicRuntimeAdapterSpecs([]));

const googleUsage = { inputTokens: 100, cachedReadTokens: 80, cachedWriteTokens: 0,
  outputTokens: 10, thoughtTokens: 5, totalTokens: 115 };

function finish(usage: unknown) {
  const controller = createCliConversationController({ runtime_key: "acp_antigravity_acp", cwd: "/workspace", prompt: "hello" })!;
  const send = () => {};
  const receive = (id: number, result: unknown) => controller.receive({ jsonrpc: "2.0", id, result }, send, send);
  controller.start(send);
  receive(1, { protocolVersion: 1 });
  receive(2, { sessionId: "s1", configOptions: [] });
  receive(4, { stopReason: "end_turn", usage });
  return controller.result();
}

describe("ACP token measurement", () => {
  it("completes an Antigravity turn with cached input without counting it twice", () => {
    expect(finish(googleUsage)).toMatchObject({ completed: true, error: null,
      usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10, reasoning_tokens: 5, total_tokens: 115 } });
  });
  it("accepts an explicitly absent optional usage measurement", () => {
    expect(finish(null)).toMatchObject({ completed: true, error: null, usage: null });
  });
  it.each([
    { ...googleUsage, totalTokens: 500 },
    { ...googleUsage, cachedReadTokens: 101 },
    { ...googleUsage, inputTokens: -1 },
    { ...googleUsage, inputTokens: "100" },
    { ...googleUsage, outputTokens: 1.5 },
    {}, "invalid",
  ])("still rejects malformed or inconsistent usage: %j", usage => {
    expect(finish(usage).error).toContain("invalid token usage");
  });
  it("keeps Codex cache separate and reasoning inside output", () => {
    expect(usageFromAcp({ inputTokens: 24620, cachedReadTokens: 87808,
      outputTokens: 1312, thoughtTokens: 946, totalTokens: 113740 }))
      .toMatchObject({ input_tokens: 24620, total_tokens: 113740 });
    expect(usageFromAcp(googleUsage)).toBeNull();
  });
});
