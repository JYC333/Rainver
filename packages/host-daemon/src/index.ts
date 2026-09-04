export { register } from "./commands/register.js";
export { unregisterHost, type UnregisterResult } from "./commands/unregister.js";
export { workspaceAdd, workspaceList, workspaceRemove, type LocalWorkspace } from "./commands/workspace.js";
export { runService } from "./commands/run.js";
export { updateHost, hostInstallRoot, type UpdateHostOptions } from "./commands/update.js";
export { startInstalledService, stopInstalledService, disableInstalledService } from "./service.js";
export { resolveFolderReadRequest, performFolderRead, type FolderReadRequest, type FolderReadResult } from "./folderRead.js";
export { loadConfig, saveConfig, removeConfig, requireConfig, configPath, configDir, type DaemonConfig } from "./config.js";
export {
  archiveManagedWorkspace,
  restoreManagedWorkspace,
  sweepManagedWorkspaceArchives,
  listManagedWorkspaces,
  managedWorkspacePath,
  ensureManagedWorkspace,
  assertManagedWorkspaceId,
  type ManagedWorkspaceContainer,
  type ManagedWorkspaceHeartbeat,
} from "./managedWorkspaces.js";
export { detectCapabilities, type DaemonCapabilities, type ProbedBinary, type RuntimeInstallation } from "./capabilities.js";
export {
  registerHost,
  revokeCurrentHost,
  createWorkspace,
  listWorkspaces,
  removeWorkspace,
  ApiError,
  type RegisterResult,
  type WorkspaceOut,
} from "./api.js";
