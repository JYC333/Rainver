/**
 * Access-token resolution for one admitted Gmail snapshot, with the once-only
 * refresh protocol copied (as separate code, per the credential-class rule)
 * from the managed-subscription resolver:
 *
 * Every transaction first requires current authority — the owner is an active
 * user and an active member of the snapshot's Space (`lockActivePerson`), not
 * just the connection snapshot — so a removed member gets neither a cached
 * token, nor a refresh POST, nor a stored refresh result (`gmail_authority_revoked`).
 *
 * 1. a short transaction locks the connection and its credential; it checks the
 *    snapshot (owner, Space, `active`, same generation and credential) and either
 *    returns a still-valid access token or records
 *    `metadata_json.oauth_refresh = {state:'in_flight', attempt_id, from, lease_until}`
 *    (`from` is the keyed fingerprint of the refresh token, never the token);
 * 2. the one POST to Google's token endpoint runs outside every transaction (10 s).
 *    Immediately before it is dispatched (after DNS), `admitRefreshSend` rechecks
 *    in a short transaction that the person, membership, generation, credential
 *    and this `in_flight` attempt are all still current; otherwise nothing is sent;
 * 3. a second short transaction settles only if the same attempt, generation and
 *    credential are still current — a disconnect, reconnect or reauth meanwhile
 *    wins, and a late refresh can never resurrect a connection.
 *
 * Outcomes: success stores the new access token (and a new refresh token if
 * Google ever returns one). A definite `invalid_grant` → `reauth_required`, the
 * credential deleted, generation +1. Google 429/5xx, another definite refusal
 * or a failure before sending → `transient`, retried after a short backoff.
 * Sent without a complete answer → `uncertain`, retried only after the lease
 * (Google does not rotate web-client refresh tokens, so the token stays usable).
 */
