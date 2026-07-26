import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const projectTemplatesModule: ServerModule = {
  name: "project_templates",
  registerRoutes,
};

export { __setProjectTemplatesServiceFactoryForTests } from "./routes";
export { ProjectTemplatesService } from "./service";
export { __setProjectTemplateRegistryForTests, listBuiltInProjectTemplates, getBuiltInProjectTemplate, DEFAULT_PROJECT_TEMPLATE_KEY } from "./registry";
export type { ProjectTemplateDescriptor } from "./types";
