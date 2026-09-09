import { readFile } from "node:fs/promises";
import { builtinCredentialPath, loadConfig, normalizeServerUrl, saveConfig } from "./config.js";

/**
 * Registration of the instance's own built-in host (ADR 0016, decision 4 of
 * the unified execution host plan).
 *
 * The pairing-code flow answers "does this person own this machine". That
 * question does not arise here: the built-in host is a container of the same
 * deployment, and the credential travels through a filesystem only these two
 * containers share. So the server issues the bearer token, writes it there,
 * and this daemon adopts it — no code to type, no host to pair, and nothing
 * about the built-in host in the pairing UI.
 *
 * Adoption is idempotent and re-runs on every reconnect attempt: when the
 * server rotates the credential (its file was lost, or the row's hash no
 * longer matches what was written), the next attempt picks the new one up
 * instead of the daemon disabling itself the way a revoked paired host does.
 */
export interface BuiltinHostCredential {
  server_url: string;
  host_id: string;
  token: string;
}

export function parseBuiltinCredential(raw: string): BuiltinHostCredential {
  const parsed = JSON.parse(raw) as Partial<BuiltinHostCredential>;
  if (typeof parsed.server_url !== "string" || typeof parsed.host_id !== "string" || typeof parsed.token !== "string") {
    throw new Error("built-in host credential is missing server_url, host_id or token");
  }
  return {
    server_url: normalizeServerUrl(parsed.server_url),
    host_id: parsed.host_id,
    token: parsed.token,
  };
}

export type BuiltinAdoption = "not_builtin" | "unavailable" | "unchanged" | "adopted";

/**
 * Adopts the credential when one is published and differs from what this
 * daemon holds. Returns `unavailable` rather than throwing while the file is
 * absent: the container can start before the server has written it, and a
 * daemon that exited then would need a manual restart to ever come up.
 */
export async function adoptBuiltinCredential(log: (line: string) => void = () => {}): Promise<BuiltinAdoption> {
  const path = builtinCredentialPath();
  if (!path) return "not_builtin";
  let credential: BuiltinHostCredential;
  try {
    credential = parseBuiltinCredential(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log(`built-in host credential at ${path} is unusable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return "unavailable";
  }
  const existing = await loadConfig();
  if (
    existing
    && existing.trust === "strict"
    && existing.host_id === credential.host_id
    && existing.token === credential.token
    && existing.server_url === credential.server_url
  ) {
    return "unchanged";
  }
  // Workspaces are this daemon's own path map and survive a credential
  // rotation; the host id is the same row either way.
  await saveConfig({
    ...credential,
    trust: "strict",
    workspaces: existing?.host_id === credential.host_id ? existing.workspaces : {},
  });
  log(`adopted the built-in host credential for host ${credential.host_id}`);
  return "adopted";
}
