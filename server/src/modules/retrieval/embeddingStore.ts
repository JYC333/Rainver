import type { Queryable } from "../routeUtils/common.js";

/**
 * Engine-owned access to the `retrieval_chunks` embedding columns. Like the rest
 * of the engine it touches only `retrieval_*` tables and never a domain table or
 * a model provider — the provider call and any domain egress policy live in the
 * app-layer backfill orchestrator (`modules/retrieval/embedding`). This keeps the
 * embedding *store* domain-agnostic while the embedding *generation* is wired to
 * credentials/policy outside the engine.
 */

export interface PendingChunk {
  id: string;
  object_type: string;
  object_id: string;
  plain_text: string;
  embedding_claim_id: string | null;
  source_connection_ids_json: unknown;
}

const MAX_BATCH = 1000;

/**
 * What a blocked chunk was blocked under: the Space-wide egress frame plus the
 * policy digest of each Source connection the chunk's object depends on. A
 * chunk is passed over until that changes, so editing one connection re-checks
 * only the chunks that depend on it. Digests are opaque to the engine; the
 * app layer computes them (`$frame`, `$digests` = {connection id: digest}).
 */
function chunkPolicyGenerationSql(objectAlias: string, frameParam: string, digestsParam: string): string {
  return `md5(${frameParam} || '|' || COALESCE((
    SELECT string_agg(dependency.id || '=' || COALESCE(${digestsParam}::jsonb ->> dependency.id, 'missing'), '|' ORDER BY dependency.id)
      FROM jsonb_array_elements_text(${objectAlias}.source_connection_ids_json) AS dependency(id)
  ), ''))`;
}

/** The egress state a blocked chunk is re-checked against. */
export interface EmbeddingPolicyGeneration {
  /** Digest of the Space-wide egress switch and destination. */
  frame: string;
  /** Policy digest of every Source connection in the Space, by id. */
  connectionDigests: Record<string, string>;
}

