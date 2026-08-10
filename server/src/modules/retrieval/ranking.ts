import type { RetrievalObjectType } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { normalizeTextForSearch } from "./normalize";
import type { EvidenceKind, ScoredCandidate } from "./types";

/**
 * Deterministic ranking signals applied after RRF fusion (Phase 2, step 7).
 *
 * Every signal here is **access-neutral**: it is computed only from the
 * candidate's OWN canonical metadata/evidence — its object type, its own match
 * kind, its own surfaced relation type, its own `updated_at`, whether the query
 * phrase appears in its OWN title, and its own fused score for the floor gate.
 * None reads any other object, so a boost can never reveal the existence or
 * scale of objects the viewer cannot read (invariant 2). Cross-object signals
 * (backlink / graph degree, co-citation) are intentionally deferred because they
 * would require counting edges from objects that may be invisible to the viewer —
 * making them access-safe needs per-viewer visible-edge counting, a separate task.
 *
 * Weights are conservative placeholders. Real tuning needs real relevance
 * signal (usage logs); until then these only mildly reorder and never gate.
 */
export interface RankingSignalConfig {
  /** Per-object-type multiplier (source/canonical tier). Missing type = 1. */
  sourceTier: Partial<Record<RetrievalObjectType, number>>;
  /** Per relation-type multiplier for graph/relational candidates. Missing type = 1. */
  linkTypeBoost: Partial<Record<string, number>>;
  /** Candidate fused score floor before metadata boosts may apply. 0 disables. */
  metadataBoostFloor: number;
  /**
   * Floor-ratio gate (§2.2): metadata boosts also require the candidate's fused
   * score to be at least this fraction of the TOP fused score of the visible set.
   * 0 disables. The absolute `metadataBoostFloor` remains as a secondary guard.
   * `topScore` is the max over already-revalidated/visible candidates only, so it
   * never leaks a hidden object's existence — it just makes the floor adapt to the
   * result-set scale instead of being a fixed absolute number.
   */
  metadataBoostTopRatio: number;
  /** Multiplier when the match is a name/title/slug/alias/url hit. */
  nameMatchBoost: number;
  /**
   * Multiplier when the (normalized) query phrase is contained in the
   * candidate's own (normalized) title. Complements `nameMatchBoost` for the
   * NamedThing case where a query term appears in the title but the match
   * arm was lexical/vector (no exact-title evidence). 1 disables it.
   */
  titlePhraseBoost: number;
  /** Recency half-life in days (older → factor decays toward 1). */
  recencyHalfLifeDays: number;
  /** Max recency multiplier for a brand-new object (1 disables recency). */
  recencyMaxBoost: number;
  /**
   * Deterministic post-RRF cosine blend strength α (§2.3). For a candidate that
   * had a vector hit, `score *= 1 + α·(cosineSim − 0.5)` using the candidate's OWN
   * best-chunk query/chunk cosine similarity (access-safe — reads only its own
   * embedding vs the query). 0 disables. Kept small so it reorders near-ties
   * rather than gating eligibility, and it is NOT floor-gated (it is a relevance
   * signal, not a metadata boost).
   */
  cosineBlendAlpha: number;
}

export const DEFAULT_RANKING_SIGNALS: RankingSignalConfig = {
  sourceTier: { knowledge_item: 1.06, project_public_summary: 0.98 },
  linkTypeBoost: {
    supports: 1.07,
    references: 1.06,
    derived_from: 1.05,
    related_to: 1.02,
  },
  metadataBoostFloor: 0.01,
  metadataBoostTopRatio: 0.15,
  nameMatchBoost: 1.08,
  titlePhraseBoost: 1.1,
  recencyHalfLifeDays: 90,
  recencyMaxBoost: 1.08,
  cosineBlendAlpha: 0.1,
};

/**
 * Aggregate-safe ranking telemetry (§2.8). Counts how often each boost axis
 * fired and how many candidates were gated off by the floor/ratio — never any
 * object id, title, query, or snippet. Populated by `applyRankingSignals` when a
 * sink is passed; surfaced only as aggregate `trace.boost_attribution`.
 */
export interface RankingTelemetry {
  boost_attribution: Record<string, number>;
}

export function newRankingTelemetry(): RankingTelemetry {
  return { boost_attribution: {} };
}

function recordAxis(telemetry: RankingTelemetry | undefined, axis: string): void {
  if (!telemetry) return;
  telemetry.boost_attribution[axis] = (telemetry.boost_attribution[axis] ?? 0) + 1;
}

const NAME_MATCH_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  "exact_title_match",
  "slug_match",
  "alias_hit",
  "source_url_match",
]);

/**
 * Whether the normalized query phrase occurs in the candidate's normalized
 * title. Access-neutral: reads only the candidate's own title. An empty query
 * never matches (so create-safety / blank queries get no spurious boost).
 */
export function titlePhraseMatches(title: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false;
  return normalizeTextForSearch(title).includes(normalizedQuery);
}

export function linkTypeForCandidate(candidate: ScoredCandidate): string | null {
  if (candidate.evidence.kind !== "graph_neighbor") return null;
  const linkType = candidate.evidence.field?.trim();
  return linkType || null;
}

export function metadataBoostsAllowed(
  candidate: ScoredCandidate,
  cfg: RankingSignalConfig,
  topScore = 0,
): boolean {
  if (cfg.metadataBoostFloor > 0 && candidate.score < cfg.metadataBoostFloor) return false;
  if (cfg.metadataBoostTopRatio > 0 && topScore > 0 && candidate.score < topScore * cfg.metadataBoostTopRatio) {
    return false;
  }
  return true;
}

