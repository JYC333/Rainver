import { PgJobQueueRepository } from "../jobs/repository.js";
import { RetrievalProjectionService } from "../retrieval/index.js";
import { enqueueRetrievalEmbeddingBackfillWithQueue } from "../retrieval/embedding/job.js";
import type { Queryable } from "../routeUtils/common.js";
import { sourceRetrievalRegistry } from "./retrievalAdapter.js";

export async function reindexSourceItemAndEvidenceForRetrieval(
  db: Queryable,
  input: { spaceId: string; itemId: string; trigger: string },
): Promise<void> {
  const projection = new RetrievalProjectionService(db, sourceRetrievalRegistry);
  await projection.reindex(input.spaceId, "source_item", input.itemId);
  for (const evidenceId of await evidenceIdsForItem(db, input.spaceId, input.itemId)) {
    await projection.reindex(input.spaceId, "extracted_evidence", evidenceId);
  }
  await enqueueSourceRetrievalEmbeddings(db, input.spaceId, input.trigger);
}

export async function reindexExtractedEvidenceAndParentForRetrieval(
  db: Queryable,
  input: { spaceId: string; evidenceId: string; trigger: string },
): Promise<void> {
  const projection = new RetrievalProjectionService(db, sourceRetrievalRegistry);
  await projection.reindex(input.spaceId, "extracted_evidence", input.evidenceId);
  const itemId = await sourceItemIdForEvidence(db, input.spaceId, input.evidenceId);
  if (itemId) await projection.reindex(input.spaceId, "source_item", itemId);
  await enqueueSourceRetrievalEmbeddings(db, input.spaceId, input.trigger);
}

export async function enqueueSourceRetrievalEmbeddings(
  db: Queryable,
  spaceId: string,
  trigger: string,
): Promise<void> {
  await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(db), {
    spaceId,
    userId: null,
    trigger,
  }).catch((error) => {
    process.stderr.write(
      `[source.retrieval] embedding backfill enqueue failed: ${String((error as Error)?.message ?? error)}\n`,
    );
    return null;
  });
}

async function evidenceIdsForItem(db: Queryable, spaceId: string, itemId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id
       FROM extracted_evidence
      WHERE space_id = $1
        AND COALESCE(source_item_id, origin_source_item_id) = $2
        AND deleted_at IS NULL`,
    [spaceId, itemId],
  );
  return result.rows.map((row) => row.id);
}

async function sourceItemIdForEvidence(db: Queryable, spaceId: string, evidenceId: string): Promise<string | null> {
  const result = await db.query<{ source_item_id: string | null }>(
    `SELECT COALESCE(source_item_id, origin_source_item_id) AS source_item_id
       FROM extracted_evidence
      WHERE space_id = $1 AND id = $2
      LIMIT 1`,
    [spaceId, evidenceId],
  );
  return result.rows[0]?.source_item_id ?? null;
}
