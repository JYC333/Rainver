import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local daemon state: which control plane this machine registered with, its
 * bearer token, and the local absolute path behind every workspace this
 * machine has registered. This file is the ONLY place a workspace's real
 * path is ever written down — the control plane never sees it (ADR 0016 B64,
 * D3: `display_path` sent to the server is informational only).
 */
export interface DaemonConfig {
  server_url: string;
  host_id: string;
  token: string;
  workspaces: Record<string, string>;
}

const CONFIG_DIR_ENV = "RAINVER_HOST_CONFIG_DIR";

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
    return { server_url: parsed.server_url, host_id: parsed.host_id, token: parsed.token, workspaces: parsed.workspaces ?? {} };
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
