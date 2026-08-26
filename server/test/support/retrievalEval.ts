import type { RetrievalSearchService } from "../../src/modules/retrieval/index.js";
import type { RetrievalObjectType } from "@rainver/protocol";

/**
 * Reusable recall@k harness for the retrieval substrate. It runs a set of golden
 * query→expected-id cases through a `RetrievalSearchService` and reports recall.
 *
 * Purpose (Phase 2 prerequisite): the deterministic recall arms are gated on
 * this so a ranking change — a source-tier boost, a reranker, a vector arm —
 * cannot silently drop a golden result. The recall arms are deterministic, so
 * curated cases assert exact recall (== 1). Non-deterministic ranking stages
 * (rerank) should assert a tolerance band instead of an exact value.
 */
export interface RecallCase {
  query: string;
  expected: string[];
}

export interface RecallReport {
  recall: number;
  perCase: Array<{ query: string; recall: number; returned: string[] }>;
}

export function recallAtK(returnedIds: readonly string[], expected: readonly string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(returnedIds.slice(0, k));
  const hits = expected.filter((id) => top.has(id)).length;
  return hits / expected.length;
}

/**
 * Fraction of the top-k returned ids that are relevant. A precision/recall pair
 * is how the mode tiers are compared: `exact` should trade recall for precision,
 * `hybrid` the reverse. With no expected ids the case is treated as precise.
 */
export function precisionAtK(returnedIds: readonly string[], expected: readonly string[], k: number): number {
  const top = returnedIds.slice(0, k);
  if (top.length === 0) return 1;
  const relevant = new Set(expected);
  const hits = top.filter((id) => relevant.has(id)).length;
  return hits / top.length;
}

/** Reciprocal of the rank (1-based) of the first relevant id, or 0 if none in the list. */
export function reciprocalRank(returnedIds: readonly string[], expected: readonly string[]): number {
  const relevant = new Set(expected);
  const idx = returnedIds.findIndex((id) => relevant.has(id));
  return idx < 0 ? 0 : 1 / (idx + 1);
}

/**
 * nDCG@k with exponential gain `2^grade - 1`. `graded` maps id→relevance grade
 * (>= 0); ids absent from `graded` contribute zero gain. Normalized by the ideal
 * ordering of the supplied grades, so it lands in [0, 1] (1 when the ideal
 * top-k ordering is achieved).
 */
export function ndcgAtK(returnedIds: readonly string[], graded: Record<string, number>, k: number): number {
  const gain = (grade: number): number => Math.pow(2, Math.max(0, grade)) - 1;
  const dcg = returnedIds
    .slice(0, k)
    .reduce((sum, id, i) => sum + gain(graded[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(graded)
    .map(gain)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
  return ideal === 0 ? 1 : dcg / ideal;
}

/**
 * A graded eval case. `expected` is the binary-relevant set (recall/precision/
 * MRR); `graded` is the optional per-id relevance grade used by nDCG. When
 * `graded` is omitted each expected id is treated as grade 1.
 */
export interface EvalCase {
  query: string;
  expected: string[];
  graded?: Record<string, number>;
}

export interface GradedReport {
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
  perCase: Array<{
    query: string;
    recall: number;
    precision: number;
    rr: number;
    ndcg: number;
    returned: string[];
  }>;
}

export async function runRecallCases(
  search: RetrievalSearchService,
  params: {
    spaceId: string;
    viewerUserId: string;
    objectTypes: RetrievalObjectType[];
    mode?: "exact" | "lexical" | "hybrid" | "hybrid_rerank";
    rewrite?: boolean;
  },
  cases: readonly RecallCase[],
  k: number,
): Promise<RecallReport> {
  const perCase: RecallReport["perCase"] = [];
  for (const testCase of cases) {
    const response = await search.search({
      spaceId: params.spaceId,
      viewerUserId: params.viewerUserId,
      objectTypes: params.objectTypes,
      query: testCase.query,
      maxResults: k,
      mode: params.mode,
      rewrite: params.rewrite,
    });
    const returned = response.items.map((item) => item.object_id);
    perCase.push({ query: testCase.query, recall: recallAtK(returned, testCase.expected, k), returned });
  }
  const recall = perCase.length
    ? perCase.reduce((sum, entry) => sum + entry.recall, 0) / perCase.length
    : 1;
  return { recall, perCase };
}

/**
 * Graded eval runner: runs each case through the service and reports the full
 * metric set (recall / precision / MRR / nDCG @k). Unlike `runRecallCases` (which
 * gates the deterministic arms at exact recall == 1), this is for the
 * retrieval eval benches that track graded quality with tolerance bands —
 * NamedThing, relational, staleness, and per-mode precision/recall comparisons.
 */
export async function runGradedCases(
  search: RetrievalSearchService,
  params: {
    spaceId: string;
    viewerUserId: string;
    objectTypes: RetrievalObjectType[];
    mode?: "exact" | "lexical" | "hybrid" | "hybrid_rerank";
    rewrite?: boolean;
  },
  cases: readonly EvalCase[],
  k: number,
): Promise<GradedReport> {
  const perCase: GradedReport["perCase"] = [];
  for (const testCase of cases) {
    const response = await search.search({
      spaceId: params.spaceId,
      viewerUserId: params.viewerUserId,
      objectTypes: params.objectTypes,
      query: testCase.query,
      maxResults: k,
      mode: params.mode,
      rewrite: params.rewrite,
    });
    const returned = response.items.map((item) => item.object_id);
    const graded = testCase.graded ?? Object.fromEntries(testCase.expected.map((id) => [id, 1]));
    perCase.push({
      query: testCase.query,
      recall: recallAtK(returned, testCase.expected, k),
      precision: precisionAtK(returned, testCase.expected, k),
      rr: reciprocalRank(returned, testCase.expected),
      ndcg: ndcgAtK(returned, graded, k),
      returned,
    });
  }
  const mean = (pick: (entry: GradedReport["perCase"][number]) => number): number =>
    perCase.length ? perCase.reduce((sum, entry) => sum + pick(entry), 0) / perCase.length : 1;
  return {
    recall: mean((entry) => entry.recall),
    precision: mean((entry) => entry.precision),
    mrr: mean((entry) => entry.rr),
    ndcg: mean((entry) => entry.ndcg),
    perCase,
  };
}
