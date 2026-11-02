import { providerCredentialEligibilitySql, isProviderEligibleForUser, type ProviderEligibilityRow } from '../../providers/eligibility.js';
import type { SourceConnectionRow } from '../../sources/sourceRepositoryRows.js';
import type { ProviderEgressSubject } from '../../retrieval/egress/egressPolicy.js';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import { providerSupportsStructuredOutput } from '../../providers/structuredOutputCapabilities.js';
import { providerSupportsTask } from '../../providers/commands/store.js';
import { providerEgressDestination } from '../../retrieval/egress/egressPolicy.js';
import { sha256Json } from '../hash.js';
export const REVISION_TASK = 'prompt_revision';
export interface RevisionProvider {
  id: string;
  model: string;
  fingerprint: string;
  name: string;
}
export async function revisionProvider(db: Queryable, identity: SpaceUserIdentity, requested?: string, model?: string, lock = false): Promise<RevisionProvider> {
  if (!requested) {
    const chain = (await db.query<{
      chain_json: Array<{
        provider_id: string;
        model?: string;
      }>;
    }>(`SELECT chain_json FROM provider_task_policies WHERE space_id=$1 AND task=$2 AND enabled=true`, [identity.spaceId, REVISION_TASK])).rows[0]?.chain_json;
    if (chain?.length) {
      requested = chain[0]!.provider_id;
      model = model ?? chain[0]!.model;
    }
  }
  const rows = (await db.query<{
    id: string;
    name: string;
    space_id: string;
    provider_type: string;
    base_url: string | null;
    config_json: unknown;
    default_model: string | null;
    capabilities_json: unknown;
    credential_id: string | null;
    network_profile_id: string | null;
    is_default: boolean;
  } & ProviderEligibilityRow>(`SELECT p.id,p.name,p.space_id,p.provider_type,p.base_url,p.config_json,p.default_model,p.capabilities_json,p.credential_id,g.network_profile_id,g.is_default,p.enabled provider_enabled,g.enabled provider_grant_enabled,p.owner_user_id provider_owner_user_id,c.credential_type provider_credential_type,${providerCredentialEligibilitySql('p.id', 'p.credential_id', 'c')} provider_has_eligible_credential FROM model_providers p JOIN model_provider_space_grants g ON g.provider_id=p.id LEFT JOIN credentials c ON c.id=p.credential_id WHERE g.space_id=$1 AND g.enabled=true AND p.enabled=true AND ($2::text IS NULL OR p.id=$2) ORDER BY g.is_default DESC,p.id ${lock ? 'FOR SHARE OF p,g' : ''}`, [identity.spaceId, requested ?? null])).rows;
  const row = requested ? rows[0] : rows.find(r => r.is_default);
  if (!row || !isProviderEligibleForUser(row, identity.userId) || !providerSupportsTask('retrieval_query_rewrite', row.provider_type) || !providerSupportsStructuredOutput(row.provider_type)) throw new HttpError(409, 'Configure an authorized default chat API provider in Providers');
  const selected = model ?? row.default_model;
  if (typeof selected !== 'string' || !selected.trim() || /(?:embed|rerank|zerank|zembed)/i.test(selected)) throw new HttpError(409, 'Configure a default text-generation model in Providers');
  return {
    id: row.id,
    model: selected,
    fingerprint: sha256Json({
      provider_id: row.id,
      space_id: row.space_id,
      provider_type: row.provider_type,
      base_url: row.base_url,
      config_json: row.config_json,
      credential_id: row.credential_id,
      network_profile_id: row.network_profile_id,
      model: selected
    }),
    name: `${row.name} · ${selected}`
  };
}
/** Historical output needs current permission, not an identical execution configuration. */
export async function assertRevisionProviderReadable(db: Queryable, identity: SpaceUserIdentity, frozen: RevisionProvider, sourceId: string | null) {
  const p = (await db.query<ProviderEgressSubject & ProviderEligibilityRow>(`SELECT p.space_id,p.provider_type,p.base_url,p.config_json,p.enabled provider_enabled,g.enabled provider_grant_enabled,p.owner_user_id provider_owner_user_id,c.credential_type provider_credential_type,${providerCredentialEligibilitySql('p.id', 'p.credential_id', 'c')} provider_has_eligible_credential FROM model_providers p JOIN model_provider_space_grants g ON g.provider_id=p.id LEFT JOIN credentials c ON c.id=p.credential_id WHERE p.id=$1 AND g.space_id=$2`, [frozen.id, identity.spaceId])).rows[0];
  if (!p || !isProviderEligibleForUser(p, identity.userId)) throw new HttpError(403, 'Generation API provider permission unavailable');
  if (sourceId) {
    const source = (await db.query<SourceConnectionRow>(`SELECT * FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL`, [sourceId, identity.spaceId])).rows[0];
    if (!source) throw new HttpError(403, 'Source unavailable');
    await (await import('../../sources/sourcePromptEgress.js')).assertSourceEgressAllowedForDestination(db, source, providerEgressDestination({
      ...p,
      model: frozen.model
    }, identity.spaceId));
  }
}
/** Executing frozen input additionally requires its exact admitted configuration. */
export async function assertRevisionProvider(db: Queryable, identity: SpaceUserIdentity, frozen: RevisionProvider, sourceId: string | null, lock = false) {
  const current = await revisionProvider(db, identity, frozen.id, frozen.model, lock);
  if (current.fingerprint !== frozen.fingerprint) throw new HttpError(409, 'Frozen API provider configuration changed');
  await assertRevisionProviderReadable(db, identity, frozen, sourceId);
}
