import { registerHost } from "../api.js";
import { saveConfig, loadConfig, configPath, assertPairableServerUrl } from "../config.js";

export async function register(options: { serverUrl: string; pairingCode: string }): Promise<{ host_id: string; name: string }> {
  const existing = await loadConfig();
  if (existing) {
    throw new Error(`Already registered (host ${existing.host_id} at ${existing.server_url}) — see ${configPath()}. Nothing to do.`);
  }
  const serverUrl = assertPairableServerUrl(options.serverUrl);
  const result = await registerHost(serverUrl, options.pairingCode);
  await saveConfig({ server_url: serverUrl, host_id: result.host_id, token: result.token, trust: "trusted", workspaces: {} });
  return { host_id: result.host_id, name: result.name };
}
