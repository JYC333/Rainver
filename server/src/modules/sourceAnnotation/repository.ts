import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import type { AnnotationPromptItem } from "./instruction.js";
import type { ParsedItemAnnotation } from "./resultParser.js";
import {
  ANNOTATION_CONDITION_REASONS,
  ANNOTATION_MAX_ATTEMPTS_PER_EPISODE,
  ANNOTATION_RETRY_DELAYS_MS,
  type AnnotationWaitReason,
} from "./retryPolicy.js";

export const SOURCE_ANNOTATION_JOB_TYPE = "source_annotation_event";

export type SourceAnnotationStatus = "pending" | "succeeded" | "failed" | "skipped";

/** One failure episode as one responsible person sees it: their items only. */
export interface AnnotationEpisodeSummary {
  episode_id: string;
  wait_reason: AnnotationWaitReason;
  responsible_user_id: string | null;
  affected_count: number;
  /** The earliest scheduled retry among the rows, when one is scheduled. */
  next_retry_at: string | null;
  connection_ids: string[];
}

/** A pending row that may run now: no wait, or a scheduled retry whose time has come. */
const RUNNABLE_CLAUSE = `(a.status = 'pending' AND (a.wait_reason IS NULL OR (a.wait_reason = 'retry_scheduled' AND a.next_retry_at <= now())))`;

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
  wait_reason: AnnotationWaitReason | null;
  next_retry_at: string | null;
  episode_id: string | null;
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
      `WITH per_item AS (
         SELECT DISTINCT ON (i.id) i.id AS source_item_id, channel.id AS source_channel_id,
                COALESCE(i.occurred_at,i.first_seen_at) AS recency
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
          ORDER BY i.id, channel.id
       ),
       -- One channel per item first, then the most recent items: DISTINCT ON
       -- forces the item id to lead its ORDER BY, so a LIMIT there picks by id.
       candidates AS (
         SELECT source_item_id, source_channel_id
           FROM per_item
          ORDER BY recency DESC NULLS LAST, source_item_id
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
          AND ${RUNNABLE_CLAUSE}
          AND i.deleted_at IS NULL
        ORDER BY a.next_retry_at ASC NULLS FIRST, a.created_at ASC, a.id ASC
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
              -- A success ends whatever wait the row was in: it leaves its
              -- retry schedule and failure episode.
              wait_reason = NULL,
              next_retry_at = NULL,
              episode_id = NULL,
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
   * Records a failed attempt and schedules the next one, or pauses the row.
   *
   * The attempt spends one of the episode's budget. Below the cap the row stays
   * `pending` with `retry_scheduled` and a `next_retry_at` from the bounded
   * delay table; at the cap it becomes `failed` / `budget_exhausted` and
   * waits for a person. Every row of the batch joins the space's open
   * transient episode, or starts one, so one notification covers them all.
   */
  async markAttemptFailed(
    spaceId: string,
    itemIds: readonly string[],
    error: Record<string, unknown>,
    runId: string | null,
  ): Promise<void> {
    if (itemIds.length === 0) return;
    const delaysSeconds = ANNOTATION_RETRY_DELAYS_MS.map((ms) => Math.round(ms / 1000));
    await this.db.query(
      `WITH episode AS (
         SELECT COALESCE(
                  (SELECT e.episode_id FROM source_item_annotations e
                    WHERE e.space_id = $1 AND e.episode_id IS NOT NULL
                      AND e.wait_reason IN ('retry_scheduled', 'budget_exhausted')
                    ORDER BY e.updated_at DESC LIMIT 1),
                  $7::varchar) AS id
       )
       UPDATE source_item_annotations a
          SET attempt_count = a.attempt_count + 1,
              status = CASE WHEN a.attempt_count + 1 >= $4 THEN 'failed' ELSE 'pending' END,
              wait_reason = CASE WHEN a.attempt_count + 1 >= $4 THEN 'budget_exhausted' ELSE 'retry_scheduled' END,
              next_retry_at = CASE WHEN a.attempt_count + 1 >= $4 THEN NULL
                                   ELSE $6::timestamptz + make_interval(secs => ($8::int[])[a.attempt_count + 1]) END,
              episode_id = COALESCE(a.episode_id, episode.id),
              error_json = $3::jsonb,
              annotation_run_id = COALESCE($5, a.annotation_run_id),
              updated_at = $6
         FROM episode
        WHERE a.space_id = $1 AND a.source_item_id = ANY($2::text[]) AND a.status = 'pending'`,
      [spaceId, itemIds, JSON.stringify(error), ANNOTATION_MAX_ATTEMPTS_PER_EPISODE, runId,
        new Date().toISOString(), randomUUID(), delaysSeconds],
    );
  }

  /**
   * Parks rows on a condition outside them — no annotator Provider, egress
   * refused for their Source, consent missing. No attempt is spent: the next
   * sweep re-checks the condition and reopens them when it holds. They join
   * the space's open episode for that reason, or start one.
   */
  async markWaiting(
    spaceId: string,
    itemIds: readonly string[],
    reason: Exclude<AnnotationWaitReason, "retry_scheduled" | "budget_exhausted">,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    if (itemIds.length === 0) return;
    await this.db.query(
      `WITH episode AS (
         SELECT COALESCE(
                  (SELECT e.episode_id FROM source_item_annotations e
                    WHERE e.space_id = $1 AND e.episode_id IS NOT NULL AND e.wait_reason = $3
                    ORDER BY e.updated_at DESC LIMIT 1),
                  $5::varchar) AS id
       )
       UPDATE source_item_annotations a
          SET wait_reason = $3,
              next_retry_at = NULL,
              episode_id = COALESCE(a.episode_id, episode.id),
              error_json = $4::jsonb,
              updated_at = $6
         FROM episode
        WHERE a.space_id = $1 AND a.source_item_id = ANY($2::text[]) AND a.status = 'pending'`,
      [spaceId, itemIds, reason, JSON.stringify({ reason, ...detail }), randomUUID(), new Date().toISOString()],
    );
  }

  /** Items the model returned nothing usable for; not retried. */
  async markSkipped(spaceId: string, itemIds: readonly string[], reason: string, runId: string | null): Promise<void> {
    if (itemIds.length === 0) return;
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE source_item_annotations
          SET status = 'skipped',
              wait_reason = NULL,
              next_retry_at = NULL,
              episode_id = NULL,
              error_json = $3::jsonb,
              annotation_run_id = COALESCE($4, annotation_run_id),
              updated_at = $5
        WHERE space_id = $1 AND source_item_id = ANY($2::text[]) AND status = 'pending'`,
      [spaceId, itemIds, JSON.stringify({ reason }), runId, now],
    );
  }

  /**
   * Reopens parked rows, bounded.
   *
   * A condition recovery (the Provider is back, consent was granted) reopens
   * rows waiting on that reason and keeps their episode and attempt count: the
   * recovery round that follows is still bounded by the episode budget. A
   * manual retry may also reopen `budget_exhausted` rows; it starts a new
   * episode for them, which is the one way the count resets. Only rows that
   * never succeeded are touched, at most `limit`, optionally one connection
   * or an explicit set of items.
   */
  async requeueParked(
    spaceId: string,
    filter: {
      reasons: readonly AnnotationWaitReason[];
      connectionId?: string | null;
      itemIds?: readonly string[] | null;
      episodeId?: string | null;
      /** Only rows this person is responsible for: their connection's items, or their own saved URLs. */
      responsibleUserId?: string | null;
      limit: number;
    },
  ): Promise<number> {
    if (filter.reasons.length === 0 || filter.limit < 1) return 0;
    const result = await this.db.query(
      `WITH chosen AS (
         SELECT a.id, a.wait_reason
           FROM source_item_annotations a
           JOIN source_items i ON i.id = a.source_item_id AND i.space_id = a.space_id
           LEFT JOIN source_connections c ON c.id = i.connection_id AND c.space_id = i.space_id
          WHERE a.space_id = $1
            AND ($8::text IS NULL OR COALESCE(c.owner_user_id, i.owner_user_id) = $8)
            AND a.wait_reason = ANY($2::text[])
            AND a.status IN ('pending', 'failed')
            AND i.deleted_at IS NULL
            AND ($3::text IS NULL OR i.connection_id = $3)
            AND ($4::text[] IS NULL OR a.source_item_id = ANY($4::text[]))
            AND ($5::text IS NULL OR a.episode_id = $5)
          ORDER BY a.created_at ASC, a.id ASC
          LIMIT $6
          FOR UPDATE OF a SKIP LOCKED
       )
       UPDATE source_item_annotations a
          SET status = 'pending',
              wait_reason = NULL,
              next_retry_at = NULL,
              attempt_count = CASE WHEN chosen.wait_reason = 'budget_exhausted' THEN 0 ELSE a.attempt_count END,
              episode_id = CASE WHEN chosen.wait_reason = 'budget_exhausted' THEN NULL ELSE a.episode_id END,
              error_json = NULL,
              updated_at = $7
         FROM chosen
        WHERE a.id = chosen.id`,
      [spaceId, filter.reasons, filter.connectionId ?? null, filter.itemIds ?? null, filter.episodeId ?? null,
        filter.limit, new Date().toISOString(), filter.responsibleUserId ?? null],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Open failure episodes, one row per episode and responsible person: the
   * owner of the connection an item came through, or of the item itself for a
   * saved URL. Counts are that person's items only, so a notification never
   * tells one member how much of another's material is waiting.
   */
  async episodeSummaries(spaceId: string, filter: { responsibleUserId?: string | null; episodeId?: string | null } = {}): Promise<AnnotationEpisodeSummary[]> {
    const result = await this.db.query<{
      episode_id: string;
      wait_reason: AnnotationWaitReason;
      responsible_user_id: string | null;
      affected_count: string;
      next_retry_at: string | null;
      connection_ids: string[] | null;
    }>(
      `SELECT a.episode_id, a.wait_reason,
              COALESCE(c.owner_user_id, i.owner_user_id) AS responsible_user_id,
              COUNT(*)::text AS affected_count,
              MIN(a.next_retry_at) AS next_retry_at,
              array_remove(array_agg(DISTINCT i.connection_id), NULL) AS connection_ids
         FROM source_item_annotations a
         JOIN source_items i ON i.id = a.source_item_id AND i.space_id = a.space_id
         LEFT JOIN source_connections c ON c.id = i.connection_id AND c.space_id = i.space_id
        WHERE a.space_id = $1
          AND a.episode_id IS NOT NULL
          AND a.wait_reason IS NOT NULL
          AND i.deleted_at IS NULL
          AND ($2::text IS NULL OR COALESCE(c.owner_user_id, i.owner_user_id) = $2)
          AND ($3::text IS NULL OR a.episode_id = $3)
        GROUP BY a.episode_id, a.wait_reason, COALESCE(c.owner_user_id, i.owner_user_id)
        ORDER BY a.episode_id, a.wait_reason`,
      [spaceId, filter.responsibleUserId ?? null, filter.episodeId ?? null],
    );
    return result.rows.map((row) => ({
      episode_id: row.episode_id,
      wait_reason: row.wait_reason,
      responsible_user_id: row.responsible_user_id,
      affected_count: Number(row.affected_count),
      next_retry_at: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
      connection_ids: row.connection_ids ?? [],
    }));
  }

  /** Connections whose items wait on `reason`, for the sweep to re-check the condition per connection. */
  async waitingConnectionIds(spaceId: string, reasons: readonly AnnotationWaitReason[]): Promise<string[]> {
    const result = await this.db.query<{ connection_id: string }>(
      `SELECT DISTINCT i.connection_id
         FROM source_item_annotations a
         JOIN source_items i ON i.id = a.source_item_id AND i.space_id = a.space_id
        WHERE a.space_id = $1 AND a.status = 'pending' AND a.wait_reason = ANY($2::text[])
          AND i.connection_id IS NOT NULL AND i.deleted_at IS NULL`,
      [spaceId, reasons],
    );
    return result.rows.map((row) => row.connection_id);
  }

  /**
   * Spaces with rows waiting on a condition the sweep can re-check, the next
   * `limit` after `afterSpaceId` in id order, wrapping round. A row whose
   * condition still holds does not change, so any order read from the rows
   * would hand the same spaces to every sweep and starve the rest once more
   * than `limit` are stuck; the caller carries the cursor between sweeps.
   */
  async spacesWithWaitingConditions(limit: number, afterSpaceId: string | null = null): Promise<string[]> {
    const select = (after: string | null, count: number) => this.db.query<{ space_id: string }>(
      `SELECT DISTINCT space_id
         FROM source_item_annotations
        WHERE status = 'pending' AND wait_reason = ANY($2::text[])
          AND ($3::text IS NULL OR space_id > $3)
        ORDER BY space_id
        LIMIT $1`,
      [count, ANNOTATION_CONDITION_REASONS, after],
    );
    const first = (await select(afterSpaceId, limit)).rows.map((row) => row.space_id);
    if (first.length >= limit || afterSpaceId === null) return first;
    const wrapped = (await select(null, limit - first.length)).rows
      .map((row) => row.space_id)
      .filter((spaceId) => !first.includes(spaceId));
    return [...first, ...wrapped];
  }

  async getByItemId(spaceId: string, sourceItemId: string): Promise<SourceAnnotationRow | null> {
    const result = await this.db.query<SourceAnnotationRow & { topic_candidates_json: unknown }>(
      `SELECT id, space_id, source_item_id, status, domain_key, depth, genre, summary,
              topic_candidates_json, stance_target, stance_target_key, stance_polarity,
              stance_confidence, annotation_run_id, attempt_count, wait_reason, next_retry_at, episode_id, annotated_at
         FROM source_item_annotations
        WHERE space_id = $1 AND source_item_id = $2`,
      [spaceId, sourceItemId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, topic_candidates: stringArray(row.topic_candidates_json) };
  }

  /** Spaces with annotation work that may run now, for the sweep. */
  async spacesWithPendingWork(limit: number): Promise<string[]> {
    const result = await this.db.query<{ space_id: string }>(
      `SELECT DISTINCT a.space_id
         FROM source_item_annotations a
        WHERE ${RUNNABLE_CLAUSE}
        ORDER BY a.space_id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.space_id);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
