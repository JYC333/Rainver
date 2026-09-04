import { ApiError, revokeCurrentHost } from "../api.js";
import { removeConfig, requireConfig, type DaemonConfig } from "../config.js";
import { stopInstalledService } from "../service.js";

export interface UnregisterResult {
  remote: "revoked" | "already_invalid" | "skipped";
  service_stopped: boolean;
}

interface UnregisterDependencies {
  requireConfig(): Promise<DaemonConfig>;
  revoke(serverUrl: string, token: string): Promise<void>;
  removeConfig(): Promise<void>;
  stopService(): Promise<boolean>;
}

const defaultDependencies: UnregisterDependencies = {
  requireConfig,
  revoke: revokeCurrentHost,
  removeConfig,
  stopService: stopInstalledService,
};

/**
 * Revokes remotely before deleting the only local copy of the credential.
 * A 401 means the server has already revoked or forgotten it, so local
 * cleanup is still both safe and necessary.
 */
export async function unregisterHost(
  options: { localOnly?: boolean } = {},
  dependencies: UnregisterDependencies = defaultDependencies,
): Promise<UnregisterResult> {
  const config = await dependencies.requireConfig();
  let remote: UnregisterResult["remote"] = "skipped";
  if (!options.localOnly) {
    try {
      await dependencies.revoke(config.server_url, config.token);
      remote = "revoked";
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 401) throw error;
      remote = "already_invalid";
    }
  }

  const serviceStopped = await dependencies.stopService();
  await dependencies.removeConfig();
  return { remote, service_stopped: serviceStopped };
}
