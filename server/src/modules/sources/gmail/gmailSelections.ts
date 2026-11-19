/**
 * Owner-only reader and remover of `gmail_project_thread_selections`: a
 * person's references to their own Gmail threads inside a Project, left from
 * the retired manual search/select flow (Gmail V2 removed adding them). Rows
 * are keyed by the caller as owner everywhere; nobody else — Project owner,
 * Space admin or another member — can list, read or remove them (hidden 404).
 * Remove is a hard delete under the owner + Space mutex and needs no Project
 * access, so a person who lost access can still clean up. Selections store no
 * subject, snippet, address or body.
 */
import type { GmailThreadSelection } from "@rainver/protocol";
import { accessibleProjectIds } from "../../projects/access.js";
import type { Queryable } from "../../routeUtils/common.js";
import { hidden } from "../../systemActions/operations/errors.js";
import { lockGmailOwnerSpace } from "./gmailConnections.js";
import { gmailWebUrl } from "./gmailMessageText.js";
import { withGmailReadTransaction, type GmailPageScope } from "./gmailReadDeadline.js";

type Identity = { spaceId: string; userId: string };

/** Locks the caller's own selection under the mutex; anything else is the hidden 404. */
export async function lockOwnedGmailSelection(db: Queryable, identity: Identity, selectionId: string): Promise<void> {
  await lockGmailOwnerSpace(db, identity);
  const row = await db.query(`SELECT 1 FROM gmail_project_thread_selections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR UPDATE`,
    [selectionId, identity.spaceId, identity.userId]);
  if (!row.rows.length) throw hidden();
}

export async function removeGmailSelectionIn(db: Queryable, identity: Identity, selectionId: string) {
  await lockOwnedGmailSelection(db, identity, selectionId);
  await db.query(`DELETE FROM gmail_project_thread_selections WHERE id=$1`, [selectionId]);
  return { selection_id: selectionId, space_id: identity.spaceId, removed: true as const };
}

/** The caller's own selections in the active Space, optionally narrowed to a Project or connection. */
export async function listGmailSelections(db: Queryable, identity: Identity, filter: { projectId?: string; connectionId?: string }): Promise<GmailThreadSelection[]> {
  const rows = (await db.query<{
    id: string; project_id: string; gmail_connection_id: string; google_thread_id: string; mailbox_email: string;
    read_after: string | Date | null; read_before: string | Date | null; created_at: string | Date; updated_at: string | Date;
  }>(
    `SELECT s.id,s.project_id,s.gmail_connection_id,s.google_thread_id,c.mailbox_email,s.read_after,s.read_before,s.created_at,s.updated_at
       FROM gmail_project_thread_selections s
       JOIN gmail_connections c ON c.id=s.gmail_connection_id AND c.space_id=s.space_id AND c.owner_user_id=s.owner_user_id
      WHERE s.owner_user_id=$1 AND s.space_id=$2 AND ($3::varchar IS NULL OR s.project_id=$3) AND ($4::varchar IS NULL OR s.gmail_connection_id=$4)
      ORDER BY s.created_at, s.id LIMIT 1000`,
    [identity.userId, identity.spaceId, filter.projectId ?? null, filter.connectionId ?? null],
  )).rows;
  const readable = await accessibleProjectIds(db, identity.spaceId, identity.userId, rows.map((r) => r.project_id));
  const iso = (value: string | Date) => new Date(value).toISOString();
  return rows.map((r) => ({
    id: r.id, project_id: r.project_id, connection_id: r.gmail_connection_id, google_thread_id: r.google_thread_id,
    read_after: r.read_after ? iso(r.read_after) : null, read_before: r.read_before ? iso(r.read_before) : null,
    project_readable: readable.has(r.project_id), gmail_url: gmailWebUrl(r.mailbox_email, r.google_thread_id),
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  }));
}

/** The caller's own owner-read audit in the active Space, newest first. */
export async function listGmailReadAudit(db: Queryable, identity: Identity) {
  const rows = (await db.query<{
    id: string; gmail_connection_id: string | null; project_id: string | null; selection_id: string | null; operation: "thread_search" | "thread_read";
    google_thread_id: string | null; item_count: number; truncated: boolean; accessed_at: string | Date;
  }>(
    `SELECT id,gmail_connection_id,project_id,selection_id,operation,google_thread_id,item_count,truncated,accessed_at
       FROM gmail_read_audit_events WHERE owner_user_id=$1 AND space_id=$2 ORDER BY accessed_at DESC, id LIMIT 100`,
    [identity.userId, identity.spaceId],
  )).rows;
  return rows.map((r) => ({
    id: r.id, connection_id: r.gmail_connection_id, project_id: r.project_id, selection_id: r.selection_id, operation: r.operation,
    google_thread_id: r.google_thread_id, item_count: r.item_count, truncated: r.truncated, accessed_at: new Date(r.accessed_at).toISOString(),
  }));
}

/**
 * The list endpoints' entry points. Plain SELECTs still wait behind table locks
 * (an `ACCESS EXCLUSIVE` lock blocks them), so both lists — and the Project
 * readability lookup after the selection query — run in one bounded page
 * transaction: lock/statement timeouts, the page deadline and cancel on abort.
 */
export function listGmailSelectionsBounded(scope: GmailPageScope, identity: Identity, filter: { projectId?: string; connectionId?: string }): Promise<GmailThreadSelection[]> {
  return withGmailReadTransaction(scope, (tx) => listGmailSelections(tx, identity, filter));
}
export function listGmailReadAuditBounded(scope: GmailPageScope, identity: Identity) {
  return withGmailReadTransaction(scope, (tx) => listGmailReadAudit(tx, identity));
}

/** Retention for the owner-read audit, on the content-access-log retention setting. */
export async function pruneGmailReadAudit(db: Queryable, cutoffIso: string): Promise<number> {
  return (await db.query(`DELETE FROM gmail_read_audit_events WHERE accessed_at < $1`, [cutoffIso])).rowCount ?? 0;
}
