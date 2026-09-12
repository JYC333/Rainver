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
  await enqueueSourceRetrievalEmbeddings(db, input.spaceId, await sourceItemOwner(db, input.spaceId, input.itemId), input.trigger);
}

export async function reindexExtractedEvidenceAndParentForRetrieval(
  db: Queryable,
  input: { spaceId: string; evidenceId: string; trigger: string },
): Promise<void> {
  const projection = new RetrievalProjectionService(db, sourceRetrievalRegistry);
  await projection.reindex(input.spaceId, "extracted_evidence", input.evidenceId);
  const itemId = await sourceItemIdForEvidence(db, input.spaceId, input.evidenceId);
  if (itemId) await projection.reindex(input.spaceId, "source_item", itemId);
  const owner = itemId
    ? await sourceItemOwner(db, input.spaceId, itemId)
    : await evidenceOwner(db, input.spaceId, input.evidenceId);
  await enqueueSourceRetrievalEmbeddings(db, input.spaceId, owner, input.trigger);
}

/**
 * Queues the embedding backfill for newly indexed source content.
 *
 * The backfill spends a model key with nobody present, so it spends as the
 * person whose source this is: the owner of the connection that ingested it,
 * or the item's own owner when it came from none. Content with no owner has
 * nobody to authorize the spend, so nothing is queued for it; the next
 * backfill a person's action queues embeds it with the rest of the Space.
 */
export async function enqueueSourceRetrievalEmbeddings(
  db: Queryable,
  spaceId: string,
  userId: string | null,
  trigger: string,
): Promise<void> {
  if (!userId) return;
  await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(db), {
    spaceId,
    userId,
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

async function sourceItemOwner(db: Queryable, spaceId: string, itemId: string): Promise<string | null> {
  const result = await db.query<{ user_id: string | null }>(
    `SELECT COALESCE(connection.owner_user_id, item.owner_user_id) AS user_id
       FROM source_items item
       LEFT JOIN source_connections connection
         ON connection.id = item.connection_id AND connection.space_id = item.space_id
      WHERE item.space_id = $1 AND item.id = $2
      LIMIT 1`,
    [spaceId, itemId],
  );
  return result.rows[0]?.user_id ?? null;
}

async function evidenceOwner(db: Queryable, spaceId: string, evidenceId: string): Promise<string | null> {
  const result = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM extracted_evidence WHERE space_id = $1 AND id = $2 LIMIT 1`,
    [spaceId, evidenceId],
  );
  return result.rows[0]?.owner_user_id ?? null;
}
