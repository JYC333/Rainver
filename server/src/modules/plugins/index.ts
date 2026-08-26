import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { assertPluginRegistryIntegrity } from "./registry.js";

// Validate descriptor uniqueness at module load time. Throws if violated.
assertPluginRegistryIntegrity();

export const pluginsModule: ServerModule = {
  name: "plugins",
  registerRoutes,
};

// Facade exports for use by other server modules.
export { requireOfficialPluginEnabled } from "./guards.js";
export { getOfficialPlugin, listOfficialPlugins } from "./registry.js";
export { pluginService } from "./service.js";
export type { PluginGuardOptions } from "./guards.js";
