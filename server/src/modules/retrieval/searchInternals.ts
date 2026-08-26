import { excerptAroundQuery } from "./normalize.js";
import type {
  CreateSafety,
  EvidenceContract,
  RetrievalSearchResult,
  RetrievalTrace,
  RevalidatedObject,
  ScoredCandidate,
  SearchCandidate,
} from "./types.js";

/**
 * Pure, stateless helpers for the retrieval search pipeline: RRF fusion, the
 * over-fetch bound, visibility collection, result shaping, and evidence mapping.
 * Extracted from `searchService` so the service file stays focused on the
 * orchestration + the arm SQL. Nothing here touches the database or `this`.
 */

const RRF_K = 60;
// Each arm over-fetches before live visibility revalidation so that readable
// results are not crowded out by private/cross-space candidates that will be
// dropped. Bounded so a hostile query cannot force an unbounded scan.
const ARM_OVERFETCH = 5;
const ARM_FETCH_MIN = 50;
const ARM_FETCH_MAX = 200;

export function armFetchLimit(maxResults: number): number {
  return Math.min(ARM_FETCH_MAX, Math.max(ARM_FETCH_MIN, maxResults * ARM_OVERFETCH));
}

// Embedding dimensions that have a `halfvec` HNSW ANN index in the schema (W5).
// The vector arm emits a constant-dimension halfvec cosine query for these so the
// planner can use the partial index; other dimensions fall back to the exact
// `vector` scan. MUST stay in sync with the ix_retrieval_chunks_embedding_hnsw_*
// partial indexes in migrations/0001_baseline.sql.
export const ANN_HALFVEC_DIMENSIONS: ReadonlySet<number> = new Set([2560]);

// Multi-hop graph recall bounds. Seeds are capped so a broad query cannot turn
// the traversal into a full-graph walk; hops are capped so relational recall
// stays bounded and cheap. Each hop still revalidates (invariant 4).
export const GRAPH_MAX_HOPS = 2;
const GRAPH_SEED_CAP = 12;

/**
 * Pick the graph-traversal seeds from the direct-match candidates: the ones the
 * viewer can actually read (present and truthy in the revalidation cache),
 * deduped by object, in their given order (exact first, then lexical/vector),
 * bounded to a small cap. Seeding only from visible matches is invariant 4 — a
 * non-visible seed must never expand to surface its neighbors.
 */
export function pickGraphSeeds(
  candidates: readonly SearchCandidate[],
  cache: Map<string, RevalidatedObject | null>,
  cap: number = GRAPH_SEED_CAP,
): SearchCandidate[] {
  const seeds: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cache.get(key)) continue; // not readable ⇒ never a seed
    seeds.push(candidate);
    if (seeds.length >= cap) break;
  }
  return seeds;
}

export function candidateKey(candidate: Pick<SearchCandidate, "objectType" | "objectId">): string {
  return `${candidate.objectType}:${candidate.objectId}`;
}

/**
 * Per-object max-pool WITHIN one arm: collapse an arm's rows to the single
 * best-ranked (lowest rank) candidate per object, then re-rank 1..n. Without
 * this, an object with many weak chunks contributes once per matching chunk to
 * that arm's RRF mass, so chunk COUNT — not relevance — inflates its fused score
 * and can crowd out a focused named object. Pooling is per-arm on purpose:
 * cross-arm fusion still sees one entry per object per arm, so genuine multi-arm
 * agreement is preserved while intra-arm chunk multiplicity is removed.
 */
export function maxPoolPerObject(candidates: SearchCandidate[]): SearchCandidate[] {
  const best = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = best.get(key);
    if (!existing || candidate.rank < existing.rank) best.set(key, candidate);
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank || a.objectId.localeCompare(b.objectId))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function fuseCandidates(candidates: SearchCandidate[]): ScoredCandidate[] {
  const byRef = new Map<string, ScoredCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const score = 1 / (RRF_K + Math.max(1, candidate.rank));
    const existing = byRef.get(key);
    if (!existing) {
      byRef.set(key, { ...candidate, score });
      continue;
    }
    existing.score += score;
    existing.matchedFields = [...new Set([...existing.matchedFields, ...candidate.matchedFields])];
    if (evidencePriority(candidate.evidence) > evidencePriority(existing.evidence)) {
      existing.evidence = candidate.evidence;
    }
    // Preserve the strongest vector similarity across the merged arms so the
    // post-RRF cosine blend (§2.3) survives even when a higher-priority arm's
    // evidence overwrites the vector evidence.
    if (typeof candidate.vectorSimilarity === "number") {
      existing.vectorSimilarity = Math.max(existing.vectorSimilarity ?? 0, candidate.vectorSimilarity);
    }
  }
  return [...byRef.values()]
    .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

