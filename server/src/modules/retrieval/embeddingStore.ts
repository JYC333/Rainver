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
  ): Promise<PendingChunk[]> {
    const result = await this.db.query<PendingChunk>(
      `WITH candidate AS (
         SELECT id
           FROM retrieval_chunks
          WHERE space_id = $1
            AND embedding IS NULL
            AND embedding_attempts < $5
            AND (
              embedding_claim_id IS NULL
              OR embedding_claimed_at IS NULL
              OR embedding_claimed_at < $4
            )
          ORDER BY created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
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
      [spaceId, clampLimit(limit), claimId, staleBefore.toISOString(), Math.max(1, Math.floor(maxAttempts))],
    );
    return result.rows;
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
              embedding_claimed_at = NULL
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
