import type { Queryable } from "../routeUtils/common.js";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "./db.js";
import { mapProviderRowToDto, type ProviderRow } from "./dbReader.js";
import {
  decryptModelProviderOAuthSecretRefV1,
  encryptModelProviderOAuthSecretRefV1,
  loadOrCreateModelProviderApiKeyMasterKey,
  type ModelProviderOAuthSecretV1,
} from "./secretRefCrypto.js";
import { parseCodexManagedUsageResponse, probeClaudeOAuthQuotaWithAccessToken, type QuotaResult } from "./subscriptionQuota.js";
import { ProviderCommandNotFoundError, ProviderCommandValidationError } from "./commands/types.js";
import { secretFingerprint } from "./secretRefCrypto.js";
import { withTransaction } from "../../db/tx.js";
import { assertCurrentActor, sessionActor } from "../systemActions/operations/actor.js";
import { hidden } from "../systemActions/operations/errors.js";
import { isInstanceAdminIn } from "../routeUtils/access.js";
import { loadManagedOAuthFlow } from "./invocation/piAiChat.js";
import type {
  ManagedAuthEvent,
  ManagedAuthInteraction,
  ManagedAuthPrompt,
  ManagedOAuthCredential,
  ManagedOAuthFlow,
} from "./managedOAuth.js";

type ManagedSubscriptionType = "anthropic" | "openai_codex";
let flowOverride: ((type: ManagedSubscriptionType) => Promise<ManagedOAuthFlow>) | null = null;
let fetchOverride: typeof globalThis.fetch | null = null;

export function __setManagedSubscriptionOAuthForTests(
  value: ((type: ManagedSubscriptionType) => Promise<ManagedOAuthFlow>) | null,
): void {
  flowOverride = value;
}

export function __setManagedSubscriptionFetchForTests(value: typeof globalThis.fetch | null): void {
  fetchOverride = value;
}

async function oauthFlow(type: ManagedSubscriptionType): Promise<ManagedOAuthFlow> {
  if (flowOverride) return flowOverride(type);
  return loadManagedOAuthFlow(type);
}

function subscriptionDefinition(type: ManagedSubscriptionType) {
  return type === "anthropic"
    ? {
        name: "Claude Pro/Max subscription",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        models: ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6"],
      }
    : {
        name: "OpenAI Codex subscription",
        baseUrl: "https://chatgpt.com/backend-api",
        defaultModel: "gpt-5.6-sol",
        models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      };
}

function assertSubscriptionType(value: string): asserts value is ManagedSubscriptionType {
  if (value !== "anthropic" && value !== "openai_codex") {
    throw new ProviderCommandValidationError("Managed subscription type must be 'anthropic' or 'openai_codex'");
  }
}

export function parseManagedSubscriptionType(value: string): ManagedSubscriptionType {
  assertSubscriptionType(value);
  return value;
}

export async function loginManagedSubscription(
  config: ServerConfig,
  type: ManagedSubscriptionType,
  spaceId: string,
  userId: string,
  interaction: ManagedAuthInteraction,
): Promise<Record<string, unknown>> {
  if (!config.databaseUrl) throw new Error("Managed subscription OAuth requires SERVER_DATABASE_URL");
  const credential = await (await oauthFlow(type)).login(interaction);
  const quota = await safeProbeQuota(type, credential);
  return persistSubscription(config, getDbPool(config.databaseUrl), type, spaceId, userId, credential, quota);
}

export async function refreshManagedSubscriptionQuota(
  config: ServerConfig,
  spaceId: string,
  userId: string,
  providerId: string,
): Promise<Record<string, unknown>> {
  if (!config.databaseUrl) throw new Error("Managed subscription OAuth requires SERVER_DATABASE_URL");
  const pool = getDbPool(config.databaseUrl);
  const resolved = await resolveManagedSubscriptionCredential(
    config,
    pool,
    spaceId,
    providerId,
    userId,
  );
  const quota = await safeProbeQuota(resolved.type, resolved.credential);
  await pool.query(
    `UPDATE credentials
        SET metadata_json=jsonb_set(COALESCE(metadata_json, '{}'::jsonb), '{quota}', $3::jsonb, true),
            updated_at=$4
      WHERE id=$1 AND owner_user_id=$2 AND credential_type='subscription_oauth'`,
    [resolved.credentialId, userId, JSON.stringify(quota), new Date()],
  );
  return subscriptionProviderDto(pool, spaceId, userId, providerId);
}

