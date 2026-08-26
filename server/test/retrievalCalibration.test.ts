import { describe, expect, it } from "vitest";
import {
  applyRankingSignals,
  metadataBoostsAllowed,
  newRankingTelemetry,
  rankingBoost,
  DEFAULT_RANKING_SIGNALS,
} from "../src/modules/retrieval/ranking.js";
import {
  applyAdaptiveReturn,
  boundRerankText,
  fuseCandidates,
  scoreBucket,
} from "../src/modules/retrieval/searchInternals.js";
import type { RetrievalTrace, ScoredCandidate, SearchCandidate } from "../src/modules/retrieval/types.js";

const NOW = Date.parse("2026-06-23T00:00:00.000Z");

function scored(over: Partial<ScoredCandidate> & { objectId: string }): ScoredCandidate {
  return {
    objectType: over.objectType ?? "source",
    objectId: over.objectId,
    title: over.title ?? over.objectId,
    snippet: over.snippet ?? null,
    matchedFields: over.matchedFields ?? ["plain_text"],
    evidence: over.evidence ?? { kind: "lexical_match" },
    rank: over.rank ?? 1,
    arm: over.arm ?? "lexical",
    updatedAt: over.updatedAt ?? null,
    score: over.score ?? 0.5,
    vectorSimilarity: over.vectorSimilarity,
  };
}

function emptyTrace(): RetrievalTrace {
  return { arms: {}, dropped: 0, dropped_reasons: {} };
}

describe("§2.2 floor-ratio gating", () => {
  it("gates metadata boosts when a candidate is far below the top score, even above the absolute floor", () => {
    const weak = scored({ objectId: "weak", score: 0.05 }); // > absolute floor 0.01
    // With a top score of 1.0, the 0.15 ratio threshold is 0.15 > 0.05 ⇒ gated.
    expect(metadataBoostsAllowed(weak, DEFAULT_RANKING_SIGNALS, 1)).toBe(false);
    // Above the ratio threshold ⇒ allowed.
    expect(metadataBoostsAllowed(scored({ objectId: "ok", score: 0.2 }), DEFAULT_RANKING_SIGNALS, 1)).toBe(true);
    // Ratio disabled (topScore 0) ⇒ only the absolute floor applies.
    expect(metadataBoostsAllowed(weak, DEFAULT_RANKING_SIGNALS, 0)).toBe(true);
  });

  it("calibrates visible candidates without a hidden high-score topScore", () => {
    const hiddenPrivate = scored({ objectId: "hidden-private", objectType: "source", score: 1 });
    const visiblePlain = scored({ objectId: "visible-plain", objectType: "source", title: "Plain candidate", score: 0.13 });
    const visibleTitle = scored({
      objectId: "visible-title",
      objectType: "source",
      title: "Calibration target",
      score: 0.12,
    });

    const visibleOnlyTelemetry = newRankingTelemetry();
    const visibleOnly = applyRankingSignals(
      [visiblePlain, visibleTitle],
      "calibration",
      NOW,
      DEFAULT_RANKING_SIGNALS,
      visibleOnlyTelemetry,
    );
    expect(visibleOnly.map((candidate) => candidate.objectId)).toEqual(["visible-title", "visible-plain"]);
    expect(visibleOnly[0]!.matchedFields).toContain("title_phrase");
    expect(visibleOnlyTelemetry.boost_attribution.title_phrase).toBe(1);

    const contaminated = applyRankingSignals(
      [hiddenPrivate, visiblePlain, visibleTitle],
      "calibration",
      NOW,
      DEFAULT_RANKING_SIGNALS,
    ).filter((candidate) => candidate.objectId.startsWith("visible-"));
    expect(contaminated.map((candidate) => candidate.objectId)).toEqual(["visible-plain", "visible-title"]);
  });
});