export class RetrievalEmbeddingStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Atomically claim a bounded batch of pending chunks. The claim is a short
   * lease, not a durable owner: stale claims are claimable again after
   * `staleBefore`, so a crashed worker cannot strand chunks forever. Chunks that
   * have already failed `maxAttempts` times are excluded so a permanently
   * un-embeddable chunk is not re-sent to the provider forever.
   */
  async claimPendingChunks(
    spaceId: string,
    limit: number,
    claimId: string,
    staleBefore: Date,
    maxAttempts: number,
    /** Chunks found not sendable are passed over until their own policy state changes. */
    policyGeneration: EmbeddingPolicyGeneration,
  ): Promise<PendingChunk[]> {
    const result = await this.db.query<PendingChunk>(
      `WITH candidate AS (
         SELECT chunk.id
           FROM retrieval_chunks chunk
           JOIN retrieval_objects chunk_object
             ON chunk_object.id = chunk.retrieval_object_id AND chunk_object.space_id = chunk.space_id
          WHERE chunk.space_id = $1
            AND chunk.embedding IS NULL
            AND chunk.embedding_attempts < $5
            AND (
              chunk.embedding_blocked_generation IS NULL
              OR chunk.embedding_blocked_generation IS DISTINCT FROM ${chunkPolicyGenerationSql("chunk_object", "$6", "$7")}
            )
            AND (
              chunk.embedding_claim_id IS NULL
              OR chunk.embedding_claimed_at IS NULL
              OR chunk.embedding_claimed_at < $4
            )
          ORDER BY chunk.created_at ASC, chunk.id ASC
          FOR UPDATE OF chunk SKIP LOCKED
          LIMIT $2
       )
       UPDATE retrieval_chunks
          SET embedding_claim_id = $3,
              embedding_claimed_at = now()
         FROM candidate, retrieval_objects ro
        WHERE retrieval_chunks.id = candidate.id
          AND ro.id = retrieval_chunks.retrieval_object_id
          AND ro.space_id = retrieval_chunks.space_id
        RETURNING retrieval_chunks.id,
                  retrieval_chunks.object_type,
                  retrieval_chunks.object_id,
                  retrieval_chunks.plain_text,
                  retrieval_chunks.embedding_claim_id,
                  ro.source_connection_ids_json`,
      [
        spaceId, clampLimit(limit), claimId, staleBefore.toISOString(), Math.max(1, Math.floor(maxAttempts)),
        policyGeneration.frame, JSON.stringify(policyGeneration.connectionDigests),
      ],
    );
    return result.rows;
  }

  /**
   * Set aside claimed chunks the egress policy does not let reach the
   * provider: the claim is released and the chunk is passed over until the
   * egress state it depends on changes (the Space switch, or one of its own
   * Source connections), so a run of blocked chunks at the head of the queue
   * never holds back the sendable ones behind it. No attempt is spent.
   */
  async markEmbeddingBlocked(
    chunkIds: readonly string[],
    spaceId: string,
    claimId: string,
    policyGeneration: EmbeddingPolicyGeneration,
  ): Promise<number> {
    if (chunkIds.length === 0) return 0;
    const result = await this.db.query(
      `UPDATE retrieval_chunks chunk
          SET embedding_blocked_generation = ${chunkPolicyGenerationSql("chunk_object", "$4", "$5")},
              embedding_claim_id = NULL,
              embedding_claimed_at = NULL
         FROM retrieval_objects chunk_object
        WHERE chunk.id = ANY($1::varchar[])
          AND chunk.space_id = $2
          AND chunk.embedding_claim_id = $3
          AND chunk.embedding IS NULL
          AND chunk_object.id = chunk.retrieval_object_id
          AND chunk_object.space_id = chunk.space_id`,
      [chunkIds, spaceId, claimId, policyGeneration.frame, JSON.stringify(policyGeneration.connectionDigests)],
    );
    return result.rowCount ?? 0;
  }

  /** Re-queue chunks embedded by a superseded model for re-embedding. */
  async clearEmbeddingsForOtherModels(
    spaceId: string,
    keepModel: string,
    keepDimensions?: number | null,
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE retrieval_chunks
          SET embedding = NULL,
              embedding_model = NULL,
              embedding_dimensions = NULL,
              embedding_generated_at = NULL,
              embedding_claim_id = NULL,
              embedding_claimed_at = NULL,
              embedding_attempts = 0
        WHERE space_id = $1
          AND embedding IS NOT NULL
          AND (
            embedding_model IS DISTINCT FROM $2
            OR ($3::int IS NOT NULL AND embedding_dimensions IS DISTINCT FROM $3)
          )`,
      [spaceId, keepModel, keepDimensions ?? null],
    );
    return result.rowCount ?? 0;
  }

  /** Re-queue all embedded chunks for a space after model/dimension policy changes. */
  async resetEmbeddingsForSpace(spaceId: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE retrieval_chunks
          SET embedding = NULL,
              embedding_model = NULL,
              embedding_dimensions = NULL,
              embedding_generated_at = NULL,
              embedding_claim_id = NULL,
              embedding_claimed_at = NULL,
              embedding_attempts = 0
        WHERE space_id = $1
          AND (
            embedding IS NOT NULL
            OR embedding_model IS NOT NULL
            OR embedding_dimensions IS NOT NULL
            OR embedding_claim_id IS NOT NULL
            OR embedding_claimed_at IS NOT NULL
            OR embedding_attempts <> 0
          )`,
      [spaceId],
    );
    return result.rowCount ?? 0;
  }

  /** Release an in-flight claim after a transient (batch-level) failure. The
   * attempt count is intentionally NOT incremented — a provider outage must not
   * burn a chunk's retry budget toward permanent exclusion. */
  async releaseEmbeddingClaim(spaceId: string, claimId: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE retrieval_chunks
          SET embedding_claim_id = NULL,
              embedding_claimed_at = NULL
        WHERE space_id = $1
          AND embedding_claim_id = $2
          AND embedding IS NULL`,
      [spaceId, claimId],
    );
    return result.rowCount ?? 0;
  }

  /** Record a per-chunk embedding failure (e.g. wrong-dimension vector): bump
   * the attempt count and release the claim so it is retried until the cap. */
  async markEmbeddingFailure(chunkId: string, spaceId: string, claimId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE retrieval_chunks
          SET embedding_attempts = embedding_attempts + 1,
              embedding_claim_id = NULL,
              embedding_claimed_at = NULL
        WHERE id = $1
          AND space_id = $2
          AND embedding_claim_id = $3
          AND embedding IS NULL`,
      [chunkId, spaceId, claimId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Persist one chunk embedding. The caller validates the vector length against
   * the space's configured embedding dimension before writing.
   */
  async writeEmbedding(
    chunkId: string,
    spaceId: string,
    vector: number[],
    model: string,
    dimensions: number,
    claimId?: string | null,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE retrieval_chunks
          SET embedding = $3::vector,
              embedding_model = $4,
              embedding_dimensions = $5,
              embedding_generated_at = now(),
              embedding_claim_id = NULL,
              embedding_claimed_at = NULL,
              embedding_blocked_generation = NULL
        WHERE id = $1
          AND space_id = $2
          AND ($6::varchar IS NULL OR embedding_claim_id = $6)`,
      [chunkId, spaceId, toVectorLiteral(vector), model, dimensions, claimId ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/** pgvector accepts the text form `[1,2,3]` for a `vector` value. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function clampLimit(limit: number): number {
  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(n, MAX_BATCH);
}
