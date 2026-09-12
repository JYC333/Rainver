import type { ServerConfig } from "../../config.js";
import { hostControlPlaneUrl } from "../hosts/controlPlaneUrl.js";
import type { Queryable } from "../routeUtils/common.js";
import {
  providerProxyExternalBaseUrl,
  providerProxyInNetworkBaseUrl,
  providerProxyLeaseUrl,
  type ProviderProxyRoute,
} from "../providers/proxy/lease.js";

/** The lease URL a dispatched Run on this host is handed; null when no address applies. */
export async function resolveHostLeaseUrl(input: {
  db: Queryable;
  config: ServerConfig;
  hostId: string;
  route: ProviderProxyRoute;
  leaseId: string;
}): Promise<string | null> {
  const row = await input.db.query<{ provider_proxy_base_url: string | null; kind: string }>(
    `SELECT provider_proxy_base_url, kind FROM hosts WHERE id = $1 LIMIT 1`,
    [input.hostId],
  );
  const host = row.rows[0];
  if (!host) return null;
  const base = hostProviderProxyBaseUrl(host, input.config);
  return base ? providerProxyLeaseUrl(base, input.route, input.leaseId) : null;
}

/**
 * The provider-proxy address for one host, in order of authority:
 *
 * 1. its explicit per-host override, for a reverse proxy in front of the API
 *    or a proxy published somewhere other than the API's host;
 * 2. for the built-in host, the in-network listener — never an address
 *    published for machines outside, which would take the lease token off the
 *    internal network;
 * 3. for a paired host, the instance-wide `PROVIDER_PROXY_EXTERNAL_BASE_URL`;
 * 4. for a paired host, its control-plane address (`hostControlPlaneUrl`,
 *    `FRONTEND_URL`) with the proxy's own port, when that address is `http:`.
 *
 * Configuration outranks derivation: the derived address is inferred from
 * `FRONTEND_URL`, and an operator who published the proxy elsewhere said so.
 * The listener is plaintext HTTP, so an `https:` control plane is not derived
 * from — its TLS terminates somewhere this port is not behind, and the
 * derived URL would fail the handshake or quietly drop TLS. Null when nothing
 * applies.
 *
 * Exported so the Command Center can show the *same* answer a dispatched run
 * will get. A second derivation in the UI would be free to disagree, and the
 * disagreement would only surface as a run failing on someone's laptop.
 */
export function hostProviderProxyBaseUrl(
  host: { provider_proxy_base_url?: string | null; kind: string },
  config: ServerConfig,
): string | null {
  const override = stringValue(host.provider_proxy_base_url);
  if (override) return override.replace(/\/+$/, "");
  if (host.kind === "server") return providerProxyInNetworkBaseUrl();
  const external = stringValue(providerProxyExternalBaseUrl());
  if (external) return external.replace(/\/+$/, "");
  if (config.providerProxyPort <= 0) return null;
  const url = new URL(hostControlPlaneUrl(config, host.kind));
  if (url.protocol !== "http:") return null;
  url.port = String(config.providerProxyPort);
  url.pathname = "";
  return url.toString().replace(/\/+$/, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
