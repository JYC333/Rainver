/**
 * Provider command persistence, credential pools, and credential resolution.
 *
 * This store is used by provider commands and the provider credential channel.
 *
 * Credential pools: a provider holds 1→N encrypted Credentials
 * through `model_provider_credentials` rows. The primary credential
 * (`model_providers.credential_id`) is lazily enrolled as the position-0 pool
 * member, so pre-pool rows keep working without a data migration and all
 * rotation/health state lives in one place. Failure state is self-healing:
 * a failed key gets `cooldown_until` (never a permanent dead flag), and
 * selection simply skips cooling keys. `healthy=false` marks auth-class
 * failures for operators but does not outlive its cooldown.
 *
 * Rotation strategy and the provider fallback chain are provider-level
 * configuration in `config_json` (same pattern as `is_default`), so no
 * provider-table schema change is needed.
 */

import { randomUUID } from "node:crypto";
import { getDbPool, type Pool } from "../db.js";
import type { ServerConfig } from "../../../config.js";
import {
  decryptModelProviderApiKeySecretRefV1,
  encryptModelProviderApiKeySecretRefV1,
  loadOrCreateModelProviderApiKeyMasterKey,
} from "../secretRefCrypto.js";
import { mapProviderRowToDto } from "../dbReader.js";
import { providerVendor, type VendorDescriptor } from "../vendors.js";
import { resolveManagedSubscriptionCredential } from "../subscriptionOAuth.js";
import { resolveNetworkProfileRepository } from "../../networkProfiles/index.js";
import { isSpaceOwnerOrAdmin } from "../../access/roles.js";
import { SpaceAssistantService } from "../../agents/spaceAssistantService.js";
import {
  recordAttributedUsageObservation,
  resolveUsageObservationAttribution,
  type UsageAttribution,
  type UsageObservation,
} from "../../usage/index.js";
import {
  ROTATION_STRATEGIES,
  configRecord,
  configuredModelsFromRow,
  fallbackProviderIdsFromRow,
  isDefaultFromRow,
  json,
  mapPoolMember,
  modelList,
  normalizeBaseUrl,
  optionalTrimmedString,
  orderPoolMembers,
  providerInfoFromRow,
  rotationStrategyFromRow,
  validateBaseUrl,
  validateCreateFields,
  validateProviderType,
  type PoolMemberRow,
  type ProviderRow,
} from "./helpers.js";
import {
  ProviderCommandForbiddenError,
  ProviderCommandNotFoundError,
  ProviderCommandValidationError,
  type CliCredentialAuditInput,
  type InvocationTarget,
  type ModelProviderCreateInput,
  type ModelProviderUpdateInput,
  type PoolKeyCandidate,
  type PoolOutcome,
  type ProviderCommandStore,
  type ProviderPoolConfigUpdateInput,
  type ProviderPoolCredentialAddInput,
  type ProviderSpaceGrantInput,
  type ProviderTaskChainEntry,
  type ProviderTaskAttemptRefs,
  type ProviderTaskAttemptStart,
} from "./types.js";

export {
  ProviderCommandForbiddenError,
  ProviderCommandNotFoundError,
  ProviderCommandValidationError,
  type CliCredentialAuditInput,
  type InvocationTarget,
  type ModelProviderCreateInput,
  type ModelProviderUpdateInput,
  type PoolKeyCandidate,
  type PoolOutcome,
  type ProviderCommandStore,
  type ProviderInfo,
  type ProviderPoolConfigUpdateInput,
  type ProviderPoolCredentialAddInput,
  type ProviderSpaceGrantInput,
  type ProviderTaskChainEntry,
  type ProviderTaskAttemptRefs,
  type ProviderTaskAttemptStart,
  type RotationStrategy,
} from "./types.js";
export { orderPoolMembers } from "./helpers.js";

