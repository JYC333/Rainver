import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { InstanceOperationsPolicy } from "../settings/index.js";
import { type BackupManifest, serializeManifest } from "./manifest.js";

const execFileAsync = promisify(execFile);

export const BACKUP_DATA_DIRS = ["storage", "artifacts", "config", "workspaces"] as const;
const ALWAYS_EXCLUDED: Record<string, string> = {
  backups: "recursion prevention",
  cache: "ephemeral",
  sandboxes: "ephemeral",
  "db/postgres": "live PostgreSQL data",
  secrets: "credential material; use ops/scripts/system/backup-credentials.sh",
};
const LOCK_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export class BackupInProgressError extends BackupError {
  constructor(message = "backup already in progress") {
    super(message);
    this.name = "BackupInProgressError";
  }
}

export interface BackupEntry {
  name: string;
  kind: "auto" | "manual" | "unknown";
  created_at: string;
  size_bytes: number;
}

export class BackupService {
  constructor(
    private readonly config: ServerConfig,
    private readonly policy: Pick<
      InstanceOperationsPolicy,
      "backup_interval_hours" | "backup_retention_count" | "backup_include_logs"
    > = {
      backup_interval_hours: config.backupIntervalHours,
      backup_retention_count: config.backupRetentionCount,
      backup_include_logs: config.backupIncludeLogs,
    },
  ) {}

  async createBackup(kind: "auto" | "manual"): Promise<string> {
    if (!this.config.backupDatabaseUrl) {
      throw new BackupError(
        "BACKUP_DATABASE_URL is required; refusing to create an archive without a database snapshot",
      );
    }
    const backupRoot = resolve(this.config.backupRoot);
    const dataRoot = resolve(this.config.rainverHome);
    await prepareBackupRoot(backupRoot);

    const releaseLock = await acquireLock(join(backupRoot, ".backup.lock"));
    try {
      const timestamp = formatTimestamp(new Date());
      let archivePath = join(backupRoot, `${kind}-${timestamp}.tar.gz`);
      let counter = 1;
      while (await pathExists(archivePath)) {
        archivePath = join(backupRoot, `${kind}-${timestamp}-${counter}.tar.gz`);
        counter += 1;
      }

      const staging = await mkdtemp(join(tmpdir(), "rainver-backup-staging-"));
      const temporaryArchivePath = `${archivePath}.tmp-${process.pid}`;
      try {
        const { included, excluded, warnings } = await this.stage(dataRoot, staging);
        const versionMetadata = await this.versionMetadata();
        const manifest: BackupManifest = {
          backup_format: "rainver-backup.v1",
          kind,
          created_at: new Date().toISOString(),
          source_root: dataRoot,
          included_paths: included,
          excluded_paths: excluded,
          db_snapshot_method: "pg_dump_custom",
          backup_interval_hours: this.policy.backup_interval_hours,
          backup_retention_count: this.policy.backup_retention_count,
          warnings,
          ...versionMetadata,
        };
        await writeFile(join(staging, "backup_manifest.json"), serializeManifest(manifest), {
          mode: 0o600,
        });
        await execFileAsync("tar", ["-czf", temporaryArchivePath, "-C", staging, "."], {
          timeout: 600_000,
        });
        await execFileAsync("tar", ["-tzf", temporaryArchivePath], { timeout: 600_000 });
        await chmodFile(temporaryArchivePath, 0o600);
        await rename(temporaryArchivePath, archivePath);
        return archivePath;
      } finally {
        await unlink(temporaryArchivePath).catch(() => undefined);
        await rmDirSafe(staging);
      }
    } finally {
      await releaseLock();
    }
  }

  async listBackups(): Promise<BackupEntry[]> {
    const backupRoot = resolve(this.config.backupRoot);
    if (!(await pathExists(backupRoot))) return [];
    const entries: BackupEntry[] = [];
    for (const name of await readdir(backupRoot)) {
      if (!name.endsWith(".tar.gz")) continue;
      const fullPath = join(backupRoot, name);
      const fileStat = await stat(fullPath);
      const stem = name.slice(0, -".tar.gz".length);
      const kindPrefix = stem.split("-", 1)[0];
      const kind =
        kindPrefix === "auto" || kindPrefix === "manual" ? kindPrefix : "unknown";
      entries.push({
        name,
        kind,
        created_at: fileStat.mtime.toISOString(),
        size_bytes: fileStat.size,
      });
    }
    entries.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return entries;
  }

