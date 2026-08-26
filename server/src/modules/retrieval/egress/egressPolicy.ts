/**
 * Provider-egress policy for retrieval content.
 *
 * Sending a retrieval object's text to a model provider (for embedding, rerank,
 * or synthesis) is egress. W9 turns the former allow-all seam into a real
 * capability: a per-space switch (`external_egress_enabled`) lets a space mark
 * its content "do not send to external providers". Local providers and internal
 * processing can still be allowed without enabling external API egress.
 *
 * The seam is a single, domain-neutral, per-row predicate. Source-derived rows
 * carry source connection ids from the retrieval projection; provider calls also
 * attach the payload's source ids so this same predicate can fail closed against
 * the actual provider destination.
 *
 * Query rewriting does NOT consult this seam: it sends only the query string,
 * never candidate content.
 */
import { getRuntimeAdapterSpec } from "../../runtimeAdapters/specs.js";

export interface RetrievalEgressRef {
  object_type: string;
  object_id: string;
  source_connection_ids?: readonly string[];
}

export type RetrievalEgressDestination =
  | "external_provider"
  | "local_provider"
  | "internal_process";

export interface RetrievalEgressPolicy {
  /**
   * Whether this space permits sending indexed content to an external model
   * provider. Default `true`.
   */
  externalEgressEnabled: boolean;
  /**
   * Destination class for the current operation. Omitted means external
   * provider, preserving conservative behavior for old call sites.
   */
  destination?: RetrievalEgressDestination;
  /**
   * Source policy snapshots keyed by source_connections.id. When a ref/payload
   * names a source id that is missing here, egress fails closed.
   */
  sourcePolicies?: Readonly<Record<string, RetrievalSourceEgressPolicy>>;
  /** Source ids for the whole provider payload, used once the provider target is known. */
  payloadSourceConnectionIds?: readonly string[];
}

export type RetrievalSourceEgressClass =
  | "internal_only"
  | "local_provider_allowed"
  | "external_provider_allowed";

export interface RetrievalSourceEgressPolicy {
  source_egress_class: RetrievalSourceEgressClass;
  allow_local_provider_egress: boolean;
  allow_external_model_egress: boolean;
}

/** Default policy: egress permitted (preserves pre-W9 behavior when unspecified). */
export const ALLOW_ALL_EGRESS: RetrievalEgressPolicy = { externalEgressEnabled: true };

export function retrievalEgressAllowed(
  ref: RetrievalEgressRef,
  policy: RetrievalEgressPolicy = ALLOW_ALL_EGRESS,
): boolean {
  const destination = policy.destination ?? "external_provider";
  if (destination === "internal_process") return true;
  if (destination === "external_provider" && !policy.externalEgressEnabled) return false;
  const sourceIds = uniqueIds([
    ...(ref.source_connection_ids ?? []),
    ...(policy.payloadSourceConnectionIds ?? []),
  ]);
  if (sourceIds.length === 0) return true;
  const sourcePolicies = policy.sourcePolicies;
  if (!sourcePolicies) return false;
  return sourceIds.every((sourceId) => sourceEgressAllowed(sourceId, destination, sourcePolicies));
}

export function retrievalProviderEgressDestination(provider: {
  provider_type: string;
  base_url?: string | null;
}): RetrievalEgressDestination {
  if (provider.provider_type === "ollama") return "local_provider";
  if (isLocalProviderUrl(provider.base_url)) return "local_provider";
  return "external_provider";
}

/** Classify the actual upstream used by a provider-bound runtime adapter. */
export function runtimeProviderEgressDestination(
  adapterType: string | null | undefined,
  provider: { provider_type: string; base_url?: string | null; config_json?: unknown },
): RetrievalEgressDestination {
  const providerApi = getRuntimeAdapterSpec(adapterType)?.model.provider_api;
  const compatibleUrlKey = providerApi ? `${providerApi}_base_url` : null;
  if (!compatibleUrlKey) return retrievalProviderEgressDestination(provider);
  const config = provider.config_json !== null
    && typeof provider.config_json === "object"
    && !Array.isArray(provider.config_json)
    ? provider.config_json as Record<string, unknown>
    : {};
  const compatibleUrl = typeof config[compatibleUrlKey] === "string"
    ? config[compatibleUrlKey].trim()
    : "";
  // Missing or malformed compatible endpoints fail conservatively as external;
  // the runtime binding will independently reject them before invocation.
  return retrievalProviderEgressDestination({
    provider_type: "compatible_upstream",
    base_url: compatibleUrl || null,
  });
}

function isLocalProviderUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function sourceEgressAllowed(
  sourceId: string,
  destination: RetrievalEgressDestination,
  sourcePolicies: Readonly<Record<string, RetrievalSourceEgressPolicy>>,
): boolean {
  const policy = sourcePolicies[sourceId];
  if (!policy) return false;
  if (destination === "local_provider") {
    return (
      policy.source_egress_class === "local_provider_allowed" ||
      policy.source_egress_class === "external_provider_allowed"
    ) && (policy.allow_local_provider_egress || policy.allow_external_model_egress);
  }
  if (destination === "external_provider") {
    return (
      policy.source_egress_class === "external_provider_allowed" &&
      policy.allow_external_model_egress
    );
  }
  return true;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];
}
