import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ENTRYPOINTS: Readonly<Record<string, string>> = {
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp/dist/index.js",
  "codex-acp": "@agentclientprotocol/codex-acp/dist/index.js",
};

let installing: Promise<boolean> | null = null;
let retryAfter = 0;
const FAILED_INSTALL_RETRY_MS = 5 * 60 * 1000;

export function isPackagedAdapter(command: string): boolean {
  return Object.hasOwn(ENTRYPOINTS, command);
}

export function resolvePackagedAdapter(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const specifier = ENTRYPOINTS[command];
  if (!specifier) return null;
  const adapterRoot = env.RAINVER_HOST_ADAPTER_ROOT;
  if (adapterRoot && !existsSync(join(adapterRoot, "package.json"))) return null;
  const requireFrom = adapterRoot ? createRequire(join(adapterRoot, "package.json")) : createRequire(import.meta.url);
  try {
    return requireFrom.resolve(specifier);
  } catch {
    return null;
  }
}

/** Installs the selected channel's adapter pack when a vendor CLI appears later. */
export async function ensurePackagedAdapter(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isPackagedAdapter(command) || resolvePackagedAdapter(command, env)) return true;
  if (!env.RAINVER_HOST_INSTALL_ROOT) return false;
  if (Date.now() < retryAfter) return false;
  if (installing) return installing;

  const installer = join(env.RAINVER_HOST_INSTALL_ROOT, "install-host.sh");
  installing = new Promise<boolean>((resolve) => {
    const child = spawn("/bin/bash", [installer, "--ensure-adapters"], { env, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", code => resolve(code === 0 && resolvePackagedAdapter(command, env) !== null));
  }).then((installed) => {
    if (!installed) retryAfter = Date.now() + FAILED_INSTALL_RETRY_MS;
    return installed;
  }).finally(() => {
    installing = null;
  });
  return installing;
}