  async pruneOldBackups(): Promise<string[]> {
    const backupRoot = resolve(this.config.backupRoot);
    await prepareBackupRoot(backupRoot);
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      releaseLock = await acquireLock(join(backupRoot, ".backup.lock"));
      const autoBackups = (await this.listBackups()).filter((entry) => entry.kind === "auto");
      const toPrune = autoBackups.slice(this.policy.backup_retention_count);
      const pruned: string[] = [];
      for (const entry of toPrune) {
        const fullPath = join(backupRoot, entry.name);
        try {
          await unlink(fullPath);
          pruned.push(fullPath);
        } catch {
          // Continue pruning later entries; one filesystem race must not abort retention cleanup.
        }
      }
      return pruned;
    } catch (error) {
      if (error instanceof BackupInProgressError) return [];
      throw error;
    } finally {
      await releaseLock?.();
    }
  }

  private async stage(
    dataRoot: string,
    staging: string,
  ): Promise<{ included: string[]; excluded: string[]; warnings: string[] }> {
    const included: string[] = [];
    const excluded: string[] = [];
    const warnings: string[] = [];

    const dbDir = join(staging, "db");
    await mkdir(dbDir, { recursive: true });
    const dumpPath = join(dbDir, "rainver.dump");
    try {
      await pgDump(this.config.backupDatabaseUrl!, dumpPath);
      included.push("db/rainver.dump (pg_dump_custom)");
    } catch (error) {
      throw new BackupError(
        `pg_dump failed; backup aborted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const dirname of BACKUP_DATA_DIRS) {
      const source = join(dataRoot, dirname);
      if (!(await pathExists(source))) {
        excluded.push(`${dirname}/ (not found)`);
        continue;
      }
      await cp(source, join(staging, dirname), {
        recursive: true,
        dereference: false,
        force: true,
      });
      await assertSafeBackupTree(join(staging, dirname));
      included.push(`${dirname}/`);
    }

    const logsSource = join(dataRoot, "logs");
    if (this.policy.backup_include_logs && (await pathExists(logsSource))) {
      await cp(logsSource, join(staging, "logs"), { recursive: true, force: true });
      await assertSafeBackupTree(join(staging, "logs"));
      included.push("logs/");
    } else {
      const reason = !(await pathExists(logsSource))
        ? "not found"
        : "excluded by config (backup_include_logs=false)";
      excluded.push(`logs/ (${reason})`);
    }

    for (const [dirname, reason] of Object.entries(ALWAYS_EXCLUDED)) {
      excluded.push(`${dirname}/ (${reason})`);
    }

    return { included, excluded, warnings };
  }

  private async versionMetadata(): Promise<Pick<
    BackupManifest,
    | "app_version"
    | "git_commit"
    | "schema_migration_version"
    | "schema_migration_checksum"
    | "postgres_server_version"
    | "pg_dump_version"
  >> {
    const databaseUrl = this.config.backupDatabaseUrl;
    const [
      git_commit,
      schemaMigration,
      postgres_server_version,
      pg_dump_version,
    ] = await Promise.all([
      gitCommit(),
      schemaMigrationVersion(databaseUrl),
      postgresServerVersion(databaseUrl),
      readPgDumpVersion(),
    ]);
    return {
      app_version: this.config.appVersion,
      git_commit,
      schema_migration_version: schemaMigration?.version ?? null,
      schema_migration_checksum: schemaMigration?.checksum ?? null,
      postgres_server_version,
      pg_dump_version,
    };
  }
}

export async function assertSafeBackupTree(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new BackupError(`backup source contains a symbolic link: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new BackupError(`backup source is not a directory: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new BackupError(`backup source contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      await assertSafeBackupTree(path);
      continue;
    }
    if (!entry.isFile()) {
      throw new BackupError(`backup source contains an unsupported file type: ${path}`);
    }
  }
}

export async function runScheduledBackup(
  config: ServerConfig,
  policy?: InstanceOperationsPolicy,
): Promise<void> {
  const service = new BackupService(config, policy);
  await service.createBackup("auto");
  await service.pruneOldBackups();
}

export function automaticBackupIsDue(
  entries: readonly BackupEntry[],
  intervalHours: number,
  now: Date = new Date(),
): boolean {
  const latestCreatedAt = entries.reduce((latest, entry) => {
    if (entry.kind !== "auto") return latest;
    const createdAt = Date.parse(entry.created_at);
    return Number.isFinite(createdAt) ? Math.max(latest, createdAt) : latest;
  }, Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(latestCreatedAt)) return true;
  return latestCreatedAt + intervalHours * 60 * 60 * 1000 <= now.getTime();
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = `pid=${process.pid} acquired_at=${new Date().toISOString()}\n`;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleLock(lockPath)) continue;
      throw new BackupInProgressError();
    }
  }
  throw new BackupInProgressError();
}

