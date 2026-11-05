import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerOrdinaryToolRoutes } from "./ordinaryToolRoutes.js";
import { registerOrdinaryToolAccountRoutes } from "./ordinaryToolAccountRoutes.js";

export const hostsModule: ServerModule = {
  name: "hosts",
  registerRoutes(app, context) {
    registerRoutes(app, context);
    registerOrdinaryToolRoutes(app, context);
    registerOrdinaryToolAccountRoutes(app, context);
  },
};

export {
  PgHostRepository,
  hostRepositoryFromConfig,
  __setHostRepositoryForTests,
  type HostRow,
  type HostOut,
  type HostFailure,
  type DaemonHelloInfo,
} from "./repository.js";

export { STOPPED_MERGE_STATUSES } from "./taskMerges.js";
