import { describe, expect, it } from "vitest";
import {
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "./support/retrievalEval.js";

// Pure metric math for the retrieval eval harness. No DB / no provider — these
// guard the scoring functions the benches rely on (recall / precision / MRR / nDCG),
// so a bench threshold means what it says.

describe("retrieval eval metrics", () => {
  describe("recallAtK", () => {
    it("is the fraction of relevant ids found within top-k", () => {
      expect(recallAtK(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
      expect(recallAtK(["a", "x", "y"], ["a", "c"], 3)).toBe(0.5);
      expect(recallAtK(["x", "y", "z", "a"], ["a"], 3)).toBe(0); // a is below k
    });

    it("treats an empty relevant set as fully recalled", () => {
      expect(recallAtK(["a"], [], 3)).toBe(1);
    });
  });

  describe("precisionAtK", () => {
    it("is the fraction of top-k that are relevant", () => {
      expect(precisionAtK(["a", "b", "c", "d"], ["a", "b"], 4)).toBe(0.5);
      expect(precisionAtK(["a", "b"], ["a", "b"], 4)).toBe(1);
    });

    it("treats an empty result as precise", () => {
      expect(precisionAtK([], ["a"], 4)).toBe(1);
    });
  });

  describe("reciprocalRank", () => {
    it("is 1 / rank of the first relevant id", () => {
      expect(reciprocalRank(["x", "a", "b"], ["a"])).toBe(1 / 2);
      expect(reciprocalRank(["a", "b"], ["a", "b"])).toBe(1); // first relevant at rank 1
      expect(reciprocalRank(["a", "b"], ["b"])).toBe(1 / 2); // first relevant "b" at rank 2
    });

    it("is 0 when no relevant id is present", () => {
      expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
    });
  });

  describe("ndcgAtK", () => {
    it("is 1 for the ideal ordering", () => {
      const graded = { a: 3, b: 2, c: 1 };
      expect(ndcgAtK(["a", "b", "c"], graded, 3)).toBeCloseTo(1, 10);
    });

    it("drops below 1 when a lower-grade id is ranked above a higher-grade one", () => {
      const graded = { a: 3, b: 2, c: 1 };
      const swapped = ndcgAtK(["b", "a", "c"], graded, 3);
      expect(swapped).toBeGreaterThan(0);
      expect(swapped).toBeLessThan(1);
    });

    it("ignores ids not present in the graded map (zero gain)", () => {
      const graded = { a: 1 };
      // Only the relevant id at rank 1 ⇒ ideal ⇒ 1.
      expect(ndcgAtK(["a", "noise"], graded, 5)).toBeCloseTo(1, 10);
      // The one relevant id buried under noise scores worse.
      expect(ndcgAtK(["noise", "a"], graded, 5)).toBeLessThan(1);
    });

    it("is 1 when there is no graded relevance to find", () => {
      expect(ndcgAtK(["a"], {}, 3)).toBe(1);
    });
  });
});
