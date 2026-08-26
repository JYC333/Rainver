import { randomUUID } from "node:crypto";
import { objectValue, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { pmBlocksText } from "../knowledge/noteDocument.js";
import type { PinnedSourceRef } from "./outbox.js";

interface OutboxEventRow {
  id: string;
  space_id: string;
  source_kind: string;
  source_id: string;
  source_ref_json: unknown;
  change_significance: string | null;
}

const CLAIM_LEASE_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;

interface PinnedKnowledgeItemRow {
  object_id: string;
  title: string;
  content: string;
  pinned_source_ref_json: PinnedSourceRef;
  visibility: string;
  owner_user_id: string | null;
}

/**
 * Consumes `domain_change_outbox` events and records exactly one idempotent
 * outcome per (Knowledge item, event) — `no_impact`, `candidate_created`, or
 * `already_superseded`. Only `candidate_created` creates a
 * (revalidation-trigger) Knowledge Candidate; `no_impact` is queryable audit
 * only, never review noise.
 *
 * Materiality: Inquiry Thread events already carry a non-LLM significance
 * ('trivial'/'material') computed at write time (threadRevisionService.ts).
 * Note events carry none — a Note's material vs. trivial-ness can only be
 * judged against the SPECIFIC block(s) a Knowledge item actually pinned to
 * (`block_anchors`), so this worker diffs exactly those blocks between the
 * item's pinned revision and the event's new revision.
 */
/** Periodic sweep entry point (see backgroundServices.ts) — every Space with at least one unclaimed event, oldest first. */
export async function processAllUnclaimedDomainChangeEvents(db: Queryable): Promise<number> {
  const spaces = await db.query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM domain_change_outbox
      WHERE processed_at IS NULL AND (claim_expires_at IS NULL OR claim_expires_at <= now())
      ORDER BY space_id`,
  );
  let processed = 0;
  for (const row of spaces.rows) {
    const result = await processUnclaimedDomainChangeEvents(db, row.space_id);
    processed += result.processed;
  }
  return processed;
}

export async function processUnclaimedDomainChangeEvents(
  db: Queryable,
  spaceId: string,
  limit = 50,
): Promise<{ processed: number; outcomes: Record<string, number> }> {
  const pending = await db.query<{ id: string }>(
    `SELECT id
       FROM domain_change_outbox
      WHERE space_id=$1 AND processed_at IS NULL
        AND (claim_expires_at IS NULL OR claim_expires_at <= now())
      ORDER BY occurred_at ASC
      LIMIT $2`,
    [spaceId, limit],
  );
  const outcomes: Record<string, number> = { no_impact: 0, candidate_created: 0, already_superseded: 0 };
  let processed = 0;
  for (const pendingEvent of pending.rows) {
    const claimToken = randomUUID();
    try {
      const outcomeCounts = await withQueryableTransaction(db, async (tx) => {
        const claimedAt = new Date();
        const claimed = await tx.query<OutboxEventRow>(
          `UPDATE domain_change_outbox
              SET claimed_at=$3, claim_token=$4, claim_expires_at=$5,
                  attempt_count=attempt_count+1, last_error=NULL
            WHERE id=$1 AND space_id=$2 AND processed_at IS NULL
              AND (claim_expires_at IS NULL OR claim_expires_at <= $3)
          RETURNING id, space_id, source_kind, source_id, source_ref_json, change_significance`,
          [pendingEvent.id, spaceId, claimedAt.toISOString(), claimToken,
            new Date(claimedAt.getTime() + CLAIM_LEASE_MS).toISOString()],
        );
        const event = claimed.rows[0];
        if (!event) return null;
        const counts = await processEvent(tx, event);
        await tx.query(
          `UPDATE domain_change_outbox
              SET processed_at=$3, claim_token=NULL, claim_expires_at=NULL
            WHERE id=$1 AND space_id=$2 AND claim_token=$4`,
          [event.id, event.space_id, new Date().toISOString(), claimToken],
        );
        return counts;
      });
      if (!outcomeCounts) continue;
      processed += 1;
      for (const [outcome, count] of Object.entries(outcomeCounts)) outcomes[outcome] = (outcomes[outcome] ?? 0) + count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date();
      await db.query(
        `UPDATE domain_change_outbox
            SET claimed_at=$3, attempt_count=attempt_count+1,
                last_error=$4, claim_expires_at=$5
          WHERE id=$1 AND space_id=$2 AND processed_at IS NULL
            AND (claim_token IS NULL OR claim_token=$6)`,
        [pendingEvent.id, spaceId, failedAt.toISOString(), message.slice(0, 4000),
          new Date(failedAt.getTime() + FAILURE_RETRY_MS).toISOString(), claimToken],
      );
    }
  }
  return { processed, outcomes };
}

async function processEvent(db: Queryable, event: OutboxEventRow): Promise<Record<string, number>> {
  const pinned = await db.query<PinnedKnowledgeItemRow>(
    `SELECT ki.object_id, so.title, ki.content, ki.pinned_source_ref_json, so.visibility, so.owner_user_id
       FROM knowledge_items ki
       JOIN space_objects so ON so.id = ki.object_id AND so.space_id = ki.space_id
      WHERE ki.space_id=$1
        AND ki.pinned_source_ref_json IS NOT NULL
        AND ki.pinned_source_ref_json->>'kind' = $2
        AND ki.pinned_source_ref_json->>$3 = $4`,
    [event.space_id, sourceRefKind(event.source_kind), sourceRefIdKey(event.source_kind), event.source_id],
  );
  const counts: Record<string, number> = { no_impact: 0, candidate_created: 0, already_superseded: 0 };
  for (const item of pinned.rows) {
    // An event describing the exact revision an item is already pinned to is
    // the origin of that pin (e.g. the initial revision emitted before any
    // Candidate existed), not a later change to revalidate against — skip
    // silently, no outcome recorded.
    const eventVersion = objectValue(event.source_ref_json).version;
    const pinnedVersion = (item.pinned_source_ref_json as { version?: number }).version;
    if (typeof eventVersion === "number" && typeof pinnedVersion === "number" && eventVersion <= pinnedVersion) continue;

    const already = await db.query<{ id: string }>(
      `SELECT id FROM knowledge_revalidation_outcomes WHERE knowledge_item_id=$1 AND event_id=$2`,
      [item.object_id, event.id],
    );
    if (already.rows[0]) continue; // already processed for this item — idempotent

    const status = await db.query<{ status: string }>(
      // Knowledge status moved to `knowledge_items` (B12D).
      `SELECT status FROM knowledge_items WHERE object_id=$1 AND space_id=$2`,
      [item.object_id, event.space_id],
    );
    let outcome: "no_impact" | "candidate_created" | "already_superseded";
    let resultingCandidateId: string | null = null;
    if (status.rows[0]?.status === "superseded") {
      outcome = "already_superseded";
    } else {
      const material = await isMaterialChange(db, event, item.pinned_source_ref_json);
      if (!material) {
        outcome = "no_impact";
      } else {
        resultingCandidateId = await createRevalidationCandidate(db, event, item);
        outcome = "candidate_created";
      }
    }
    await db.query(
      `INSERT INTO knowledge_revalidation_outcomes (id, space_id, knowledge_item_id, event_id, outcome, resulting_candidate_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), event.space_id, item.object_id, event.id, outcome, resultingCandidateId, new Date().toISOString()],
    );
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

