/**
 * server migration runner.
 *
 * Runtime PostgreSQL schema evolution is applied through explicit ops
 * commands. `server/migrations/0001_baseline.sql` is the current consolidated
 * generated baseline for empty database bootstrap; applied schema versions are
 * immutable for any database that has recorded them.
 *
 * During the consolidated-baseline phase, `pnpm run schema:generate`
 * (drizzle-kit diffing `server/src/db/schema/` against `server/drizzle/meta/`)
 * merges generated SQL into `0001_baseline.sql` instead of creating a new
 * migration file. This runner doesn't care which produced a file; it only reads
 * ordered `.sql` files from disk.
 *
 * Design:
 * - Migrations are ordered `.sql` files named `NNNN_name.sql` under a directory;
 *   lexicographic filename order is apply order.
 * - Applied migrations are tracked in `public.server_schema_migrations`
 *   with a content checksum, so re-applying is a no-op and editing an
 *   already-applied migration fails loudly rather than silently diverging.
 * - The whole run holds one session-level **advisory lock**, so two server
 *   instances starting at once cannot apply the same migration twice.
 * - Each migration runs in its own transaction. After a migration's SQL we
 *   `RESET search_path` and reference the tracking table fully-qualified, so a
 *   migration that changes `search_path` (e.g. a `pg_dump` baseline does
 *   `set_config('search_path','')`) cannot break version recording.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

/** Arbitrary, stable 64-bit key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 7263123498012n;

const MIGRATIONS_TABLE = "public.server_schema_migrations";

export interface MigrationFile {
  /** Numeric-ish prefix used for ordering + identity, e.g. `0001`. */
  version: string;
  /** Human label after the first underscore, e.g. `baseline`. */
  name: string;
  path: string;
  sql: string;
  /** SHA-256 of the file contents; detects post-apply edits. */
  checksum: string;
}

export interface MigrateResult {
  /** Versions applied by this call (empty if already up to date). */
  applied: string[];
  /** Every known migration version, in order. */
  all: string[];
}

export interface MigrationStatus {
  version: string;
  name: string;
  applied: boolean;
}

const MIGRATION_FILE_RE = /^(\d+)_(.+)\.sql$/;

/** Load + checksum the ordered migration files in `dir`. */
export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();
  const seenVersions = new Map<string, string>();
  return files.map((file) => {
    const match = MIGRATION_FILE_RE.exec(file)!;
    const version = match[1];
    const previous = seenVersions.get(version);
    if (previous) {
      throw new Error(
        `duplicate migration version ${version}: ${previous} and ${file}. ` +
          "Migration version prefixes must be unique.",
      );
    }
    seenVersions.set(version, file);
    const path = join(dir, file);
    const sql = readFileSync(path, "utf8");
    return {
      version,
      name: match[2],
      path,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query("RESET search_path");
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       version    text PRIMARY KEY,
       name       text NOT NULL,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedMap(
  client: PoolClient,
): Promise<Map<string, { name: string; checksum: string }>> {
  const res = await client.query<{ version: string; name: string; checksum: string }>(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE}`,
  );
  const out = new Map<string, { name: string; checksum: string }>();
  for (const row of res.rows) out.set(row.version, { name: row.name, checksum: row.checksum });
  return out;
}

/**
 * Apply all pending migrations in `dir`. Idempotent. Throws if an
 * already-applied migration's content changed (checksum mismatch).
 */
export async function migrate(
  pool: Pool,
  dir: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const files = loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
    await ensureMigrationsTable(client);
    const done = await appliedMap(client);

    for (const file of files) {
      const prev = done.get(file.version);
      if (prev) {
        if (prev.checksum !== file.checksum) {
          throw new Error(
            `migration ${file.version}_${file.name} was already applied with different ` +
              `content (checksum mismatch). Migrations are immutable once applied; ` +
              `add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      log(`applying migration ${file.version}_${file.name}`);
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        // A migration may have changed search_path (pg_dump baselines do); reset
        // before touching the fully-qualified tracking table.
        await client.query("RESET search_path");
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
          [file.version, file.name, file.checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
      applied.push(file.version);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()])
      .catch(() => {});
    client.release();
  }

  return { applied, all: files.map((f) => f.version) };
}

/** Report which migrations are applied vs pending, in order. */
export async function status(pool: Pool, dir: string): Promise<MigrationStatus[]> {
  const files = loadMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const done = await appliedMap(client);
    return files.map((f) => ({
      version: f.version,
      name: f.name,
      applied: done.has(f.version),
    }));
  } finally {
    client.release();
  }
}
