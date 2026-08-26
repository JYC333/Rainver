/**
 * Provider DB read port.
 *
 * SELECTs exactly the columns in the protocol package's
 * `MODEL_PROVIDERS_READ_COLUMNS` allowlist and maps rows to the public
 * `ModelProviderDTO` wire shape:
 * `available_models` from `capabilities_json`, `is_default` from
 * `config_json`, and credential presence/type from the joined Credential row.
 * This reader does not perform writes or return secret material.
 */

import { getDbPool, type Pool } from "./db.js";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { defaultBaseUrlFor } from "./commands/helpers.js";

export interface ProvidersDbPort {
  listProviders(spaceId: string, userId: string): Promise<unknown[]>;
  getProvider(spaceId: string, userId: string | null, configId: string): Promise<unknown | null>;
}

export interface ProviderRow {
  id: string;
  space_id: string;
  home_space_id?: string | null;
  owner_user_id?: string | null;
  grant_id?: string | null;
  manageable?: boolean | null;
  grant_enabled?: boolean | null;
  name: string;
  provider_type: string;
  base_url: string | null;
  network_profile_id: string | null;
  default_model: string | null;
  enabled: boolean;
  credential_id: string | null;
  credential_type?: string | null;
  credential_metadata_json?: unknown;
  capabilities_json: unknown;
  config_json: unknown;
  grant_is_default?: boolean | null;
  created_at: Date;
  updated_at: Date;
}

function availableModels(capabilities: unknown): string[] {
  if (Array.isArray(capabilities)) {
    return capabilities.filter((m): m is string => typeof m === "string");
  }
  if (capabilities !== null && typeof capabilities === "object") {
    const models = (capabilities as { models?: unknown }).models;
    if (Array.isArray(models)) {
      return models.filter((m): m is string => typeof m === "string");
    }
  }
  return [];
}

function isDefault(config: unknown): boolean {
  if (config !== null && typeof config === "object") {
    return Boolean((config as { is_default?: unknown }).is_default);
  }
  return false;
}

function isDefaultForRow(row: ProviderRow): boolean {
  if (typeof row.grant_is_default === "boolean") return row.grant_is_default;
  return isDefault(row.config_json);
}