/**
 * Disconnects the owner's managed subscription in the caller's transaction:
 * the Provider keeps its row (disabled) and the encrypted OAuth credential is
 * deleted. Instance-admin authority is the caller's to check.
 */
export async function disconnectManagedSubscriptionIn(
  db: Queryable,
  spaceId: string,
  userId: string,
  providerId: string,
): Promise<Record<string, unknown>> {
  const found = await db.query<{ credential_id: string }>(
    `SELECT p.credential_id
       FROM model_providers p
       JOIN credentials c ON c.id=p.credential_id AND c.credential_type='subscription_oauth'
      WHERE p.id=$1 AND p.space_id=$2 AND p.owner_user_id=$3
      FOR UPDATE OF p, c`,
    [providerId, spaceId, userId],
  );
  const credentialId = found.rows[0]?.credential_id;
  if (!credentialId) throw new ProviderCommandNotFoundError(`Managed subscription provider '${providerId}' not found`);
  await db.query(
    `UPDATE model_providers SET credential_id=NULL,enabled=false,updated_at=$2 WHERE id=$1`,
    [providerId, new Date()],
  );
  await db.query(`DELETE FROM credentials WHERE id=$1`, [credentialId]);
  return subscriptionProviderDto(db, spaceId, userId, providerId, true);
}

/**
 * The OAuth refresh state a managed subscription credential carries in
 * `credentials.metadata_json.oauth_refresh` (never a token: `from` is the
 * keyed fingerprint of the refresh token the attempt spends).
 *
 * A vendor refresh rotates the grant remotely, so it is a once-only effect,
 * never repeated blindly: a short transaction records the intent under the
 * credential's row lock, the vendor call runs outside every transaction, and a
 * second short transaction stores the new tokens only if the intent and the
 * spent token are still the current ones. An intent whose lease ran out
 * (a crash, a lost connection before the second commit) or a vendor call that
 * ended without a definite refusal is `unknown`: the old refresh token may
 * already be spent, so it is never sent again and the subscription needs a
 * new login (which replaces the credential and clears this state).
 */
interface OAuthRefreshState {
  state: "in_flight" | "unknown";
  attempt_id: string;
  from: string;
  started_at: string;
  lease_until?: string;
}
export class ManagedSubscriptionRefreshError extends Error {
  constructor(readonly code: "subscription_reconnect_required" | "subscription_refresh_busy") {
    super(code === "subscription_reconnect_required"
      ? "This subscription's sign-in could not be renewed safely; disconnect and connect it again."
      : "This subscription's sign-in is being renewed; try again shortly.");
    this.name = "ManagedSubscriptionRefreshError";
  }
}
const REFRESH_EXPIRY_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_LEASE_MS = 60_000;
const REFRESH_WAIT_MS = 250;
/** A vendor answer that refused the refresh (so nothing rotated); anything else may have rotated. */
const VENDOR_REFUSAL = /\((40[0-3])\)|\bstatus[ =:](40[0-3])\b|invalid_grant|invalid_request|unauthorized_client/i;
let refreshClock: () => number = () => Date.now();
export function __setManagedSubscriptionRefreshClockForTests(value: (() => number) | null): void {
  refreshClock = value ?? (() => Date.now());
}

type CredentialRow = { credential_id: string; provider_type: string; secret_ref: string; oauth_refresh: OAuthRefreshState | null };
async function lockCredential(db: Queryable, spaceId: string, providerId: string, ownerUserId: string | null): Promise<CredentialRow> {
  const row = (await db.query<CredentialRow>(
    `SELECT c.id AS credential_id,p.provider_type,c.secret_ref,c.metadata_json->'oauth_refresh' AS oauth_refresh
       FROM model_provider_space_grants g
       JOIN model_providers p ON p.id=g.provider_id
       JOIN credentials c ON c.id=p.credential_id
      WHERE g.space_id=$1 AND p.id=$2 AND g.enabled=true AND p.enabled=true
        AND c.credential_type='subscription_oauth'
        AND ($3::text IS NULL OR p.owner_user_id=$3)
      FOR UPDATE OF c`,
    [spaceId, providerId, ownerUserId],
  )).rows[0];
  if (!row) throw new ProviderCommandNotFoundError(`Managed subscription provider '${providerId}' not found`);
  return row;
}
async function writeRefreshState(db: Queryable, credentialId: string, state: OAuthRefreshState | null, secretRef?: string): Promise<void> {
  await db.query(
    `UPDATE credentials
        SET metadata_json=CASE WHEN $2::jsonb IS NULL THEN COALESCE(metadata_json,'{}'::jsonb)-'oauth_refresh'
                               ELSE jsonb_set(COALESCE(metadata_json,'{}'::jsonb),'{oauth_refresh}',$2::jsonb,true) END,
            secret_ref=COALESCE($3,secret_ref),updated_at=now()
      WHERE id=$1`,
    [credentialId, state ? JSON.stringify(state) : null, secretRef ?? null],
  );
}

