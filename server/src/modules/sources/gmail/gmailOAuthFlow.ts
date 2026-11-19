/**
 * The personal Gmail OAuth lifecycle: start (single-use expiring state bound to
 * the person, Space and fixed callback, S256 PKCE) and the one callback that
 * consumes it. The callback is a single authentication step, not a command:
 * the attempt row is consumed before the code is spent, the code is used once
 * and never persisted, and the only thing it renders is a fixed result code.
 * No path here revokes a Google grant: refused fresh tokens are discarded
 * (see `gmailConnections.ts` for why the MVP never revokes automatically).
 */
import { createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { GmailOAuthCallbackResult } from "@rainver/protocol";
import type { GmailOAuthClientConfig, ServerConfig } from "../../../config.js";
import type { Pool } from "../../../db/pool.js";
import { lockActivePerson } from "../../access/activePerson.js";
import { loadOrCreateModelProviderApiKeyMasterKey } from "../../providers/secretRefCrypto.js";
import { hidden } from "../../systemActions/operations/errors.js";
import { createSourceRequestBroker } from "../sourceRequestBroker.js";
import type { OutboundGuard } from "../outboundUrlSafety.js";
import { createGmailSendBudget, evaluateGrantedGmailScopes, GMAIL_REQUESTED_SCOPES, gmailProfileUrl, gmailSourceRequestPolicy, GOOGLE_OAUTH_AUTHORIZE_URL } from "./gmailReadContract.js";
import { GMAIL_ACCOUNT_QUOTA, GMAIL_OWNER_QUOTA, gmailQuotaGroups } from "./gmailQuota.js";
import { googleSubjectFromIdToken } from "./gmailIdToken.js";
import { exchangeGmailAuthorizationCode } from "./gmailOAuthTransport.js";
import { gmailInstallWindowSql, gmailLockedNow, installGmailConnection, lockConsumedGmailAttempt, lockGmailOwnerSpace } from "./gmailConnections.js";

/** State lifetime of an unconsumed attempt (SQL interval, from the locked start instant). */
const GMAIL_OAUTH_ATTEMPT_TTL_SQL = "interval '10 minutes'";
const STATE = /^[A-Za-z0-9_-]{43}$/;
const MAX_CODE_CHARS = 2048;

export class GmailLifecycleError extends Error {
  constructor(readonly code: "gmail_not_configured", readonly statusCode: 503) { super(code); this.name = "GmailLifecycleError"; }
}

let profileGuardOverride: OutboundGuard | undefined;
/** Tests inject a DNS-stubbed guard for the identity profile read; production uses the strict one. */
export function __setGmailProfileGuardForTests(guard: OutboundGuard | null): void { profileGuardOverride = guard ?? undefined; }

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** PKCE verifier = HMAC(HKDF(master key, "gmail-pkce-v1"), state): derivable at the callback, never stored. */
async function pkceVerifier(config: ServerConfig, state: string): Promise<string> {
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  const key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "gmail-pkce-v1", 32));
  return createHmac("sha256", key).update(state, "utf8").digest("base64url");
}

function client(config: ServerConfig): GmailOAuthClientConfig {
  if (!config.gmailOAuth) throw new GmailLifecycleError("gmail_not_configured", 503);
  return config.gmailOAuth;
}

/**
 * Records a new attempt (superseding the person's earlier unconsumed ones in
 * this Space, and dropping their consumed ones whose install window has passed;
 * a consumed attempt still inside its window, and every other person's or
 * Space's attempt, is left alone) and
 * returns Google's authorization URL. A reconnect must name the caller's own
 * connection in the active Space; anything else is the hidden 404. The attempt
 * records the target's generation, which the callback checks before spending
 * the code and the install rechecks under its locks.
 */
