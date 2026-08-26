import type { ServerConfig } from "../../config.js";

export class BackupPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPolicyError";
  }
}

export interface BackupPolicyLogger {
  warn(message: string): void;
}

/**
 * Enforce backup safety policy at server startup.
 */
export function enforceBackupPolicy(
  config: ServerConfig,
  log: BackupPolicyLogger = console,
): void {
  if (config.backupEnabled) return;

  const env = (config.rainverEnv ?? "").trim().toLowerCase();
  if (env === "prod") {
    if (config.backupAcceptNoBackup) {
      log.warn(
        "BACKUP DISABLED in prod: RAINVER_ENV=prod with BACKUP_ENABLED=false. " +
          "Proceeding because BACKUP_ACCEPT_NO_BACKUP=true. No automatic backups will be taken.",
      );
      return;
    }
    throw new BackupPolicyError(
      "Refusing to start: RAINVER_ENV=prod but BACKUP_ENABLED=false. " +
        "Set BACKUP_ENABLED=true or BACKUP_ACCEPT_NO_BACKUP=true.",
      );
  }
  log.warn(
    `Automatic backups are DISABLED (BACKUP_ENABLED=false, RAINVER_ENV=${env || "unset"}). ` +
      "This is fine for tests/CI, but enable backups before dogfooding data.",
  );
}
