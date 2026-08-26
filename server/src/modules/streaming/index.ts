/**
 * Streaming edge module.
 *
 * The server owns the SSE transport, run-event reads, and access checks.
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const streamingModule: ServerModule = {
  name: "streaming",
  registerRoutes,
};

export {
  RUN_EVENT_APPENDED_TYPE,
  __setStreamingRepositoryFactoryForTests,
} from "./service.js";