function grantOut(row: {
  id: string;
  provider_id: string;
  space_id: string;
  owner_user_id: string | null;
  granted_by_user_id: string | null;
  enabled: boolean;
  is_default: boolean;
  network_profile_id: string | null;
  created_at: Date;
  updated_at: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    provider_id: row.provider_id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id,
    granted_by_user_id: row.granted_by_user_id,
    enabled: row.enabled,
    is_default: row.is_default,
    network_profile_id: row.network_profile_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Which vendor capability each retrieval task needs. The capability itself is
 * the vendor registry's, read here rather than restated: this table used to
 * repeat the per-vendor lists, which made it a second answer to a question
 * `VendorDescriptor` already answers — and a silently divergent one the moment
 * a vendor changed.
 *
 * Query rewrite and synthesis are chat calls, and exclude a vendor reachable
 * only through a managed subscription. That exclusion is about the credential
 * channel, not about ownership: every provider of such a vendor is created by
 * the subscription flow and carries an owner, so a space-wide task chain built
 * from one would be spending an individual's subscription on the whole Space's
 * background work. Note this is not a general owner-scoping rule — an
 * API-key Anthropic provider and a managed Claude subscription share the
 * `anthropic` vendor, and only the credential distinguishes them.
 */
const TASK_REQUIRED_CAPABILITY: Record<string, (vendor: VendorDescriptor) => boolean> = {
  retrieval_embedding: (vendor) => vendor.supportsEmbedding,
  retrieval_rerank: (vendor) => vendor.supportsRerank,
  retrieval_query_rewrite: (vendor) => vendor.supportsChat && !vendor.subscriptionOnly,
  retrieval_synthesis: (vendor) => vendor.supportsChat && !vendor.subscriptionOnly,
  room_conversation_title: (vendor) => vendor.supportsChat && !vendor.subscriptionOnly,
};

export function providerSupportsTask(task: string, providerType: string): boolean {
  const required = TASK_REQUIRED_CAPABILITY[task];
  if (!required) return true;
  const vendor = providerVendor(providerType);
  return vendor ? required(vendor) : false;
}

function validateTaskProviderCompatibility(
  task: string,
  provider: ProviderRow,
): void {
  if (providerSupportsTask(task, provider.provider_type)) return;
  throw new ProviderCommandValidationError(
    `Provider '${provider.id}' (${provider.provider_type}) is not compatible with task '${task}'`,
  );
}

class PgProviderCommandStore implements ProviderCommandStore {
  private pool: Pool;

  constructor(private config: ServerConfig) {
    if (!config.databaseUrl) {
      throw new Error("Provider command store requires SERVER_DATABASE_URL");
    }
    this.pool = getDbPool(config.databaseUrl);
  }

  private async masterKey(): Promise<Buffer> {
    return loadOrCreateModelProviderApiKeyMasterKey(this.config.rainverHome);
  }

  private async reconcileManagedAssistantProfilesForSpace(spaceId: string): Promise<void> {
    await SpaceAssistantService.reconcileModelApiProfiles(this.pool, spaceId);
  }

  private async reconcileManagedAssistantProfilesForProvider(providerId: string): Promise<void> {
    const grants = await this.pool.query<{ space_id: string }>(
      `SELECT DISTINCT space_id
         FROM model_provider_space_grants
        WHERE provider_id = $1`,
      [providerId],
    );
    for (const grant of grants.rows) {
      await this.reconcileManagedAssistantProfilesForSpace(grant.space_id);
    }
  }

  private async providerById(spaceId: string, providerId: string): Promise<ProviderRow | null> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT p.id,
              g.space_id AS space_id,
              p.space_id AS home_space_id,
              p.owner_user_id,
              p.name,
              p.provider_type,
              p.base_url,
              p.default_model,
              COALESCE(g.network_profile_id, p.network_profile_id) AS network_profile_id,
              p.enabled,
              p.credential_id,
              p.capabilities_json,
              p.config_json,
              g.is_default AS grant_is_default,
              p.created_at,
              p.updated_at
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id = g.provider_id
        WHERE g.space_id = $1
          AND g.provider_id = $2
          AND g.enabled = true
          AND p.enabled = true
        LIMIT 1`,
      [spaceId, providerId],
    );
    return result.rows[0] ?? null;
  }

  private async defaultProvider(spaceId: string): Promise<ProviderRow | null> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT p.id,
              g.space_id AS space_id,
              p.space_id AS home_space_id,
              p.owner_user_id,
              p.name,
              p.provider_type,
              p.base_url,
              p.default_model,
              COALESCE(g.network_profile_id, p.network_profile_id) AS network_profile_id,
              p.enabled,
              p.credential_id,
              p.capabilities_json,
              p.config_json,
              g.is_default AS grant_is_default,
              p.created_at,
              p.updated_at
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id = g.provider_id
        WHERE g.space_id = $1
          AND g.enabled = true
          AND p.enabled = true
          AND g.is_default = true
        ORDER BY p.created_at DESC
        LIMIT 1`,
      [spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async providerOwnedBy(userId: string, providerId: string): Promise<ProviderRow | null> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT id, space_id, space_id AS home_space_id, owner_user_id, name, provider_type,
              base_url, default_model, network_profile_id, enabled, credential_id,
              capabilities_json, config_json, created_at, updated_at
         FROM model_providers
        WHERE id = $1 AND owner_user_id = $2
        LIMIT 1`,
      [providerId, userId],
    );
    return result.rows[0] ?? null;
  }

  private async requireOwnedProvider(userId: string, providerId: string): Promise<ProviderRow> {
    const row = await this.providerOwnedBy(userId, providerId);
    if (!row) {
      throw new ProviderCommandNotFoundError(`ModelProvider '${providerId}' not found`);
    }
    return row;
  }

  private async requireProvider(spaceId: string, providerId: string): Promise<ProviderRow> {
    const row = await this.providerById(spaceId, providerId);
    if (!row) {
      throw new ProviderCommandNotFoundError(`ModelProvider '${providerId}' not found`);
    }
    return row;
  }

  private assertPoolSupported(row: ProviderRow): void {
    if (configRecord(row).credential_channel === "managed_subscription_oauth") {
      throw new ProviderCommandValidationError(
        "Managed subscription providers do not support credential pools",
      );
    }
  }

  private async clearDefault(spaceId: string, exceptId?: string): Promise<void> {
    await this.pool.query(
      `UPDATE model_provider_space_grants
          SET is_default = false,
              updated_at = $2
        WHERE space_id = $1
          AND ($3::text IS NULL OR provider_id <> $3)`,
      [spaceId, new Date(), exceptId ?? null],
    );
  }

  private async validateNetworkProfileId(
    spaceId: string,
    value: string | null | undefined,
  ): Promise<string | null> {
    const networkProfileId = optionalTrimmedString(value);
    if (!networkProfileId) return null;
    const profile = await resolveNetworkProfileRepository(this.config).resolve(
      spaceId,
      networkProfileId,
    );
    if (!profile) {
      throw new ProviderCommandValidationError(
        `NetworkProfile '${networkProfileId}' not found`,
      );
    }
    return networkProfileId;
  }

  /**
   * Ensure the primary credential (`model_providers.credential_id`)
   * has a position-0 pool row, so pre-pool providers keep working and all
   * health state is tracked uniformly.
   */
  private async enrollPrimaryCredential(row: ProviderRow): Promise<void> {
    if (!row.credential_id) return;
    const now = new Date();
    const homeSpaceId = typeof row.home_space_id === "string" && row.home_space_id
      ? row.home_space_id
      : row.space_id;
    await this.pool.query(
      `INSERT INTO model_provider_credentials
        (id, space_id, provider_id, credential_id, position, enabled, healthy,
         request_count, failure_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, true, true, 0, 0, $5, $5)
       ON CONFLICT ON CONSTRAINT uq_model_provider_credentials_provider_credential
       DO NOTHING`,
      [randomUUID(), homeSpaceId, row.id, row.credential_id, now],
    );
  }

  private async poolMembers(
    _spaceId: string,
    providerId: string,
    withSecrets: boolean,
  ): Promise<PoolMemberRow[]> {
    const secretColumn = withSecrets ? ", c.secret_ref" : "";
    const result = await this.pool.query<PoolMemberRow>(
      `SELECT m.id, m.credential_id, c.name, m.position, m.enabled, m.healthy,
              m.cooldown_until, m.last_failure_class, m.request_count,
              m.failure_count, m.last_used_at, m.created_at, m.updated_at${secretColumn}
         FROM model_provider_credentials m
         JOIN credentials c ON c.id = m.credential_id AND c.credential_type = 'api_key'
        WHERE m.provider_id = $1
        ORDER BY m.position ASC, m.created_at ASC`,
      [providerId],
    );
    return result.rows;
  }

  private async attachApiKeyCredential(
    homeSpaceId: string,
    ownerUserId: string,
    providerId: string,
    providerName: string,
    existingCredentialId: string | null | undefined,
    apiKey: string,
  ): Promise<string> {
    const secretRef = encryptModelProviderApiKeySecretRefV1(apiKey, await this.masterKey());
    const now = new Date();
    if (existingCredentialId) {
      const updated = await this.pool.query<{ id: string }>(
        `UPDATE credentials
            SET secret_ref = $3, owner_user_id = COALESCE(owner_user_id, $5), updated_at = $4
          WHERE id = $1 AND space_id = $2 AND credential_type = 'api_key'
          RETURNING id`,
        [existingCredentialId, homeSpaceId, secretRef, now, ownerUserId],
      );
      if (updated.rows[0]) {
        // A re-keyed credential is healthy again until proven otherwise.
        await this.pool.query(
          `UPDATE model_provider_credentials
              SET healthy = true, cooldown_until = NULL, last_failure_class = NULL, updated_at = $3
            WHERE space_id = $1 AND credential_id = $2`,
          [homeSpaceId, existingCredentialId, now],
        );
        return updated.rows[0].id;
      }
    }

    const credentialId = randomUUID();
    await this.pool.query(
      `INSERT INTO credentials
        (id, space_id, owner_user_id, name, credential_type, secret_ref, scopes_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'api_key', $5, $6::jsonb, $7, $7)`,
      [credentialId, homeSpaceId, ownerUserId, `${providerName} API key`, secretRef, json([]), now],
    );
    await this.pool.query(
      `UPDATE model_providers SET credential_id = $3, updated_at = $4
        WHERE id = $1 AND space_id = $2`,
      [providerId, homeSpaceId, credentialId, now],
    );
    await this.pool.query(
      `INSERT INTO model_provider_credentials
        (id, space_id, provider_id, credential_id, position, enabled, healthy,
         request_count, failure_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, true, true, 0, 0, $5, $5)
       ON CONFLICT ON CONSTRAINT uq_model_provider_credentials_provider_credential
       DO NOTHING`,
      [randomUUID(), homeSpaceId, providerId, credentialId, now],
    );
    return credentialId;
  }

  async createProvider(
    spaceId: string,
    userId: string,
    input: ModelProviderCreateInput,
  ): Promise<unknown> {
    validateCreateFields(input);
    const isDefault = Boolean(input.is_default);
    if (isDefault) await this.clearDefault(spaceId);
    const networkProfileId = await this.validateNetworkProfileId(
      spaceId,
      input.network_profile_id,
    );

    const providerId = randomUUID();
    const now = new Date();
    const models = modelList(input.default_model, input.available_models ?? []);
    const name = input.name.trim();
    const baseUrl = normalizeBaseUrl(input.provider_type, input.base_url);
    await this.pool.query(
      `INSERT INTO model_providers
        (id, space_id, owner_user_id, name, provider_type, base_url, default_model, enabled,
         credential_id, network_profile_id, capabilities_json, config_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9::jsonb, $10::jsonb, $11, $11)`,
      [
        providerId,
        spaceId,
        userId,
        name,
        input.provider_type,
        baseUrl,
        input.default_model || (models[0] ?? null),
        input.enabled ?? true,
        json({ models }),
        json({
          ...(optionalTrimmedString(input.claude_compatible_base_url)
            ? { claude_compatible_base_url: optionalTrimmedString(input.claude_compatible_base_url) }
            : {}),
          ...(optionalTrimmedString(input.openai_compatible_base_url)
            ? { openai_compatible_base_url: optionalTrimmedString(input.openai_compatible_base_url) }
            : {}),
        }),
        now,
      ],
    );
    await this.pool.query(
      `INSERT INTO model_provider_space_grants
        (id, provider_id, space_id, owner_user_id, granted_by_user_id, enabled,
         is_default, network_profile_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, true, $5, $6, $7, $7)`,
      [randomUUID(), providerId, spaceId, userId, isDefault, networkProfileId, now],
    );
    if (input.api_key?.trim()) {
      await this.attachApiKeyCredential(spaceId, userId, providerId, name, null, input.api_key);
    }
    const row = await this.providerById(spaceId, providerId);
    if (!row) throw new Error("created provider was not readable");
    await this.reconcileManagedAssistantProfilesForSpace(spaceId);
    return mapProviderRowToDto(row);
  }

  async updateProvider(
    spaceId: string,
    userId: string,
    providerId: string,
    input: ModelProviderUpdateInput,
  ): Promise<unknown> {
    const current = await this.requireOwnedProvider(userId, providerId);
    const currentConfig = configRecord(current);
    const isManagedSubscription = currentConfig.credential_channel === "managed_subscription_oauth";
    if (isManagedSubscription && (input.api_key !== undefined || (
      input.provider_type !== undefined && input.provider_type !== current.provider_type
    ))) {
      throw new ProviderCommandValidationError(
        "Managed subscription providers cannot replace credentials or change provider type",
      );
    }

    const providerType = input.provider_type ?? current.provider_type;
    validateProviderType(providerType);
    if (!isManagedSubscription && providerType === "openai_codex") {
      throw new ProviderCommandValidationError(
        "OpenAI Codex providers must be connected through managed subscription OAuth",
      );
    }
    const baseUrl =
      input.base_url === undefined
        ? normalizeBaseUrl(providerType, current.base_url)
        : normalizeBaseUrl(providerType, input.base_url);
    validateBaseUrl(providerType, baseUrl);
    const networkProfileId =
      input.network_profile_id === undefined
        ? current.network_profile_id ?? null
        : await this.validateNetworkProfileId(spaceId, input.network_profile_id);
    if (input.is_default === true && !isDefaultFromRow(current)) {
      await this.clearDefault(spaceId, providerId);
    }

    let credentialId = current.credential_id ?? null;
    const name = input.name === undefined ? current.name : input.name.trim();
    const apiKey = input.api_key?.trim();
    if (apiKey) {
      credentialId = await this.attachApiKeyCredential(
        current.space_id,
        userId,
        providerId,
        name,
        credentialId,
        apiKey,
      );
    }

    const available =
      input.available_models === undefined
        ? configuredModelsFromRow(current)
        : input.available_models;
    const defaultModel =
      input.default_model === undefined ? current.default_model : input.default_model || null;
    const configJson = currentConfig;
    delete configJson.is_default;
    if (input.claude_compatible_base_url !== undefined) {
      const claudeUrl = optionalTrimmedString(input.claude_compatible_base_url);
      if (claudeUrl) configJson.claude_compatible_base_url = claudeUrl;
      else delete configJson.claude_compatible_base_url;
    }
    if (input.openai_compatible_base_url !== undefined) {
      const openAiUrl = optionalTrimmedString(input.openai_compatible_base_url);
      if (openAiUrl) configJson.openai_compatible_base_url = openAiUrl;
      else delete configJson.openai_compatible_base_url;
    }

    const updated = await this.pool.query<ProviderRow>(
      `UPDATE model_providers
          SET name = $3,
              provider_type = $4,
              base_url = $5,
              default_model = $6,
              enabled = $7,
              credential_id = $8,
              network_profile_id = $9,
              capabilities_json = $10::jsonb,
              config_json = $11::jsonb,
              updated_at = $12
          WHERE id = $1 AND space_id = $2
        RETURNING id, space_id, name, provider_type, base_url, default_model,
                  network_profile_id, enabled, credential_id, capabilities_json, config_json,
                  created_at, updated_at`,
      [
        providerId,
        current.space_id,
        name,
        providerType,
        baseUrl,
        defaultModel,
        input.enabled ?? current.enabled,
        credentialId,
        null,
        json({ models: modelList(defaultModel, available) }),
        json(configJson),
        new Date(),
      ],
    );
    if (input.network_profile_id !== undefined || input.is_default !== undefined) {
      await this.grantProviderToSpace(spaceId, userId, providerId, {
        space_id: spaceId,
        network_profile_id: input.network_profile_id === undefined ? undefined : networkProfileId,
        is_default: input.is_default,
      });
    }
    const row = await this.providerById(spaceId, providerId);
    await this.reconcileManagedAssistantProfilesForProvider(providerId);
    if (!row) return mapProviderRowToDto(updated.rows[0]);
    return mapProviderRowToDto({ ...row, manageable: true });
  }

  async deleteProvider(spaceId: string, userId: string, providerId: string): Promise<void> {
    const current = await this.requireOwnedProvider(userId, providerId);
    const cfg = configRecord(current);
    cfg.is_default = false;
    await this.pool.query(
      `UPDATE model_providers
          SET enabled = false, config_json = $3::jsonb, updated_at = $4
        WHERE id = $1 AND space_id = $2`,
      [providerId, current.space_id, json(cfg), new Date()],
    );
    await this.pool.query(
      `UPDATE model_provider_space_grants
          SET enabled = false, is_default = false, updated_at = $2
        WHERE provider_id = $1`,
      [providerId, new Date()],
    );
    await this.reconcileManagedAssistantProfilesForProvider(providerId);
  }

  private async userSpaceRole(userId: string, spaceId: string): Promise<string | null> {
    const result = await this.pool.query<{ role: string }>(
      `SELECT role
         FROM space_memberships
        WHERE user_id = $1 AND space_id = $2 AND status = 'active'
        LIMIT 1`,
      [userId, spaceId],
    );
    return result.rows[0]?.role ?? null;
  }

  private async requireSpaceMembership(userId: string, spaceId: string): Promise<void> {
    if (await this.userSpaceRole(userId, spaceId)) return;
    throw new ProviderCommandNotFoundError(`Space '${spaceId}' not found`);
  }

  private async canAdminSpace(userId: string, spaceId: string): Promise<boolean> {
    const role = await this.userSpaceRole(userId, spaceId);
    return isSpaceOwnerOrAdmin(role);
  }

  async grantProviderToSpace(
    activeSpaceId: string,
    userId: string,
    providerId: string,
    input: ProviderSpaceGrantInput,
  ): Promise<unknown> {
    const provider = await this.requireOwnedProvider(userId, providerId);
    const targetSpaceId = input.space_id || activeSpaceId;
    if (
      configRecord(provider).credential_channel === "managed_subscription_oauth"
      && targetSpaceId !== provider.space_id
    ) {
      throw new ProviderCommandForbiddenError(
        "Managed subscription providers cannot be granted to another space",
      );
    }
    if (provider.credential_id) {
      const credential = await this.pool.query<{ credential_type: string }>(
        `SELECT credential_type FROM credentials WHERE id=$1 LIMIT 1`,
        [provider.credential_id],
      );
      if (
        credential.rows[0]?.credential_type === "subscription_oauth"
        && targetSpaceId !== provider.space_id
      ) {
        throw new ProviderCommandForbiddenError(
          "Managed subscription providers cannot be granted to another space",
        );
      }
    }
    await this.requireSpaceMembership(userId, targetSpaceId);
    const networkProfileId =
      input.network_profile_id === undefined
        ? undefined
        : await this.validateNetworkProfileId(targetSpaceId, input.network_profile_id);
    const existingGrant = await this.pool.query<{ is_default: boolean }>(
      `SELECT is_default
         FROM model_provider_space_grants
        WHERE provider_id = $1 AND space_id = $2
        LIMIT 1`,
      [providerId, targetSpaceId],
    );
    const isDefault =
      input.is_default === undefined
        ? Boolean(existingGrant.rows[0]?.is_default)
        : Boolean(input.is_default);
    if (isDefault) await this.clearDefault(targetSpaceId, providerId);
    const now = new Date();
    const result = await this.pool.query<{
      id: string;
      provider_id: string;
      space_id: string;
      owner_user_id: string | null;
      granted_by_user_id: string | null;
      enabled: boolean;
      is_default: boolean;
      network_profile_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO model_provider_space_grants
        (id, provider_id, space_id, owner_user_id, granted_by_user_id, enabled,
         is_default, network_profile_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT ON CONSTRAINT uq_model_provider_space_grants_provider_space
       DO UPDATE SET enabled = EXCLUDED.enabled,
                     is_default = EXCLUDED.is_default,
                     network_profile_id = CASE
                       WHEN $10::boolean THEN EXCLUDED.network_profile_id
                       ELSE model_provider_space_grants.network_profile_id
                     END,
                     granted_by_user_id = EXCLUDED.granted_by_user_id,
                     owner_user_id = EXCLUDED.owner_user_id,
                     updated_at = EXCLUDED.updated_at
       RETURNING id, provider_id, space_id, owner_user_id, granted_by_user_id,
                 enabled, is_default, network_profile_id, created_at, updated_at`,
      [
        randomUUID(),
        providerId,
        targetSpaceId,
        provider.owner_user_id ?? userId,
        userId,
        input.enabled ?? true,
        isDefault,
        networkProfileId ?? null,
        now,
        input.network_profile_id !== undefined,
      ],
    );
    await this.reconcileManagedAssistantProfilesForSpace(targetSpaceId);
    return grantOut(result.rows[0]);
  }

  async revokeProviderGrant(
    _activeSpaceId: string,
    userId: string,
    providerId: string,
    grantSpaceId: string,
  ): Promise<void> {
    const owned = await this.providerOwnedBy(userId, providerId);
    if (!owned && !(await this.canAdminSpace(userId, grantSpaceId))) {
      throw new ProviderCommandNotFoundError(`ModelProvider '${providerId}' not found`);
    }
    const result = await this.pool.query(
      `UPDATE model_provider_space_grants
          SET enabled = false,
              is_default = false,
              updated_at = $3
        WHERE provider_id = $1 AND space_id = $2 AND enabled = true
        RETURNING id`,
      [providerId, grantSpaceId, new Date()],
    );
    if (result.rowCount === 0) {
      throw new ProviderCommandNotFoundError(`ModelProvider grant not found`);
    }
    await this.reconcileManagedAssistantProfilesForSpace(grantSpaceId);
  }

  async getInvocationTarget(
    spaceId: string,
    providerId?: string | null,
    subjectUserId?: string | null,
  ): Promise<InvocationTarget> {
    const row = providerId
      ? await this.providerById(spaceId, providerId)
      : await this.defaultProvider(spaceId);
    if (!row) {
      throw new ProviderCommandNotFoundError(
        providerId ? `ModelProvider '${providerId}' not found` : "No default provider configured",
      );
    }
    if (!row.enabled) {
      throw new ProviderCommandNotFoundError(`ModelProvider '${row.id}' is disabled`);
    }
    if (row.credential_id) {
      const credentialClass = await this.pool.query<{ credential_type: string }>(
        `SELECT credential_type FROM credentials WHERE id=$1 LIMIT 1`,
        [row.credential_id],
      );
      if (credentialClass.rows[0]?.credential_type === "subscription_oauth") {
        if (!subjectUserId || subjectUserId !== row.owner_user_id) {
          throw new ProviderCommandForbiddenError(
            "Managed subscription credentials can only be used by their owner",
          );
        }
        const resolved = await resolveManagedSubscriptionCredential(
          this.config,
          this.pool,
          spaceId,
          row.id,
          subjectUserId,
        );
        return {
          provider: providerInfoFromRow(row),
          network_profile: await resolveNetworkProfileRepository(this.config).resolve(
            spaceId,
            row.network_profile_id,
          ),
          rotation_strategy: "fill_first",
          fallback_provider_ids: fallbackProviderIdsFromRow(row),
          candidates: [{
            member_id: null,
            credential_id: resolved.credentialId,
            api_key: resolved.credential.access,
            credential_kind: "subscription_oauth",
          }],
        };
      }
    }
    await this.enrollPrimaryCredential(row);

    const strategy = rotationStrategyFromRow(row);
    const members = await this.poolMembers(spaceId, row.id, true);
    const now = Date.now();
    const available = members.filter(
      (m) => m.enabled && (!m.cooldown_until || m.cooldown_until.getTime() <= now),
    );
    const masterKey = members.length > 0 ? await this.masterKey() : null;
    const candidates: PoolKeyCandidate[] = orderPoolMembers(available, strategy).map((m) => ({
      member_id: m.id,
      credential_id: m.credential_id,
      api_key: masterKey && m.secret_ref
        ? decryptModelProviderApiKeySecretRefV1(m.secret_ref, masterKey)
        : null,
      credential_kind: "api_key",
    }));
    // Key-less providers (e.g. ollama) still get one attempt slot.
    if (candidates.length === 0 && members.length === 0) {
      candidates.push({ member_id: null, credential_id: null, api_key: null, credential_kind: "none" });
    }
    return {
      provider: providerInfoFromRow(row),
      network_profile: await resolveNetworkProfileRepository(this.config).resolve(
        spaceId,
        row.network_profile_id,
      ),
      rotation_strategy: strategy,
      fallback_provider_ids: fallbackProviderIdsFromRow(row),
      candidates,
    };
  }

  async recordPoolOutcome(memberId: string, outcome: PoolOutcome): Promise<void> {
    const now = new Date();
    if (outcome.kind === "success") {
      await this.pool.query(
        `UPDATE model_provider_credentials
            SET request_count = request_count + 1,
                last_used_at = $2,
                healthy = true,
                cooldown_until = NULL,
                last_failure_class = NULL,
                updated_at = $2
          WHERE id = $1`,
        [memberId, now],
      );
      return;
    }
    const cooldownUntil = outcome.cooldown_seconds
      ? new Date(now.getTime() + outcome.cooldown_seconds * 1_000)
      : null;
    await this.pool.query(
      `UPDATE model_provider_credentials
          SET request_count = request_count + 1,
              failure_count = failure_count + 1,
              last_used_at = $2,
              healthy = $3,
              cooldown_until = COALESCE($4, cooldown_until),
              last_failure_class = $5,
              updated_at = $2
        WHERE id = $1`,
      [memberId, now, !outcome.unhealthy, cooldownUntil, outcome.failure_class],
    );
  }

  async resolveUsageAttribution(input: UsageObservation): Promise<UsageAttribution> {
    return resolveUsageObservationAttribution(this.config, input);
  }

  async recordUsageObservation(
    input: UsageObservation,
    attribution: UsageAttribution,
  ): Promise<void> {
    await recordAttributedUsageObservation(this.config, input, attribution);
  }

  async beginProviderTaskAttempt(input: ProviderTaskAttemptStart): Promise<ProviderTaskAttemptRefs> {
    const invocationId = randomUUID();
    const controlId = randomUUID();
    const deliveryId = randomUUID();
    const snapshotId = randomUUID();
    const usageSourceId = `provider-task:${deliveryId}`;
    const now = new Date().toISOString();
    const refs: ProviderTaskAttemptRefs = {
      invocation_id: invocationId,
      control_id: controlId,
      delivery_id: deliveryId,
      invocation_snapshot_id: snapshotId,
      usage_source_id: usageSourceId,
      attempt: 1,
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO provider_task_controls
           (id,space_id,task,owner_domain,control_json,created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [controlId, input.space_id, input.task, input.owner_domain, JSON.stringify({
          task: input.task,
          owner_domain: input.owner_domain,
          provider_id: input.provider_id,
          model: input.model,
          source_resource_type: input.metering.source_resource_type ?? null,
          source_resource_id: input.metering.source_resource_id ?? null,
          subject_user_id: input.metering.subject_user_id ?? null,
        }), now],
      );
      await client.query(
        `INSERT INTO provider_task_deliveries
           (id,space_id,invocation_id,attempt,control_id,provider_id,model,
            input_fingerprint,usage_source_id,delivery_metadata_json,created_at)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [deliveryId, input.space_id, invocationId, controlId, input.provider_id,
          input.model, input.input_fingerprint, usageSourceId, JSON.stringify({
            delivery_kind: "provider_task",
            task: input.task,
            owner_domain: input.owner_domain,
          }), now],
      );
      await client.query(
        `INSERT INTO provider_task_snapshots
           (id,space_id,delivery_id,safe_snapshot_json,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4::jsonb,'draft',$5,$5)`,
        [snapshotId, input.space_id, deliveryId, JSON.stringify({
          ...refs,
          task: input.task,
          owner_domain: input.owner_domain,
          provider_id: input.provider_id,
          model: input.model,
          input_fingerprint: input.input_fingerprint,
        }), now],
      );
      await client.query("COMMIT");
      return refs;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeProviderTaskAttempt(
    refs: ProviderTaskAttemptRefs,
    result: { status: "accepted" | "failed"; error_code?: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE provider_task_snapshots
          SET status=$2,error_code=$3,updated_at=$4,
              safe_snapshot_json=safe_snapshot_json || $5::jsonb
        WHERE id=$1 AND status='draft'`,
      [refs.invocation_snapshot_id, result.status, result.error_code ?? null,
        new Date().toISOString(), JSON.stringify({ status: result.status, error_code: result.error_code ?? null })],
    );
  }

  async resolveProviderApiKey(spaceId: string, providerId: string): Promise<string> {
    const target = await this.getInvocationTarget(spaceId, providerId);
    const candidate = target.candidates.find((c) => c.api_key);
    if (!candidate?.api_key || candidate.credential_kind === "subscription_oauth") {
      throw new ProviderCommandValidationError(
        `ModelProvider '${providerId}' has no available API key credential`,
      );
    }
    if (candidate.member_id) {
      await this.recordPoolOutcome(candidate.member_id, { kind: "success" });
    }
    return candidate.api_key;
  }

  async resolveCredentialApiKey(spaceId: string, credentialId: string): Promise<string> {
    const result = await this.pool.query<{ secret_ref: string }>(
      `SELECT secret_ref
         FROM credentials
        WHERE id = $1 AND space_id = $2 AND credential_type = 'api_key'
        LIMIT 1`,
      [credentialId, spaceId],
    );
    const secretRef = result.rows[0]?.secret_ref;
    if (!secretRef) {
      throw new ProviderCommandNotFoundError(`Credential '${credentialId}' not found`);
    }
    const apiKey = decryptModelProviderApiKeySecretRefV1(secretRef, await this.masterKey());
    if (!apiKey) {
      throw new ProviderCommandValidationError(
        `Credential '${credentialId}' resolved to an empty API key`,
      );
    }
    return apiKey;
  }

  async listConfiguredModels(spaceId: string, providerId: string): Promise<string[]> {
    const row = await this.requireProvider(spaceId, providerId);
    const configured = configuredModelsFromRow(row);
    if (configured.length > 0) return configured;
    return row.default_model ? [row.default_model] : [];
  }

  async recordCliCredentialUsage(input: CliCredentialAuditInput): Promise<string> {
    const eventId = randomUUID();
    const credentialSource = input.credential_profile_id ? "profile" : "none";
    await this.pool.query(
      `INSERT INTO cli_credential_events
        (id, space_id, run_id, runtime_adapter_type,
         credential_profile_id, credential_source, trigger_origin, fallback_used,
         fallback_reason, broker_error, cleanup_status, action, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        eventId,
        input.space_id,
        input.run_id ?? null,
        input.runtime_adapter_type ?? null,
        input.credential_profile_id ?? null,
        credentialSource,
        input.trigger_origin ?? null,
        Boolean(input.fallback_used),
        input.fallback_reason ?? null,
        Boolean(input.broker_error),
        input.cleanup_status ?? "not_needed",
        input.action ?? "grant",
        new Date(),
      ],
    );
    return eventId;
  }

  // -------------------------------------------------------------------------
  // Credential pool management
  // -------------------------------------------------------------------------

  async listPool(spaceId: string, providerId: string): Promise<unknown> {
    const row = await this.requireProvider(spaceId, providerId);
    this.assertPoolSupported(row);
    await this.enrollPrimaryCredential(row);
    const members = await this.poolMembers(spaceId, providerId, false);
    return {
      provider_id: providerId,
      rotation_strategy: rotationStrategyFromRow(row),
      fallback_provider_ids: fallbackProviderIdsFromRow(row),
      members: members.map(mapPoolMember),
    };
  }

  async addPoolCredential(
    spaceId: string,
    userId: string,
    providerId: string,
    input: ProviderPoolCredentialAddInput,
  ): Promise<unknown> {
    const row = await this.requireOwnedProvider(userId, providerId);
    this.assertPoolSupported(row);
    if (!input.api_key.trim()) {
      throw new ProviderCommandValidationError("api_key must not be empty");
    }
    await this.enrollPrimaryCredential(row);

    const secretRef = encryptModelProviderApiKeySecretRefV1(input.api_key, await this.masterKey());
    const now = new Date();
    const credentialId = randomUUID();
    const memberId = randomUUID();
    const name = input.name?.trim() || `${row.name} pool key`;
    let position = input.position;
    if (position === undefined) {
      const result = await this.pool.query<{ max: number | null }>(
        `SELECT MAX(position) AS max FROM model_provider_credentials
          WHERE provider_id = $1`,
        [providerId],
      );
      position = (result.rows[0]?.max ?? -1) + 1;
    }

    await this.pool.query(
      `INSERT INTO credentials
        (id, space_id, owner_user_id, name, credential_type, secret_ref, scopes_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'api_key', $5, $6::jsonb, $7, $7)`,
      [credentialId, row.space_id, userId, name, secretRef, json([]), now],
    );
    await this.pool.query(
      `INSERT INTO model_provider_credentials
        (id, space_id, provider_id, credential_id, position, enabled, healthy,
         request_count, failure_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, true, 0, 0, $6, $6)`,
      [memberId, row.space_id, providerId, credentialId, position, now],
    );
    // A provider that previously had no key at all gains this one as primary.
    if (!row.credential_id) {
      await this.pool.query(
        `UPDATE model_providers SET credential_id = $3, updated_at = $4
          WHERE id = $1 AND space_id = $2`,
        [providerId, row.space_id, credentialId, now],
      );
    }
    const members = await this.poolMembers(spaceId, providerId, false);
    const created = members.find((m) => m.id === memberId);
    if (!created) throw new Error("created pool member was not readable");
    return mapPoolMember(created);
  }

  async removePoolCredential(
    spaceId: string,
    userId: string,
    providerId: string,
    memberId: string,
  ): Promise<void> {
    const row = await this.requireOwnedProvider(userId, providerId);
    this.assertPoolSupported(row);
    const member = await this.pool.query<{ credential_id: string }>(
      `DELETE FROM model_provider_credentials
        WHERE id = $1 AND provider_id = $2
        RETURNING credential_id`,
      [memberId, providerId],
    );
    const credentialId = member.rows[0]?.credential_id;
    if (!credentialId) {
      throw new ProviderCommandNotFoundError(`Pool credential '${memberId}' not found`);
    }
    const now = new Date();
    if (row.credential_id === credentialId) {
      // Primary removed: promote the lowest-position remaining member.
      const remaining = await this.poolMembers(spaceId, providerId, false);
      const next = remaining[0]?.credential_id ?? null;
      await this.pool.query(
        `UPDATE model_providers SET credential_id = $3, updated_at = $4
          WHERE id = $1 AND space_id = $2`,
        [providerId, row.space_id, next, now],
      );
    }
    // Drop the credential row itself unless any other pool still references it.
    const stillUsed = await this.pool.query(
      `SELECT 1 FROM model_provider_credentials WHERE credential_id = $1
        UNION ALL
       SELECT 1 FROM model_providers WHERE credential_id = $1
        LIMIT 1`,
      [credentialId],
    );
    if (stillUsed.rows.length === 0) {
      await this.pool.query(`DELETE FROM credentials WHERE id = $1 AND space_id = $2`, [
        credentialId,
        row.space_id,
      ]);
    }
  }

  async updatePoolConfig(
    spaceId: string,
    userId: string,
    providerId: string,
    input: ProviderPoolConfigUpdateInput,
  ): Promise<unknown> {
    const row = await this.requireOwnedProvider(userId, providerId);
    this.assertPoolSupported(row);
    const cfg = configRecord(row);
    if (input.rotation_strategy !== undefined) {
      if (!ROTATION_STRATEGIES.has(input.rotation_strategy)) {
        throw new ProviderCommandValidationError(
          `Invalid rotation_strategy '${input.rotation_strategy}'`,
        );
      }
      cfg.rotation_strategy = input.rotation_strategy;
    }
    if (input.fallback_provider_ids !== undefined) {
      for (const id of input.fallback_provider_ids) {
        if (id === providerId) {
          throw new ProviderCommandValidationError(
            "fallback_provider_ids must not contain the provider itself",
          );
        }
        await this.requireProvider(spaceId, id);
      }
      cfg.fallback_provider_ids = input.fallback_provider_ids;
    }
    await this.pool.query(
      `UPDATE model_providers SET config_json = $3::jsonb, updated_at = $4
        WHERE id = $1 AND space_id = $2`,
      [providerId, row.space_id, json(cfg), new Date()],
    );
    return this.listPool(spaceId, providerId);
  }

  // -------------------------------------------------------------------------
  // Per-auxiliary-task provider chains
  // -------------------------------------------------------------------------

  async getTaskChain(spaceId: string, task: string): Promise<ProviderTaskChainEntry[] | null> {
    const result = await this.pool.query<{ chain_json: unknown }>(
      `SELECT chain_json FROM provider_task_policies
        WHERE space_id = $1 AND task = $2 AND enabled = true
        LIMIT 1`,
      [spaceId, task],
    );
    const chain = result.rows[0]?.chain_json;
    if (!Array.isArray(chain)) return null;
    const entries = chain
      .filter((e): e is { provider_id: string; model?: string | null } =>
        e !== null && typeof e === "object" && typeof (e as { provider_id?: unknown }).provider_id === "string",
      )
      .map((e) => ({ provider_id: e.provider_id, model: e.model ?? null }));
    return entries.length > 0 ? entries : null;
  }

  async listTaskPolicies(spaceId: string): Promise<unknown[]> {
    const result = await this.pool.query<{
      task: string;
      chain_json: unknown;
      enabled: boolean;
      updated_at: Date;
    }>(
      `SELECT task, chain_json, enabled, updated_at
         FROM provider_task_policies
        WHERE space_id = $1
        ORDER BY task ASC`,
      [spaceId],
    );
    return result.rows.map((row) => ({
      task: row.task,
      chain: Array.isArray(row.chain_json) ? row.chain_json : [],
      enabled: row.enabled,
      updated_at: row.updated_at.toISOString(),
    }));
  }

  async putTaskPolicy(
    spaceId: string,
    userId: string,
    task: string,
    chain: ProviderTaskChainEntry[],
    enabled = true,
  ): Promise<unknown> {
    if (!(await this.canAdminSpace(userId, spaceId))) {
      throw new ProviderCommandForbiddenError("Requires space owner or admin role");
    }
    for (const entry of chain) {
      const provider = await this.requireProvider(spaceId, entry.provider_id);
      validateTaskProviderCompatibility(task, provider);
    }
    const now = new Date();
    await this.pool.query(
      `INSERT INTO provider_task_policies
        (id, space_id, task, chain_json, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
       ON CONFLICT ON CONSTRAINT uq_provider_task_policies_space_task
       DO UPDATE SET chain_json = EXCLUDED.chain_json,
                     enabled = EXCLUDED.enabled,
                     updated_at = EXCLUDED.updated_at`,
      [randomUUID(), spaceId, task, json(chain), enabled, now],
    );
    return {
      task,
      chain: chain.map((e) => ({ provider_id: e.provider_id, model: e.model ?? null })),
      enabled,
      updated_at: now.toISOString(),
    };
  }

  async deleteTaskPolicy(spaceId: string, userId: string, task: string): Promise<void> {
    if (!(await this.canAdminSpace(userId, spaceId))) {
      throw new ProviderCommandForbiddenError("Requires space owner or admin role");
    }
    const result = await this.pool.query(
      `DELETE FROM provider_task_policies WHERE space_id = $1 AND task = $2`,
      [spaceId, task],
    );
    if (result.rowCount === 0) {
      throw new ProviderCommandNotFoundError(`Task policy '${task}' not found`);
    }
  }
}

let testOverride: ProviderCommandStore | null = null;
let pgStore: PgProviderCommandStore | null = null;
let pgStoreKey: string | null = null;

export function __setProviderCommandStoreForTests(
  store: ProviderCommandStore | null,
): void {
  testOverride = store;
}

export function resolveProviderCommandStore(config: ServerConfig): ProviderCommandStore {
  if (testOverride) return testOverride;
  if (!config.databaseUrl) {
    throw new Error("Provider command store requires SERVER_DATABASE_URL");
  }
  const key = `${config.databaseUrl}|${config.rainverHome}`;
  if (!pgStore || pgStoreKey !== key) {
    pgStore = new PgProviderCommandStore(config);
    pgStoreKey = key;
  }
  return pgStore;
}
