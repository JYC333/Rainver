import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const runtimeToolBindingsModule: ServerModule = {
  name: "runtime_tool_bindings",
  registerRoutes,
};
