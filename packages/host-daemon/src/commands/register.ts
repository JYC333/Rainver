import { registerHost } from "../api.js";
import { saveConfig, loadConfig, configPath } from "../config.js";

export async function register(options: { serverUrl: string; pairingCode: string }): Promise<{ host_id: string; name: string }> {
  const existing = await loadConfig();
  if (existing) {
    throw new Error(`Already registered (host ${existing.host_id} at ${existing.server_url}) — see ${configPath()}. Nothing to do.`);
  }
  const result = await registerHost(options.serverUrl, options.pairingCode);
  await saveConfig({ server_url: options.serverUrl, host_id: result.host_id, token: result.token, workspaces: {} });
  return { host_id: result.host_id, name: result.name };
}
