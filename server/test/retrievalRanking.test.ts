import { describe, expect, it } from "vitest";
import {
  applyRankingSignals,
  metadataBoostsAllowed,
  rankingBoost,
  DEFAULT_RANKING_SIGNALS,
  linkTypeForCandidate,
} from "../src/modules/retrieval/ranking";
import type { ScoredCandidate } from "../src/modules/retrieval/types";

const NOW = Date.parse("2026-06-23T00:00:00.000Z");

function cand(over: Partial<ScoredCandidate> & { objectId: string }): ScoredCandidate {
  return {
    objectType: over.objectType ?? "knowledge_item",
    objectId: over.objectId,
    title: over.title ?? over.objectId,
    snippet: over.snippet ?? null,
    matchedFields: over.matchedFields ?? ["plain_text"],
    evidence: over.evidence ?? { kind: "lexical_match" },
    rank: over.rank ?? 1,
    arm: over.arm ?? "lexical",
    updatedAt: over.updatedAt ?? null,
    score: over.score ?? 0.5,
  };
}

function order(candidates: ScoredCandidate[], query = ""): string[] {
  return applyRankingSignals(candidates, query, NOW, DEFAULT_RANKING_SIGNALS).map((c) => c.objectId);
}

describe("retrieval ranking signals", () => {
  it("source-tier lifts a higher-tier object above an equal-score lower-tier one", () => {
    expect(
      order([
        cand({ objectId: "src", objectType: "source", score: 0.5 }),
        cand({ objectId: "know", objectType: "knowledge_item", score: 0.5 }),
      ]),
    ).toEqual(["know", "src"]);
  });

  it("name/title match outranks an equal-score body match", () => {
    expect(
      order([
        cand({ objectId: "body", evidence: { kind: "lexical_match" }, score: 0.5 }),
        cand({ objectId: "name", evidence: { kind: "exact_title_match" }, score: 0.5 }),
      ]),
    ).toEqual(["name", "body"]);
  });

  it("recency lifts a newer object above an equal-score older one", () => {
    expect(
      order([
        cand({ objectId: "old", updatedAt: "2020-01-01T00:00:00.000Z", score: 0.5 }),
        cand({ objectId: "new", updatedAt: "2026-06-22T00:00:00.000Z", score: 0.5 }),
      ]),
    ).toEqual(["new", "old"]);
  });

  it("is access-neutral: a candidate's relative order does not depend on other objects (invariant 2)", () => {
    const a = cand({ objectId: "A", objectType: "source", score: 0.5 });
    const b = cand({ objectId: "B", objectType: "source", score: 0.4 });
    const c = cand({ objectId: "C", objectType: "knowledge_item", score: 0.9, updatedAt: "2026-06-22T00:00:00.000Z" });

    const pair = order([a, b]);
    const trioWithoutC = order([a, b, c]).filter((id) => id !== "C");
    expect(trioWithoutC).toEqual(pair);
  });

  it("title-phrase boost lifts an object whose title contains the query over an equal body match", () => {
    // Both are lexical_match (no exact-title evidence). "named" has the query
    // term in its title; "body" only in its body. Title-phrase boost breaks the tie.
    expect(
      order(
        [
          cand({ objectId: "body", title: "Engineering notes", evidence: { kind: "lexical_match" }, score: 0.5 }),
          cand({ objectId: "named", title: "Project Helios", evidence: { kind: "lexical_match" }, score: 0.5 }),
        ],
        "helios",
      ),
    ).toEqual(["named", "body"]);
  });

  it("title-phrase boost is access-neutral and tags the matched field", () => {
    const ranked = applyRankingSignals(
      [cand({ objectId: "named", title: "Project Helios", evidence: { kind: "lexical_match" } })],
      "helios",
      NOW,
      DEFAULT_RANKING_SIGNALS,
    );
    expect(ranked[0]!.matchedFields).toContain("title_phrase");
    // No query ⇒ no title-phrase boost and no tag.
    const noQuery = applyRankingSignals(
      [cand({ objectId: "named", title: "Project Helios", evidence: { kind: "lexical_match" } })],
      "",
      NOW,
      DEFAULT_RANKING_SIGNALS,
    );
    expect(noQuery[0]!.matchedFields).not.toContain("title_phrase");
  });

  it("rankingBoost reads only the candidate's own fields and stays positive", () => {
    const neutral = cand({ objectId: "n", objectType: "memory_entry", evidence: { kind: "lexical_match" }, updatedAt: null });
    expect(rankingBoost(neutral, "", NOW, DEFAULT_RANKING_SIGNALS)).toBe(1);

    const future = cand({ objectId: "f", updatedAt: "2999-01-01T00:00:00.000Z" });
    expect(rankingBoost(future, "", NOW, DEFAULT_RANKING_SIGNALS)).toBeGreaterThan(1);

    const bad = cand({ objectId: "x", updatedAt: "not-a-date" });
    expect(rankingBoost(bad, "", NOW, DEFAULT_RANKING_SIGNALS)).toBeGreaterThan(0);
  });

  it("recencyMaxBoost = 1 disables the recency signal", () => {
    const cfg = {
      ...DEFAULT_RANKING_SIGNALS,
      recencyMaxBoost: 1,
      sourceTier: {},
      linkTypeBoost: {},
      nameMatchBoost: 1,
      titlePhraseBoost: 1,
    };
    const fresh = cand({ objectId: "fresh", updatedAt: "2026-06-22T00:00:00.000Z" });
    expect(rankingBoost(fresh, "", NOW, cfg)).toBe(1);
  });

  it("relation-type weighting is access-neutral and explained on the candidate", () => {
    const ranked = applyRankingSignals(
      [
        cand({
          objectId: "related",
          evidence: { kind: "graph_neighbor", field: "related_to" },
          matchedFields: ["retrieval_edge", "relation:related_to"],
          score: 0.5,
        }),
        cand({
          objectId: "support",
          evidence: { kind: "graph_neighbor", field: "supports" },
          matchedFields: ["retrieval_edge", "relation:supports"],
          score: 0.5,
        }),
      ],
      "",
      NOW,
      DEFAULT_RANKING_SIGNALS,
    );

    expect(ranked.map((c) => c.objectId)).toEqual(["support", "related"]);
    expect(ranked[0]!.matchedFields).toContain("relation_weight:supports");
    expect(linkTypeForCandidate(ranked[0]!)).toBe("supports");
  });

  it("metadata boosts are floor-gated so weak candidates cannot win on metadata alone", () => {
    const weakSupport = cand({
      objectId: "weak-support",
      evidence: { kind: "graph_neighbor", field: "supports" },
      score: 0.0098,
    });
    const plain = cand({ objectId: "plain", score: 0.01 });

    expect(metadataBoostsAllowed(weakSupport, DEFAULT_RANKING_SIGNALS)).toBe(false);
    expect(rankingBoost(weakSupport, "", NOW, DEFAULT_RANKING_SIGNALS)).toBe(1);
    expect(order([weakSupport, plain])).toEqual(["plain", "weak-support"]);
  });
});
