/**
 * Gmail V2 monitors: the owner's private rules, their sync cursor row, the
 * proposal applier that creates them, the owner's commands, the wake-up of a
 * background sync and retention. Every writer takes the Gmail lock order:
 * active person → owner + Space mutex → connection → monitor / sync rows.
 *
 * Privacy is structural, as for connections: every read and write is keyed
 * by the caller as owner; another person's monitor — a Project owner's or a
 * Space admin's included — is the hidden 404. A monitor's optional Project is
 * a context label; it adds no reader.
 */
import { randomUUID } from "node:crypto";
import {
  GmailMonitorProposalPayloadSchema, type GmailMailboxSyncStatus, type GmailMonitor, type GmailMonitorList,
  GMAIL_MONITOR_LIMITS,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { lockActivePerson } from "../../access/activePerson.js";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import { type Queryable } from "../../routeUtils/common.js";
import { hidden, OperationError } from "../../systemActions/operations/errors.js";
import { canReadProject } from "../../projects/access.js";
import { gmailLockedNow, lockGmailOwnerSpace } from "./gmailConnections.js";
import { gmailWebUrl } from "./gmailMessageText.js";
import { parseGmailMonitorCriteria } from "./gmailMonitorCriteria.js";
import { GMAIL_SYNC_LIMITS } from "./gmailSyncContract.js";
import { requestGmailMailboxSync } from "./gmailSyncRequests.js";

export { GMAIL_SYNC_JOB, enqueueDueGmailMailboxSyncs, requestGmailMailboxSync } from "./gmailSyncRequests.js";
type Identity = { spaceId: string; userId: string };

interface MonitorRow {
  id: string; space_id: string; owner_user_id: string; gmail_connection_id: string; project_id: string | null; purpose: string;
  criteria: unknown; status: "active" | "paused"; active_since: string | Date; match_count: number; last_matched_at: string | Date | null;
  created_at: string | Date; updated_at: string | Date;
}
const isoOf = (value: string | Date) => new Date(value).toISOString();
const isoOrNull = (value: string | Date | null) => value === null ? null : isoOf(value);

function monitorDto(row: MonitorRow): GmailMonitor | null {
  const criteria = parseGmailMonitorCriteria(row.criteria);
  if (!criteria) return null;
  return {
    id: row.id, connection_id: row.gmail_connection_id, project_id: row.project_id, purpose: row.purpose, criteria, status: row.status,
    active_since: isoOf(row.active_since), match_count: row.match_count, last_matched_at: isoOrNull(row.last_matched_at),
    created_at: isoOf(row.created_at), updated_at: isoOf(row.updated_at),
  };
}

/**
 * The cursor row a monitor needs. When the connection had no other active
 * monitor, monitoring (re)starts from `baseline`: the current mailbox position
 * plus only mail received since `activeSince`, never the inbox's history.
 */
export async function ensureGmailSyncState(db: Queryable, input: { connectionId: string; spaceId: string; ownerUserId: string; restart: boolean; now: string }): Promise<void> {
  await db.query(
    `INSERT INTO gmail_mailbox_sync_states (gmail_connection_id,space_id,owner_user_id,history_id,state,recovery_after,recovery_partial,
       sync_requested_at,next_poll_at,failure_count,created_at,updated_at)
     VALUES ($1,$2,$3,NULL,'baseline',NULL,false,$4,$4,0,$4,$4)
     ON CONFLICT (gmail_connection_id) DO UPDATE SET
       state=CASE WHEN $5 THEN 'baseline' ELSE gmail_mailbox_sync_states.state END,
       recovery_after=CASE WHEN $5 THEN NULL ELSE gmail_mailbox_sync_states.recovery_after END,
       record_history_id=CASE WHEN $5 THEN NULL ELSE gmail_mailbox_sync_states.record_history_id END,
       record_offset=CASE WHEN $5 THEN 0 ELSE gmail_mailbox_sync_states.record_offset END,
       recovery_partial=CASE WHEN $5 THEN false ELSE gmail_mailbox_sync_states.recovery_partial END,
       sync_requested_at=$4,next_poll_at=LEAST(gmail_mailbox_sync_states.next_poll_at,$4::timestamptz),updated_at=$4`,
    [input.connectionId, input.spaceId, input.ownerUserId, input.now, input.restart],
  );
}

async function otherActiveMonitors(db: Queryable, connectionId: string, exceptId: string | null): Promise<boolean> {
  // An active application-update automation (ADR 0034) keeps the same cursor going.
  return (await db.query(`SELECT 1 FROM gmail_monitor_rules WHERE gmail_connection_id=$1 AND status='active' AND ($2::varchar IS NULL OR id<>$2)
      UNION ALL SELECT 1 FROM gmail_digests WHERE gmail_connection_id=$1 AND kind='application' AND status='active' LIMIT 1`,
    [connectionId, exceptId])).rows.length > 0;
}

/** Owner lock prefix for every monitor write: person, then the owner + Space mutex. */
async function lockOwner(db: Queryable, identity: Identity): Promise<void> {
  try { await lockActivePerson(db, identity.spaceId, identity.userId); } catch { throw hidden(); }
  await lockGmailOwnerSpace(db, identity);
}

async function lockOwnedMonitor(db: Queryable, identity: Identity, monitorId: string): Promise<MonitorRow> {
  const row = (await db.query<MonitorRow>(`SELECT * FROM gmail_monitor_rules WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR UPDATE`,
    [monitorId, identity.spaceId, identity.userId])).rows[0];
  if (!row) throw hidden();
  return row;
}

export async function authorizeGmailMonitorCommand(db: Queryable, identity: Identity, monitorId: string): Promise<void> {
  await lockOwner(db, identity);
  await lockOwnedMonitor(db, identity, monitorId);
}

/** Pause or resume. Resuming starts again from now: mail that arrived while paused never reminds. */
export async function setGmailMonitorStatusIn(db: Queryable, identity: Identity, monitorId: string, status: "active" | "paused") {
  await lockOwner(db, identity);
  const row = await lockOwnedMonitor(db, identity, monitorId);
  if (row.status !== status) {
    const now = await gmailLockedNow(db);
    if (status === "active") {
      const connection = (await db.query<{ status: string }>(`SELECT status FROM gmail_connections WHERE id=$1 FOR SHARE`, [row.gmail_connection_id])).rows[0];
      if (connection?.status !== "active") throw new OperationError("operation_conflict", 409);
      const restart = !(await otherActiveMonitors(db, row.gmail_connection_id, row.id));
      await db.query(`UPDATE gmail_monitor_rules SET status='active',active_since=$2,updated_at=$2 WHERE id=$1`, [row.id, now]);
      await ensureGmailSyncState(db, { connectionId: row.gmail_connection_id, spaceId: row.space_id, ownerUserId: row.owner_user_id, restart, now });
      await requestGmailMailboxSync(db, row.gmail_connection_id, "monitor");
    } else {
      await db.query(`UPDATE gmail_monitor_rules SET status='paused',updated_at=$2 WHERE id=$1`, [row.id, now]);
    }
  }
  return { monitor_id: row.id, space_id: row.space_id, status };
}

/** Hard delete of the owner's monitor; its match ledger cascades. Earlier Inbox pointers stay as history. */
export async function deleteGmailMonitorIn(db: Queryable, identity: Identity, monitorId: string) {
  await lockOwner(db, identity);
  const row = await lockOwnedMonitor(db, identity, monitorId);
  await db.query(`DELETE FROM gmail_monitor_rules WHERE id=$1`, [row.id]);
  return { monitor_id: row.id, space_id: row.space_id, deleted: true as const };
}

/**
 * `gmail_monitor_create` applier. Only the proposal's owner — the person whose
 * turn drafted it — may accept, and only while they still own the connection
 * and it is active; anyone else (Space owner or admin included) is the hidden
 * 404. `active_since` is the acceptance instant on the database clock.
 */
export function registerGmailMonitorProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("gmail_monitor_create", async ({ db, proposal, userId, ownerCardDecision }) => {
    const payload = GmailMonitorProposalPayloadSchema.parse(proposal.payload_json);
    // Only the owner, deciding directly on their card (never an Agent carrying the decision).
    if (!ownerCardDecision || !proposal.owner_user_id || proposal.owner_user_id !== userId || proposal.visibility !== "private") throw hidden();
    const identity = { spaceId: proposal.space_id, userId };
    await lockOwner(db, identity);
    const connection = (await db.query<{ id: string; status: string }>(
      `SELECT id,status FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
      [payload.connection_id, identity.spaceId, userId])).rows[0];
    if (!connection) throw hidden();
    if (connection.status !== "active") throw new OperationError("operation_conflict", 409);
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gmail_monitor_rules WHERE gmail_connection_id=$1`, [connection.id])).rows[0]!.n;
    if (count >= GMAIL_MONITOR_LIMITS.rulesPerConnection) throw new OperationError("operation_conflict", 409);
    // The Project is a label the owner can still read; otherwise the monitor simply carries none.
    const projectId = payload.target_project_id && await canReadProject(db, identity.spaceId, payload.target_project_id, userId) ? payload.target_project_id : null;
    const restart = !(await otherActiveMonitors(db, connection.id, null));
    const now = await gmailLockedNow(db);
    const id = randomUUID();
    await db.query(
      `INSERT INTO gmail_monitor_rules (id,space_id,owner_user_id,gmail_connection_id,project_id,purpose,criteria,status,active_since,proposal_id,
         match_count,last_matched_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active',$8,$9,0,NULL,$8,$8)`,
      [id, identity.spaceId, userId, connection.id, projectId, payload.purpose.trim(), JSON.stringify(payload.criteria), now, proposal.id]);
    await ensureGmailSyncState(db, { connectionId: connection.id, spaceId: identity.spaceId, ownerUserId: userId, restart, now });
    await requestGmailMailboxSync(db, connection.id, "monitor");
    return { result_type: "gmail_monitor", result: { monitor_id: id, connection_id: connection.id } };
  });
}