function stringConfig(config: unknown, key: string): string | null {
  if (config !== null && typeof config === "object") {
    const value = (config as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return null;
}

export function mapProviderRowToDto(row: ProviderRow): Record<string, unknown> {
  const providerType = row.provider_type;
  const metadata = row.credential_metadata_json !== null
    && typeof row.credential_metadata_json === "object"
    && !Array.isArray(row.credential_metadata_json)
    ? row.credential_metadata_json as Record<string, unknown>
    : {};
  const hasSubscription = row.credential_type === "subscription_oauth";
  return {
    id: row.id,
    space_id: row.space_id,
    home_space_id: row.home_space_id ?? row.space_id,
    owner_user_id: row.owner_user_id ?? null,
    grant_id: row.grant_id ?? null,
    name: row.name,
    provider_type: providerType,
    base_url: row.base_url ?? defaultBaseUrlFor(providerType) ?? "",
    network_profile_id: row.network_profile_id ?? null,
    claude_compatible_base_url: stringConfig(row.config_json, "claude_compatible_base_url"),
    openai_compatible_base_url: stringConfig(row.config_json, "openai_compatible_base_url"),
    default_model: row.default_model,
    available_models: availableModels(row.capabilities_json),
    enabled: Boolean(row.enabled),
    is_default: isDefaultForRow(row),
    has_api_key: row.credential_type === "api_key",
    has_subscription: hasSubscription,
    subscription_type: hasSubscription ? providerType : null,
    subscription_quota: hasSubscription && metadata.quota && typeof metadata.quota === "object"
      ? metadata.quota
      : null,
    manageable: Boolean(row.manageable),
    grant_enabled: row.grant_enabled === undefined || row.grant_enabled === null
      ? undefined
      : Boolean(row.grant_enabled),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

class PgProvidersDbPort implements ProvidersDbPort {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = getDbPool(databaseUrl);
  }

  private async selectClause(): Promise<{ table: string; columns: string }> {
    return {
      table: protocol.MODEL_PROVIDERS_TABLE,
      columns: protocol.MODEL_PROVIDERS_READ_COLUMNS.map((c) => `"${c}"`).join(", "),
    };
  }

  private async grantSelect(): Promise<{ table: string; columns: string }> {
    const { table } = await this.selectClause();
    return {
      table,
      columns: `p.id,
              g.space_id AS space_id,
              p.name,
              p.provider_type,
              p.base_url,
              p.default_model,
              p.enabled,
              p.credential_id,
              c.credential_type,
              c.metadata_json AS credential_metadata_json,
              p.capabilities_json,
              p.created_at,
              p.updated_at`,
    };
  }

  async listProviders(spaceId: string, userId: string): Promise<unknown[]> {
    const { table, columns } = await this.grantSelect();
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${columns},
              p.space_id AS home_space_id,
              p.owner_user_id,
              g.id AS grant_id,
              g.enabled AS grant_enabled,
              g.is_default AS grant_is_default,
              (p.owner_user_id = $2) AS manageable,
              jsonb_set(
                COALESCE(p.config_json, '{}'::jsonb),
                '{is_default}',
                to_jsonb(g.is_default),
                true
              ) AS config_json,
              COALESCE(g.network_profile_id, p.network_profile_id) AS network_profile_id
         FROM model_provider_space_grants g
         JOIN "${table}" p ON p.id = g.provider_id
         LEFT JOIN credentials c ON c.id = p.credential_id
        WHERE g.space_id = $1
          AND g.enabled = true
          AND p.enabled = true
          AND (c.credential_type IS DISTINCT FROM 'subscription_oauth' OR p.owner_user_id = $2)
        ORDER BY g.is_default DESC, p.created_at DESC`,
      [spaceId, userId],
    );
    return result.rows.map(mapProviderRowToDto);
  }

  async getProvider(
    spaceId: string,
    userId: string | null,
    configId: string,
  ): Promise<unknown | null> {
    const { table, columns } = await this.grantSelect();
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${columns},
              p.space_id AS home_space_id,
              p.owner_user_id,
              g.id AS grant_id,
              g.enabled AS grant_enabled,
              g.is_default AS grant_is_default,
              (p.owner_user_id = $3) AS manageable,
              jsonb_set(
                COALESCE(p.config_json, '{}'::jsonb),
                '{is_default}',
                to_jsonb(g.is_default),
                true
              ) AS config_json,
              COALESCE(g.network_profile_id, p.network_profile_id) AS network_profile_id
         FROM model_provider_space_grants g
         JOIN "${table}" p ON p.id = g.provider_id
         LEFT JOIN credentials c ON c.id = p.credential_id
        WHERE g.space_id = $1
          AND g.provider_id = $2
          AND g.enabled = true
          AND p.enabled = true
          AND (c.credential_type IS DISTINCT FROM 'subscription_oauth' OR p.owner_user_id = $3)
        LIMIT 1`,
      [spaceId, configId, userId],
    );
    if (result.rows.length === 0) return null;
    return mapProviderRowToDto(result.rows[0]);
  }
}

let testOverride: ProvidersDbPort | null = null;
let pgPort: PgProvidersDbPort | null = null;
let pgPortUrl: string | null = null;

/** Test helper: inject a fake DB port (pass null to restore the real one). */
export function __setProvidersDbPortForTests(port: ProvidersDbPort | null): void {
  testOverride = port;
}

/** Resolve the DB port for this config, or null when no database is configured. */
export function resolveProvidersDbPort(config: ServerConfig): ProvidersDbPort | null {
  if (testOverride) return testOverride;
  if (!config.databaseUrl) return null;
  if (!pgPort || pgPortUrl !== config.databaseUrl) {
    pgPort = new PgProvidersDbPort(config.databaseUrl);
    pgPortUrl = config.databaseUrl;
  }
  return pgPort;
}
