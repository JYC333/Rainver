export { register } from "./commands/register.js";
export { workspaceAdd, workspaceList, workspaceRemove, type LocalWorkspace } from "./commands/workspace.js";
export { runService } from "./commands/run.js";
export { loadConfig, saveConfig, requireConfig, configPath, configDir, type DaemonConfig } from "./config.js";
export { detectCapabilities, type DaemonCapabilities, type ProbedBinary } from "./capabilities.js";
export {
  registerHost,
  createWorkspace,
  listWorkspaces,
  removeWorkspace,
  ApiError,
  type RegisterResult,
  type WorkspaceOut,
} from "./api.js";
