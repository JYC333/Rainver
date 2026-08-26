import type { Queryable } from "../routeUtils/common.js";
import {
  providerProxyExternalLeaseUrl,
  providerProxyLeaseUrl,
  type ProviderProxyRoute,
} from "../providers/proxy/lease.js";

/**
 * The provider-proxy address *this host* should use, in order of authority:
 *
 * 1. an explicit per-host override, for a reverse proxy in front of the API or
 *    a proxy port published somewhere other than the API's host;
 * 2. derived from the address the daemon reports it reaches the control plane
 *    at, with the proxy's own port — the common case, and the reason this
 *    needs no configuration at all;
 * 3. an instance-wide `PROVIDER_PROXY_EXTERNAL_BASE_URL`.
 *
 * The server cannot guess (2) on its own: its in-network hostname is a Compose
 * service name no paired machine can resolve. The daemon already knows it.
 */
export async function resolveHostLeaseUrl(input: {
  db: Queryable;
  hostId: string;
  route: ProviderProxyRoute;
  leaseId: string;
  proxyPort: number;
}): Promise<string | null> {
  const row = await input.db.query<{ provider_proxy_base_url: string | null; daemon_server_url: string | null }>(
    `SELECT provider_proxy_base_url, daemon_server_url FROM hosts WHERE id = $1 LIMIT 1`,
    [input.hostId],
  );
  const host = row.rows[0];
  const base = hostProviderProxyBaseUrl(host ?? null, input.proxyPort);
  if (base) return providerProxyLeaseUrl(base, input.route, input.leaseId);
  return providerProxyExternalLeaseUrl(input.route, input.leaseId);
}

/**
 * The proxy base URL for one host: its explicit override, else derived from
 * the control-plane address the daemon reports plus the proxy's own port.
 * Null when neither is available — the instance-wide setting is the caller's
 * remaining fallback.
 *
 * Exported so the Command Center can show the *same* answer a dispatched run
 * will get. A second derivation in the UI would be free to disagree, and the
 * disagreement would only surface as a run failing on someone's laptop.
 */
export function hostProviderProxyBaseUrl(
  host: { provider_proxy_base_url?: string | null; daemon_server_url?: string | null } | null,
  proxyPort: number,
): string | null {
  const override = stringValue(host?.provider_proxy_base_url);
  if (override) return override.replace(/\/+$/, "");

  const reported = stringValue(host?.daemon_server_url);
  if (!reported || proxyPort <= 0) return null;
  try {
    const url = new URL(reported);
    url.port = String(proxyPort);
    url.pathname = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    // A daemon reporting something unparseable is not a reason to fail here;
    // the instance-wide setting still applies.
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
