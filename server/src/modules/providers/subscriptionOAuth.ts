import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "./db";
import { mapProviderRowToDto, type ProviderRow } from "./dbReader";
import {
  decryptModelProviderOAuthSecretRefV1,
  encryptModelProviderOAuthSecretRefV1,
  loadOrCreateModelProviderApiKeyMasterKey,
  type ModelProviderOAuthSecretV1,
} from "./secretRefCrypto";
import { probeClaudeOAuthQuotaWithAccessToken } from "./cli/claudeOAuthUsageProbe";
import { parseCodexManagedUsageResponse } from "./cli/codexUsageProbe";
import type { QuotaResult } from "./cli/usageProbe";
import { ProviderCommandNotFoundError, ProviderCommandValidationError } from "./commands/types";
import {
  loadManagedOAuthFlow,
  type ManagedAuthEvent,
  type ManagedAuthInteraction,
  type ManagedAuthPrompt,
  type ManagedOAuthCredential,
  type ManagedOAuthFlow,
} from "./invocation/piAiChat";

export type ManagedSubscriptionType = "anthropic" | "openai_codex";
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

export async function disconnectManagedSubscription(
  config: ServerConfig,
  spaceId: string,
  userId: string,
  providerId: string,
): Promise<Record<string, unknown>> {
  if (!config.databaseUrl) throw new Error("Managed subscription OAuth requires SERVER_DATABASE_URL");
  const pool = getDbPool(config.databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ credential_id: string }>(
      `SELECT p.credential_id
         FROM model_providers p
         JOIN credentials c ON c.id=p.credential_id AND c.credential_type='subscription_oauth'
        WHERE p.id=$1 AND p.space_id=$2 AND p.owner_user_id=$3
        FOR UPDATE OF p, c`,
      [providerId, spaceId, userId],
    );
    const credentialId = found.rows[0]?.credential_id;
    if (!credentialId) throw new ProviderCommandNotFoundError(`Managed subscription provider '${providerId}' not found`);
    await client.query(
      `UPDATE model_providers SET credential_id=NULL,enabled=false,updated_at=$2 WHERE id=$1`,
      [providerId, new Date()],
    );
    await client.query(`DELETE FROM credentials WHERE id=$1`, [credentialId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return subscriptionProviderDto(pool, spaceId, userId, providerId, true);
}

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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      credential_id: string;
      provider_type: string;
      secret_ref: string;
    }>(
      `SELECT c.id AS credential_id,p.provider_type,c.secret_ref
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id=g.provider_id
         JOIN credentials c ON c.id=p.credential_id
        WHERE g.space_id=$1 AND p.id=$2 AND g.enabled=true AND p.enabled=true
          AND c.credential_type='subscription_oauth'
          AND ($3::text IS NULL OR p.owner_user_id=$3)
        FOR UPDATE OF c`,
      [spaceId, providerId, ownerUserId ?? null],
    );
    const row = selected.rows[0];
    if (!row) throw new ProviderCommandNotFoundError(`Managed subscription provider '${providerId}' not found`);
    const type = parseManagedSubscriptionType(row.provider_type);
    const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.agentSpaceHome);
    let credential = decryptModelProviderOAuthSecretRefV1(row.secret_ref, masterKey);
    if (credential.expires <= Date.now() + 60_000) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        credential = await (await oauthFlow(type)).refresh(credential as ManagedOAuthCredential, controller.signal);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      await client.query(
        `UPDATE credentials SET secret_ref=$2,updated_at=$3 WHERE id=$1`,
        [row.credential_id, encryptModelProviderOAuthSecretRefV1(credential, masterKey), new Date()],
      );
    }
    await client.query("COMMIT");
    return { type, credentialId: row.credential_id, credential };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  const masterKey = await loadOrCreateModelProviderApiKeyMasterKey(config.agentSpaceHome);
  const secretRef = encryptModelProviderOAuthSecretRefV1(credential, masterKey);
  const client = await pool.connect();
  let providerId = "";
  try {
    await client.query("BEGIN");
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return subscriptionProviderDto(pool, spaceId, userId, providerId);
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
  pool: Pool,
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
      emit({ type: "prompt", promptType: prompt.type, message: prompt.message, placeholder: prompt.placeholder });
      return new Promise<string>((resolve, reject) => {
        pending = resolve;
        pendingReject = reject;
        const abort = () => reject(new Error("Login cancelled"));
        controller.signal.addEventListener("abort", abort, { once: true });
        prompt.signal?.addEventListener("abort", abort, { once: true });
      }).finally(() => {
        pending = null;
        pendingReject = null;
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