// Adaptive-return bounds (§2.4). Trim only — never grows the set. Keeps at least
// the first `MIN_KEEP` visible candidates, then cuts at the first sharp score
// cliff (next score below `CLIFF_RATIO` of the previous one), so a precise answer
// is not padded with a weak tail. Operates only on the already-visible set.
const ADAPTIVE_RETURN_MIN_KEEP = 3;
const ADAPTIVE_RETURN_CLIFF_RATIO = 0.5;

/**
 * Conservative adaptive return (§2.4): shrink the visible list at the first sharp
 * score cliff. Access-safe — reads only the visible candidates' own scores, never
 * adds candidates, never reads hidden objects. Records aggregate trace only.
 */
export function applyAdaptiveReturn(
  visible: ScoredCandidate[],
  trace: RetrievalTrace,
  minKeep: number = ADAPTIVE_RETURN_MIN_KEEP,
  cliffRatio: number = ADAPTIVE_RETURN_CLIFF_RATIO,
): ScoredCandidate[] {
  if (visible.length <= minKeep) {
    trace.adaptive_return = { applied: false, trimmed: 0 };
    return visible;
  }
  let cut = visible.length;
  for (let i = minKeep; i < visible.length; i += 1) {
    const prev = visible[i - 1]!.score;
    const here = visible[i]!.score;
    if (prev > 0 && here < prev * cliffRatio) {
      cut = i;
      break;
    }
  }
  const trimmed = visible.length - cut;
  trace.adaptive_return = { applied: trimmed > 0, trimmed };
  return trimmed > 0 ? visible.slice(0, cut) : visible;
}

export function collectVisibleCandidates(
  candidates: ScoredCandidate[],
  cache: Map<string, RevalidatedObject | null>,
  trace: RetrievalTrace,
): ScoredCandidate[] {
  const visible: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const revalidated = cache.get(candidateKey(candidate));
    if (!revalidated) {
      continue;
    }
    visible.push(candidate);
  }
  return visible;
}

/**
 * Shape the final, viewer-facing results from a ranked+revalidated candidate list.
 * Snippet/title come only from the live-revalidated content. `excludeKeys` drops
 * candidates already returned elsewhere (used so the rewrite section omits primary
 * hits). Bounded to `maxResults`.
 */
export function buildItems(
  visible: ScoredCandidate[],
  cache: Map<string, RevalidatedObject | null>,
  query: string,
  maxResults: number,
  includeTrace: boolean | undefined,
  excludeKeys?: Set<string>,
): RetrievalSearchResult[] {
  const items: RetrievalSearchResult[] = [];
  for (const candidate of visible) {
    if (excludeKeys?.has(candidateKey(candidate))) continue;
    const revalidated = cache.get(candidateKey(candidate));
    if (!revalidated) continue;
    const result = resultFromCandidate(candidate, revalidated.title, revalidated.text, query);
    items.push(includeTrace ? { ...result, trace: { arms: candidate.matchedFields } } : result);
    if (items.length >= maxResults) break;
  }
  return items;
}