/**
 * Resolves a managed subscription's current OAuth credential for in-process
 * use (a Run's provider call, a quota read). Every DB step is a short
 * transaction; the vendor refresh, when the access token is about to expire,
 * follows the once-only protocol above. Decrypted tokens never leave the
 * process and are never written anywhere but the encrypted `secret_ref`.
 */
export async function resolveManagedSubscriptionCredential(
  config: ServerConfig,
  pool: Pool,
  spaceId: string,
  providerId: string,
  ownerUserId?: string | null,
  signal?: AbortSignal,
): Promise<{
  type: ManagedSubscriptionType;
  credentialId: string;
  credential: ModelProviderOAuthSecretV1;
}> {
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  const deadline = refreshClock() + REFRESH_LEASE_MS;
  for (;;) {
    signal?.throwIfAborted();
    const step = await withTransaction(pool, async (tx) => {
      const row = await lockCredential(tx, spaceId, providerId, ownerUserId ?? null);
      const type = parseManagedSubscriptionType(row.provider_type);
      const credential = decryptModelProviderOAuthSecretRefV1(row.secret_ref, masterKey);
      const from = await secretFingerprint(config.rainverHome, credential.refresh);
      const pending = row.oauth_refresh;
      if (pending?.state === "unknown" && pending.from === from) throw new ManagedSubscriptionRefreshError("subscription_reconnect_required");
      if (pending?.state === "in_flight" && pending.from === from) {
        if (Date.parse(pending.lease_until ?? "") > refreshClock()) return { kind: "wait" as const };
        // Its attempt never settled: the vendor may have rotated the token it spent.
        await writeRefreshState(tx, row.credential_id, { ...pending, state: "unknown", lease_until: undefined });
        return { kind: "unknown" as const };
      }
      if (credential.expires > refreshClock() + REFRESH_EXPIRY_MARGIN_MS) {
        // A state left behind by a credential that was replaced since (a new login) is not this one's.
        if (pending) await writeRefreshState(tx, row.credential_id, null);
        return { kind: "ready" as const, type, credentialId: row.credential_id, credential };
      }
      const attempt: OAuthRefreshState = {
        state: "in_flight", attempt_id: randomUUID(), from,
        started_at: new Date(refreshClock()).toISOString(),
        lease_until: new Date(refreshClock() + REFRESH_LEASE_MS).toISOString(),
      };
      await writeRefreshState(tx, row.credential_id, attempt);
      return { kind: "refresh" as const, type, credentialId: row.credential_id, credential, attempt };
    });
    if (step.kind === "ready") return { type: step.type, credentialId: step.credentialId, credential: step.credential };
    if (step.kind === "unknown") throw new ManagedSubscriptionRefreshError("subscription_reconnect_required");
    if (step.kind === "wait") {
      if (refreshClock() >= deadline) throw new ManagedSubscriptionRefreshError("subscription_refresh_busy");
      await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS));
      continue;
    }
    // Outside every transaction: the one vendor call this attempt may make.
    let refreshed: ManagedOAuthCredential;
    const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    try {
      refreshed = await (await oauthFlow(step.type)).refresh(step.credential as ManagedOAuthCredential,
        signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (error) {
      const refusedByVendor = error instanceof Error && VENDOR_REFUSAL.test(error.message);
      await settleRefresh(pool, step.credentialId, step.attempt, refusedByVendor ? null : { ...step.attempt, state: "unknown", lease_until: undefined });
      if (!refusedByVendor) throw new ManagedSubscriptionRefreshError("subscription_reconnect_required");
      throw error;
    }
    const secretRef = encryptModelProviderOAuthSecretRefV1(refreshed, masterKey);
    const stored = await settleRefresh(pool, step.credentialId, step.attempt, null, secretRef);
    // Replaced meanwhile (a new login): the new credential is the current one, not this refresh.
    if (!stored) continue;
    return { type: step.type, credentialId: step.credentialId, credential: refreshed };
  }
}

