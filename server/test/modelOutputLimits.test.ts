import { describe, expect, it } from "vitest";
import { effectiveMaxOutputTokens, recommendedMaxOutputTokens } from "../src/modules/providers/modelOutputLimits.js";
import { DEFAULT_MODEL_CONFIG, defaultModelConfigFor } from "../src/modules/agents/agentRepositoryHelpers.js";

// max_tokens caps the completion, not the context window; reasoning models
// spend their thinking inside the same budget. The registry keeps per-model
// output guidance in one place so agent defaults and provider request
// builders never stamp a generic small cap onto a model that needs more.

describe("recommendedMaxOutputTokens", () => {
  it("returns the official recommendation for MiniMax-M3 in its common spellings", () => {
    expect(recommendedMaxOutputTokens("MiniMax-M3")).toBe(131_072);
    expect(recommendedMaxOutputTokens("minimax-m3")).toBe(131_072);
    expect(recommendedMaxOutputTokens("minimax/MiniMax-M3")).toBe(131_072);
  });

  it("returns null for unknown or empty models", () => {
    expect(recommendedMaxOutputTokens("MiniMax-M2.7")).toBeNull();
    expect(recommendedMaxOutputTokens("claude-sonnet-4-6")).toBeNull();
    expect(recommendedMaxOutputTokens("")).toBeNull();
    expect(recommendedMaxOutputTokens(null)).toBeNull();
  });
});

describe("effectiveMaxOutputTokens", () => {
  it("preserves explicit caller caps below the registered recommendation", () => {
    expect(effectiveMaxOutputTokens("MiniMax-M3", 1800)).toBe(1800);
    expect(effectiveMaxOutputTokens("MiniMax-M3", 8_192)).toBe(8_192);
  });

  it("keeps a caller cap above the recommendation and caller caps for unregistered models", () => {
    expect(effectiveMaxOutputTokens("MiniMax-M3", 200_000)).toBe(200_000);
    expect(effectiveMaxOutputTokens("claude-sonnet-4-6", 1800)).toBe(1800);
  });

  it("falls back to the recommendation alone, or null when neither side has one", () => {
    expect(effectiveMaxOutputTokens("MiniMax-M3", null)).toBe(131_072);
    expect(effectiveMaxOutputTokens("claude-sonnet-4-6", undefined)).toBeNull();
  });
});

describe("defaultModelConfigFor", () => {
  it("stamps the recommended output budget for known models", () => {
    expect(defaultModelConfigFor("MiniMax-M3")).toEqual({ model: "MiniMax-M3", max_tokens: 131_072 });
  });

  it("falls back to the generic default for unknown or missing models", () => {
    expect(defaultModelConfigFor("some-model")).toEqual({ model: "some-model", max_tokens: DEFAULT_MODEL_CONFIG.max_tokens });
    expect(defaultModelConfigFor(null)).toEqual(DEFAULT_MODEL_CONFIG);
  });
});
