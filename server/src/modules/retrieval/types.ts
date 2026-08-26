import type {
  CreateSafety,
  EvidenceContract,
  EvidenceKind,
  RetrievalObjectType,
  RetrievalSearchMode,
  RetrievalSearchResult,
} from "@agent-space/protocol";

export type {
  CreateSafety,
  EvidenceContract,
  EvidenceKind,
  RetrievalObjectType,
  RetrievalSearchMode,
  RetrievalSearchResult,
};

export interface RetrievalObjectRef {
  objectType: RetrievalObjectType;
  objectId: string;
}

export interface RetrievalAlias {
  alias: string;
  normalizedAlias: string;
  aliasKind: string;
  confidence: number;
}

export interface RetrievalChunk {
  chunkIndex: number;
  plainText: string;
  contentHash: string;
}

export interface RetrievalEdge {
  from: RetrievalObjectRef;
  to: RetrievalObjectRef;
  linkType: string;
  edgeOrigin: string;
  edgeStatus: "derived" | "suggested";
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface RetrievalTrace {
  // Counts over the final visible result set only. These numbers are recomputed
  // after live read/source-policy revalidation so object_profile filters cannot be
  // used to infer hidden or source-policy-denied candidate distributions.
  arms: Record<string, number>;
  // Aggregate counts only for visible-set post-processing drops. We intentionally
  // do not count canonical/source-policy revalidation failures here: those can
  // depend on hidden/private/source-restricted candidates.
  dropped: number;
  dropped_reasons: Record<string, number>;
  // Optional rerank-stage diagnostics. Counts only (never candidate ids), so the
  // trace cannot leak the existence of objects sent to or dropped by the reranker.
  // `moved` counts windowed candidates whose position changed (§2.8). `truncated`
  // counts candidates whose text was bounded by the token budget (§2.6).
  rerank?: { sent: number; applied: boolean; moved?: number; truncated?: number };
  // Aggregate ranking telemetry (§2.8). `score_buckets` is a histogram of the
  // visible candidates' final fused+boosted scores; `boost_attribution` counts
  // how often each boost axis (and the floor gate) fired. Both are counts over
  // the visible set / the candidates' own boost axes — never ids/titles/queries.
  score_buckets?: Record<string, number>;
  boost_attribution?: Record<string, number>;
  // Adaptive-return diagnostics (§2.4): whether the trim fired and how many
  // low-tail candidates it dropped. Aggregate only.
  adaptive_return?: { applied: boolean; trimmed: number };
  // Optional query-rewrite diagnostics. Counts only (never the variant strings).
  rewrite?: { variants: number; applied: boolean };
  // The resolved search mode (the caller's own requested tier; no leak).
  mode?: RetrievalSearchMode;
  // The classified query intent (derived from the caller's own query; no leak).
  // It selects access-neutral ranking knobs only — it does not gate recall.
  intent?: string;
  // Multi-hop graph recall diagnostics: how many hops the traversal walked.
  // Aggregate only (no candidate ids), so it cannot leak unreadable objects.
  graph?: { hops: number };
  // Relational intent diagnostics: aggregate query-shape/arm counts only. Seed
  // phrases come from the caller query, but object ids/titles never appear here.
  relational?: { intent: string; seed_phrases: number; seeds: number; results: number; hops: number };
  // Context Brief diagnostics: source count fed to synthesis and whether an LLM
  // answer was produced. Counts only (no candidate ids / no content).
  synthesis?: { sources: number; synthesized: boolean };
}

export interface SearchCandidate {
  objectType: RetrievalObjectType;
  objectId: string;
  /**
   * Active governed object_profile from space_object_profiles when the projected row
   * matches an active registry definition. Null means either the canonical row
   * has no kind or the projected kind is not active in the space registry.
   */
  objectProfile?: string | null;
  objectProfileLabel?: string | null;
  title: string;
  snippet: string | null;
  matchedFields: string[];
  evidence: EvidenceContract;
  rank: number;
  arm: string;
  /** Canonical object's last-update timestamp (ISO), for the recency signal. */
  updatedAt: string | null;
  /**
   * Source connection ids for source-derived content. Empty means the object is
   * not governed by a source connection policy.
   */
  sourceConnectionIds?: string[];
  /**
   * The candidate's own best-chunk query/chunk cosine similarity in [0,1] when it
   * had a vector hit, for the deterministic post-RRF cosine blend (§2.3). Carried
   * separately from `evidence.confidence` because fusion may overwrite the
   * candidate's evidence with a higher-priority arm's. Access-safe: it is derived
   * only from the candidate's own embedding versus the query.
   */
  vectorSimilarity?: number;
}

/** A fused candidate carrying its RRF (then ranking-boosted) score. */
export interface ScoredCandidate extends SearchCandidate {
  score: number;
}

/**
 * Query-time embedder for the vector recall arm. Injected by the app layer so
 * the engine stays domain- and provider-agnostic. Returns `null` when an
 * embedding provider is unavailable or the call fails, which disables the vector
 * arm for that search (graceful degradation to the deterministic arms).
 */
export interface QueryEmbedder {
  /**
   * Embed the query for the vector arm. `opts.cache` (default true) controls
   * whether a per-process query-embedding cache may serve/populate the result;
   * `false` forces a fresh provider call (e.g. after a model swap).
   */
  embedQuery(
    spaceId: string,
    text: string,
    opts?: { cache?: boolean; subjectUserId?: string },
  ): Promise<number[] | null>;
}

/**
 * The projectable shape of a canonical domain object. A domain adapter assembles
 * this from its own tables; the engine writes it into the derived projection
 * (object row, aliases, chunks). The engine never reads domain tables directly.
 */
export interface CanonicalObject {
  objectType: RetrievalObjectType;
  objectId: string;
  title: string;
  slug: string | null;
  projectFolderId: string | null;
  ownerUserId: string | null;
  visibility: string | null;
  status: string;
  objectProfile: string | null;
  aliases: string[];
  text: string;
  /** Source connection ids resolved by the domain adapter at projection time. */
  sourceConnectionIds: string[];
  /**
   * The CANONICAL object's last-update time (ISO), projected into
   * `retrieval_objects.source_updated_at`. This is real content freshness — used
   * by the recency ranking signal, the brief's stale gap, and the maintenance
   * stale-source scan — as opposed to `indexed_at`/`updated_at` which are
   * projection (reindex) times. Null when the domain has no meaningful timestamp.
   */
  updatedAt: string | null;
}

/**
 * Live revalidation output for a search candidate. A domain adapter returns the
 * authoritative title/snippet text after confirming the viewer may read the
 * canonical object, or null to drop it.
 */
export interface RevalidatedObject {
  title: string;
  text: string | null;
}
