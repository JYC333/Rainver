/**
 * Hybrid-retrieval embedding configuration.
 *
 * Spaces can choose their embedding dimensions for model experimentation. The
 * default matches the retrieval index.
 */
export const DEFAULT_EMBED_DIMENSIONS = 2560;
export const EMBED_DIMENSIONS = DEFAULT_EMBED_DIMENSIONS;

/** Provider task policy used to route embedding generation (ADR 0008 channel). */
export const RETRIEVAL_EMBEDDING_TASK = "retrieval_embedding";

/** Job type for the async embedding backfill worker. */
export const RETRIEVAL_EMBEDDING_JOB = "retrieval_embedding_backfill";

/** Default chunks embedded per backfill invocation. */
export const DEFAULT_EMBED_BATCH = 128;

/** Pending chunk claim lease before another worker may reclaim it. */
export const EMBED_CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * Max embedding attempts per chunk before it is left out of future claims. A
 * chunk only burns an attempt on a per-chunk failure (e.g. a wrong-dimension
 * vector); a transient batch failure releases the claim without burning one.
 * This caps the "poison chunk" retry loop — a permanently un-embeddable chunk
 * (e.g. model dim ≠ column dim) stops being re-sent to the provider.
 */
export const EMBED_MAX_ATTEMPTS = 5;

/**
 * Query-embedding cache bounds. The vector arm embeds the search query on every
 * request; this in-memory, per-process LRU+TTL cache lets repeated queries
 * (pagination, retries, debounced typing) reuse a vector instead of re-calling
 * the provider. Bounded by count (memory) and TTL (a model swap goes stale
 * within the window). ~20KB per 2560-dim vector → 1000 entries ≈ 20MB.
 */
export const QUERY_EMBED_CACHE_MAX = 1000;
export const QUERY_EMBED_CACHE_TTL_MS = 5 * 60 * 1000;
