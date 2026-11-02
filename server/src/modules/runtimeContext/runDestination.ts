import { HttpError, type Queryable } from "../routeUtils/common.js";
import { runtimeProviderEgressDestination, type RetrievalEgressDestination } from "../retrieval/egress/egressPolicy.js";
import { availableModels } from "../providers/dbReader.js";
import { isVendorCliAdapter } from "../runtimeAdapters/specs.js";
import { effectiveRunProviderModel } from "../runs/remoteProviderBinding.js";

export interface RunDestinationSubject {
  runtime_key?: string | null;
  model_provider_id?: string | null;
  model_override_json?: unknown;
  runtime_profile_snapshot_json?: unknown;
}

export interface RunDestinationProvider {
  space_id: string;
  provider_type: string;
  base_url: string | null;
  config_json: unknown;
  default_model: string | null;
  capabilities_json: unknown;
}

/**
 * Where a Run's model call actually goes, from the Run's own persisted
 * binding (its adapter and ModelProvider) — never from the live, editable
 * runtime Profile it was routed from. A vendor CLI with no ModelProvider is
 * an external destination (its account is the runtime owner's); a
 * ModelProvider is classified by the endpoint the adapter will reach. This
 * is the destination the Delivery's egress authority checks
 * (`gateway.ts`, `authorizeEgress`).
 */
export function classifyRunDestination(
  run: RunDestinationSubject,
  provider: RunDestinationProvider | null,
  spaceId: string,
): RetrievalEgressDestination {
  if (run.model_provider_id) {
    if (!provider) throw new HttpError(409, "The Run's ModelProvider grant is no longer active");
    return runtimeProviderEgressDestination(
      run.runtime_key,
      { ...provider, model: effectiveRunProviderModel(run as never, { ...provider, available_models: availableModels(provider.capabilities_json) }) },
      spaceId,
    );
  }
  return isVendorCliAdapter(run.runtime_key) ? "external_provider" : "internal_process";
}

/** The granted, enabled ModelProvider of a Run, as the Delivery reads it (`FOR SHARE` when locking). */
export async function loadRunProvider(
  db: Queryable,
  spaceId: string,
  providerId: string,
  options: { lock?: boolean } = {},
): Promise<RunDestinationProvider | null> {
  return (await db.query<RunDestinationProvider>(
    `SELECT provider.space_id,provider.provider_type,provider.base_url,provider.config_json,provider.default_model,provider.capabilities_json
       FROM model_provider_space_grants provider_grant
       JOIN model_providers provider ON provider.id=provider_grant.provider_id
      WHERE provider_grant.space_id=$1 AND provider_grant.provider_id=$2
        AND provider_grant.enabled=TRUE AND provider.enabled=TRUE${options.lock ? "\n      FOR SHARE OF provider_grant,provider" : ""}`,
    [spaceId, providerId],
  )).rows[0] ?? null;
}

/** The Run's actual destination, read without locks: for planning, which the Delivery re-checks under its locks. */
export async function runDestination(db: Queryable, spaceId: string, run: RunDestinationSubject): Promise<RetrievalEgressDestination> {
  const provider = run.model_provider_id ? await loadRunProvider(db, spaceId, run.model_provider_id) : null;
  return classifyRunDestination(run, provider, spaceId);
}
