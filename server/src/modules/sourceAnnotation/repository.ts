import type { Queryable } from "../routeUtils/common";
import type { AnnotationPromptItem } from "./instruction";
import type { ParsedItemAnnotation } from "./resultParser";

export const SOURCE_ANNOTATION_JOB_TYPE = "source_annotation_event";

export type SourceAnnotationStatus = "pending" | "succeeded" | "failed" | "skipped";

export type PendingAnnotationRow = AnnotationPromptItem;

export interface SourceAnnotationRow {
  id: string;
  space_id: string;
  source_item_id: string;
  status: SourceAnnotationStatus;
  domain_key: string | null;
  depth: string | null;
  genre: string | null;
  summary: string | null;
  topic_candidates: string[];
  stance_target: string | null;
  stance_target_key: string | null;
  stance_polarity: string | null;
  stance_confidence: number | null;
  annotation_run_id: string | null;
  attempt_count: number;
  annotated_at: string | null;
}

export class PgSourceAnnotationRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Records that these items need annotating.
   *
   * Idempotent per (space, item): a rescan that re-materializes the same item,
   * two channels carrying the same deduped item, and a retried scan job all
   * converge on one row. `ON CONFLICT DO NOTHING` rather than an upsert on
   * purpose — re-queueing an item that already succeeded would pay for the same
   * annotation twice and churn the coverage distribution.
   */
  async enqueueItems(
    spaceId: string,
    itemIds: readonly string[],
    sourceChannelId: string | null,
  ): Promise<number> {
    if (itemIds.length === 0) return 0;
    const now = new Date().toISOString();
    const result = await this.db.query(
      `INSERT INTO source_item_annotations
         (id, space_id, source_item_id, source_channel_id, status, topic_candidates_json, attempt_count, created_at, updated_at)
       SELECT gen_random_uuid()::text, $1, item_id, $2, 'pending', '[]'::jsonb, 0, $3, $3
         FROM unnest($4::text[]) AS item_id
       ON CONFLICT (space_id, source_item_id) DO NOTHING`,
      [spaceId, sourceChannelId, now, itemIds],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Enqueues items a scan just brought in, identified by channel or connection
   * and a recency window rather than by id.
   *
   * The scan workers report how many items they created, not which ones, and
   * threading ids back through three materialization paths to serve one
   * consumer buys nothing the window does not already give: `ON CONFLICT DO
   * NOTHING` makes re-covering the same items free, and a scan that overlaps a
   * previous one simply finds those rows present.
   *
   * The window is what keeps this from being a backfill. Without it, the first
   * scan after deployment would enqueue an established instance's entire
   * history — and history backfill is an explicit, separately budgeted action,
   * not something a routine scan should trigger.
   */
  async enqueueRecentItems(
    spaceId: string,
    scope: { sourceChannelId: string | null; sourceConnectionId: string | null },
    since: string,
  ): Promise<number> {
    const now = new Date().toISOString();
    if (scope.sourceChannelId) {
      const result = await this.db.query(
        `INSERT INTO source_item_annotations
           (id, space_id, source_item_id, source_channel_id, status, topic_candidates_json, attempt_count, created_at, updated_at)
         SELECT gen_random_uuid()::text, $1::varchar, i.id, $2::varchar, 'pending', '[]'::jsonb, 0, $3, $3
           FROM source_items i
           JOIN source_channel_item_links l
             ON l.source_item_id = i.id AND l.space_id = i.space_id
          WHERE i.space_id = $1::varchar
            AND l.source_channel_id = $2::varchar
            AND i.deleted_at IS NULL
            AND i.first_seen_at >= $4
         ON CONFLICT (space_id, source_item_id) DO NOTHING`,
        [spaceId, scope.sourceChannelId, now, since],
      );
      return result.rowCount ?? 0;
    }
    if (!scope.sourceConnectionId) return 0;
    const result = await this.db.query(
      `INSERT INTO source_item_annotations
         (id, space_id, source_item_id, source_channel_id, status, topic_candidates_json, attempt_count, created_at, updated_at)
       SELECT gen_random_uuid()::text, $1::varchar, i.id, NULL, 'pending', '[]'::jsonb, 0, $3, $3
         FROM source_items i
        WHERE i.space_id = $1::varchar
          AND i.connection_id = $2::varchar
          AND i.deleted_at IS NULL
          AND i.first_seen_at >= $4
       ON CONFLICT (space_id, source_item_id) DO NOTHING`,
      [spaceId, scope.sourceConnectionId, now, since],
    );
    return result.rowCount ?? 0;
  }

  /** Explicit, bounded accelerator for pre-annotation subscription history. */
  async enqueueSubscriptionHistory(spaceId: string, userId: string, limit: number): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `WITH candidates AS (
         SELECT DISTINCT ON (i.id) i.id AS source_item_id, channel.id AS source_channel_id
           FROM source_channel_user_subscriptions subscription
           JOIN source_channels channel
             ON channel.id=subscription.source_channel_id AND channel.space_id=subscription.space_id
           JOIN source_channel_item_links link
             ON link.source_channel_id=channel.id AND link.space_id=channel.space_id AND link.status='active'
           JOIN source_items i
             ON i.id=link.source_item_id AND i.space_id=link.space_id AND i.deleted_at IS NULL
          WHERE subscription.space_id=$1 AND subscription.user_id=$2
            AND subscription.status='subscribed'
            AND NOT EXISTS (
              SELECT 1 FROM source_item_annotations annotation
               WHERE annotation.space_id=i.space_id AND annotation.source_item_id=i.id
            )
          ORDER BY i.id, COALESCE(i.occurred_at,i.first_seen_at) DESC
          LIMIT $3
       )
       INSERT INTO source_item_annotations
         (id,space_id,source_item_id,source_channel_id,status,topic_candidates_json,attempt_count,created_at,updated_at)
       SELECT gen_random_uuid()::text,$1,source_item_id,source_channel_id,'pending','[]'::jsonb,0,$4,$4 FROM candidates
       ON CONFLICT (space_id,source_item_id) DO NOTHING`,
      [spaceId, userId, limit, now],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Oldest pending items in a space, with the fields the prompt needs.
   *
   * Deleted items are excluded here rather than filtered later: an item deleted
   * between scan and annotation would otherwise be sent to a model after the
   * user removed it.
   */
  async loadPendingBatch(spaceId: string, limit: number): Promise<PendingAnnotationRow[]> {
    const result = await this.db.query<{
      id: string;
      title: string;
      excerpt: string | null;
      author: string | null;
      source_domain: string | null;
      occurred_at: string | null;
    }>(
      `SELECT i.id,
              i.title,
              i.excerpt,
              i.author,
              i.source_domain,
              i.occurred_at
         FROM source_item_annotations a
         JOIN source_items i ON i.id = a.source_item_id AND i.space_id = a.space_id
        WHERE a.space_id = $1
          AND a.status = 'pending'
          AND i.deleted_at IS NULL
        ORDER BY a.created_at ASC, a.id ASC
        LIMIT $2`,
      [spaceId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      excerpt: row.excerpt,
      author: row.author,
      source_domain: row.source_domain,
      occurred_at: row.occurred_at,
    }));
  }

  /**
   * The connection the batch's items came through.
   *
   * Egress consent is a property of the connection, so a batch spanning several
   * connections has to be gated per connection. Returned grouped rather than
   * as one connection id, because a deduped item can legitimately belong to
   * several.
   */
  async connectionIdsForItems(spaceId: string, itemIds: readonly string[]): Promise<Map<string, string[]>> {
    if (itemIds.length === 0) return new Map();
    const result = await this.db.query<{ connection_id: string; source_item_id: string }>(
      `SELECT DISTINCT c.connection_id, c.source_item_id
         FROM (
           SELECT i.connection_id, i.id AS source_item_id
             FROM source_items i
            WHERE i.space_id = $1 AND i.id = ANY($2::text[]) AND i.connection_id IS NOT NULL
            UNION
           SELECT s.connection_id, s.source_item_id
             FROM source_snapshots s
            WHERE s.space_id = $1 AND s.source_item_id = ANY($2::text[]) AND s.connection_id IS NOT NULL
         ) c`,
      [spaceId, itemIds],
    );
    const byConnection = new Map<string, string[]>();
    for (const row of result.rows) {
      const items = byConnection.get(row.connection_id) ?? [];
      items.push(row.source_item_id);
      byConnection.set(row.connection_id, items);
    }
    return byConnection;
  }

  async markSucceeded(
    spaceId: string,
    annotation: ParsedItemAnnotation,
    runId: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE source_item_annotations
          SET status = 'succeeded',
              domain_key = $3,
              depth = $4,
              genre = $5,
              summary = $6,
              topic_candidates_json = $7::jsonb,
              stance_target = $8,
              stance_target_key = $9,
              stance_polarity = $10,
              stance_confidence = $11,
              annotation_run_id = $12,
              error_json = NULL,
              annotated_at = $13,
              updated_at = $13
        WHERE space_id = $1 AND source_item_id = $2`,
      [
        spaceId,
        annotation.source_item_id,
        annotation.domain_key,
        annotation.depth,
        annotation.genre,
        annotation.summary || null,
        JSON.stringify(annotation.topic_candidates),
        annotation.stance_target,
        annotation.stance_target_key,
        annotation.stance_polarity,
        annotation.stance_confidence,
        runId,
        now,
      ],
    );
  }

  /**
   * Records a failed attempt.
   *
   * Rows stay `pending` while attempts remain so the next sweep retries them,
   * and flip to `failed` once the budget is spent. A permanently `failed` row
   * is what makes "this item never reached the digest" answerable; leaving it
   * `pending` forever would make the queue grow silently instead.
   */
  async markAttemptFailed(
    spaceId: string,
    itemIds: readonly string[],
    error: Record<string, unknown>,
    maxAttempts: number,
    runId: string | null,
  ): Promise<void> {
    if (itemIds.length === 0) return;
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE source_item_annotations
          SET attempt_count = attempt_count + 1,
              status = CASE WHEN attempt_count + 1 >= $4 THEN 'failed' ELSE 'pending' END,
              error_json = $3::jsonb,
              annotation_run_id = COALESCE($5, annotation_run_id),
              updated_at = $6
        WHERE space_id = $1 AND source_item_id = ANY($2::text[]) AND status = 'pending'`,
      [spaceId, itemIds, JSON.stringify(error), maxAttempts, runId, now],
    );
  }

  /** Items the model returned nothing usable for; not retried. */
  async markSkipped(spaceId: string, itemIds: readonly string[], reason: string, runId: string | null): Promise<void> {
    if (itemIds.length === 0) return;
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE source_item_annotations
          SET status = 'skipped',
              error_json = $3::jsonb,
              annotation_run_id = COALESCE($4, annotation_run_id),
              updated_at = $5
        WHERE space_id = $1 AND source_item_id = ANY($2::text[]) AND status = 'pending'`,
      [spaceId, itemIds, JSON.stringify({ reason }), runId, now],
    );
  }

  /**
   * Returns parked rows to the queue.
   *
   * Both terminal states are reachable from a condition the user can change
   * later — `source_egress_denied` from a consent setting they may relax, and
   * `failed` from a provider outage that ends. Without a way back, flipping the
   * setting would annotate everything arriving afterwards while everything that
   * arrived during the denial stays permanently invisible to the digest, and
   * nothing about the resulting gap would look broken.
   *
   * Attempts reset, because the next run is retrying a different world.
   */
  async requeueParked(
    spaceId: string,
    filter: { statuses?: readonly SourceAnnotationStatus[]; reason?: string } = {},
  ): Promise<number> {
    const statuses = filter.statuses ?? (["failed", "skipped"] as const);
    const result = await this.db.query(
      `UPDATE source_item_annotations
          SET status = 'pending',
              attempt_count = 0,
              error_json = NULL,
              updated_at = $3
        WHERE space_id = $1
          AND status = ANY($2::text[])
          AND ($4::text IS NULL OR error_json->>'reason' = $4 OR error_json->>'error_code' = $4)`,
      [spaceId, statuses, new Date().toISOString(), filter.reason ?? null],
    );
    return result.rowCount ?? 0;
  }

  async getByItemId(spaceId: string, sourceItemId: string): Promise<SourceAnnotationRow | null> {
    const result = await this.db.query<SourceAnnotationRow & { topic_candidates_json: unknown }>(
      `SELECT id, space_id, source_item_id, status, domain_key, depth, genre, summary,
              topic_candidates_json, stance_target, stance_target_key, stance_polarity,
              stance_confidence, annotation_run_id, attempt_count, annotated_at
         FROM source_item_annotations
        WHERE space_id = $1 AND source_item_id = $2`,
      [spaceId, sourceItemId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, topic_candidates: stringArray(row.topic_candidates_json) };
  }

  /** Spaces with pending annotation work, for the sweep. */
  async spacesWithPendingWork(limit: number): Promise<string[]> {
    const result = await this.db.query<{ space_id: string }>(
      `SELECT DISTINCT space_id
         FROM source_item_annotations
        WHERE status = 'pending'
        ORDER BY space_id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.space_id);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
