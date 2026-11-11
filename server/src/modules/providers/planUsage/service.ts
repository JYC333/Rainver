import type { ApiPlanUsageProvider, ApiPlanUsageSnapshot } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { dbPool, HttpError, type Queryable } from "../../routeUtils/common.js";
import { fetchWithNetworkProfile, resolveNetworkProfileRepository } from "../../networkProfiles/index.js";
import { resolveProviderCommandStore } from "../commands/store.js";
import { collectPlanUsage, planUsageSource, type PlanUsageSource } from "./collectors.js";

type Provider = { id: string; name: string; base_url: string; home_space_id: string; credential_id: string; credential_revision: string; provider_revision: string; network_profile_id: string | null; network_profile_revision: string | null };
async function ownedProviders(config: ServerConfig, spaceId: string, userId: string): Promise<Provider[]> {
  return ownedProvidersIn(dbPool(config), spaceId, userId);
}
async function ownedProvidersIn(db: Queryable, spaceId: string, userId: string): Promise<Provider[]> {
  const result = await db.query<Provider>(
    `SELECT p.id, p.name, p.base_url, p.space_id AS home_space_id, p.credential_id, c.updated_at::text AS credential_revision, p.updated_at::text AS provider_revision,
            COALESCE(g.network_profile_id, p.network_profile_id) AS network_profile_id,
            np.updated_at::text AS network_profile_revision
       FROM model_providers p
       JOIN model_provider_space_grants g ON g.provider_id = p.id AND g.space_id = $1
       LEFT JOIN network_profiles np ON np.id = COALESCE(g.network_profile_id, p.network_profile_id) AND np.space_id = $1
       JOIN credentials c ON c.id = p.credential_id AND c.space_id = p.space_id AND c.owner_user_id = p.owner_user_id
       JOIN space_memberships sm ON sm.space_id = g.space_id AND sm.user_id = $2 AND sm.status = 'active'
      WHERE p.owner_user_id = $2 AND p.enabled = true AND g.enabled = true
        AND c.credential_type = 'api_key'
      ORDER BY p.created_at, p.id`, [spaceId, userId],
  );
  return result.rows;
}

/**
 * The plan-usage authority of `provider.plan_usage.refresh`, read through the
 * caller's transaction: the person's own enabled API-key Provider in this
 * Space; whether its endpoint is supported is answered for admission to refuse. Rechecked at admission, before the
 * vendor read, before the snapshot is released and at every status read.
 */
export async function assertPlanUsageProviderIn(db: Queryable, spaceId: string, userId: string, providerId: string): Promise<{ supported: boolean }> {
  const provider = (await ownedProvidersIn(db, spaceId, userId)).find(p => p.id === providerId);
  if (!provider) throw new HttpError(404, "API plan provider not found");
  return { supported: planUsageSource(provider.base_url) !== null };
}

export async function listApiPlanUsageProviders(config: ServerConfig, spaceId: string, userId: string): Promise<ApiPlanUsageProvider[]> {
  return (await ownedProviders(config, spaceId, userId)).flatMap(p => {
    const source = planUsageSource(p.base_url);
    return source ? [{ provider_id: p.id, name: p.name, vendor: source.vendor }] : [];
  });
}

/**
 * Concurrent queries for the same person, Space, Provider and key revision
 * share one vendor request: a remount or a second click while the first is on
 * the wire must not spend the vendor's rate limit twice. The key includes
 * every input to authorization, so no caller joins a request it could not
 * have made, and each caller has already been authorized before joining.
 * The person's session is not in the key: the route authorizes each caller's
 * own session again after the shared wait (`routes.ts`).
 */
const inFlightQueries = new Map<string, Promise<ApiPlanUsageSnapshot>>();

export async function refreshApiPlanUsage(config: ServerConfig, spaceId: string, userId: string, providerId: string): Promise<ApiPlanUsageSnapshot> {
  const provider = (await ownedProviders(config, spaceId, userId)).find(p => p.id === providerId);
  if (!provider) throw new HttpError(404, "API plan provider not found");
  const source = planUsageSource(provider.base_url);
  if (!source) throw new HttpError(422, "This provider has no supported plan usage endpoint");
  const key = JSON.stringify([spaceId, userId, providerId, provider.base_url, provider.credential_id, provider.credential_revision, provider.provider_revision, provider.network_profile_id, provider.network_profile_revision]);
  const existing = inFlightQueries.get(key);
  if (existing) return existing;
  const query = queryPlanUsage(config, spaceId, userId, provider, source)
    .finally(() => { if (inFlightQueries.get(key) === query) inFlightQueries.delete(key); });
  inFlightQueries.set(key, query);
  return query;
}

async function queryPlanUsage(config: ServerConfig, spaceId: string, userId: string, provider: Provider, source: PlanUsageSource): Promise<ApiPlanUsageSnapshot> {
  const providerId = provider.id;
  // Resolve exactly the primary key, not a rotated/fallback key from a different account.
  try {
    const apiKey = await resolveProviderCommandStore(config).resolveCredentialApiKey(provider.home_space_id, provider.credential_id);
    const profile = await resolveNetworkProfileRepository(config).resolve(spaceId, provider.network_profile_id);
    const windows = await collectPlanUsage(source, apiKey, fetchWithNetworkProfile(profile));
    // Reauthorize after the network wait; a revoked grant must not release the snapshot.
    // Every profile edit (proxy, bypass list, enabled) moves its updated_at, so
    // the revision catches a profile changed or disabled in place, not only a swapped id.
    const current = (await ownedProviders(config, spaceId, userId)).find(p => p.id === providerId);
    if (!current || current.credential_id !== provider.credential_id || current.base_url !== provider.base_url || current.credential_revision !== provider.credential_revision || current.provider_revision !== provider.provider_revision || current.network_profile_id !== provider.network_profile_id || current.network_profile_revision !== provider.network_profile_revision) {
      throw new HttpError(409, "Provider changed during the query. Refresh again.");
    }
    return { provider_id: providerId, checked_at: new Date().toISOString(), windows };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Plan usage query failed. Check the subscription key, plan status and network, then retry.");
  }
}