/**
 * Access-neutral boost multiplier for one candidate. Reads only the candidate's
 * own fields (see module note). `normalizedQuery` is the already-normalized
 * query phrase, shared across the batch. `topScore` is the visible set's top
 * fused score for the floor-ratio gate (0 disables it). Always returns a positive
 * finite value. When `telemetry` is provided, each fired axis (and the floor gate)
 * is counted aggregate-only.
 */
export function rankingBoost(
  candidate: ScoredCandidate,
  normalizedQuery: string,
  nowMs: number,
  cfg: RankingSignalConfig,
  topScore = 0,
  telemetry?: RankingTelemetry,
): number {
  let boost = 1;
  if (metadataBoostsAllowed(candidate, cfg, topScore)) {
    const tier = cfg.sourceTier[candidate.objectType] ?? 1;
    if (tier !== 1) { boost *= tier; recordAxis(telemetry, "source_tier"); }
    if (cfg.nameMatchBoost !== 1 && NAME_MATCH_KINDS.has(candidate.evidence.kind)) {
      boost *= cfg.nameMatchBoost;
      recordAxis(telemetry, "name_match");
    }
    const linkType = linkTypeForCandidate(candidate);
    if (linkType) {
      const relationBoost = cfg.linkTypeBoost[linkType] ?? 1;
      if (relationBoost !== 1) { boost *= relationBoost; recordAxis(telemetry, "relation_weight"); }
    }
    if (cfg.titlePhraseBoost !== 1 && titlePhraseMatches(candidate.title, normalizedQuery)) {
      boost *= cfg.titlePhraseBoost;
      recordAxis(telemetry, "title_phrase");
    }
    const recency = recencyFactor(candidate.updatedAt, nowMs, cfg);
    if (recency !== 1) { boost *= recency; recordAxis(telemetry, "recency"); }
  } else {
    recordAxis(telemetry, "floor_gated");
  }
  // Cosine blend is a relevance signal, not a metadata boost, so it applies even
  // when the metadata floor gated the candidate off (§2.3).
  const blend = cosineBlendFactor(candidate, cfg);
  if (blend !== 1) { boost *= blend; recordAxis(telemetry, "cosine_blend"); }
  return boost > 0 && Number.isFinite(boost) ? boost : 1;
}

/**
 * Post-RRF cosine blend factor from the candidate's own vector similarity (§2.3).
 * Returns 1 (no-op) for candidates with no vector hit or when α is disabled.
 */
function cosineBlendFactor(candidate: ScoredCandidate, cfg: RankingSignalConfig): number {
  if (cfg.cosineBlendAlpha <= 0) return 1;
  const sim = candidate.vectorSimilarity;
  if (typeof sim !== "number" || !Number.isFinite(sim)) return 1;
  const clamped = Math.max(0, Math.min(1, sim));
  return 1 + cfg.cosineBlendAlpha * (clamped - 0.5);
}

function recencyFactor(updatedAt: string | null, nowMs: number, cfg: RankingSignalConfig): number {
  if (cfg.recencyMaxBoost <= 1 || cfg.recencyHalfLifeDays <= 0 || !updatedAt) return 1;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return 1;
  const ageDays = (nowMs - updatedMs) / 86_400_000;
  if (ageDays <= 0) return cfg.recencyMaxBoost; // future/now → freshest
  const decay = Math.pow(0.5, ageDays / cfg.recencyHalfLifeDays); // (0, 1]
  return 1 + (cfg.recencyMaxBoost - 1) * decay;
}

/**
 * Apply ranking signals to fused candidates and re-rank. Deterministic and
 * stable (ties broken by objectId). `query` is the raw search query; it is
 * normalized once and used for the access-neutral title-phrase signal. When the
 * title-phrase signal fires, the candidate is tagged with a `title_phrase`
 * matched field for observability (the candidate's own title, no leak).
 */
export function applyRankingSignals(
  candidates: ScoredCandidate[],
  query: string,
  nowMs: number,
  cfg: RankingSignalConfig = DEFAULT_RANKING_SIGNALS,
  telemetry?: RankingTelemetry,
): ScoredCandidate[] {
  const normalizedQuery = normalizeTextForSearch(query);
  // Top fused score over the (visible) input set for the floor-ratio gate (§2.2).
  const topScore = candidates.reduce((max, candidate) => Math.max(max, candidate.score), 0);
  return candidates
    .map((candidate) => {
      const metadataAllowed = metadataBoostsAllowed(candidate, cfg, topScore);
      const titlePhrase = metadataAllowed && cfg.titlePhraseBoost !== 1 && titlePhraseMatches(candidate.title, normalizedQuery);
      const linkType = metadataAllowed ? linkTypeForCandidate(candidate) : null;
      const relationWeighted = linkType && (cfg.linkTypeBoost[linkType] ?? 1) !== 1;
      const matchedFields = [
        ...candidate.matchedFields,
        ...(titlePhrase ? ["title_phrase"] : []),
        ...(relationWeighted ? [`relation_weight:${linkType}`] : []),
      ];
      return {
        ...candidate,
        score: candidate.score * rankingBoost(candidate, normalizedQuery, nowMs, cfg, topScore, telemetry),
        matchedFields: [...new Set(matchedFields)],
      };
    })
    .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
