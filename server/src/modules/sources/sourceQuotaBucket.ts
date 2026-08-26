import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export interface QuotaConsumeResult {
  allowed: boolean;
  resetAt?: string;
}

const WINDOW_MS: Record<string, number> = { minute: 60000, hour: 3600000, day: 86400000 };

/**
 * Consumes one unit from a durable quota bucket scoped to the source
 * connection (not the individual backfill plan). Concurrent plans against the
 * same connection therefore share one throttle instead of each getting their
 * own budget, which is the actual protection this quota exists for (avoiding
 * remote rate-limit bans). When plans disagree on the limit for a window, the
 * bucket keeps the most conservative (smallest) limit currently proposed.
 */
export async function consumeConnectionQuota(
  db: Queryable,
  spaceId: string,
  connectionId: string,
  policy: { window?: unknown; limit_count?: unknown } | null | undefined,
): Promise<QuotaConsumeResult> {
  const window = String(policy?.window ?? "minute");
  const limit = Number(policy?.limit_count ?? 10);
  const windowMs = WINDOW_MS[window];
  if (!windowMs || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Invalid persisted backfill quota policy");
  }

  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs).toISOString();
  await db.query(
    `INSERT INTO source_quota_buckets (id, space_id, scope_kind, scope_key, "window", limit_count, used_count, window_started_at, reset_at)
      VALUES ($1,$2,'source_connection',$3,$4,$5,0,$6,$7)
      ON CONFLICT (space_id, scope_kind, scope_key, "window") DO UPDATE SET
       limit_count = LEAST(source_quota_buckets.limit_count, EXCLUDED.limit_count),
       used_count = CASE WHEN source_quota_buckets.reset_at <= now() THEN 0 ELSE source_quota_buckets.used_count END,
       window_started_at = CASE WHEN source_quota_buckets.reset_at <= now() THEN $6 ELSE source_quota_buckets.window_started_at END,
       reset_at = CASE WHEN source_quota_buckets.reset_at <= now() THEN $7 ELSE source_quota_buckets.reset_at END`,
    [randomUUID(), spaceId, connectionId, window, limit, now.toISOString(), resetAt],
  );

  const consumed = await db.query<{ reset_at: string }>(
    `UPDATE source_quota_buckets SET used_count = used_count + 1
      WHERE space_id=$1 AND scope_kind='source_connection' AND scope_key=$2 AND "window"=$3 AND used_count < limit_count
      RETURNING reset_at`,
    [spaceId, connectionId, window],
  );
  if (consumed.rows[0]) return { allowed: true };

  const bucket = await db.query<{ reset_at: string }>(
    `SELECT reset_at FROM source_quota_buckets WHERE space_id=$1 AND scope_kind='source_connection' AND scope_key=$2 AND "window"=$3 FOR UPDATE`,
    [spaceId, connectionId, window],
  );
  return { allowed: false, resetAt: bucket.rows[0]?.reset_at ?? resetAt };
}