/** Settles one refresh attempt, only while it is still the credential's current attempt. */
async function settleRefresh(pool: Pool, credentialId: string, attempt: OAuthRefreshState, next: OAuthRefreshState | null, secretRef?: string): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const current = (await tx.query<{ oauth_refresh: OAuthRefreshState | null }>(
      `SELECT metadata_json->'oauth_refresh' AS oauth_refresh FROM credentials WHERE id=$1 AND credential_type='subscription_oauth' FOR UPDATE`,
      [credentialId],
    )).rows[0];
    if (!current || current.oauth_refresh?.attempt_id !== attempt.attempt_id || current.oauth_refresh.state !== "in_flight") return false;
    await writeRefreshState(tx, credentialId, next, secretRef);
    return true;
  });
}

async function persistSubscription(
  config: ServerConfig,
  pool: Pool,
  type: ManagedSubscriptionType,
  spaceId: string,
  userId: string,
  credential: ManagedOAuthCredential,
  quota: QuotaResult,
): Promise<Record<string, unknown>> {
  const definition = subscriptionDefinition(type);
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.rainverHome);
  const secretRef = encryptModelProviderOAuthSecretRefV1(credential, masterKey);
  const client = await pool.connect();
  let providerId = "";
  try {
    await client.query("BEGIN");
    // The login waited on the person and the vendor: whoever started it must still be an
    // active member of this Space and the instance admin now, in the transaction that
    // writes, or nothing (credential, Provider, grant) is written.
    await assertCurrentActor(client, sessionActor({ spaceId, userId }), true);
    if (!(await isInstanceAdminIn(client, config, userId))) throw hidden();
    const existing = await client.query<{ id: string; credential_id: string | null }>(
      `SELECT p.id,p.credential_id FROM model_providers p
        LEFT JOIN credentials c ON c.id=p.credential_id
        WHERE p.space_id=$1 AND p.owner_user_id=$2 AND p.provider_type=$3
          AND (c.credential_type='subscription_oauth'
            OR p.config_json->>'credential_channel'='managed_subscription_oauth')
        ORDER BY p.created_at ASC LIMIT 1 FOR UPDATE OF p`,
      [spaceId, userId, type],
    );
    providerId = existing.rows[0]?.id ?? randomUUID();
    const credentialId = existing.rows[0]?.credential_id ?? randomUUID();
    const now = new Date();
    await client.query(
      `INSERT INTO credentials
        (id,space_id,owner_user_id,name,credential_type,secret_ref,scopes_json,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'subscription_oauth',$5,'[]'::jsonb,$6::jsonb,$7,$7)
       ON CONFLICT (id) DO UPDATE SET credential_type='subscription_oauth',secret_ref=EXCLUDED.secret_ref,
         metadata_json=EXCLUDED.metadata_json,owner_user_id=EXCLUDED.owner_user_id,updated_at=EXCLUDED.updated_at`,
      [credentialId, spaceId, userId, `${definition.name} OAuth`, secretRef, JSON.stringify({ quota }), now],
    );
    await client.query(
      `INSERT INTO model_providers
        (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,
         credential_id,network_profile_id,capabilities_json,config_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,NULL,$9::jsonb,$10::jsonb,$11,$11)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,base_url=EXCLUDED.base_url,
         default_model=EXCLUDED.default_model,enabled=true,credential_id=EXCLUDED.credential_id,
         capabilities_json=EXCLUDED.capabilities_json,config_json=EXCLUDED.config_json,
         updated_at=EXCLUDED.updated_at`,
      [providerId, spaceId, userId, definition.name, type, definition.baseUrl,
        definition.defaultModel, credentialId, JSON.stringify({ models: definition.models }),
        JSON.stringify({ credential_channel: "managed_subscription_oauth" }), now],
    );
    await client.query(
      `INSERT INTO model_provider_space_grants
        (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,
         network_profile_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$4,true,false,NULL,$5,$5)
       ON CONFLICT ON CONSTRAINT uq_model_provider_space_grants_provider_space
       DO UPDATE SET enabled=true,updated_at=EXCLUDED.updated_at`,
      [randomUUID(), providerId, spaceId, userId, now],
    );
    // Read in the same transaction: what the stream releases is what this checked authority wrote.
    const dto = await subscriptionProviderDto(client, spaceId, userId, providerId);
    await client.query("COMMIT");
    return dto;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function safeProbeQuota(type: ManagedSubscriptionType, credential: ManagedOAuthCredential): Promise<QuotaResult> {
  try {
    const quota = type === "anthropic"
      ? await probeClaudeOAuthQuotaWithAccessToken(credential.access)
      : await probeCodexQuota(credential);
    return { ...quota, checked_at: new Date().toISOString(), error: null };
  } catch (error) {
    return {
      available: false,
      session_pct: null,
      session_resets: null,
      week_pct: null,
      week_resets: null,
      checked_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Subscription quota probe failed.",
    };
  }
}

async function probeCodexQuota(credential: ManagedOAuthCredential): Promise<QuotaResult> {
  const accountId = typeof credential.accountId === "string" ? credential.accountId : "";
  if (!accountId) throw new Error("OpenAI Codex OAuth account id is missing.");
  const response = await (fetchOverride ?? fetch)("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${credential.access}`,
      "ChatGPT-Account-ID": accountId,
    },
  });
  if (!response.ok) throw new Error(`OpenAI Codex usage API returned HTTP ${response.status}.`);
  const quota = parseCodexManagedUsageResponse(await response.json());
  if (!quota.available) throw new Error("OpenAI Codex usage API returned no quota windows.");
  return quota;
}