function sourceRefKind(sourceKind: string): string {
  return sourceKind === "note" ? "note_revision" : "inquiry_thread_revision";
}

function sourceRefIdKey(sourceKind: string): string {
  return sourceKind === "note" ? "note_id" : "thread_id";
}

async function isMaterialChange(db: Queryable, event: OutboxEventRow, pinnedRef: PinnedSourceRef): Promise<boolean> {
  if (event.source_kind === "inquiry_thread") {
    return event.change_significance === "material";
  }
  // Notes: no write-time significance signal — diff the item's own pinned
  // block(s) between its pinned revision and the event's new revision.
  if (pinnedRef.kind !== "note_revision") return true;
  const [pinnedDoc, newDoc] = await Promise.all([
    db.query<{ content_json: unknown }>(`SELECT content_json FROM note_revisions WHERE note_id=$1 AND space_id=$2 AND version=$3`, [pinnedRef.note_id, event.space_id, pinnedRef.version]),
    db.query<{ content_json: unknown }>(`SELECT content_json FROM note_revisions WHERE note_id=$1 AND space_id=$2 AND version=$3`,
      [pinnedRef.note_id, event.space_id, objectValue(event.source_ref_json).version]),
  ]);
  if (!pinnedDoc.rows[0] || !newDoc.rows[0]) return true; // fail safe: missing revision data -> treat as material
  const pinnedBlocks = pmBlocksText(pinnedDoc.rows[0].content_json);
  const newBlocks = pmBlocksText(newDoc.rows[0].content_json);
  const anchors = pinnedRef.block_anchors.length > 0 ? pinnedRef.block_anchors : pinnedBlocks.map((_, index) => index);
  return anchors.some((anchor) => (pinnedBlocks[anchor] ?? "") !== (newBlocks[anchor] ?? ""));
}

