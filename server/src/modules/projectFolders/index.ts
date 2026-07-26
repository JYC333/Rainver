import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const projectFoldersModule: ServerModule = {
  name: "projectFolders",
  registerRoutes,
};

export {
  __setProjectFolderIdentityForTests,
  __setProjectFolderServicesFactoryForTests,
} from "./routes";
export { PgRunSandboxManager } from "./sandbox";
export type { RunSandboxManagerPort, PreparedRunSandbox } from "./sandbox";
export { PgCodePatchCollector, registerProjectFolderProposalAppliers } from "./codePatch";
export { PgProjectFolderRepository, projectFolderAbsoluteRoot } from "./repository";
export type { ProjectFolderRow, ProjectFolderOut } from "./repository";
