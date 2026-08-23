import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const hostsModule: ServerModule = { name: "hosts", registerRoutes };

export {
  PgHostRepository,
  hostRepositoryFromConfig,
  __setHostRepositoryForTests,
  type HostRow,
  type HostOut,
  type HostFailure,
  type DaemonHelloInfo,
} from "./repository";