export function resultFromCandidate(
  candidate: SearchCandidate & { score?: number },
  title: string,
  text: string | null,
  query: string,
): RetrievalSearchResult {
  // Snippet comes only from the live-revalidated text, never the pre-revalidation
  // projection snippet: an adapter may intentionally return null text for a
  // visible-but-redacted object (e.g. a summary_only memory shown to a non-owner),
  // and falling back to the indexed chunk would leak the content it redacted.
  const snippet = text ? excerptAroundQuery(text, query) : null;
  // Surface the candidate's source connection ids (it already passed the source
  // read gate, so the viewer may see them). This lets durable brief artifacts
  // record their source provenance so a later non-owner attachment can be
  // re-gated against current source policy (immutable snapshots stay immutable).
  const sourceRefs = (candidate.sourceConnectionIds ?? [])
    .filter((id) => Boolean(id))
    .map((id) => ({ source_connection_id: id }));
  return {
    object_type: candidate.objectType,
    object_id: candidate.objectId,
    object_profile: candidate.objectProfile ?? null,
    object_profile_label: candidate.objectProfileLabel ?? null,
    title,
    snippet,
    score: Number(candidate.score ?? (1 / (RRF_K + candidate.rank)).toFixed(6)),
    evidence: candidate.evidence,
    create_safety: createSafetyForEvidence(candidate.evidence),
    matched_fields: candidate.matchedFields,
    ...(sourceRefs.length ? { source_refs: sourceRefs } : {}),
  };
}

export function evidenceForAlias(field: string | null, matchedText: string | null): EvidenceContract {
  if (field === "title") {
    return {
      kind: "exact_title_match",
      field: "title",
      matched_text: matchedText ?? undefined,
      source: "exact",
      confidence: 1,
    };
  }
  if (field === "slug") {
    return {
      kind: "slug_match",
      field: "slug",
      matched_text: matchedText ?? undefined,
      source: "exact",
      confidence: 0.95,
    };
  }
  if (field === "url") {
    return {
      kind: "source_url_match",
      field: "uri",
      matched_text: matchedText ?? undefined,
      source: "exact",
      confidence: 1,
    };
  }
  return {
    kind: "alias_hit",
    field: field ?? "alias",
    matched_text: matchedText ?? undefined,
    source: "exact",
    confidence: 0.9,
  };
}

function createSafetyForEvidence(evidence: EvidenceContract): CreateSafety {
  if (
    evidence.kind === "alias_hit" ||
    evidence.kind === "exact_title_match" ||
    evidence.kind === "slug_match" ||
    evidence.kind === "source_url_match"
  ) {
    return "exists";
  }
  if (
    evidence.kind === "lexical_match" ||
    evidence.kind === "vector_match" ||
    evidence.kind === "graph_neighbor"
  ) {
    return "probable_duplicate";
  }
  return "unknown";
}

function evidencePriority(evidence: EvidenceContract): number {
  switch (evidence.kind) {
    case "exact_title_match":
    case "source_url_match":
      return 6;
    case "alias_hit":
    case "slug_match":
      return 5;
    case "graph_neighbor":
      return 4;
    case "lexical_match":
      return 3;
    case "vector_match":
      return 2;
    case "weak_match":
      return 1;
  }
}

/**
 * Bound one rerank candidate's text by the per-item and remaining payload budget
 * (§2.6). Returns the (possibly truncated/empty) text plus whether it was cut.
 * Null in → null out (a redacted object keeps its null text). Truncates only
 * already-visible, already-revalidated text that was going to be sent anyway.
 */
export function boundRerankText(
  text: string | null,
  perItemCap: number,
  payloadCap: number,
  used: number,
): { text: string | null; truncated: boolean } {
  if (text === null) return { text: null, truncated: false };
  let bounded = text;
  let truncated = false;
  if (perItemCap > 0 && bounded.length > perItemCap) {
    bounded = bounded.slice(0, perItemCap);
    truncated = true;
  }
  if (payloadCap > 0) {
    const remaining = Math.max(0, payloadCap - used);
    if (bounded.length > remaining) {
      bounded = bounded.slice(0, remaining);
      truncated = true;
    }
  }
  return { text: bounded, truncated };
}

/**
 * Aggregate-safe score histogram bucket label (§2.8). Reuses the same thresholds
 * as the explain/diagnostics surfaces so telemetry is comparable across stages.
 */
export function scoreBucket(score: number): string {
  if (!Number.isFinite(score)) return "lt_0_25";
  if (score >= 0.75) return "ge_0_75";
  if (score >= 0.5) return "ge_0_50";
  if (score >= 0.25) return "ge_0_25";
  return "lt_0_25";
}

/** Map a pgvector cosine distance (`<=>`, in [0,2]) to a [0,1] similarity. */
export function similarityFromDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
