/**
 * Runtime host module.
 *
 * Internal route only: run orchestration invokes this module through the
 * runtime-adapter seam. The module executes a provider-backed server host turn and
 * returns a normalized adapter result; it does not own run lifecycle state.
 */

import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const runtimeHostModule: ServerModule = {
  name: "runtime_host",
  registerRoutes,
};

export { executeRuntimeHost, type RuntimeHostLogger } from "./service";
export { __setRuntimeHostDeliveryAuthorizerForTests } from "./routes";
export { authorizeRuntimeHostDelivery, bindRuntimeHostDeliveryRequest } from "./deliveryAuthorizer";
