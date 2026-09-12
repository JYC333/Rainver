import type { ServerConfig } from "../../config.js";

/**
 * The control-plane address a host's child processes call back on
 * (`RAINVER_API_URL`), and the one a host's provider-proxy address is derived
 * from.
 *
 * Configuration only — never the request and never the daemon's report. A
 * request's Host and `X-Forwarded-*` and a daemon's own account of where it
 * connected are all attested by someone other than the instance, and none of
 * them may choose where a Run's bearer token is sent. A paired host is handed
 * `FRONTEND_URL`, the one address the instance declares; the built-in host is
 * handed its in-network address.
 */
export function hostControlPlaneUrl(config: ServerConfig, hostKind: string): string {
  if (hostKind === "server") return builtinHostServerUrl(config);
  const url = new URL(config.frontendUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The address the built-in execution host reaches this server at.
 *
 * The same in-network name the sandbox path already uses: the built-in host is
 * a Compose service beside the server, not a machine on someone's LAN, so
 * unlike a paired host it needs no externally-resolvable address and no
 * operator configuration.
 */
export function builtinHostServerUrl(config: ServerConfig): string {
  return `http://${config.sandboxRunnerServerHost}:${config.port}`;
}
