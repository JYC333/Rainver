import { HttpError, type Queryable } from "../routeUtils/common.js";
import {
  retrievalEgressAllowed,
  retrievalProviderEgressDestination,
  type RetrievalEgressDestination,
} from "../retrieval/egress/egressPolicy.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";
import { normalizeSourceConnectionReadGovernance } from "./sourceConsent.js";
import type { SourceConnectionRow } from "./sourceRepositoryRows.js";

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
    runtime_key: string;
    backend_mode: "runtime_native" | "model_provider";
    model_provider_id: string | null;
    provider_type: string | null;
    base_url: string | null;
  }>(
    `SELECT arp.runtime_key,
            arp.backend_mode,
            arp.model_provider_id,
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
  if (profile.backend_mode === "model_provider") {
    if (!profile.model_provider_id) {
      throw new HttpError(409, "Selected agent Runtime Profile has no ModelProvider binding.");
    }
    if (!profile.provider_type) {
      throw new HttpError(409, "Selected agent model provider is not available in this space.");
    }
    return retrievalProviderEgressDestination({
      provider_type: profile.provider_type,
      base_url: profile.base_url,
    });
  }
  if (profile.model_provider_id) {
    throw new HttpError(409, "Runtime-native Agent Profiles cannot carry a ModelProvider binding.");
  }
  // Native runtime egress is conservatively treated as external. The server
  // cannot infer which account or endpoint the runtime owner configured.
  return "external_provider";
}
