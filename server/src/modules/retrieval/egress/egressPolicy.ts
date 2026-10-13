/**
 * Provider-egress policy for retrieval content.
 *
 * Sending a retrieval object's text to a model provider (for embedding, rerank,
 * or synthesis) is egress. A per-space switch (`external_egress_enabled`) lets a space mark
 * its content "do not send to external providers". Local providers and internal
 * processing can still be allowed without enabling external API egress. What
 * makes a Provider local is its declared deployment, its endpoint, and the
 * model it runs — see `providerEgressDestination`.
 *
 * The seam is a single, domain-neutral, per-row predicate. Source-derived rows
 * carry source connection ids from the retrieval projection; provider calls also
 * attach the payload's source ids so this same predicate can fail closed against
 * the actual provider destination.
 *
 * Query rewriting does NOT consult this seam: it sends only the query string,
 * never candidate content.
 */
import { isIP } from "node:net";
import { isBlockedAddress, isLoopbackAddress, isSyntheticDnsAddress } from "@rainver/outbound-guard";
import { adapterProviderApi, adapterProviderRequirement } from "../../runs/adapterProviderRequirement.js";
import { providerDeployment, type ProviderDeployment } from "../../providers/deployment.js";

interface RetrievalEgressRef {
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
   * provider. Do not treat a missing class as local.
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

/** Default policy when the caller names none: egress permitted. */
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

/** The Provider facts the destination is judged on; `model` is the one the call will actually use. */
export interface ProviderEgressSubject {
  provider_type: string;
  base_url?: string | null;
  /** The declaration, when the caller has it resolved; otherwise read from `config_json`. */
  deployment?: ProviderDeployment;
  config_json?: unknown;
  default_model?: string | null;
  model?: string | null;
}

/**
 * Whether sending content to this Provider is a local or an external egress.
 *
 * Local needs all three: the Provider is declared a trusted local deployment,
 * the endpoint it will be reached at is inside this instance's own network
 * (loopback, a private range, a single-label container name, or a
 * non-public suffix), and the model it will run is not one its vendor serves
 * from the cloud. A vendor name (`ollama`) proves nothing: the same server
 * forwards `-cloud` models to the vendor's hosted service. A loopback URL
 * proves nothing: a local gateway may forward anywhere. Unknown is external.
 */
export function providerEgressDestination(subject: ProviderEgressSubject): RetrievalEgressDestination {
  const deployment = subject.deployment ?? providerDeployment(subject.config_json);
  if (deployment !== "trusted_local") return "external_provider";
  if (!isInstanceNetworkUrl(subject.base_url)) return "external_provider";
  const model = subject.model ?? subject.default_model ?? null;
  if (isCloudServedModel(subject.provider_type, model)) return "external_provider";
  return "local_provider";
}

/** Classify the actual upstream used by a provider-bound runtime adapter. */
export function runtimeProviderEgressDestination(
  runtimeKey: string | null | undefined,
  provider: ProviderEgressSubject,
): RetrievalEgressDestination {
  if (!adapterProviderApi(runtimeKey)) return providerEgressDestination(provider);
  // The same resolution the binding uses, so a runtime that follows its
  // vendor's protocol (OpenCode) is classified by the endpoint it will reach.
  // The deployment declaration and the model are the Provider's own: a
  // runtime cannot be configured into a "local" classification the Provider
  // was never declared to have.
  const compatibleUrlKey = adapterProviderRequirement(runtimeKey, provider.provider_type)?.base_url_field ?? null;
  const config = provider.config_json !== null
    && typeof provider.config_json === "object"
    && !Array.isArray(provider.config_json)
    ? provider.config_json as Record<string, unknown>
    : {};
  const compatibleUrl = compatibleUrlKey && typeof config[compatibleUrlKey] === "string"
    ? config[compatibleUrlKey].trim()
    : "";
  // Missing or malformed compatible endpoints, and a vendor protocol the
  // runtime cannot bind, fail conservatively as external;
  // the runtime binding will independently reject them before invocation.
  return providerEgressDestination({ ...provider, base_url: compatibleUrl || null });
}

/**
 * Models a self-hosted server hands to its vendor's cloud. Ollama names them
 * with a `-cloud` suffix or a `:cloud` tag (`gpt-oss:120b-cloud`,
 * `deepseek-v3.1:671b-cloud`); running one through a local daemon is still
 * an external egress.
 */
export function isCloudServedModel(providerType: string, model: string | null | undefined): boolean {
  if (!model) return false;
  if (providerType !== "ollama") return false;
  const name = model.trim().toLowerCase();
  return name.endsWith("-cloud") || name.endsWith(":cloud") || name.includes("-cloud:");
}

const NON_PUBLIC_SUFFIXES = [".local", ".localhost", ".localdomain", ".lan", ".internal", ".home", ".home.arpa", ".intranet"];

/**
 * Whether a URL names something inside this instance's own network: the
 * machine (`localhost`, loopback), a private or link-local address, a
 * single-label name (a Compose service), or a non-public DNS suffix. A public
 * address or a public-looking name is not local even when declared so.
 */
export function isInstanceNetworkUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let host: string;
  try {
    // `hostname` keeps an IPv6 literal's brackets; strip them before judging
    // it as an address. Judged as an address, never as a name prefix:
    // `127.evil.com` is a hostname somebody else controls.
    host = new URL(value).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "localhost" || isLoopbackAddress(host)) return true;
  if (isIP(host) !== 0) return isBlockedAddress(host) && !isSyntheticDnsAddress(host);
  if (!host.includes(".")) return true;
  return NON_PUBLIC_SUFFIXES.some((suffix) => host.endsWith(suffix));
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
