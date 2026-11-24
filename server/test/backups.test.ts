import { describe, expect, it, vi } from "vitest";
import fsPromises, { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
      BETTER_AUTH_SECRET: "test-better-auth-secret",
      BACKUP_ENABLED: "false",
      BACKUP_ACCEPT_NO_BACKUP: "false",
    });
    expect(() => enforceBackupPolicy(config, { warn: vi.fn() })).toThrow(BackupPolicyError);
  });

  it("allows prod startup when BACKUP_ACCEPT_NO_BACKUP=true and logs a warning", () => {
    const warn = vi.fn();
    const config = loadConfig({
      RAINVER_ENV: "prod",
      BETTER_AUTH_SECRET: "test-better-auth-secret",
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

  it("clears a lock left by an earlier process that had this process's pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-lock-"));
    try {
      const home = join(root, "home");
      const backupRoot = join(root, "backups");
      await mkdir(home, { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const lockPath = join(backupRoot, ".backup.lock");
      // A container restart: the server is PID 1 again and finds its own pid.
      await writeFile(lockPath, `pid=${process.pid} acquired_at=${new Date().toISOString()}\n`);

      const service = new BackupService(
        loadConfig({ RAINVER_HOME: home, BACKUP_ROOT: backupRoot, BACKUP_RETENTION_COUNT: "2" }),
      );

      await expect(service.pruneOldBackups()).resolves.toEqual([]);
      await expect(pathExists(lockPath)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prevents retention from displacing a lock still being acquired by a local backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-backup-concurrent-"));
    const backupRoot = join(root, "backups");
    const bin = join(root, "bin");
    const previousPath = process.env.PATH;
    let recordLock!: () => void;
    let resumeBackup!: () => void;
    const lockWritten = new Promise<void>((resolve) => { recordLock = resolve; });
    const continueBackup = new Promise<void>((resolve) => { resumeBackup = resolve; });
    const open = fsPromises.open;
    let pauseFirstLock = true;
    let backup: Promise<string> | undefined;
    try {
      await mkdir(backupRoot);
      await mkdir(bin);
      await writeFile(join(bin, "pg_dump"), "#!/bin/sh\nexit 42\n", { mode: 0o700 });
      for (const day of [1, 2]) {
        await writeFile(join(backupRoot, `auto-2020010${day}-000000.tar.gz`), "fixture");
      }
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      const service = new BackupService(loadConfig({
        RAINVER_HOME: root,
        BACKUP_ROOT: backupRoot,
        BACKUP_DATABASE_URL: "postgresql://fixture@127.0.0.1/fixture",
        BACKUP_RETENTION_COUNT: "1",
      }));
      fsPromises.open = async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (pauseFirstLock && args[0] === join(backupRoot, ".backup.lock")) {
          pauseFirstLock = false;
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            recordLock();
            await continueBackup;
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      backup = service.createBackup("manual");
      const result = backup.catch((error: BackupError) => error.message);
      await Promise.race([
        lockWritten,
        result.then(() => { throw new Error("Backup reached completion before the fixture observed its lock"); }),
      ]);
      expect(await service.pruneOldBackups()).toEqual([]);
      resumeBackup();
      await expect(result).resolves.toMatch(/pg_dump failed/);
    } finally {
      fsPromises.open = open;
      syncBuiltinESMExports();
      resumeBackup();
      await backup?.catch(() => undefined);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
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
      // The parent process stands in for another live owner.
      await writeFile(lockPath, `pid=${process.ppid} acquired_at=${new Date().toISOString()}\n`);

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

describe("pg_dump invocation", () => {
  it("passes the whole connection through libpq variables, nothing secret on argv, no server secrets", async () => {
    const { pgDump, pgDumpInvocation } = await import("../src/modules/backups/service.js");
    const bin = await mkdtemp(join(tmpdir(), "rainver-fake-pgdump-"));
    const record = join(bin, "record.json");
    // A synthetic pg_dump: records exactly what it was given, writes a dump file.
    await writeFile(
      join(bin, "pg_dump"),
      `#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:a,env:process.env}));fs.writeFileSync(a[a.indexOf("-f")+1],"dump");\n`,
    );
    await chmod(join(bin, "pg_dump"), 0o755);
    const saved = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY, PGSSLMODE: process.env.PGSSLMODE };
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    process.env.OPENAI_API_KEY = "sk-synthetic-provider-key";
    delete process.env.PGSSLMODE;
    try {
      const url = "postgresql://backup%40ro:s3cr%2Ft@[::1]:6543/rain%20db?sslmode=verify-full&sslrootcert=%2Fcerts%2Froot.crt&application_name=backup";
      await pgDump(url, join(bin, "out.dump"));
      const seen = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(record, "utf8"))) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv).toEqual(["--no-password", "-Fc", "--no-owner", "--no-acl", "-f", join(bin, "out.dump")]);
      expect(seen.argv.join(" ")).not.toMatch(/s3cr|postgres/);
      expect(seen.env).toMatchObject({
        PGHOST: "::1", PGPORT: "6543", PGUSER: "backup@ro", PGPASSWORD: "s3cr/t", PGDATABASE: "rain db",
        PGSSLMODE: "verify-full", PGSSLROOTCERT: "/certs/root.crt", PGAPPNAME: "backup",
      });
      expect(seen.env.OPENAI_API_KEY).toBeUndefined();
      expect(Object.keys(seen.env).filter((key) => !/^(PG|PATH$|HOME$|LANG$|LC_|TZ$|TMPDIR$)/.test(key))).toEqual([]);

      // A TLS setting libpq does not define is refused, not dropped.
      for (const bad of ["postgresql://u@h/db?ssl=true", "postgresql://u@h/db?sslmode=verify-full&uselibpqcompat=true"]) {
        expect(() => pgDumpInvocation(bad, "/x"), bad).toThrow(BackupError);
      }
      // A parameter libpq takes only as a connection-string keyword is refused too, its value never echoed.
      expect(() => pgDumpInvocation("postgresql://u@h/db?sslpassword=k3y-secret", "/x")).toThrow(/sslpassword/);
      expect(() => pgDumpInvocation("postgresql://u@h/db?sslpassword=k3y-secret", "/x")).not.toThrow(/k3y-secret/);
      // Malformed escapes and multi-host lists fail as a BackupError without echoing the URL.
      for (const bad of ["postgresql://u:%E0%A4%A@h/db", "postgresql://u:pw-secret@h1:5432,h2:5433/db"]) {
        expect(() => pgDumpInvocation(bad, "/x"), bad).toThrow(BackupError);
        expect(() => pgDumpInvocation(bad, "/x"), bad).not.toThrow(/secret|%E0/);
      }
      // libpq options and a URL-encoded value survive exactly, in the environment.
      expect(pgDumpInvocation("postgresql://u@h/db?options=-c%20search_path%3Dapp&sslmode=require", "/x", {}).env).toMatchObject({ PGOPTIONS: "-c search_path=app", PGSSLMODE: "require" });
      // Server-level libpq settings keep their meaning unless the URL overrides them.
      expect(pgDumpInvocation("postgresql://u@h/db", "/x", { PGSSLMODE: "require", SECRET: "x" }).env).toEqual({ PGSSLMODE: "require", PGHOST: "h", PGUSER: "u", PGDATABASE: "db" });
      expect(pgDumpInvocation("postgresql://u@h/db?sslmode=verify-ca", "/x", { PGSSLMODE: "disable" }).env.PGSSLMODE).toBe("verify-ca");
      // Unix socket directory as a query host.
      expect(pgDumpInvocation("postgresql:///db?host=%2Fvar%2Frun%2Fpostgresql", "/x", {}).env).toEqual({ PGDATABASE: "db", PGHOST: "/var/run/postgresql" });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(bin, { recursive: true, force: true });
    }
  });
});
