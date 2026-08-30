export { register } from "./commands/register.js";
export { workspaceAdd, workspaceList, workspaceRemove, type LocalWorkspace } from "./commands/workspace.js";
export { runService } from "./commands/run.js";
export { parseFolderReadFrame, performFolderRead, type FolderReadRequest, type FolderReadResult } from "./folderRead.js";
export { loadConfig, saveConfig, requireConfig, configPath, configDir, type DaemonConfig } from "./config.js";
export { detectCapabilities, type DaemonCapabilities, type ProbedBinary, type RuntimeInstallation } from "./capabilities.js";
export {
  registerHost,
  createWorkspace,
  listWorkspaces,
  removeWorkspace,
  ApiError,
  type RegisterResult,
  type WorkspaceOut,
} from "./api.js";
