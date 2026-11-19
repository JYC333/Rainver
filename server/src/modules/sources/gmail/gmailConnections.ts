/**
 * Canonical writer of `gmail_connections` and their `gmail_oauth` credentials
 * (`.agent/modules/sources.md`, "Personal Gmail connections"). Owner-only: every read and
 * write is keyed by (connection, Space, owner); anything else is the hidden 404.
 *
 * Generation rule: +1 on connect, reconnect, credential replacement, reauth
 * transition and disconnect. A refresh or revocation settles only against the
 * generation it started from, so a late one cannot resurrect a connection.
 *
 * Lock order (every Gmail transaction that writes or admits a send): active
 * person (`lockActivePerson`, or the operation core's actor pin) → the owner +
 * Space mutex (`lockGmailOwnerSpace`, a transaction advisory lock that exists
 * even when the owner has no attempt or connection row yet) → attempt rows →
 * connection row → credential row. Start, consume, install, disconnect, forget,
 * every refresh step and both pre-send admissions take it, so these writers are
 * serialized per owner and Space and no connection row is locked before it.
 * Writers that end consents (`endGmailAgentReadGrants`) do so after the
 * connection row. A consent approval takes no mutex: it holds the connection
 * `FOR SHARE` after its Run and before the request row
 * (`lockGmailConsentConnection`), so it never waits on what a writer takes
 * after the connection.
 *
 * No remote revocation. Google revokes per grant (client + account), so a
 * revoke sent for one connection can also cut another Space's connection of the
 * same account or a newer attempt's freshly exchanged tokens, and no local lock
 * or timer can prove when Google stopped processing it. The MVP therefore never
 * revokes automatically: a disconnect removes local authority only
 * (`remote_revocation: not_requested`) and the person revokes Rainver in their
 * Google Account (`GMAIL_MANUAL_REVOCATION_URL`).
 *
 * Clock rule: every attempt deadline (state expiry, install window) is judged
 * against `gmailLockedNow` — one `clock_timestamp()` read after the mutex and
 * the attempt row are held — never `now()`, which is the transaction's start
 * and can predate a long lock wait. Consumption records that same instant.
 */
import { randomUUID } from "node:crypto";
import { endGmailAgentReadGrants, listGmailAgentReadGrants } from "./gmailAgentReadGrants.js";
import { GMAIL_MANUAL_REVOCATION_URL, type GmailConnection } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import { lockActivePerson } from "../../access/activePerson.js";
import type { Queryable } from "../../routeUtils/common.js";
import { loadOrCreateModelProviderApiKeyMasterKey } from "../../providers/secretRefCrypto.js";
import { hidden, OperationRefusal } from "../../systemActions/operations/errors.js";
import { decryptGmailOAuthSecret, encryptGmailOAuthSecret, type GmailOAuthSecretV1 } from "./gmailCredentialCrypto.js";
import { resumeGmailSyncAfterReconnect } from "./gmailSyncRequests.js";

export const GMAIL_CREDENTIAL_TYPE = "gmail_oauth" as const;
/**
 * A consumed attempt stays installable for 10 minutes after consumption: SQL predicate on
 * `gmail_oauth_attempts`, where `nowParam` is the placeholder bound to `gmailLockedNow`.
 */
export const gmailInstallWindowSql = (nowParam: string) => `consumed_at > ${nowParam}::timestamptz - interval '10 minutes'`;

/** The database's actual time, read once after the caller's locks are held (text keeps microseconds). */
export async function gmailLockedNow(db: Queryable): Promise<string> {
  return (await db.query<{ now: string }>(`SELECT clock_timestamp()::text AS now`)).rows[0]!.now;
}

export interface GmailConnectionRow {
  id: string;
  space_id: string;
  owner_user_id: string;
  google_subject: string;
  mailbox_email: string;
  credential_id: string | null;
  status: "active" | "reauth_required" | "disconnected";
  generation: number;
  granted_scopes: string[];
  last_error_class: GmailConnection["last_error_class"];
  connected_at: string | Date;
  disconnected_at: string | Date | null;
  agent_read_enabled: boolean;
  updated_at: string | Date;
}

const iso = (value: string | Date) => new Date(value).toISOString();
export function gmailConnectionDto(row: GmailConnectionRow, agentReadGrants: GmailConnection["agent_read_grants"] = []): GmailConnection {
  return {
    id: row.id,
    mailbox_email: row.mailbox_email,
    status: row.status,
    granted_scopes: [...row.granted_scopes],
    last_error_class: row.last_error_class,
    connected_at: iso(row.connected_at),
    disconnected_at: row.disconnected_at ? iso(row.disconnected_at) : null,
    agent_read_enabled: row.agent_read_enabled === true,
    agent_read_grants: row.status === "active" && row.agent_read_enabled === true ? agentReadGrants : [],
    updated_at: iso(row.updated_at),
  };
}

