import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import { builtinHostServerUrl } from "./controlPlaneUrl.js";
import { PgHostRepository } from "./repository.js";

/**
 * The built-in host's registration credential (plan decision 4).
 *
 * The instance's own execution host is not a machine anyone pairs: it is a
 * container of this deployment, and a pairing code — a one-time secret typed
 * at a terminal by the machine's owner — answers a question that does not
 * arise for it. So the control plane issues the bearer token itself and leaves
 * it in a directory only these two containers share; the daemon adopts it on
 * startup. Nothing about the built-in host ever appears in the pairing flow,
 * and there is no step between deploying an instance and having an execution
 * host.
 *
 * Publishing is idempotent: the file is rewritten only when it is missing,
 * unreadable, or no longer matches the row (someone deleted the instance's
 * cache, or restored a database whose hash the file predates). The token is
 * the only copy — the server stores a hash — so "the file is gone" and
 * "rotate" are necessarily the same case.
 */
export interface BuiltinHostCredential {
  server_url: string;
  host_id: string;
  token: string;
}

/** Under the instance root, beside the other caches; mounted read-only into `sandbox-runner`. */
export function builtinHostCredentialPath(rainverHome: string): string {
  return join(rainverHome, "cache", "builtin-host", "registration.json");
}


async function readPublished(path: string): Promise<BuiltinHostCredential | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BuiltinHostCredential>;
    if (typeof parsed.server_url !== "string" || typeof parsed.host_id !== "string" || typeof parsed.token !== "string") {
      return null;
    }
    return { server_url: parsed.server_url, host_id: parsed.host_id, token: parsed.token };
  } catch {
    return null;
  }
}

export async function publishBuiltinHostCredential(
  pool: Pool,
  config: ServerConfig,
  log: (message: string) => void = () => {},
): Promise<{ host_id: string; rotated: boolean }> {
  const hosts = new PgHostRepository(pool);
  const hostId = await hosts.ensureServerHostId();
  const serverUrl = builtinHostServerUrl(config);
  const path = builtinHostCredentialPath(config.rainverHome);
  const published = await readPublished(path);
  if (
    published
    && published.host_id === hostId
    && published.server_url === serverUrl
    && await hosts.builtinHostTokenMatches(hostId, published.token)
  ) {
    return { host_id: hostId, rotated: false };
  }
  const token = await hosts.rotateBuiltinHostToken(hostId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written and renamed rather than written in place: the daemon polls this
  // file every few seconds, and a crash partway through a direct write would
  // leave it holding JSON that never parses — which the daemon reports as
  // "not published yet" and waits on until the next server start.
  const staging = `${path}.tmp`;
  await writeFile(staging, `${JSON.stringify({ server_url: serverUrl, host_id: hostId, token }, null, 2)}\n`, { mode: 0o600 });
  await rename(staging, path);
  log(`[hosts] published the built-in host credential for host ${hostId}`);
  return { host_id: hostId, rotated: true };
}
