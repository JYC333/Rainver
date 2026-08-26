import type { RetrievalObjectType } from "@agent-space/protocol";
import type { RetrievalEgressPolicy } from "./egress/egressPolicy.js";
import type { ScoredCandidate } from "./types.js";

/**
 * Post-fusion, post-revalidate reranking stage (Phase 2, step 8).
 *
 * The reranker is a NON-deterministic LLM stage. Two contracts make it safe to
 * layer on top of the deterministic recall arms:
 *
 *  - **revalidate-before-rerank (invariant 1).** The engine only ever hands the
 *    reranker candidates that already passed the adapter `revalidate` gate, and
 *    builds their text from the live-revalidated content (never the raw
 *    projection chunk). A redacted object contributes its visible title with
 *    null text. Non-visible candidate content is never sent to a provider.
 *  - **never required for correctness.** The reranker is optional and skippable:
 *    when no reranker is injected, the request opts out, or the provider call
 *    fails, the engine keeps the fused order. `rerank` returning `null` is the
 *    graceful-degradation signal.
 *
 * The engine owns only the access-safe seam + the deterministic apply step; the
 * provider call, prompt, and audit live in the app layer (`modules/retrieval/rerankProvider`).
 */
export interface RerankCandidate {
  objectType: RetrievalObjectType;
  objectId: string;
  /** Live-revalidated title (authoritative, viewer-readable). */
  title: string;
  /** Live-revalidated text. `null` when the adapter redacted it for the viewer. */
  text: string | null;
  sourceConnectionIds?: string[];
}

export interface RerankScore {
  objectType: RetrievalObjectType;
  objectId: string;
  /** Relevance in [0,1]; higher is more relevant. */
  score: number;
}

export interface Reranker {
  /**
   * Score the (already-visible) candidates against the query. `viewerUserId` is
   * the requesting user, passed so the provider-egress audit can attribute the
   * call. Returns `null` to signal the stage is unavailable, disabled, or failed,
   * so the caller keeps the prior order. Implementations must never throw for an
   * ordinary provider failure — they degrade to `null`.
   */
  rerank(
    spaceId: string,
    viewerUserId: string,
    query: string,
    candidates: readonly RerankCandidate[],
    egressPolicy?: RetrievalEgressPolicy,
  ): Promise<RerankScore[] | null>;
}

export interface RerankConfig {
  /** Default top-N window sent to the reranker (bounds the provider payload). */
  window: number;
  /** Hard cap on the window regardless of the requested page size. */
  maxWindow: number;
  /**
   * Token (char-proxy) budget on the rerank payload (§2.6): per-candidate text is
   * truncated to `maxCandidateTextChars`, and once the running total reaches
   * `maxPayloadChars` no further candidate text is sent (those candidates keep
   * their fused order). Bounds the payload in tokens, not just rows. 0 disables.
   */
  maxCandidateTextChars: number;
  maxPayloadChars: number;
}

export const DEFAULT_RERANK_CONFIG: RerankConfig = {
  window: 24,
  maxWindow: 50,
  maxCandidateTextChars: 2000,
  maxPayloadChars: 24000,
};

/** RRF-like constant used to re-score the merged order after reranking. */
const RERANK_RANK_K = 60;

/**
 * Resolve how many of the visible candidates to rerank. Always covers at least
 * the returned page so the final top-k is fully reranked, but is bounded so a
 * hostile query cannot force an unbounded LLM payload.
 */
export function rerankWindowSize(visibleCount: number, maxResults: number, cfg: RerankConfig): number {
  const desired = Math.min(cfg.maxWindow, Math.max(maxResults, cfg.window));
  return Math.min(visibleCount, desired);
}

/**
 * Apply reranker scores to the visible candidates. Deterministic given the
 * scores: the windowed candidates are re-sorted by rerank score (desc), with the
 * prior order as a stable tiebreak; a windowed candidate the reranker omitted
 * sinks within the window but stays above the un-reranked tail. Candidates past
 * the window keep their prior order. Scores are recomputed positionally so the
 * surfaced order is monotonic and a later weak feedback boost still composes.
 */
export function applyRerank(
  candidates: ScoredCandidate[],
  scores: readonly RerankScore[],
  windowSize: number,
): ScoredCandidate[] {
  const scoreByKey = new Map<string, number>();
  for (const s of scores) scoreByKey.set(rerankKey(s), clamp01(s.score));

  const window = candidates.slice(0, windowSize);
  const rest = candidates.slice(windowSize);
  const reordered = window
    .map((candidate, index) => ({
      candidate,
      index,
      rerankScore: scoreByKey.has(rerankKey(candidate)) ? scoreByKey.get(rerankKey(candidate))! : -1,
    }))
    .sort((a, b) => b.rerankScore - a.rerankScore || a.index - b.index)
    .map((entry) => entry.candidate);

  return [...reordered, ...rest].map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    score: 1 / (RERANK_RANK_K + index + 1),
  }));
}

function rerankKey(ref: { objectType: RetrievalObjectType; objectId: string }): string {
  return `${ref.objectType}:${ref.objectId}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