export async function listGmailConnections(db: Queryable, identity: { spaceId: string; userId: string }): Promise<GmailConnection[]> {
  const rows = await db.query<GmailConnectionRow>(
    `SELECT * FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 ORDER BY created_at, id LIMIT 100`,
    [identity.spaceId, identity.userId],
  );
  const grants = await listGmailAgentReadGrants(db, identity);
  return rows.rows.map((row) => gmailConnectionDto(row, grants.get(row.id) ?? []));
}

/**
 * The owner + Space Gmail mutex: a transaction-scoped advisory lock keyed by the
 * pair, taken after the person pin and before any attempt, connection or
 * credential row. Re-entrant in one transaction; a hash collision only adds
 * serialization, never a cycle (a transaction takes one such key).
 */
export async function lockGmailOwnerSpace(db: Queryable, identity: { spaceId: string; userId: string }): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`gmail-owner:${identity.spaceId}:${identity.userId}`]);
}

/**
 * Locks the owner's consumed attempt (after the mutex), then reads the actual time once and
 * returns the row with that instant only if the attempt is still inside its install window.
 */
export async function lockConsumedGmailAttempt(db: Queryable, identity: { spaceId: string; userId: string }, attemptId: string, mode: "UPDATE" | "SHARE") {
  const row = (await db.query<{ reconnect_connection_id: string | null; reconnect_generation: number | null }>(
    `SELECT reconnect_connection_id,reconnect_generation FROM gmail_oauth_attempts
      WHERE id=$1 AND user_id=$2 AND space_id=$3 AND consumed_at IS NOT NULL FOR ${mode === "UPDATE" ? "UPDATE" : "SHARE"}`,
    [attemptId, identity.userId, identity.spaceId],
  )).rows[0];
  if (!row) return null;
  const now = await gmailLockedNow(db);
  const live = await db.query(`SELECT 1 FROM gmail_oauth_attempts WHERE id=$1 AND ${gmailInstallWindowSql("$2")}`, [attemptId, now]);
  return live.rows.length ? { ...row, now } : null;
}

/** Locks the owner's connection; another person's (or a vanished) row is the hidden 404. */
export async function lockOwnedGmailConnection(db: Queryable, identity: { spaceId: string; userId: string }, connectionId: string): Promise<GmailConnectionRow> {
  const row = (await db.query<GmailConnectionRow>(
    `SELECT * FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR UPDATE`,
    [connectionId, identity.spaceId, identity.userId],
  )).rows[0];
  if (!row) throw hidden();
  return row;
}

/**
 * Reads and decrypts an active connection's credential. The resolver refuses
 * unless type, owner, Space and connection link all match; an owner-deleted
 * credential (`owner_user_id` NULL) never resolves.
 */
export async function readGmailCredentialIn(db: Queryable, config: ServerConfig, connection: Pick<GmailConnectionRow, "id" | "space_id" | "owner_user_id" | "credential_id">, lock = false): Promise<{ credentialId: string; secret: GmailOAuthSecretV1; refreshState: unknown } | null> {
  if (!connection.credential_id) return null;
  const row = (await db.query<{ id: string; secret_ref: string; oauth_refresh: unknown }>(
    `SELECT id,secret_ref,metadata_json->'oauth_refresh' AS oauth_refresh FROM credentials
      WHERE id=$1 AND credential_type=$2 AND owner_user_id=$3 AND space_id=$4 ${lock ? "FOR UPDATE" : ""}`,
    [connection.credential_id, GMAIL_CREDENTIAL_TYPE, connection.owner_user_id, connection.space_id],
  )).rows[0];
  if (!row) return null;
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  return {
    credentialId: row.id,
    secret: decryptGmailOAuthSecret(row.secret_ref, masterKey, { credentialId: row.id, connectionId: connection.id }),
    refreshState: row.oauth_refresh,
  };
}

export type GmailInstallRefusal = "gmail_account_mismatch" | "gmail_refresh_token_missing" | "gmail_connection_unavailable" | "gmail_oauth_superseded";

/**
 * Installs a completed OAuth grant in one transaction after current-authority
 * checks: active person and Space membership, the reconnect target still the
 * caller's own, and the proven Google subject. Same subject → the same row
 * (a new credential replaces the old one; an absent refresh token keeps the
 * existing one only for this proven account). Another subject → another row;
 * a reconnect never moves a row to a different account.
 *
 * The consumed attempt must still exist (a disconnect, or another attempt's
 * install, deletes it → `gmail_oauth_superseded`), and a reconnect's target must
 * still be at the generation recorded at start. A successful install deletes
 * the owner's other attempts in the Space. A refused install stores nothing;
 * its fresh tokens are discarded, never revoked (see the module header).
 */
