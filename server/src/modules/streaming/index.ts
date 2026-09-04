/**
 * Streaming edge module.
 *
 * The server owns the SSE transport, the turn projection read, and access
 * checks.
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const streamingModule: ServerModule = {
  name: "streaming",
  registerRoutes,
};
