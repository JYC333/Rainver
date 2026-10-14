import { HttpError, type Queryable } from "../routeUtils/common.js";
import {
  retrievalEgressAllowed,
  runtimeProviderEgressDestination,
  type RetrievalEgressDestination,
} from "../retrieval/egress/egressPolicy.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";
import { normalizeSourceConnectionReadGovernance } from "./sourceConsent.js";
import type { SourceConnectionRow } from "./sourceRepositoryRows.js";

/**
 * Why the gate refused, as the stable `code` of its 403 body: the Space
 * turned external model egress off, or the Source has not consented to the
 * destination. Callers that wait on the refusal name the right condition.
 */
export const SOURCE_EGRESS_SPACE_DISABLED = "space_external_egress_disabled";
export const SOURCE_EGRESS_NOT_CONSENTED = "source_model_egress_not_consented";

/**
 * The consent/egress gate every path that ships source content to a model must
 * pass through. One gate. Do not keep a second copy: the copies stop matching
 * and one of them fails open. Sources owns the gate; callers own what they do
 * when it throws.
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
    const detail = "Space settings disable external model egress. Enable external egress in Space Settings or use a local model provider.";
    throw new HttpError(403, detail, { detail, code: SOURCE_EGRESS_SPACE_DISABLED });
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
    const detail = `This source has not allowed ${label} processing. Enable model egress for the source or choose an allowed provider.`;
    throw new HttpError(403, detail, { detail, code: SOURCE_EGRESS_NOT_CONSENTED });
  }
}

async function resolveAgentPromptEgressDestination(
  db: Queryable,
  spaceId: string,
  agentId: string,
): Promise<RetrievalEgressDestination> {
  const result = await db.query<{
    runtime_key: string;
    backend_mode: "runtime_native" | "model_provider";
    model_provider_id: string | null;
    model_name: string | null;
    provider_type: string | null;
    base_url: string | null;
    config_json: unknown;
    default_model: string | null;
  }>(
    `SELECT arp.runtime_key,
            arp.backend_mode,
            arp.model_provider_id,
            arp.model_name,
            p.provider_type,
            p.base_url,
            p.config_json,
            p.default_model
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
  if (profile.backend_mode === "model_provider") {
    if (!profile.model_provider_id) {
      throw new HttpError(409, "Selected agent Runtime Profile has no ModelProvider binding.");
    }
    if (!profile.provider_type) {
      throw new HttpError(409, "Selected agent model provider is not available in this space.");
    }
    return runtimeProviderEgressDestination(profile.runtime_key, {
      provider_type: profile.provider_type,
      base_url: profile.base_url,
      config_json: profile.config_json,
      default_model: profile.default_model,
      model: profile.model_name,
    });
  }
  if (profile.model_provider_id) {
    throw new HttpError(409, "Runtime-native Agent Profiles cannot carry a ModelProvider binding.");
  }
  // Native runtime egress is conservatively treated as external. The server
  // cannot infer which account or endpoint the runtime owner configured.
  return "external_provider";
}