export async function installGmailConnection(pool: Pool, config: ServerConfig, input: {
  spaceId: string;
  userId: string;
  attemptId: string;
  reconnectConnectionId: string | null;
  reconnectGeneration: number | null;
  googleSubject: string;
  mailboxEmail: string;
  scopes: string[];
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string | null;
}): Promise<{ ok: true; connectionId: string } | { ok: false; code: GmailInstallRefusal }> {
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await lockActivePerson(client, input.spaceId, input.userId);
    } catch {
      await client.query("ROLLBACK");
      return { ok: false, code: "gmail_connection_unavailable" };
    }
    const identity = { spaceId: input.spaceId, userId: input.userId };
    const refuse = async (code: GmailInstallRefusal) => { await client.query("ROLLBACK"); return { ok: false as const, code }; };
    await lockGmailOwnerSpace(client, identity);
    // A consumed attempt older than the install window is a stalled callback; never install it.
    const attempt = await lockConsumedGmailAttempt(client, identity, input.attemptId, "UPDATE");
    if (!attempt || attempt.reconnect_connection_id !== input.reconnectConnectionId || attempt.reconnect_generation !== input.reconnectGeneration) return refuse("gmail_oauth_superseded");
    let row: GmailConnectionRow | undefined;
    if (input.reconnectConnectionId) {
      row = (await client.query<GmailConnectionRow>(
        `SELECT * FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR UPDATE`,
        [input.reconnectConnectionId, identity.spaceId, identity.userId],
      )).rows[0];
      if (!row) return refuse("gmail_connection_unavailable");
      if (row.google_subject !== input.googleSubject) return refuse("gmail_account_mismatch");
      if (row.generation !== input.reconnectGeneration) return refuse("gmail_oauth_superseded");
    } else {
      row = (await client.query<GmailConnectionRow>(
        `SELECT * FROM gmail_connections WHERE space_id=$1 AND owner_user_id=$2 AND google_subject=$3 FOR UPDATE`,
        [identity.spaceId, identity.userId, input.googleSubject],
      )).rows[0];
    }
    const previous = row ? await readGmailCredentialIn(client, config, row, true).catch(() => null) : null;
    const refreshToken = input.refreshToken ?? previous?.secret.refresh_token ?? null;
    if (!refreshToken) return refuse("gmail_refresh_token_missing");

    const connectionId = row?.id ?? randomUUID();
    const credentialId = randomUUID();
    const now = attempt.now;
    const secretRef = encryptGmailOAuthSecret({
      refresh_token: refreshToken,
      access_token: input.accessToken,
      access_token_expires_at: input.accessTokenExpiresAt,
    }, masterKey, { credentialId, connectionId });
    await client.query(
      `INSERT INTO credentials (id,space_id,owner_user_id,name,credential_type,secret_ref,scopes_json,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,'Gmail read-only connection',$4,$5,$6::jsonb,'{}'::jsonb,$7,$7)`,
      [credentialId, identity.spaceId, identity.userId, GMAIL_CREDENTIAL_TYPE, secretRef, JSON.stringify(input.scopes), now],
    );
    if (row) {
      await client.query(
        `UPDATE gmail_connections SET credential_id=$2,status='active',generation=generation+1,granted_scopes=$3::jsonb,
           mailbox_email=$4,last_error_class=NULL,connected_at=$5,disconnected_at=NULL,updated_at=$5
         WHERE id=$1`,
        [connectionId, credentialId, JSON.stringify(input.scopes), input.mailboxEmail, now],
      );
      // A new generation: consents given for the earlier one end (ADR 0033).
      await endGmailAgentReadGrants(client, { spaceId: identity.spaceId, ownerUserId: identity.userId, connectionId });
      // The replaced credential row (if any) goes with the replacement, never left behind.
      if (row.credential_id) await client.query(`DELETE FROM credentials WHERE id=$1 AND credential_type=$2`, [row.credential_id, GMAIL_CREDENTIAL_TYPE]);
      // Same account, row active again: a monitor sync parked for lost authority resumes now, cursor kept.
      await resumeGmailSyncAfterReconnect(client, connectionId);
    } else {
      await client.query(
        `INSERT INTO gmail_connections (id,space_id,owner_user_id,google_subject,mailbox_email,credential_id,status,generation,
           granted_scopes,last_error_class,connected_at,disconnected_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7::jsonb,NULL,$8,NULL,$8,$8)`,
        [connectionId, identity.spaceId, identity.userId, input.googleSubject, input.mailboxEmail, credentialId, JSON.stringify(input.scopes), now],
      );
    }
    // This attempt is spent; any other outstanding one of the owner here is superseded.
    await client.query(`DELETE FROM gmail_oauth_attempts WHERE user_id=$1 AND space_id=$2`, [identity.userId, identity.spaceId]);
    await client.query("COMMIT");
    return { ok: true, connectionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // A concurrent first connect of the same account won the unique key.
    if ((error as { code?: string }).code === "23505") return { ok: false, code: "gmail_connection_unavailable" };
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Disconnect, inside the operation transaction (every entry shares it): no
 * further admission (generation +1, status `disconnected`), the credential row
 * — refresh and access token — deleted, and the owner's OAuth attempts in this
 * Space deleted so no paused callback can reinstall. Nothing is sent to Google:
 * the receipt says `remote_revocation: not_requested` and where the person can
 * revoke the grant themselves. A same-key replay returns that receipt.
 */
export async function disconnectGmailConnectionIn(db: Queryable, identity: { spaceId: string; userId: string }, connectionId: string) {
  await lockGmailOwnerSpace(db, identity);
  const row = await lockOwnedGmailConnection(db, identity, connectionId);
  if (row.status === "disconnected") throw new OperationRefusal(409, "sources", "This Gmail connection is already disconnected.", { code: "gmail_connection_disconnected" });
  const updated = (await db.query<{ generation: number }>(
    // The Agent-read opt-in ends with the connection's authority; a reconnect needs a new opt-in (ADR 0032).
    `UPDATE gmail_connections SET status='disconnected',credential_id=NULL,generation=generation+1,last_error_class=NULL,
       agent_read_enabled=false,disconnected_at=now(),updated_at=now() WHERE id=$1 RETURNING generation`,
    [row.id],
  )).rows[0]!;
  if (row.credential_id) await db.query(`DELETE FROM credentials WHERE id=$1 AND credential_type=$2`, [row.credential_id, GMAIL_CREDENTIAL_TYPE]);
  await db.query(`DELETE FROM gmail_oauth_attempts WHERE user_id=$1 AND space_id=$2`, [identity.userId, identity.spaceId]);
  // Every Project consent on this mailbox ends with it (ADR 0033); a reconnect needs new consents.
  await endGmailAgentReadGrants(db, { spaceId: identity.spaceId, ownerUserId: identity.userId, connectionId: row.id });
  return {
    connection_id: row.id, space_id: row.space_id, status: "disconnected" as const, generation: updated.generation,
    remote_revocation: "not_requested" as const, manual_revocation_url: GMAIL_MANUAL_REVOCATION_URL,
  };
}

/**
 * Deletes a connection that holds no credential (disconnected or reauth-required); an active one must be
 * disconnected first. Deleting the row cascades to its reconnect attempts, thread selections, monitor
 * rules (and their matches) and mailbox sync state. Its Agent-read consents and their approved requests
 * stay as ended history (ADR 0033): they name the connection only as a snapshot, so they never block the
 * deletion and never admit again; anything still active or pending ends first.
 */
export async function forgetGmailConnectionIn(db: Queryable, identity: { spaceId: string; userId: string }, connectionId: string) {
  await lockGmailOwnerSpace(db, identity);
  const row = await lockOwnedGmailConnection(db, identity, connectionId);
  if (row.credential_id) throw new OperationRefusal(409, "sources", "Disconnect this Gmail connection before forgetting it.", { code: "gmail_connection_active" });
  await endGmailAgentReadGrants(db, { spaceId: identity.spaceId, ownerUserId: identity.userId, connectionId: row.id });
  await db.query(`DELETE FROM gmail_connections WHERE id=$1`, [row.id]);
  return { connection_id: row.id, space_id: row.space_id, forgotten: true as const };
}

/**
 * The owner's opt-in for on-demand Agent reads (ADR 0032), under the same
 * person → mutex → connection `FOR UPDATE` order as every connection writer.
 * Turning it off removes the tool from new Runs and refuses every later read
 * and release, also in a Run already holding a consent. Only an active
 * connection can be opted in.
 */
export async function setGmailAgentReadIn(db: Queryable, identity: { spaceId: string; userId: string }, connectionId: string, enabled: boolean) {
  const row = await lockOwnedGmailConnection(db, identity, connectionId);
  if (enabled && row.status !== "active") throw new OperationRefusal(409, "sources", "Reconnect this Gmail account before allowing Agent reads.", { code: "gmail_connection_inactive" });
  await db.query(`UPDATE gmail_connections SET agent_read_enabled=$2,updated_at=now() WHERE id=$1`, [row.id, enabled]);
  // Turning reads off ends every Project consent on this mailbox; turning them on again restores none (ADR 0033).
  if (!enabled) await endGmailAgentReadGrants(db, { spaceId: identity.spaceId, ownerUserId: identity.userId, connectionId: row.id });
  return { connection_id: row.id, space_id: identity.spaceId, agent_read_enabled: enabled };
}
