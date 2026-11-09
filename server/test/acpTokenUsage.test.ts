import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelUsageFromAcpQuota, usageFromAcp } from "../src/modules/runs/cliRuntimeMeasurement.js";
import { cliUsageScope } from "../src/modules/runs/cliUsageDiagnostics.js";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";

import { setDynamicRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/dynamicSpecs.js";
import { getRuntimeAdapterSpec } from "../src/modules/runtimeAdapters/specs.js";

beforeAll(() => setDynamicRuntimeAdapterSpecs([{
  ...getRuntimeAdapterSpec("codex_cli")!, runtime_key: "acp_antigravity_acp",
}]));
afterAll(() => setDynamicRuntimeAdapterSpecs([]));

const googleUsage = { inputTokens: 20, cachedReadTokens: 80, cachedWriteTokens: 0,
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
  it("reads concrete model versions from wrapper quota rows and separates Codex cached input", () => {
    const meta = { quota: { model_usage: [{ model: "gpt-6.1-sol", token_count: {
      inputTokens: 20, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110,
    } }] } };
    expect(modelUsageFromAcpQuota(meta, "codex_cli")).toEqual([{ model: "gpt-6.1-sol", usage: {
      input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, output_tokens: 10, reasoning_tokens: 5, total_tokens: 110,
    } }]);
    const claude = { quota: { model_usage: ["claude-opus-5-5", "claude-fable-5-1"].map(model => ({ model,
      token_count: { inputTokens: 20, cachedInputTokens: 80, cachedWriteTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 } })) } };
    expect(modelUsageFromAcpQuota(claude, "claude_code").map(row => row.model)).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
    expect(modelUsageFromAcpQuota({ quota: { model_usage: [...meta.quota.model_usage, ...meta.quota.model_usage] } }, "codex_cli")).toEqual([]);
  });
  it("uses the negotiated wrapper version to describe Codex's token scope", () => {
    expect(cliUsageScope("codex_cli", "2.5.0")).toBe("run_attempt_aggregate");
    expect(cliUsageScope("codex_cli", "2.5.1-preview.1")).toBe("unknown");
    expect(cliUsageScope("codex_cli")).toBe("unknown");
  });
  it("attributes a turn by its reported model, preserving version changes and unknown defaults", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-5-6", null]) {
      const controller = createCliConversationController({ runtime_key: "claude_code", prompt: "hello", cwd: "/workspace" })!;
      const noop = () => {};
      controller.start(noop);
      controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "claude", version: "0.101.0" } } }, noop, noop);
      controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1", configOptions: [{ category: "model", currentValue: "default" }] } }, noop, noop);
      if (model) controller.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: {
        sessionUpdate: "usage_update", used: 1, size: 100, _meta: { "_claude/model": model },
      } } }, noop, noop);
      controller.receive({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } }, noop, noop);
      expect(controller.result().model_usage?.map(row => row.model)).toEqual(model ? [model] : []);
      expect(controller.result().acp?.version).toBe("0.101.0");
    }
  });
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
    expect(usageFromAcp(googleUsage)?.input_tokens).toBe(20);
  });
});
