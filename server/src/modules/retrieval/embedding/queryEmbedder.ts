import { completeProviderEmbedding } from "../../providers/invocation/invocation.js";
import type { ProviderCommandStore } from "../../providers/commands/store.js";
import type { QueryEmbedder } from "../index.js";
import type { RetrievalEgressPolicy } from "../egress/egressPolicy.js";
import { DEFAULT_EMBED_DIMENSIONS, RETRIEVAL_EMBEDDING_TASK } from "./config.js";
import { sharedQueryEmbeddingCache, type QueryEmbeddingCache } from "./queryEmbeddingCache.js";

/**
 * Provider-backed query embedder for the vector recall arm. Routes through the
 * same `retrieval_embedding` task policy as backfill (ADR 0008 channel). Returns
 * null on any failure, empty query, or dimension mismatch so search degrades to
 * the deterministic arms rather than failing the request.
 *
 * A bounded LRU+TTL cache (process-wide by default) reuses the vector for
 * repeated queries so identical searches don't re-call the provider. Only
 * successful, correct-dimension embeddings are cached.
 */
export class ProviderQueryEmbedder implements QueryEmbedder {
  constructor(
    private readonly store: ProviderCommandStore,
    private readonly providerId: string | null = null,
    private readonly cache: QueryEmbeddingCache = sharedQueryEmbeddingCache,
    private readonly expectedDimensions: number = DEFAULT_EMBED_DIMENSIONS,
    private readonly egressPolicy: RetrievalEgressPolicy | null = null,
  ) {}

  async embedQuery(
    spaceId: string,
    text: string,
    opts: { cache?: boolean; subjectUserId?: string } = {},
  ): Promise<number[] | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const useCache = opts.cache !== false;
    if (useCache) {
      const cached = this.cache.get(spaceId, trimmed, this.expectedDimensions);
      if (cached) return cached;
    }
    try {
      const result = await completeProviderEmbedding(this.store, spaceId, {
        provider_id: this.providerId,
        inputs: [trimmed],
        task: RETRIEVAL_EMBEDDING_TASK,
        dimensions: this.expectedDimensions,
        inputType: "query",
        egressPolicy: this.egressPolicy,
        metering: { subject_user_id: opts.subjectUserId },
      });
      const vector = result.vectors[0];
      if (!Array.isArray(vector) || vector.length !== this.expectedDimensions) return null;
      this.cache.set(spaceId, trimmed, vector, this.expectedDimensions);
      return vector;
    } catch {
      return null;
    }
  }
}
