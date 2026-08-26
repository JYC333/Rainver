import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const projectFoldersModule: ServerModule = {
  name: "projectFolders",
  registerRoutes,
};

export {
  __setProjectFolderIdentityForTests,
  __setProjectFolderServicesFactoryForTests,
} from "./routes.js";
export { PgRunSandboxManager } from "./sandbox.js";
export type { RunSandboxManagerPort, PreparedRunSandbox } from "./sandbox.js";
export { PgCodePatchCollector, registerProjectFolderProposalAppliers } from "./codePatch.js";
export { PgProjectFolderRepository } from "./repository.js";
export type { ProjectFolderRow, ProjectFolderOut } from "./repository.js";
export {
  PgWorkspaceLocationRepository,
  assertServerHostLocation,
  locationAbsoluteRoot,
  resolvePreferredServerHostLocation,
  resolveServerHostLocationForRun,
} from "./workspaceLocations.js";
export type { WorkspaceLocationRow, WorkspaceLocationOut } from "./workspaceLocations.js";