describe("§2.3 post-RRF cosine blend", () => {
  it("lifts a stronger cosine match above an equal-score weaker one and reduces a poor one", () => {
    const ranked = applyRankingSignals(
      [
        scored({ objectId: "near", score: 0.5, vectorSimilarity: 0.9 }),
        scored({ objectId: "far", score: 0.5, vectorSimilarity: 0.1 }),
      ],
      "",
      NOW,
      DEFAULT_RANKING_SIGNALS,
    );
    expect(ranked.map((c) => c.objectId)).toEqual(["near", "far"]);
  });

  it("is a no-op for candidates with no vector hit", () => {
    expect(rankingBoost(scored({ objectId: "n", objectType: "memory_entry" }), "", NOW, DEFAULT_RANKING_SIGNALS)).toBe(1);
    const blended = rankingBoost(
      scored({ objectId: "v", objectType: "memory_entry", vectorSimilarity: 1 }),
      "",
      NOW,
      DEFAULT_RANKING_SIGNALS,
    );
    expect(blended).toBeCloseTo(1.05, 5); // 1 + 0.1*(1 - 0.5)
  });

  it("fusion preserves the strongest vector similarity across merged arms", () => {
    const lexical: SearchCandidate = { ...scored({ objectId: "x" }), arm: "lexical", rank: 1 };
    const vector: SearchCandidate = {
      ...scored({ objectId: "x", evidence: { kind: "vector_match" }, vectorSimilarity: 0.8 }),
      arm: "vector",
      rank: 1,
    };
    const fused = fuseCandidates([lexical, vector]);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.vectorSimilarity).toBe(0.8);
  });
});

describe("§2.8 telemetry / boost attribution", () => {
  it("records aggregate boost-axis fire counts without ids/titles", () => {
    const telemetry = newRankingTelemetry();
    applyRankingSignals(
      [
        scored({ objectId: "k", objectType: "knowledge_item", score: 0.5, updatedAt: "2026-06-22T00:00:00.000Z" }),
        scored({ objectId: "weak", score: 0.0001 }),
      ],
      "",
      NOW,
      DEFAULT_RANKING_SIGNALS,
      telemetry,
    );
    expect(telemetry.boost_attribution.source_tier).toBeGreaterThanOrEqual(1);
    expect(telemetry.boost_attribution.recency).toBeGreaterThanOrEqual(1);
    expect(telemetry.boost_attribution.floor_gated).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(telemetry)).not.toContain("weak"); // no ids leak
  });

  it("buckets scores by the shared thresholds", () => {
    expect(scoreBucket(0.9)).toBe("ge_0_75");
    expect(scoreBucket(0.6)).toBe("ge_0_50");
    expect(scoreBucket(0.3)).toBe("ge_0_25");
    expect(scoreBucket(0.1)).toBe("lt_0_25");
  });
});

describe("§2.4 adaptive return (trim-only)", () => {
  it("trims the tail at a sharp score cliff while keeping the head", () => {
    const trace = emptyTrace();
    const visible = [1, 0.9, 0.8, 0.1, 0.05].map((score, i) => scored({ objectId: `c${i}`, score }));
    const out = applyAdaptiveReturn(visible, trace);
    expect(out.map((c) => c.objectId)).toEqual(["c0", "c1", "c2"]);
    expect(trace.adaptive_return).toEqual({ applied: true, trimmed: 2 });
  });

  it("never trims below the minimum keep and is a no-op without a cliff", () => {
    const trace = emptyTrace();
    const gentle = [0.9, 0.8, 0.75, 0.7, 0.65].map((score, i) => scored({ objectId: `g${i}`, score }));
    const out = applyAdaptiveReturn(gentle, trace);
    expect(out).toHaveLength(5);
    expect(trace.adaptive_return).toEqual({ applied: false, trimmed: 0 });
  });
});

describe("§2.6 rerank payload token budget", () => {
  it("truncates per-item and stops at the remaining payload budget", () => {
    expect(boundRerankText("x".repeat(5000), 2000, 24000, 0)).toEqual({ text: "x".repeat(2000), truncated: true });
    expect(boundRerankText("short", 2000, 24000, 0)).toEqual({ text: "short", truncated: false });
    // Per-item cap 5000 (no cut), but only 1000 of payload budget remains.
    expect(boundRerankText("x".repeat(3000), 5000, 1000, 0)).toEqual({ text: "x".repeat(1000), truncated: true });
    // A redacted (null) text stays null.
    expect(boundRerankText(null, 2000, 24000, 0)).toEqual({ text: null, truncated: false });
  });
});
