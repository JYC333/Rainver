import { describe, expect, it } from "vitest";
import type { ResearchPreviewObservation } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { AdaptiveQueryEvaluator } from "../src/modules/research/queryPlanning/adaptiveQueryEvaluator";
import { researchQueryPolicy } from "../src/modules/research/queryPlanning/queryPolicy";

describe("AdaptiveQueryEvaluator", () => {
  const policy = researchQueryPolicy("openalex", 50);
  const evaluator = new AdaptiveQueryEvaluator();

  it("broadens zero and materially undersupplied results", () => {
    expect(evaluator.evaluate(observation({ hits: 0 }), policy, 1).decision).toBe("broaden");
    expect(evaluator.evaluate(observation({ hits: 5, accessible: 5, lower: 0.2, relevance: 0.3 }), policy, 1).decision).toBe("broaden");
  });

  it("accepts slightly low, high-relevance yield", () => {
    const result = evaluator.evaluate(observation({ hits: 12, accessible: 12, lower: 0.5, relevance: 0.8 }), policy, 1);
    expect(result.decision).toBe("accept");
    expect(result.reason).toContain("slightly below");
  });

  it("accepts a very broad query when relevance is strong and caps downstream pagination", () => {
    const result = evaluator.evaluate(observation({ hits: 20_000, accessible: 10_000, lower: 0.7, relevance: 0.9 }), policy, 1);
    expect(result.decision).toBe("accept");
    expect(result.reason).toContain("broad");
  });

  it("narrows only when overload and low relevance occur together", () => {
    const result = evaluator.evaluate(observation({ hits: 500, accessible: 500, lower: 0.1, relevance: 0.2 }), policy, 1);
    expect(result.decision).toBe("narrow");
  });

  it("stops after the final unsatisfactory attempt and emits a coverage warning", () => {
    const result = evaluator.evaluate(observation({ hits: 0 }), policy, policy.maxAttempts);
    expect(result).toMatchObject({ decision: "stop" });
    expect(result.coverageWarning).toContain(`${policy.maxAttempts} attempts`);
  });

  it("scores an overloaded, low-precision result below a well-scoped one instead of letting a saturated yield win", () => {
    // Real numbers from a production run: an arxiv attempt capped at 2,000
    // accessible hits out of 17,831 total outscored a properly narrowed
    // 60-hit attempt under the old formula (yieldScore saturates at 1.0 once
    // projected yield clears the floor, and the old overload penalty topped
    // out at 0.35 — nowhere near enough to offset that).
    const arxivPolicy = researchQueryPolicy("arxiv", 334);
    const overloaded = evaluator.evaluate(
      observation({ hits: 17_831, accessible: 2_000, lower: 0.174565, relevance: 0.366667 }),
      arxivPolicy,
      2,
    );
    const wellScoped = evaluator.evaluate(
      observation({ hits: 60, accessible: 60, lower: 0.129876, relevance: 0.3 }),
      arxivPolicy,
      arxivPolicy.maxAttempts,
    );
    expect(overloaded.decision).toBe("narrow");
    expect(wellScoped.decision).toBe("stop");
    expect(overloaded.score).toBeLessThan(wellScoped.score);
  });
});

function observation(input: { hits: number; accessible?: number; lower?: number; relevance?: number }): ResearchPreviewObservation {
  return {
    schema_version: "research_preview_observation.v1",
    provider_hit_count: input.hits,
    accessible_hit_count: input.accessible ?? input.hits,
    samples: [],
    relevance_rate: input.relevance ?? 0.8,
    relevance_lower_bound: input.lower ?? 0.6,
    diversity_score: 0.8,
    duplicate_rate: 0,
  };
}
