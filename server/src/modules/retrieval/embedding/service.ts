import { randomUUID } from "node:crypto";
import { RetrievalEmbeddingStore } from "../index.js";
import type { Queryable } from "../../routeUtils/common.js";
import {
  EMBED_CLAIM_TTL_MS,
  DEFAULT_EMBED_DIMENSIONS,
  EMBED_MAX_ATTEMPTS,
  DEFAULT_EMBED_BATCH,
} from "./config.js";
import { retrievalEgressAllowed, type RetrievalEgressPolicy } from "../egress/egressPolicy.js";
import {
  loadSourcePolicySnapshots,
  sourceConnectionIdsFromJson,
  sourceEgressPoliciesForSnapshots,
} from "../index.js";

/**
 * Generates embeddings for a batch of chunk texts. The model name is reported
 * back so the store can record which model produced each vector (model-change
 * staleness). Implementations call a model provider, so they run OUTSIDE any DB
 * transaction (see backfillSpace).
 */
export interface RetrievalEmbedder {
  embed(
    spaceId: string,
    texts: string[],
    opts?: { dimensions?: number },
  ): Promise<{ vectors: number[][]; model: string }>;
}

export interface BackfillResult {
  scanned: number;
  embedded: number;
  skipped: number;
  model: string | null;
}

export interface RetrievalEmbeddingAuditEvent {
  spaceId: string;
  model: string;
  dimensions: number;
  scanned: number;
  inputCount: number;
  embedded: number;
  skipped: number;
}

export type RetrievalEmbeddingAudit = (event: RetrievalEmbeddingAuditEvent) => Promise<void>;

/**
 * Async embedding backfill over `retrieval_chunks`. Selects chunks with no
 * embedding, runs the (external) embedder once for the batch OUTSIDE any
 * transaction, then writes each vector in its own short statement. A projection
 * never blocks on this: chunks simply stay un-embedded until a backfill runs.
 */
export class RetrievalEmbeddingBackfillService {
  constructor(
    private readonly db: Queryable,
    private readonly embedder: RetrievalEmbedder,
    private readonly audit?: RetrievalEmbeddingAudit,
  ) {}

  async backfillSpace(
    spaceId: string,
    opts: { batchLimit?: number; embeddingDimensions?: number; externalEgressEnabled?: boolean } = {},
  ): Promise<BackfillResult> {
    const embeddingDimensions = opts.embeddingDimensions ?? DEFAULT_EMBED_DIMENSIONS;
    // W9 egress gate: if the space disables external egress, embedding (which
    // sends chunk text to a provider) is skipped entirely — no chunks are even
    // claimed, and the vector arm degrades to the deterministic arms. The caller
    // (the job handler) resolves the space switch; default-allow keeps the
    // service decoupled and matches the pre-W9 behavior for direct callers.
    const egressPolicy: RetrievalEgressPolicy = { externalEgressEnabled: opts.externalEgressEnabled ?? true };
    if (!egressPolicy.externalEgressEnabled) {
      return { scanned: 0, embedded: 0, skipped: 0, model: null };
    }
    const store = new RetrievalEmbeddingStore(this.db);
    const claimId = randomUUID();
    const staleBefore = new Date(Date.now() - EMBED_CLAIM_TTL_MS);
    const pending = await store.claimPendingChunks(
      spaceId,
      opts.batchLimit ?? DEFAULT_EMBED_BATCH,
      claimId,
      staleBefore,
      EMBED_MAX_ATTEMPTS,
    );
    const egressPolicyWithSources = await this.egressPolicyForPendingChunks(spaceId, pending, egressPolicy);
    const eligible = pending.filter((chunk) =>
      retrievalEgressAllowed({
        object_type: chunk.object_type,
        object_id: chunk.object_id,
        source_connection_ids: sourceConnectionIdsFromJson(chunk.source_connection_ids_json),
      }, egressPolicyWithSources),
    );
    if (eligible.length === 0) {
      return { scanned: pending.length, embedded: 0, skipped: pending.length, model: null };
    }

    let vectors: number[][];
    let model: string;
    try {
      // External model call happens here, with no open transaction held.
      const result = await this.embedder.embed(
        spaceId,
        eligible.map((chunk) => chunk.plain_text),
        { dimensions: embeddingDimensions },
      );
      vectors = result.vectors;
      model = result.model;
    } catch (error) {
      await this.releaseClaimAfterFailure(store, spaceId, claimId);
      throw error;
    }

    let embedded = 0;
    let wrongDim: number | null = null;
    try {
      for (let i = 0; i < eligible.length; i += 1) {
        const vector = vectors[i];
        // A missing or wrong-dimension vector (model misconfig) cannot be used
        // for this space's current vector arm. Don't crash the batch: record a
        // per-chunk failure (bumps the attempt count toward the cap) so a poison
        // chunk stops being retried.
        if (!Array.isArray(vector) || vector.length !== embeddingDimensions) {
          if (Array.isArray(vector)) wrongDim = vector.length;
          await store.markEmbeddingFailure(eligible[i]!.id, spaceId, claimId);
          continue;
        }
        if (await store.writeEmbedding(eligible[i]!.id, spaceId, vector, model, embeddingDimensions, claimId)) {
          embedded += 1;
        }
      }
    } catch (error) {
      await this.releaseClaimAfterFailure(store, spaceId, claimId);
      throw error;
    }
    // A consistent wrong dimension means the configured model and the embedding
    // column disagree — surface it; otherwise nothing would ever embed silently.
    if (embedded === 0 && wrongDim !== null) {
      process.stderr.write(
        `[retrieval.embedding] model '${model}' returned ${wrongDim}-dim vectors but the ` +
          `space expects ${embeddingDimensions}-dim vectors; no chunks embedded. ` +
          `Check the embedding model or the space retrieval setting.\n`,
      );
    }
    const skipped = pending.length - embedded;
    await this.writeAudit({
      spaceId,
      model,
      scanned: pending.length,
      inputCount: eligible.length,
      embedded,
      skipped,
      dimensions: embeddingDimensions,
    });
    return { scanned: pending.length, embedded, skipped, model };
  }

  private async writeAudit(event: RetrievalEmbeddingAuditEvent): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit(event);
    } catch (error) {
      process.stderr.write(
        `[retrieval.embedding] policy audit write failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }

  private async egressPolicyForPendingChunks(
    spaceId: string,
    pending: readonly { source_connection_ids_json: unknown }[],
    base: RetrievalEgressPolicy,
  ): Promise<RetrievalEgressPolicy> {
    const sourceIds = uniqueSourceConnectionIds(pending);
    if (sourceIds.length === 0) return base;
    const snapshots = await loadSourcePolicySnapshots(this.db, spaceId, sourceIds);
    return {
      ...base,
      sourcePolicies: sourceEgressPoliciesForSnapshots(snapshots),
      payloadSourceConnectionIds: sourceIds,
    };
  }

  private async releaseClaimAfterFailure(
    store: RetrievalEmbeddingStore,
    spaceId: string,
    claimId: string,
  ): Promise<void> {
    try {
      await store.releaseEmbeddingClaim(spaceId, claimId);
    } catch (error) {
      process.stderr.write(
        `[retrieval.embedding] claim release failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}

function uniqueSourceConnectionIds(pending: readonly { source_connection_ids_json: unknown }[]): string[] {
  const out: string[] = [];
  for (const chunk of pending) {
    for (const sourceId of sourceConnectionIdsFromJson(chunk.source_connection_ids_json)) {
      if (!out.includes(sourceId)) out.push(sourceId);
    }
  }
  return out;
}