import { randomUUID } from "node:crypto";
import { endGmailAgentReadGrants } from "./gmailAgentReadGrants.js";
import type { ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import { runTransaction, type TransactionRunner } from "../../../db/tx.js";
import { lockActivePerson } from "../../access/activePerson.js";
import type { Queryable } from "../../routeUtils/common.js";
import { loadOrCreateModelProviderApiKeyMasterKey, secretFingerprint } from "../../providers/secretRefCrypto.js";
import { encryptGmailOAuthSecret, type GmailOAuthSecretV1 } from "./gmailCredentialCrypto.js";
import { GMAIL_CREDENTIAL_TYPE, lockGmailOwnerSpace, readGmailCredentialIn, type GmailConnectionRow } from "./gmailConnections.js";
import { refreshGmailAccessToken } from "./gmailOAuthTransport.js";
import { evaluateGrantedGmailScopes } from "./gmailReadContract.js";

export interface GmailReadSnapshot { connectionId: string; ownerUserId: string; spaceId: string; generation: number }

interface RefreshState {
  state: "in_flight" | "transient" | "uncertain";
  attempt_id: string;
  from: string;
  started_at: string;
  lease_until?: string;
  retry_after?: string;
}

export class GmailTokenError extends Error {
  constructor(readonly code: "gmail_authority_revoked" | "gmail_connection_changed" | "gmail_not_configured" | "gmail_reauth_required" | "gmail_refresh_unavailable" | "gmail_refresh_busy") {
    super(code);
    this.name = "GmailTokenError";
  }
}

const EXPIRY_MARGIN_MS = 60_000;
const LEASE_MS = 30_000;
const TRANSIENT_BACKOFF_MS = 30_000;
const WAIT_MS = 200;
let clock: () => number = () => Date.now();
export function __setGmailRefreshClockForTests(value: (() => number) | null): void { clock = value ?? (() => Date.now()); }

const at = (ms: number) => new Date(ms).toISOString();
/** A wait that ends early (rejecting) on abort. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function lockSnapshot(db: Queryable, config: ServerConfig, snapshot: GmailReadSnapshot) {
  try { await lockActivePerson(db, snapshot.spaceId, snapshot.ownerUserId); } catch { throw new GmailTokenError("gmail_authority_revoked"); }
  await lockGmailOwnerSpace(db, { spaceId: snapshot.spaceId, userId: snapshot.ownerUserId });
  const row = (await db.query<GmailConnectionRow>(
    `SELECT * FROM gmail_connections WHERE id=$1 AND owner_user_id=$2 AND space_id=$3 FOR UPDATE`,
    [snapshot.connectionId, snapshot.ownerUserId, snapshot.spaceId],
  )).rows[0];
  if (!row || row.status !== "active" || row.generation !== snapshot.generation) throw new GmailTokenError("gmail_connection_changed");
  const credential = await readGmailCredentialIn(db, config, row, true);
  if (!credential) throw new GmailTokenError("gmail_connection_changed");
  return { row, credentialId: credential.credentialId, secret: credential.secret, state: (credential.refreshState ?? null) as RefreshState | null };
}

async function writeState(db: Queryable, credentialId: string, state: RefreshState | null, secretRef?: string): Promise<void> {
  await db.query(
    `UPDATE credentials
        SET metadata_json=CASE WHEN $2::jsonb IS NULL THEN COALESCE(metadata_json,'{}'::jsonb)-'oauth_refresh'
                               ELSE jsonb_set(COALESCE(metadata_json,'{}'::jsonb),'{oauth_refresh}',$2::jsonb,true) END,
            secret_ref=COALESCE($3,secret_ref),updated_at=now()
      WHERE id=$1 AND credential_type=$4`,
    [credentialId, state ? JSON.stringify(state) : null, secretRef ?? null, GMAIL_CREDENTIAL_TYPE],
  );
}

/** Returns a usable access token for the snapshot or throws a `GmailTokenError`; never returns or logs the refresh token. */
/** `pool` may be the caller's bounded runner (a mail-read page's deadline); every step then follows it. */
export async function resolveGmailAccessToken(config: ServerConfig, pool: Pool | TransactionRunner, snapshot: GmailReadSnapshot, signal?: AbortSignal): Promise<string> {
  const oauth = config.gmailOAuth;
  if (!oauth) throw new GmailTokenError("gmail_not_configured");
  const deadline = clock() + LEASE_MS;
  for (;;) {
    signal?.throwIfAborted();
    const step = await runTransaction(pool, async (tx) => {
      const current = await lockSnapshot(tx, config, snapshot);
      const from = await secretFingerprint(config.rainverHome, current.secret.refresh_token);
      const pending = current.state?.from === from ? current.state : null;
      if (current.secret.access_token_expires_at > clock() + EXPIRY_MARGIN_MS) return { kind: "ready" as const, token: current.secret.access_token };
      if (pending?.state === "in_flight" && Date.parse(pending.lease_until ?? "") > clock()) return { kind: "wait" as const };
      if (pending && pending.state !== "in_flight" && Date.parse(pending.retry_after ?? "") > clock()) return { kind: "backoff" as const };
      // A new attempt; an expired in-flight lease is a lost process (Google keeps the refresh token valid).
      const attempt: RefreshState = { state: "in_flight", attempt_id: randomUUID(), from, started_at: at(clock()), lease_until: at(clock() + LEASE_MS) };
      await writeState(tx, current.credentialId, attempt);
      return { kind: "refresh" as const, attempt, credentialId: current.credentialId, secret: current.secret };
    });
    if (step.kind === "ready") return step.token;
    if (step.kind === "backoff") throw new GmailTokenError("gmail_refresh_unavailable");
    if (step.kind === "wait") {
      if (clock() >= deadline) throw new GmailTokenError("gmail_refresh_busy");
      await pause(WAIT_MS, signal);
      continue;
    }
    // Outside every transaction: the one token-endpoint POST this attempt may make.
    const outcome = await refreshGmailAccessToken(oauth, {
      refreshToken: step.secret.refresh_token,
      admit: () => admitRefreshSend(config, pool, snapshot, step.credentialId, step.attempt.attempt_id),
    }, signal);
    const settled = await settle(config, pool, snapshot, step.credentialId, step.attempt, step.secret, outcome);
    if (settled.kind === "token") return settled.token;
    if (settled.kind === "superseded") continue;
    throw new GmailTokenError(settled.code);
  }
}

/** The physical-send recheck: the same locks as every refresh step, and this attempt still the one in flight. */
async function admitRefreshSend(config: ServerConfig, pool: Pool | TransactionRunner, snapshot: GmailReadSnapshot, credentialId: string, attemptId: string): Promise<void> {
  await runTransaction(pool, async (tx) => {
    const current = await lockSnapshot(tx, config, snapshot);
    if (current.credentialId !== credentialId || current.state?.attempt_id !== attemptId || current.state.state !== "in_flight") {
      throw new GmailTokenError("gmail_connection_changed");
    }
  });
}

type Settled = { kind: "token"; token: string } | { kind: "superseded" } | { kind: "error"; code: GmailTokenError["code"] };

async function settle(config: ServerConfig, pool: Pool | TransactionRunner, snapshot: GmailReadSnapshot, credentialId: string, attempt: RefreshState, secret: GmailOAuthSecretV1,
  outcome: Awaited<ReturnType<typeof refreshGmailAccessToken>>): Promise<Settled> {
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  return runTransaction(pool, async (tx) => {
    let current: Awaited<ReturnType<typeof lockSnapshot>>;
    try { current = await lockSnapshot(tx, config, snapshot); } catch (error) {
      // The refreshed token is discarded: nothing is stored for a changed connection or a person without authority.
      return { kind: "error" as const, code: error instanceof GmailTokenError && error.code === "gmail_authority_revoked" ? error.code : "gmail_connection_changed" as const };
    }
    if (current.credentialId !== credentialId) return { kind: "error" as const, code: "gmail_connection_changed" as const };
    if (current.state?.attempt_id !== attempt.attempt_id || current.state.state !== "in_flight") return { kind: "superseded" as const };
    const reauth = async (errorClass: "invalid_grant" | "scope") => {
      await tx.query(
        `UPDATE gmail_connections SET status='reauth_required',credential_id=NULL,generation=generation+1,last_error_class=$2,updated_at=now() WHERE id=$1`,
        [snapshot.connectionId, errorClass],
      );
      await tx.query(`DELETE FROM credentials WHERE id=$1 AND credential_type=$2`, [credentialId, GMAIL_CREDENTIAL_TYPE]);
      // Re-authorization starts a new generation; its Project consents end (ADR 0033).
      await endGmailAgentReadGrants(tx, { spaceId: snapshot.spaceId, ownerUserId: snapshot.ownerUserId, connectionId: snapshot.connectionId });
      return { kind: "error" as const, code: "gmail_reauth_required" as const };
    };
    const retryLater = async (state: "transient" | "uncertain", retryAfterMs: number) => {
      await writeState(tx, credentialId, { ...attempt, state, lease_until: undefined, retry_after: at(retryAfterMs) });
      await tx.query(`UPDATE gmail_connections SET last_error_class=$2,updated_at=now() WHERE id=$1`, [snapshot.connectionId, state]);
      return { kind: "error" as const, code: "gmail_refresh_unavailable" as const };
    };
    if (outcome.kind === "ok") {
      if (outcome.value.scope !== null && !evaluateGrantedGmailScopes(outcome.value.scope).ok) return reauth("scope");
      const next: GmailOAuthSecretV1 = {
        refresh_token: outcome.value.refresh_token ?? secret.refresh_token,
        access_token: outcome.value.access_token,
        access_token_expires_at: clock() + outcome.value.expires_in * 1000,
      };
      await writeState(tx, credentialId, null, encryptGmailOAuthSecret(next, masterKey, { credentialId, connectionId: snapshot.connectionId }));
      await tx.query(`UPDATE gmail_connections SET last_error_class=NULL,updated_at=now() WHERE id=$1`, [snapshot.connectionId]);
      return { kind: "token" as const, token: next.access_token };
    }
    if (outcome.kind === "refused" && outcome.error === "invalid_grant") return reauth("invalid_grant");
    if (outcome.kind === "uncertain") return retryLater("uncertain", Date.parse(attempt.lease_until ?? "") || clock() + LEASE_MS);
    return retryLater("transient", clock() + TRANSIENT_BACKOFF_MS);
  });
}