/** The caller's monitors, content-free sync status and recent match ids/links. */
export async function listGmailMonitors(db: Queryable, config: ServerConfig, identity: Identity): Promise<GmailMonitorList> {
  const monitors = (await db.query<MonitorRow>(
    `SELECT r.* FROM gmail_monitor_rules r WHERE r.space_id=$1 AND r.owner_user_id=$2 ORDER BY r.created_at DESC,r.id LIMIT 1000`,
    [identity.spaceId, identity.userId])).rows.map(monitorDto).filter((row): row is GmailMonitor => row !== null);
  const sync = (await db.query<{
    gmail_connection_id: string; state: GmailMailboxSyncStatus["state"]; last_success_at: string | Date | null; next_poll_at: string | Date;
    recovery_partial: boolean; last_error_code: string | null; watch_expires_at: string | Date | null; watch_error_code: string | null; now: string | Date;
  }>(
    `SELECT s.*,clock_timestamp() AS now FROM gmail_mailbox_sync_states s
       JOIN gmail_connections c ON c.id=s.gmail_connection_id AND c.space_id=$1 AND c.owner_user_id=$2
      ORDER BY s.created_at LIMIT 100`, [identity.spaceId, identity.userId])).rows.map((row): GmailMailboxSyncStatus => ({
    connection_id: row.gmail_connection_id, state: row.state,
    // A watch whose last renewal failed is not shown as active, even before its old expiry.
    push: !config.gmailPush ? "not_configured"
      : row.watch_error_code === null && row.watch_expires_at !== null && new Date(row.watch_expires_at) > new Date(row.now) ? "active" : "inactive",
    last_success_at: isoOrNull(row.last_success_at), next_check_at: isoOf(row.next_poll_at), recovery_partial: row.recovery_partial,
    last_error_code: row.last_error_code && /^gmail_[a-z_]{1,58}$/.test(row.last_error_code) ? row.last_error_code : null,
  }));
  const recent = (await db.query<{ rule_id: string; google_message_id: string; matched_at: string | Date; mailbox_email: string }>(
    `SELECT m.rule_id,m.google_message_id,m.matched_at,c.mailbox_email FROM gmail_monitor_matches m
       JOIN gmail_monitor_rules r ON r.id=m.rule_id JOIN gmail_connections c ON c.id=r.gmail_connection_id
      WHERE m.space_id=$1 AND m.owner_user_id=$2 ORDER BY m.matched_at DESC,m.google_message_id LIMIT 50`,
    [identity.spaceId, identity.userId])).rows.map((row) => ({
    monitor_id: row.rule_id, google_message_id: row.google_message_id, gmail_url: gmailWebUrl(row.mailbox_email, row.google_message_id), matched_at: isoOf(row.matched_at),
  }));
  return { push_configured: config.gmailPush !== null, monitors, sync, recent_matches: recent };
}

/** Retention of the dedup ledger: far older than any history overlap or recovery window. */
export async function pruneGmailMonitorMatches(db: Queryable, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - GMAIL_SYNC_LIMITS.matchRetentionDays * 86_400_000).toISOString();
  return (await db.query(`DELETE FROM gmail_monitor_matches WHERE matched_at<$1`, [cutoff])).rowCount ?? 0;
}
