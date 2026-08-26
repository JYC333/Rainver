import { QUERY_EMBED_CACHE_MAX, QUERY_EMBED_CACHE_TTL_MS } from "./config.js";

interface CacheEntry {
  vector: number[];
  expiresAt: number;
}

/**
 * Bounded, in-memory, per-process cache of query embeddings for the vector
 * recall arm. Two guarantees keep it from growing without bound:
 *
 * - **Count (LRU):** at most `maxEntries`; the least-recently-used entry is
 *   evicted when full. Caps memory regardless of query volume.
 * - **TTL:** each entry expires after `ttlMs`. Bounds how long a stale vector
 *   lives — e.g. if a space swaps its embedding model, cached query vectors
 *   (and any not-yet-re-embedded chunks) self-heal within the window.
 *
 * Keyed by `space_id` + configured dimensions + lightly-normalized query text
 * (the model is resolved per space via the `retrieval_embedding` task, so the
 * space scopes the model). Only successful, correct-dimension embeddings are
 * cached. Not persisted — cleared on restart; not shared across processes
 * (each worker has its own).
 */
export class QueryEmbeddingCache {
  // Map preserves insertion order; we treat front = least-recently-used.
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries: number = QUERY_EMBED_CACHE_MAX,
    private readonly ttlMs: number = QUERY_EMBED_CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(spaceId: string, query: string, dimensions?: number): number[] | null {
    const key = cacheKey(spaceId, query, dimensions);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    // LRU touch: move to most-recently-used (back of the Map).
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Return a copy so a caller mutating the result can't poison the shared entry.
    return [...entry.vector];
  }

  set(spaceId: string, query: string, vector: number[], dimensions?: number): void {
    const key = cacheKey(spaceId, query, dimensions);
    this.entries.delete(key);
    // Store a copy so a later mutation of the caller's array can't alter the cache.
    this.entries.set(key, { vector: [...vector], expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Current entry count (diagnostics/tests). */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Light normalization: same vector for whitespace/case-only variants; keeps
 * punctuation/words so semantically-distinct queries get distinct entries. */
function cacheKey(spaceId: string, query: string, dimensions?: number): string {
  return `${spaceId}\n${dimensions ?? "default"}\n${query.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

/** Process-wide shared cache used by the production query embedder. */
export const sharedQueryEmbeddingCache = new QueryEmbeddingCache();
