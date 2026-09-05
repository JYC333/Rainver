import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const backupsModule: ServerModule = {
  name: "backups",
  registerRoutes,
};

export { BackupService, automaticBackupIsDue, runScheduledBackup } from "./service.js";
export { enforceBackupPolicy, BackupPolicyError } from "./guard.js";
