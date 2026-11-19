/**
 * The one authority predicate for every Gmail mail read (`authorizeGmailRead`
 * in the plan): run at admission, as the broker's `authorize` before each
 * physical send (and each hop's credential resolution), and again inside the
 * final release transaction that writes the owner-read audit row.
 *
 * Lock order, consistent with the Phase 2 writers (person → owner + Space mutex →
 * connection) and the Project rule (Project audience before person):
 * Project, Space and the caller's Project membership `FOR SHARE`
 * (`assertProjectReadableLocked`) → active person (`lockActivePerson`) → the
 * owner + Space Gmail mutex → the connection row `FOR SHARE` → the selection row
 * `FOR SHARE`. Disconnect, forget, reconnect, refresh and selection add/remove
 * take the same mutex, so each of them either commits before a check (which then
 * refuses) or waits until the check's transaction ends.
 *
 * Every row is keyed by the caller as owner: another person's connection or
 * selection — including for a Project owner or Space admin — is the hidden 404.
 */
import { lockActivePerson } from "../../access/activePerson.js";
import { assertProjectReadableLocked } from "../../projects/access.js";
import type { Queryable } from "../../routeUtils/common.js";
import { lockGmailOwnerSpace, type GmailConnectionRow } from "./gmailConnections.js";
import { gmailWindowKey } from "./gmailCursor.js";
import { GmailReadError } from "./gmailReadErrors.js";
import { withGmailReadTransaction, type GmailPageScope } from "./gmailReadDeadline.js";

export { GmailReadError, type GmailReadErrorCode } from "./gmailReadErrors.js";
export { GMAIL_READ_TX_LIMITS, withGmailReadTransaction } from "./gmailReadDeadline.js";

export interface GmailSelectionRow {
  id: string;
  space_id: string;
  project_id: string;
  owner_user_id: string;
  gmail_connection_id: string;
  google_thread_id: string;
  read_after: string | Date | null;
  read_before: string | Date | null;
}

export interface GmailReadTarget {
  spaceId: string;
  ownerUserId: string;
  /** The selection's Project; null for an Agent read (its Project is on the consent, ADR 0033). */
  projectId: string | null;
  connectionId: string;
  selectionId?: string | null;
  /** An Agent read on the owner's behalf: the connection must also carry the owner's opt-in. */
  agentRead?: boolean;
}

/** What admission saw; every later check must see the same generation (and selection window). */
export interface GmailReadSnapshot extends GmailReadTarget {
  generation: number;
  googleSubject: string;
  mailboxEmail: string;
  selection: { googleThreadId: string; readAfter: string | null; readBefore: string | null; windowKey: string } | null;
}

const isoOrNull = (value: string | Date | null) => value === null ? null : new Date(value).toISOString();

/** Takes the read locks and returns the current rows, or refuses (hidden 404 / 409 for the owner's own changed connection). */
export async function lockGmailReadAuthority(db: Queryable, target: GmailReadTarget): Promise<{ connection: GmailConnectionRow; selection: GmailSelectionRow | null }> {
  try {
    if (target.projectId !== null) await assertProjectReadableLocked(db, target.spaceId, target.projectId, target.ownerUserId);
    await lockActivePerson(db, target.spaceId, target.ownerUserId);
  } catch {
    throw new GmailReadError(404, "gmail_not_found");
  }
  await lockGmailOwnerSpace(db, { spaceId: target.spaceId, userId: target.ownerUserId });
  const connection = (await db.query<GmailConnectionRow>(
    `SELECT * FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
    [target.connectionId, target.spaceId, target.ownerUserId],
  )).rows[0];
  if (!connection) throw new GmailReadError(404, "gmail_not_found");
  if (connection.status === "reauth_required") throw new GmailReadError(409, "gmail_reauth_required");
  if (connection.status !== "active") throw new GmailReadError(409, "gmail_connection_inactive");
  if (target.agentRead && !connection.agent_read_enabled) throw new GmailReadError(409, "gmail_agent_read_unavailable");
  let selection: GmailSelectionRow | null = null;
  if (target.selectionId) {
    selection = (await db.query<GmailSelectionRow>(
      `SELECT * FROM gmail_project_thread_selections
        WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND project_id=$4 AND gmail_connection_id=$5 FOR SHARE`,
      [target.selectionId, target.spaceId, target.ownerUserId, target.projectId, target.connectionId],
    )).rows[0] ?? null;
    if (!selection) throw new GmailReadError(404, "gmail_not_found");
  }
  return { connection, selection };
}

/** Admission: the locks above, recorded as the snapshot every later step must match. */
export async function admitGmailRead(db: Queryable, target: GmailReadTarget): Promise<GmailReadSnapshot> {
  const { connection, selection } = await lockGmailReadAuthority(db, target);
  return {
    ...target,
    generation: connection.generation,
    googleSubject: connection.google_subject,
    mailboxEmail: connection.mailbox_email,
    selection: selection ? {
      googleThreadId: selection.google_thread_id,
      readAfter: isoOrNull(selection.read_after),
      readBefore: isoOrNull(selection.read_before),
      windowKey: gmailWindowKey(isoOrNull(selection.read_after), isoOrNull(selection.read_before)),
    } : null,
  };
}

/** Same locks, and nothing the snapshot depends on has changed: generation, and the selection's thread and window. */
export async function recheckGmailRead(db: Queryable, snapshot: GmailReadSnapshot): Promise<void> {
  const { connection, selection } = await lockGmailReadAuthority(db, snapshot);
  if (connection.generation !== snapshot.generation) throw new GmailReadError(409, "gmail_connection_changed");
  if (snapshot.selection) {
    if (!selection || selection.google_thread_id !== snapshot.selection.googleThreadId
      || gmailWindowKey(isoOrNull(selection.read_after), isoOrNull(selection.read_before)) !== snapshot.selection.windowKey) {
      throw new GmailReadError(409, "gmail_selection_changed");
    }
  }
}

/** The broker's per-send `authorize`: its own short bounded transaction; no mail request leaves unless it commits clean. */
export async function authorizeGmailSend(scope: GmailPageScope, snapshot: GmailReadSnapshot, signal?: AbortSignal): Promise<void> {
  await withGmailReadTransaction(scope, (tx) => recheckGmailRead(tx, snapshot), signal);
}
