import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const backupsModule: ServerModule = {
  name: "backups",
  registerRoutes,
};

export { BackupService, runScheduledBackup } from "./service.js";
export { enforceBackupPolicy, BackupPolicyError } from "./guard.js";
