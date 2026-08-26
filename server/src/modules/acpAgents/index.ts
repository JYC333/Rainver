import type { ServerModule } from "../../gateway/routeRegistry.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { registerRoutes } from "./routes.js";
import { AcpAgentService } from "./service.js";

export const acpAgentsModule: ServerModule = { name: "acpAgents", registerRoutes };

export { AcpAgentService, acpAgentAdapterType } from "./service.js";
export { __setAcpRegistryForTests, type AcpRegistryEntry } from "./registry.js";

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Loads the enabled registry agents into this process's adapter catalog and
 * keeps them fresh. Writes republish immediately in the process that made
 * them; the timer is for everyone else.
 */
export function startAcpAgentSpecRefresh(
  config: ServerConfig,
  log: { error(message: string): void },
): { stop(): void } | null {
  if (!config.databaseUrl) return null;
  const service = new AcpAgentService(getDbPool(config.databaseUrl));
  const refresh = () => service.refreshRuntimeAdapterSpecs().catch((error) => {
    log.error(`[acp-agents] adapter refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  void refresh();
  const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
