import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const runtimeToolsModule: ServerModule = {
  name: "runtimeTools",
  registerRoutes,
};

export {
  RUNTIME_TOOL_DEFINITIONS,
  npmInstallEnv,
  RuntimeToolError,
  RuntimeToolRegistry,
  type ResolvedRuntimeTool,
  type RuntimeToolDefinition,
  type RuntimeToolInstallInput,
  type RuntimeToolInstallRunner,
  type RuntimeToolInstallResult,
  type RuntimeToolManifest,
  type RuntimeToolResolverPort,
  type RuntimeToolStatus,
} from "./service.js";
