import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isLoopbackAddress } from "@rainver/outbound-guard";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local daemon state: which control plane this machine registered with, its
 * bearer token, and the local absolute path behind every workspace this
 * machine has registered. This file is the ONLY place a workspace's real
 * path is ever written down — the control plane never sees it (ADR 0016 B64,
 * D3: `display_path` sent to the server is informational only).
 */
/**
 * How much of this machine a Run is allowed to see.
 *
 * `trusted` is a paired personal machine: native spawn, no namespace, the
 * trust the owner already extends to their own laptop (ADR 0016 §2).
 * `strict` is the built-in host inside `sandbox-runner`: the same daemon,
 * serving every Space of the instance, with each Run wrapped in its own
 * bubblewrap namespace — which is what makes a shared, multi-user execution
 * host safe at all. The mode is chosen by how this daemon registered, never
 * per Run, and is written into this file with the credential it registered
 * with; a config that predates the field is a paired host.
 */
export type HostTrustMode = "trusted" | "strict";

export interface DaemonConfig {
  server_url: string;
  host_id: string;
  token: string;
  trust: HostTrustMode;
  workspaces: Record<string, string>;
}

const CONFIG_DIR_ENV = "RAINVER_HOST_CONFIG_DIR";

/**
 * Where the control plane leaves this instance's built-in-host credential.
 *
 * The server writes it into a mount both containers share; the daemon reads
 * it and adopts it. There is no pairing code for the built-in host — it is not
 * a machine someone pairs, it is the instance's own execution host, and it
 * must come up on a fresh instance without anyone typing anything.
 */
const BUILTIN_CREDENTIAL_ENV = "RAINVER_BUILTIN_HOST_CREDENTIAL";

/**
 * The instance's own workspace root, as this container mounts it.
 *
 * Only the built-in host has one: its Locations are created by the control
 * plane under a root both containers share, so a launch can name one by a path
 * relative to it. A paired machine has no such root — its Locations are
 * directories its owner registered, and their paths live only in this file.
 */
export function workspacesRoot(): string | null {
  const configured = process.env.RAINVER_HOST_WORKSPACES_ROOT?.trim();
  return configured ? configured : null;
}

/** Set only inside the `sandbox-runner` container; absent on a paired machine. */
export function builtinCredentialPath(): string | null {
  const configured = process.env[BUILTIN_CREDENTIAL_ENV]?.trim();
  return configured ? configured : null;
}

/**
 * The control-plane base URL as every API and WebSocket path is appended to
 * it: scheme, host, optional path prefix, no trailing slash, no query or
 * fragment. `https://rainver.example/` typed at the prompt is the same server
 * as `https://rainver.example`, and the daemon must not build
 * `https://rainver.example//api/v1/...` out of it.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid --server URL: ${JSON.stringify(raw)} (expected e.g. https://rainver.example)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid --server URL: ${JSON.stringify(raw)} (must start with http:// or https://)`);
  }
  if (url.username || url.password) {
    throw new Error(`Invalid --server URL: ${JSON.stringify(raw)} (must not embed credentials)`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/**
 * Whether this URL host is this machine.
 *
 * The two named forms, and otherwise an *address* — `startsWith("127.")` was
 * true of `127.evil.com`, a hostname somebody else controls and can point
 * anywhere, which is exactly the thing plain HTTP must not be allowed for.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "localhost.localdomain") return true;
  return isLoopbackAddress(host);
}

/**
 * Pairing sends a one-time code and returns a long-lived host token. Plain
 * HTTP is only allowed on loopback, where the packets never leave this machine.
 * The built-in host does not go through this — it adopts a published credential
 * over the Compose network.
 */
export function assertPairableServerUrl(raw: string): string {
  const serverUrl = normalizeServerUrl(raw);
  const url = new URL(serverUrl);
  if (url.protocol === "https:") return serverUrl;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return serverUrl;
  throw new Error(
    `Plain HTTP is only allowed for localhost (got ${url.origin}). Use HTTPS, or register via http://127.0.0.1 when the control plane is on this machine.`,
  );
}

export function configDir(): string {
  return process.env[CONFIG_DIR_ENV] ?? join(homedir(), ".rainver-host");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<DaemonConfig | null> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    if (typeof parsed.server_url !== "string" || typeof parsed.host_id !== "string" || typeof parsed.token !== "string") {
      throw new Error(`Malformed daemon config at ${configPath()}`);
    }
    // A config written before strict mode existed is a paired machine — the
    // only thing this daemon could have been then.
    const trust = parsed.trust === "strict" ? "strict" : "trusted";
    return {
      // The same rule pairing applied, re-applied on read: a config file is an
      // ordinary file on the user's machine, and one edited afterwards would
      // otherwise send this host's bearer token to a plain-HTTP address
      // off-box.
      //
      // The built-in host is exempt for the reason `assertPairableServerUrl`
      // already gives — it adopts a credential the instance published to it
      // over the Compose network, where the control plane is
      // `http://server:8010` and there is no pairing at all. The exemption is
      // decided by `builtinCredentialPath()`, an environment variable set only
      // inside the `sandbox-runner` container, and *not* by `parsed.trust`:
      // that field lives in the same file this check distrusts, so an edit that
      // pointed `server_url` at a plain-HTTP address off-box could have set
      // `"trust":"strict"` in the same stroke and turned the check off.
      server_url: builtinCredentialPath()
        ? normalizeServerUrl(parsed.server_url)
        : assertPairableServerUrl(parsed.server_url),
      host_id: parsed.host_id,
      token: parsed.token,
      trust,
      workspaces: parsed.workspaces ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function requireConfig(): Promise<DaemonConfig> {
  const config = await loadConfig();
  if (!config) {
    throw new Error(`Not registered yet — run 'rainver-host register --server <url> --code <pairing-code>' first (expected config at ${configPath()})`);
  }
  return config;
}

export async function saveConfig(config: DaemonConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Removes only the registration credential and workspace-path map, not installed tools or managed workspaces. */
export async function removeConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}
