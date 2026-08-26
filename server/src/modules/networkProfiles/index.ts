import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const networkProfilesModule: ServerModule = {
  name: "networkProfiles",
  registerRoutes,
};

export {
  resolveNetworkProfileRepository,
  type NetworkProfileCreateInput,
  type NetworkProfileUpdateInput,
} from "./repository.js";
export {
  envForNetworkProfile,
  fetchWithNetworkProfile,
  shouldBypassProxy,
  validateNetworkProfileInput,
  type ResolvedNetworkProfile,
} from "./transport.js";