async function removeStaleLock(lockPath: string, now = new Date()): Promise<boolean> {
  let lockStat: Awaited<ReturnType<typeof stat>>;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  let content = "";
  try {
    content = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  const parsed = parseLockContent(content);
  const pidAlive = parsed.pid === null ? null : isProcessAlive(parsed.pid);
  const ageAnchor = parsed.acquiredAt ?? lockStat.mtime;
  const staleByAge = now.getTime() - ageAnchor.getTime() > LOCK_STALE_AFTER_MS;
  const stale = pidAlive === false || (pidAlive === null && staleByAge);
  if (!stale) return false;

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function parseLockContent(content: string): { pid: number | null; acquiredAt: Date | null } {
  const parts = new Map(
    content
      .trim()
      .split(/\s+/)
      .map((part) => {
        const [key, ...valueParts] = part.split("=");
        return [key, valueParts.join("=")] as const;
      }),
  );
  const pidRaw = parts.get("pid");
  const pid = pidRaw && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
  const acquiredRaw = parts.get("acquired_at");
  const acquiredAt = acquiredRaw ? new Date(acquiredRaw) : null;
  return {
    pid: pid && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    acquiredAt: acquiredAt && !Number.isNaN(acquiredAt.getTime()) ? acquiredAt : null,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function pgDump(databaseUrl: string, dest: string): Promise<void> {
  const parsed = new URL(databaseUrl);
  const env = { ...process.env };
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const args = ["--no-password", "-Fc", "--no-owner", "--no-acl"];
  if (parsed.hostname) args.push("--host", parsed.hostname);
  if (parsed.port) args.push("--port", parsed.port);
  if (parsed.username) args.push("--username", decodeURIComponent(parsed.username));
  const dbName = parsed.pathname.replace(/^\//, "");
  args.push("-f", dest, dbName);
  await execFileAsync("pg_dump", args, { env, timeout: 300_000 });
}

async function readPgDumpVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pg_dump", ["--version"], { timeout: 5_000 });
    return stdout.match(/(\d+(?:\.\d+)*)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function gitCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { timeout: 10_000 });
    const commit = stdout.trim();
    return commit || null;
  } catch {
    return null;
  }
}

async function schemaMigrationVersion(
  databaseUrl: string | null,
): Promise<{ version: string; checksum: string } | null> {
  if (!databaseUrl) return null;
  const pool = getDbPool(normalizePostgresConnectionString(databaseUrl));
  try {
    const result = await pool.query<{ version: string; checksum: string }>(
      `SELECT version, checksum
         FROM server_schema_migrations
        ORDER BY version DESC
        LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? { version: row.version, checksum: row.checksum } : null;
  } catch {
    return null;
  }
}

async function postgresServerVersion(databaseUrl: string | null): Promise<string | null> {
  return queryBackupScalar(databaseUrl, "SHOW server_version");
}

async function queryBackupScalar(databaseUrl: string | null, sql: string): Promise<string | null> {
  if (!databaseUrl) return null;
  const pool = getDbPool(normalizePostgresConnectionString(databaseUrl));
  try {
    const result = await pool.query(sql);
    const value = result.rows[0] ? Object.values(result.rows[0])[0] : null;
    return value === null || value === undefined ? null : String(value);
  } catch {
    return null;
  }
}

function normalizePostgresConnectionString(databaseUrl: string): string {
  return databaseUrl.replace(/^postgresql\+psycopg:/, "postgresql:");
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareBackupRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function chmodFile(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}

async function rmDirSafe(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}