async function createRevalidationCandidate(db: Queryable, event: OutboxEventRow, item: PinnedKnowledgeItemRow): Promise<string> {
  const knowledgeItem = await db.query<{ project_id: string | null; knowledge_kind: string }>(
    `SELECT so.primary_project_id AS project_id, ki.knowledge_kind
       FROM knowledge_items ki JOIN space_objects so ON so.id = ki.object_id AND so.space_id = ki.space_id
      WHERE ki.object_id=$1 AND ki.space_id=$2`,
    [item.object_id, event.space_id],
  );
  const projectId = knowledgeItem.rows[0]?.project_id ?? null;
  const candidateKind = knowledgeItem.rows[0]?.knowledge_kind ?? "concept";
  const proposedContent = await contentFromNewSource(db, event, item.pinned_source_ref_json);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO knowledge_promotion_candidates (
       id, space_id, project_id, trigger, source_kind, source_id, source_ref_json,
       candidate_kind, proposed_title, proposed_content, visibility, owner_user_id,
       supersedes_knowledge_item_id, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'revalidation', $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, 'pending', $13, $13)`,
    [id, event.space_id, projectId, event.source_kind, event.source_id, JSON.stringify(event.source_ref_json),
      candidateKind, item.title, proposedContent,
      item.visibility === "space_shared" ? "space_shared" : "private", item.owner_user_id,
      item.object_id, now],
  );
  return id;
}

async function contentFromNewSource(
  db: Queryable,
  event: OutboxEventRow,
  pinnedRef: PinnedSourceRef,
): Promise<string> {
  if (event.source_kind === "note" && pinnedRef.kind === "note_revision") {
    const revisionId = objectValue(event.source_ref_json).revision_id;
    const revision = await db.query<{ content_json: unknown }>(
      `SELECT content_json FROM note_revisions WHERE id=$1 AND note_id=$2 AND space_id=$3`,
      [revisionId, pinnedRef.note_id, event.space_id],
    );
    if (!revision.rows[0]) throw new Error(`Note revision ${String(revisionId)} is missing`);
    const blocks = pmBlocksText(revision.rows[0].content_json);
    const anchors = pinnedRef.block_anchors.length > 0 ? pinnedRef.block_anchors : blocks.map((_, index) => index);
    return anchors.map((anchor) => blocks[anchor] ?? "").filter(Boolean).join("\n\n");
  }
  if (event.source_kind === "inquiry_thread") {
    const revisionId = objectValue(event.source_ref_json).revision_id;
    const revision = await db.query<{ statement: string; state_snapshot_json: unknown }>(
      `SELECT statement, state_snapshot_json FROM inquiry_thread_revisions
        WHERE id=$1 AND thread_id=$2 AND space_id=$3`,
      [revisionId, event.source_id, event.space_id],
    );
    if (!revision.rows[0]) throw new Error(`Inquiry Thread revision ${String(revisionId)} is missing`);
    const state = objectValue(revision.rows[0].state_snapshot_json);
    const details = Object.entries(state)
      .filter(([, value]) => value !== null && value !== "")
      .map(([key, value]) => `${key.replaceAll("_", " ")}: ${String(value)}`);
    return [revision.rows[0].statement, ...details].join("\n\n");
  }
  return itemContentFallback(pinnedRef);
}

function itemContentFallback(ref: PinnedSourceRef): string {
  throw new Error(`Unsupported revalidation source: ${ref.kind}`);
}