export async function startGmailOAuth(config: ServerConfig, pool: Pool, input: { spaceId: string; userId: string; reconnectConnectionId?: string | null }): Promise<{ authorize_url: string }> {
  const oauth = client(config);
  const state = randomBytes(32).toString("base64url");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try { await lockActivePerson(db, input.spaceId, input.userId); } catch { throw hidden(); }
    // Owner + Space mutex, then attempts, then the connection row (lock order in gmailConnections.ts).
    await lockGmailOwnerSpace(db, input);
    const now = await gmailLockedNow(db);
    await db.query(`DELETE FROM gmail_oauth_attempts WHERE user_id=$1 AND space_id=$2 AND (consumed_at IS NULL OR NOT (${gmailInstallWindowSql("$3")}))`,
      [input.userId, input.spaceId, now]);
    let reconnectGeneration: number | null = null;
    if (input.reconnectConnectionId) {
      const own = (await db.query<{ generation: number }>(`SELECT generation FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
        [input.reconnectConnectionId, input.spaceId, input.userId])).rows[0];
      if (!own) throw hidden();
      reconnectGeneration = own.generation;
    }
    await db.query(
      `INSERT INTO gmail_oauth_attempts (id,state_sha256,space_id,user_id,reconnect_connection_id,reconnect_generation,expires_at,consumed_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz + ${GMAIL_OAUTH_ATTEMPT_TTL_SQL},NULL,$7::timestamptz)`,
      [randomUUID(), sha256(state), input.spaceId, input.userId, input.reconnectConnectionId ?? null, reconnectGeneration, now],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  const challenge = createHash("sha256").update(await pkceVerifier(config, state), "utf8").digest("base64url");
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", oauth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_REQUESTED_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorize_url: url.toString() };
}

type ConsumedAttempt = { spaceId: string; reconnectConnectionId: string | null; reconnectGeneration: number | null; attemptId: string };

/**
 * Consumes the attempt exactly once, for the person who started it, before
 * expiry — and, in the same transaction, before the code is spent, checks
 * current authority: the person is still active and an active member of the
 * attempt's Space, and a reconnect's target is still theirs at the generation
 * recorded at start. A refusal still consumes the attempt (single use). The
 * consumed row stays until installation, which rechecks all of it under locks.
 * The initial lookup only routes to a Space; expiry is decided after the
 * mutex and the row lock, against the actual time, which is also recorded as
 * `consumed_at` (clock rule in gmailConnections.ts).
 */
async function consumeAttempt(pool: Pool, state: string, userId: string): Promise<{ ok: true; attempt: ConsumedAttempt } | { ok: false; code: GmailOAuthCallbackResult }> {
  const stateHash = sha256(state);
  const found = (await pool.query<{ space_id: string }>(
    `SELECT space_id FROM gmail_oauth_attempts WHERE state_sha256=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at > now()`,
    [stateHash, userId],
  )).rows[0];
  if (!found) return { ok: false, code: "gmail_oauth_state_invalid" };
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    let active = true;
    try { await lockActivePerson(db, found.space_id, userId); } catch { active = false; }
    await lockGmailOwnerSpace(db, { spaceId: found.space_id, userId });
    const locked = (await db.query<{ id: string }>(
      `SELECT id FROM gmail_oauth_attempts WHERE state_sha256=$1 AND consumed_at IS NULL AND user_id=$2 AND space_id=$3 FOR UPDATE`,
      [stateHash, userId, found.space_id],
    )).rows[0];
    const row = locked && (await db.query<{ id: string; reconnect_connection_id: string | null; reconnect_generation: number | null }>(
      `UPDATE gmail_oauth_attempts SET consumed_at=$2::timestamptz WHERE id=$1 AND expires_at > $2::timestamptz
        RETURNING id,reconnect_connection_id,reconnect_generation`,
      [locked.id, await gmailLockedNow(db)],
    )).rows[0];
    let result: Awaited<ReturnType<typeof consumeAttempt>>;
    if (!row) result = { ok: false, code: "gmail_oauth_state_invalid" };
    else if (!active) result = { ok: false, code: "gmail_connection_unavailable" };
    else {
      result = { ok: true, attempt: { attemptId: row.id, spaceId: found.space_id, reconnectConnectionId: row.reconnect_connection_id, reconnectGeneration: row.reconnect_generation } };
      if (row.reconnect_connection_id) {
        const target = (await db.query<{ generation: number }>(
          `SELECT generation FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 FOR SHARE`,
          [row.reconnect_connection_id, found.space_id, userId],
        )).rows[0];
        if (!target) result = { ok: false, code: "gmail_connection_unavailable" };
        else if (target.generation !== row.reconnect_generation) result = { ok: false, code: "gmail_oauth_superseded" };
      }
    }
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

/**
 * The pre-send recheck for the code exchange and the profile read, run by the
 * guard after DNS as the last step before dispatch, in its own short
 * transaction with the writers' lock order: the person still active and a
 * member of the attempt's Space, this consumed attempt still present inside its
 * install window (a disconnect or another install deletes it), and a reconnect
 * target still the caller's at the recorded generation. Throws the result code.
 */
async function admitAttemptSend(pool: Pool, userId: string, attempt: ConsumedAttempt): Promise<void> {
  const db = await pool.connect();
  let refusal: GmailOAuthCallbackResult | null = null;
  try {
    await db.query("BEGIN");
    try { await lockActivePerson(db, attempt.spaceId, userId); } catch { refusal = "gmail_connection_unavailable"; }
    if (!refusal) {
      await lockGmailOwnerSpace(db, { spaceId: attempt.spaceId, userId });
      const live = await lockConsumedGmailAttempt(db, { spaceId: attempt.spaceId, userId }, attempt.attemptId, "SHARE");
      if (!live) refusal = "gmail_oauth_superseded";
      else if (attempt.reconnectConnectionId) {
        const target = (await db.query<{ generation: number }>(`SELECT generation FROM gmail_connections WHERE id=$1 AND space_id=$2 AND owner_user_id=$3`,
          [attempt.reconnectConnectionId, attempt.spaceId, userId])).rows[0];
        if (!target) refusal = "gmail_connection_unavailable";
        else if (target.generation !== attempt.reconnectGeneration) refusal = "gmail_oauth_superseded";
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  if (refusal) throw new GmailSendRefused(refusal);
}

class GmailSendRefused extends Error {
  constructor(readonly code: GmailOAuthCallbackResult) { super(code); this.name = "GmailSendRefused"; }
}

/**
 * The mailbox address for display, via the Sources broker with the exact
 * Gmail policy (no redirects, exact URL, one send) and the stable-subject
 * quota. `users.getProfile` is identity, not mail content.
 */
async function fetchProfileEmail(pool: Pool, attempt: ConsumedAttempt, input: { googleSubject: string; userId: string; accessToken: string }): Promise<{ email: string } | { refused: GmailOAuthCallbackResult }> {
  let refused: GmailOAuthCallbackResult = "gmail_profile_unavailable";
  const keys = gmailQuotaGroups({ googleSubject: input.googleSubject, ownerUserId: input.userId });
  const broker = createSourceRequestBroker(pool, {
    scopeId: `gmail-identity:${attempt.attemptId}`,
    quotaGroup: keys.account,
    quota: GMAIL_ACCOUNT_QUOTA,
    endpointQuotas: [{ key: keys.owner, windows: GMAIL_OWNER_QUOTA }],
    authorize: () => admitAttemptSend(pool, input.userId, attempt).catch((error: unknown) => {
      if (error instanceof GmailSendRefused) refused = error.code;
      throw error;
    }),
    ...gmailSourceRequestPolicy({ credentialHeaders: async () => ({ authorization: `Bearer ${input.accessToken}` }), budget: createGmailSendBudget(1) }),
  }, AbortSignal.timeout(15_000), profileGuardOverride);
  try {
    const response = await broker({ sequence: 1, method: "GET", url: gmailProfileUrl() });
    if (response.status !== 200) return { refused };
    const body = JSON.parse(Buffer.from(response.body_base64, "base64").toString("utf8")) as { emailAddress?: unknown };
    const email = body.emailAddress;
    return typeof email === "string" && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? { email } : { refused };
  } catch {
    return { refused };
  }
}

export interface GmailOAuthCallbackInput {
  userId: string | null;
  state: unknown;
  code: unknown;
  error: unknown;
}

/**
 * Completes one OAuth attempt. The code is spent only after `consumeAttempt`
 * proved current authority and, again after DNS, `admitAttemptSend`. Every refusal after the exchange discards the fresh
 * tokens without storing or revoking them; the grant stays visible in the
 * person's Google Account, where they can remove it.
 */
export async function completeGmailOAuth(config: ServerConfig, pool: Pool, input: GmailOAuthCallbackInput): Promise<GmailOAuthCallbackResult> {
  if (!config.gmailOAuth) return "gmail_not_configured";
  const oauth = config.gmailOAuth;
  if (!input.userId) return "gmail_oauth_session_required";
  if (typeof input.state !== "string" || !STATE.test(input.state)) return "gmail_oauth_state_invalid";
  const consumed = await consumeAttempt(pool, input.state, input.userId);
  if (!consumed.ok) return consumed.code;
  const attempt = consumed.attempt;
  if (input.error !== undefined) return "gmail_oauth_denied";
  if (typeof input.code !== "string" || !input.code || input.code.length > MAX_CODE_CHARS) return "gmail_oauth_exchange_failed";

  const userId = input.userId;
  let refused: GmailOAuthCallbackResult | null = null;
  const exchanged = await exchangeGmailAuthorizationCode(oauth, {
    code: input.code,
    codeVerifier: await pkceVerifier(config, input.state),
    admit: async () => {
      try { await admitAttemptSend(pool, userId, attempt); } catch (error) { if (error instanceof GmailSendRefused) refused = error.code; throw error; }
    },
  });
  if (refused) return refused;
  if (exchanged.kind !== "ok") return "gmail_oauth_exchange_failed";
  const tokens = exchanged.value;

  const subject = googleSubjectFromIdToken(tokens.id_token, oauth.clientId);
  if (!subject) return "gmail_identity_invalid";
  const scopes = evaluateGrantedGmailScopes(tokens.scope);
  if (!scopes.ok) return scopes.code;
  const profile = await fetchProfileEmail(pool, attempt, { googleSubject: subject, userId, accessToken: tokens.access_token });
  if ("refused" in profile) return profile.refused;

  const installed = await installGmailConnection(pool, config, {
    spaceId: attempt.spaceId,
    userId: input.userId,
    attemptId: attempt.attemptId,
    reconnectConnectionId: attempt.reconnectConnectionId,
    reconnectGeneration: attempt.reconnectGeneration,
    googleSubject: subject,
    mailboxEmail: profile.email,
    scopes: scopes.scopes,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token,
  });
  if (!installed.ok) return installed.code;
  return "connected";
}
