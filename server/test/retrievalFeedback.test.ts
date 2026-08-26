import { describe, expect, it } from "vitest";
import { DEFAULT_RETRIEVAL_FEEDBACK, feedbackBoostMultiplier, retrievalFeedbackQueryHash, type FeedbackEventRow } from "../src/modules/retrieval/feedback.js";

const NOW = Date.parse("2026-06-23T00:00:00.000Z");

function event(over: Partial<FeedbackEventRow>): FeedbackEventRow {
  return {
    object_type: "knowledge_item",
    object_id: "item-1",
    signal_type: "opened",
    dwell_ms: null,
    created_at: "2026-06-23T00:00:00.000Z",
    ...over,
  };
}

describe("retrieval feedback ranking", () => {
  it("uses stable normalized query hashes", () => {
    expect(retrievalFeedbackQueryHash("  Alpha   Beta ")).toBe(
      retrievalFeedbackQueryHash("alpha beta"),
    );
  });

  it("treats implicit feedback as weak and bounded", () => {
    const manyOpens = Array.from({ length: 100 }, () => event({ signal_type: "opened" }));
    const multiplier = feedbackBoostMultiplier(manyOpens, NOW);
    expect(multiplier).toBe(1 + DEFAULT_RETRIEVAL_FEEDBACK.maxImplicitBoost);
  });

  it("treats explicit positive feedback as stronger but still bounded", () => {
    const manyPins = Array.from({ length: 100 }, () => event({ signal_type: "pinned" }));
    const multiplier = feedbackBoostMultiplier(manyPins, NOW);
    expect(multiplier).toBe(1 + DEFAULT_RETRIEVAL_FEEDBACK.maxExplicitBoost);
  });

  it("caps the combined feedback boost", () => {
    const events = [
      ...Array.from({ length: 100 }, () => event({ signal_type: "opened" })),
      ...Array.from({ length: 100 }, () => event({ signal_type: "pinned" })),
    ];
    const multiplier = feedbackBoostMultiplier(events, NOW);
    expect(multiplier).toBe(1 + DEFAULT_RETRIEVAL_FEEDBACK.maxTotalBoost);
  });

  it("ignores dwell events below the satisfied-dwell threshold", () => {
    const multiplier = feedbackBoostMultiplier(
      [event({ signal_type: "dwell", dwell_ms: DEFAULT_RETRIEVAL_FEEDBACK.dwellMinMs - 1 })],
      NOW,
    );
    expect(multiplier).toBe(1);
  });

  it("decays older feedback", () => {
    const fresh = feedbackBoostMultiplier([event({ signal_type: "accepted" })], NOW);
    const old = feedbackBoostMultiplier(
      [event({ signal_type: "accepted", created_at: "2026-05-09T00:00:00.000Z" })],
      NOW,
    );
    expect(old).toBeLessThan(fresh);
    expect(old).toBeGreaterThan(1);
  });
});
