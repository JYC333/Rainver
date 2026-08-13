import { describe, expect, it } from "vitest";
import { promptBudgetCharsFor } from "../src/modules/sources/postProcessing/service";

// A screening batch is trimmed to fit the prompt. The budget used to be a flat
// 48k characters — a figure from when every model was assumed to have a ~16k
// window — so a sixteen-item intake was cut to four items per run. The trim is
// silent, so the leftovers returned as fresh recovery batches and the reviewer
// was asked to approve the same intake again.
describe("promptBudgetCharsFor", () => {
  it("scales with the model's real context window", () => {
    // MiniMax-M3: 512k window, 131k output reserve → ~380k tokens for prompt.
    const budget = promptBudgetCharsFor("MiniMax-M3");
    expect(budget).toBeGreaterThan(100_000);
    // Enough for a sixteen-item intake at ~7k characters per item.
    expect(budget).toBeGreaterThan(16 * 7_000);
  });

  it("keeps the conservative floor for unknown models and missing configuration", () => {
    expect(promptBudgetCharsFor("some-local-model")).toBe(48_000);
    expect(promptBudgetCharsFor(null)).toBe(48_000);
  });

  it("never exceeds a third of the window, so a byte-counted token estimate cannot overflow it", () => {
    for (const model of ["MiniMax-M3", "MiniMax-M2.7", "claude-opus-5", "gpt-4o"]) {
      expect(promptBudgetCharsFor(model) * 3).toBeLessThanOrEqual(1_000_000);
    }
  });
});
