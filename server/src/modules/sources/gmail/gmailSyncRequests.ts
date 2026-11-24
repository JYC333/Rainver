/**
 * Waking a Gmail mailbox sync: a push, a monitor change, a reconnect or the
 * Sources heartbeat. Every path marks the request on the cursor row and
 * queues at most one `gmail_mailbox_sync` Job per connection — and every path
 * honours the row's durable retry floor (`retry_not_before`, set by a failed
 * sync): before it, the request mark is kept but nothing is queued, and the
 * heartbeat queues it once the floor has passed. The sync's own claim checks
 * the same floor, so a Job queued earlier cannot start Google requests early.
 *
 * Kept apart from `gmailMonitors.ts` so the connection installer can use it
 * without an import cycle. Locks only the sync row, so it composes with any
 * caller already holding the owner + Space mutex.
 */
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { withQueryableTransaction, type Queryable } from "../../routeUtils/common.js";

export const GMAIL_SYNC_JOB = "gmail_mailbox_sync" as const;

/**
 * Whether connection `$conn` needs its mailbox sync: an active monitor, or an active application-update
 * automation (ADR 0034), which records every new inbox message without monitor criteria.
 */
export function gmailSyncWantedSql(conn: string): string {
  return `(EXISTS (SELECT 1 FROM gmail_monitor_rules r WHERE r.gmail_connection_id=${conn} AND r.status='active')
    OR EXISTS (SELECT 1 FROM gmail_digests d WHERE d.gmail_connection_id=${conn} AND d.kind='application' AND d.status='active'))`;
}

/** Error codes a reconnect makes stale: they described the connection's authority, not Google's load. */
const AUTHORITY_ERROR_CODES = ["gmail_authority_revoked", "gmail_reauth_required", "gmail_connection_inactive", "gmail_connection_changed", "gmail_not_configured"];

/**
 * Mark a request and queue one sync Job unless one is waiting or running or
 * the retry floor has not passed. Returns whether a Job was queued.
 */
export async function requestGmailMailboxSync(db: Queryable, connectionId: string, reason: "push" | "monitor" | "schedule"): Promise<boolean> {
  const row = (await db.query<{ space_id: string; owner_user_id: string; waiting: boolean }>(
    `SELECT space_id,owner_user_id,(retry_not_before IS NOT NULL AND retry_not_before>clock_timestamp()) AS waiting
       FROM gmail_mailbox_sync_states WHERE gmail_connection_id=$1 FOR UPDATE`, [connectionId])).rows[0];
  if (!row) return false;
  if (reason !== "schedule") {
    await db.query(`UPDATE gmail_mailbox_sync_states SET sync_requested_at=clock_timestamp(),
       last_push_at=CASE WHEN $2 THEN clock_timestamp() ELSE last_push_at END,updated_at=clock_timestamp() WHERE gmail_connection_id=$1`,
      [connectionId, reason === "push"]);
  }
  // Backing off: the mark stays, the heartbeat queues the sync once the floor has passed.
  if (row.waiting) return false;
  const queued = await db.query(`SELECT 1 FROM jobs WHERE space_id=$1 AND job_type=$2 AND payload_json->>'connection_id'=$3 AND status IN ('pending','claimed','running') LIMIT 1`,
    [row.space_id, GMAIL_SYNC_JOB, connectionId]);
  if (queued.rows.length) return false;
  await new PgJobQueueRepository(db).enqueue({ job_type: GMAIL_SYNC_JOB, space_id: row.space_id, user_id: row.owner_user_id, payload: { connection_id: connectionId }, max_attempts: 1 });
  return true;
}

/** Heartbeat: due cursors (schedule elapsed or a request pending, retry floor passed) whose connection is active and has an active monitor. */
export async function enqueueDueGmailMailboxSyncs(db: Queryable, limit = 50): Promise<number> {
  const due = (await db.query<{ gmail_connection_id: string }>(
    `SELECT s.gmail_connection_id FROM gmail_mailbox_sync_states s
       JOIN gmail_connections c ON c.id=s.gmail_connection_id AND c.status='active'
      WHERE (s.next_poll_at<=clock_timestamp() OR s.sync_requested_at IS NOT NULL)
        AND (s.retry_not_before IS NULL OR s.retry_not_before<=clock_timestamp())
        AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp())
        AND ${gmailSyncWantedSql("s.gmail_connection_id")}
      ORDER BY s.next_poll_at LIMIT $1`, [limit])).rows;
  let queued = 0;
  for (const row of due) {
    if (await withQueryableTransaction(db, (tx) => requestGmailMailboxSync(tx, row.gmail_connection_id, "schedule"))) queued += 1;
  }
  return queued;
}

/**
 * Inside the reconnect transaction (same account, row now `active`): a sync
 * parked for lost authority resumes now instead of after its parked interval.
 * Authority error codes and their backoff are cleared; a Google rate-limit or
 * quota floor is not (reconnecting does not change Google's load), and the
 * request then waits for it. The cursor is kept. A sync still holding a lease
 * from the old generation is superseded: the lease is dropped, so that sync
 * can neither settle nor record its failure (or retry floor) afterwards, and
 * the resumed sync need not wait for it to expire.
 */
export async function resumeGmailSyncAfterReconnect(db: Queryable, connectionId: string): Promise<void> {
  const row = (await db.query<{ gmail_connection_id: string }>(
    `UPDATE gmail_mailbox_sync_states
        SET last_error_code=CASE WHEN last_error_code = ANY($2::varchar[]) THEN NULL ELSE last_error_code END,
            retry_not_before=CASE WHEN last_error_code = ANY($2::varchar[]) THEN NULL ELSE retry_not_before END,
            failure_count=CASE WHEN last_error_code = ANY($2::varchar[]) THEN 0 ELSE failure_count END,
            watch_retry_at=NULL,lease_id=NULL,lease_until=NULL,
            next_poll_at=LEAST(next_poll_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE gmail_connection_id=$1
        AND ${gmailSyncWantedSql("$1")}
      RETURNING gmail_connection_id`, [connectionId, AUTHORITY_ERROR_CODES])).rows[0];
  if (row) await requestGmailMailboxSync(db, connectionId, "monitor");
}