async function subscriptionProviderDto(
  pool: Queryable,
  spaceId: string,
  userId: string,
  providerId: string,
  includeDisabled = false,
): Promise<Record<string, unknown>> {
  const result = await pool.query<ProviderRow>(
    `SELECT p.id,g.space_id,p.space_id AS home_space_id,p.owner_user_id,g.id AS grant_id,
            true AS manageable,g.enabled AS grant_enabled,p.name,p.provider_type,p.base_url,
            COALESCE(g.network_profile_id,p.network_profile_id) AS network_profile_id,
            p.default_model,p.enabled,p.credential_id,c.credential_type,
            c.metadata_json AS credential_metadata_json,p.capabilities_json,
            jsonb_set(COALESCE(p.config_json,'{}'::jsonb),'{is_default}',to_jsonb(g.is_default),true) AS config_json,
            g.is_default AS grant_is_default,p.created_at,p.updated_at
       FROM model_providers p
       JOIN model_provider_space_grants g ON g.provider_id=p.id AND g.space_id=$1
       LEFT JOIN credentials c ON c.id=p.credential_id
      WHERE p.id=$2 AND p.owner_user_id=$3 ${includeDisabled ? "" : "AND p.enabled=true AND g.enabled=true"}
      LIMIT 1`,
    [spaceId, providerId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new ProviderCommandNotFoundError(`Managed subscription provider '${providerId}' not found`);
  return mapProviderRowToDto(row);
}

export interface ManagedSubscriptionLoginSession {
  interaction: ManagedAuthInteraction;
  submit(input: string): boolean;
  cancel(): void;
}

export function createManagedSubscriptionLoginSession(
  type: ManagedSubscriptionType,
  emit: (event: ManagedAuthEvent | { type: "prompt"; promptType: string; message: string; placeholder?: string }) => void,
): ManagedSubscriptionLoginSession {
  const controller = new AbortController();
  let pending: ((value: string) => void) | null = null;
  let pendingReject: ((error: Error) => void) | null = null;
  const interaction: ManagedAuthInteraction = {
    signal: controller.signal,
    notify: emit,
    async prompt(prompt: ManagedAuthPrompt): Promise<string> {
      if (prompt.type === "select" && type === "openai_codex") return "device_code";
      if (prompt.type !== "manual_code" && prompt.type !== "text") {
        throw new Error(`Unsupported managed OAuth prompt '${prompt.type}'`);
      }
      // An abort that fired before this prompt existed fires no event for it:
      // the browser closes the login stream while the library is still minting
      // PKCE and opening its callback port. Waiting here would hold the login
      // session key and that port until a restart.
      if (controller.signal.aborted || prompt.signal?.aborted) {
        throw new Error("Login cancelled");
      }
      emit({ type: "prompt", promptType: prompt.type, message: prompt.message, placeholder: prompt.placeholder });
      const abort = () => pendingReject?.(new Error("Login cancelled"));
      return new Promise<string>((resolve, reject) => {
        pending = resolve;
        pendingReject = reject;
        controller.signal.addEventListener("abort", abort, { once: true });
        prompt.signal?.addEventListener("abort", abort, { once: true });
      }).finally(() => {
        pending = null;
        pendingReject = null;
        controller.signal.removeEventListener("abort", abort);
        prompt.signal?.removeEventListener("abort", abort);
      });
    },
  };
  return {
    interaction,
    submit(input) {
      if (!pending) return false;
      pending(input);
      return true;
    },
    cancel() {
      controller.abort();
      pendingReject?.(new Error("Login cancelled"));
    },
  };
}
