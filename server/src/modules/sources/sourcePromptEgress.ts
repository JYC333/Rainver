import { HttpError, type Queryable } from "../routeUtils/common";
import {
  retrievalEgressAllowed,
  retrievalProviderEgressDestination,
  type RetrievalEgressDestination,
} from "../retrieval/egress/egressPolicy";
import { readSpaceRetrievalSettings } from "../retrieval/settings";
import { BUILTIN_RUNTIME_ADAPTER_SPECS, type RuntimeAdapterType } from "../runtimeAdapters/specs";
import { normalizeSourceConnectionReadGovernance } from "./sourceConsent";
import type { SourceConnectionRow } from "./sourceRepositoryRows";

/**
 * The consent/egress gate every path that ships source content to a model must
 * pass through.
 *
 * This lived as two private methods on `SourcePostProcessingService` while
 * post-processing was the only such path. The system annotation pass is the
 * second one, and a second copy of a gate whose whole purpose is to fail closed
 * is how one of them silently stops matching the other. Sources owns the gate;
 * callers own what they do when it throws.
 */
export async function assertSourcePromptEgressAllowed(
  db: Queryable,
  connection: SourceConnectionRow,
  agentId: string,
): Promise<void> {
  const destination = await resolveAgentPromptEgressDestination(db, connection.space_id, agentId);
  const governance = normalizeSourceConnectionReadGovernance(connection);
  const retrievalSettings = await readSpaceRetrievalSettings(db, connection.space_id);
  if (destination === "external_provider" && !retrievalSettings.externalEgressEnabled) {
    throw new HttpError(
      403,
      "Space settings disable external model egress. Enable external egress in Space Settings or use a local model provider.",
    );
  }
  const allowed = retrievalEgressAllowed(
    {
      object_type: "source_connection",
      object_id: connection.id,
      source_connection_ids: [connection.id],
    },
    {
      externalEgressEnabled: retrievalSettings.externalEgressEnabled,
      destination,
      sourcePolicies: {
        [connection.id]: {
          source_egress_class: governance.policy.source_egress_class,
          allow_local_provider_egress: governance.consent.allow_local_provider_egress,
          allow_external_model_egress: governance.consent.allow_external_model_egress,
        },
      },
    },
  );
  if (!allowed) {
    const label = destination === "local_provider" ? "local provider" : "external model";
    throw new HttpError(
      403,
      `This source has not allowed ${label} processing. Enable model egress for the source or choose an allowed provider.`,
    );
  }
}

export async function resolveAgentPromptEgressDestination(
  db: Queryable,
  spaceId: string,
  agentId: string,
): Promise<RetrievalEgressDestination> {
  const result = await db.query<{
    adapter_type: string | null;
    model_provider_id: string | null;
    runtime_config_json: unknown;
    runtime_policy_json: unknown;
    provider_type: string | null;
    base_url: string | null;
  }>(
    `SELECT arp.adapter_type,
            arp.model_provider_id,
            arp.runtime_config_json,
            arp.runtime_policy_json,
            p.provider_type,
            p.base_url
       FROM agent_runtime_profiles arp
       LEFT JOIN model_provider_space_grants g
         ON g.space_id = arp.space_id
        AND g.provider_id = arp.model_provider_id
        AND g.enabled = TRUE
       LEFT JOIN model_providers p
         ON p.id = g.provider_id
        AND p.enabled = TRUE
      WHERE arp.space_id = $1
        AND arp.agent_id = $2
        AND arp.enabled = TRUE
      ORDER BY arp.is_default DESC, arp.created_at ASC, arp.id ASC
      LIMIT 1`,
    [spaceId, agentId],
  );
  const profile = result.rows[0];
  if (!profile) throw new HttpError(409, "Selected agent has no enabled runtime profile.");
  const runtimeConfig = recordValue(profile.runtime_config_json);
  const runtimePolicy = recordValue(profile.runtime_policy_json);
  const adapterType = stringValue(profile.adapter_type) ||
    stringValue(runtimeConfig.adapter_type) ||
    stringValue(runtimePolicy.default_adapter_type) ||
    "model_api";
  const mode = BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType]?.model.model_provider_mode ?? "none";
  if (profile.model_provider_id) {
    if (!profile.provider_type) {
      throw new HttpError(409, "Selected agent model provider is not available in this space.");
    }
    return retrievalProviderEgressDestination({
      provider_type: profile.provider_type,
      base_url: profile.base_url,
    });
  }
  if (mode === "required") {
    const fallback = await resolveDefaultProviderForEgress(db, spaceId, adapterType);
    if (!fallback) {
      throw new HttpError(
        409,
        `adapter_type ${JSON.stringify(adapterType)} requires a model provider; set default_model_provider_id.`,
      );
    }
    return retrievalProviderEgressDestination(fallback);
  }
  return adapterType === "ts_agent_host" ? "internal_process" : "external_provider";
}

async function resolveDefaultProviderForEgress(
  db: Queryable,
  spaceId: string,
  adapterType: string,
): Promise<{ provider_type: string; base_url: string | null } | null> {
  const result = await db.query<{
    provider_type: string;
    base_url: string | null;
    config_json: unknown;
  }>(
    `SELECT p.provider_type,
            p.base_url,
            jsonb_set(
              COALESCE(p.config_json, '{}'::jsonb),
              '{is_default}',
              to_jsonb(g.is_default),
              true
            ) AS config_json
       FROM model_provider_space_grants g
       JOIN model_providers p ON p.id = g.provider_id
      WHERE g.space_id = $1
        AND g.enabled = TRUE
        AND p.enabled = TRUE`,
    [spaceId],
  );
  let spaceDefault: { provider_type: string; base_url: string | null } | null = null;
  for (const row of result.rows) {
    const cfg = recordValue(row.config_json);
    const provider = { provider_type: row.provider_type, base_url: row.base_url };
    if (cfg.runtime_default_for === adapterType) return provider;
    if (cfg.runtime_default_adapter_type === adapterType) return provider;
    const types = cfg.runtime_default_adapter_types;
    if (Array.isArray(types) && types.includes(adapterType)) return provider;
    const defaults = cfg.runtime_defaults;
    if (defaults && typeof defaults === "object" && (defaults as Record<string, unknown>)[adapterType] === true) {
      return provider;
    }
    if (spaceDefault === null && cfg.is_default === true) spaceDefault = provider;
  }
  return spaceDefault;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
