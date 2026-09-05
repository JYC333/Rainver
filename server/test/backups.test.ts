import { describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupPolicyError, enforceBackupPolicy } from "../src/modules/backups/guard.js";
import {
  BACKUP_DATA_DIRS,
  BackupError,
  BackupService,
  automaticBackupIsDue,
  assertSafeBackupTree,
} from "../src/modules/backups/service.js";
import { loadConfig } from "../src/config.js";

describe("backup policy guard", () => {
  it("fails fast in prod when backups are disabled and unacknowledged", () => {
    const config = loadConfig({
      RAINVER_ENV: "prod",
      BACKUP_ENABLED: "false",
      BACKUP_ACCEPT_NO_BACKUP: "false",
    });
    expect(() => enforceBackupPolicy(config, { warn: vi.fn() })).toThrow(BackupPolicyError);
  });

  it("allows prod startup when BACKUP_ACCEPT_NO_BACKUP=true and logs a warning", () => {
    const warn = vi.fn();
    const config = loadConfig({
      RAINVER_ENV: "prod",
      BACKUP_ENABLED: "false",
      BACKUP_ACCEPT_NO_BACKUP: "true",
    });
    expect(() => enforceBackupPolicy(config, { warn })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BACKUP DISABLED in prod"));
  });

  it("logs a warning when non-prod backups are disabled", () => {
    const warn = vi.fn();
    const config = loadConfig({
      RAINVER_ENV: "dev",
      BACKUP_ENABLED: "false",
    });
    enforceBackupPolicy(config, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Automatic backups are DISABLED"));
  });
});

describe("automatic backup scheduling", () => {
  it("uses the database-backed interval against the latest automatic archive", () => {
    const entries = [{ name: "auto.tar.gz", kind: "auto" as const, created_at: "2026-09-05T10:00:00.000Z", size_bytes: 1 }];
    expect(automaticBackupIsDue(entries, 12, new Date("2026-09-05T21:59:59.000Z"))).toBe(false);
    expect(automaticBackupIsDue(entries, 12, new Date("2026-09-05T22:00:00.000Z"))).toBe(true);
    expect(automaticBackupIsDue([], 12, new Date("2026-09-05T22:00:00.000Z"))).toBe(true);
  });
});

describe("BackupService lock handling", () => {
  it("refuses to create a backup without a database snapshot URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-required-db-"));
    try {
      const service = new BackupService(loadConfig({
        RAINVER_HOME: join(root, "home"),
        BACKUP_ROOT: join(root, "backups"),
        BACKUP_DATABASE_URL: "",
      }));
      await expect(service.createBackup("manual")).rejects.toThrow(
        new BackupError(
          "BACKUP_DATABASE_URL is required; refusing to create an archive without a database snapshot",
        ),
      );
      await expect(pathExists(join(root, "backups"))).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps credential material out of normal data archives", () => {
    expect(BACKUP_DATA_DIRS).toEqual(["storage", "artifacts", "config", "workspaces"]);
    expect(BACKUP_DATA_DIRS).not.toContain("secrets" as never);
  });

  it("rejects links that cannot pass safe restore extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-safe-tree-"));
    try {
      await writeFile(join(root, "value"), "ok");
      await symlink("value", join(root, "link"));
      await expect(assertSafeBackupTree(root)).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a top-level backup directory that is itself a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-safe-root-link-"));
    try {
      const target = join(root, "target");
      const linkedRoot = join(root, "storage");
      await mkdir(target);
      await writeFile(join(target, "value"), "ok");
      await symlink(target, linkedRoot);
      await expect(assertSafeBackupTree(linkedRoot)).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes stale lock files before pruning", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-lock-"));
    try {
      const home = join(root, "home");
      const backupRoot = join(root, "backups");
      await mkdir(home, { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const lockPath = join(backupRoot, ".backup.lock");
      await writeFile(lockPath, "acquired_at=2020-01-01T00:00:00.000Z\n");

      const service = new BackupService(
        loadConfig({
          RAINVER_HOME: home,
          BACKUP_ROOT: backupRoot,
          BACKUP_RETENTION_COUNT: "2",
        }),
      );

      await expect(service.pruneOldBackups()).resolves.toEqual([]);
      await expect(pathExists(lockPath)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tightens existing backup root permissions before pruning", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-mode-"));
    try {
      const home = join(root, "home");
      const backupRoot = join(root, "backups");
      await mkdir(home, { recursive: true });
      await mkdir(backupRoot, { recursive: true, mode: 0o777 });
      await chmod(backupRoot, 0o777);

      const service = new BackupService(
        loadConfig({
          RAINVER_HOME: home,
          BACKUP_ROOT: backupRoot,
          BACKUP_RETENTION_COUNT: "2",
        }),
      );

      await service.pruneOldBackups();
      const mode = (await stat(backupRoot)).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips prune when another live process owns the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-lock-"));
    try {
      const home = join(root, "home");
      const backupRoot = join(root, "backups");
      await mkdir(home, { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const lockPath = join(backupRoot, ".backup.lock");
      await writeFile(lockPath, `pid=${process.pid} acquired_at=${new Date().toISOString()}\n`);

      const service = new BackupService(
        loadConfig({
          RAINVER_HOME: home,
          BACKUP_ROOT: backupRoot,
          BACKUP_RETENTION_COUNT: "2",
        }),
      );

      await expect(service.pruneOldBackups()).resolves.toEqual([]);
      await expect(pathExists(lockPath)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
