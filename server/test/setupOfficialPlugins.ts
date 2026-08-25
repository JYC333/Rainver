import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import { loadMigrations, migrate } from "../src/db/migrator";
import type { SharedPostgresContext } from "./support/sharedPostgres";

interface GlobalSetupProject {
  provide(key: "sharedPostgres", value: SharedPostgresContext): void;
  getProvidedContext(): { sharedPostgres?: SharedPostgresContext };
}

const serverRoot = join(__dirname, "..");

function buildOfficialPlugins(): void {
  const repoRoot = join(serverRoot, "..");
  const officialPluginsRoot = join(repoRoot, "plugins", "official");
  const pluginIds = existsSync(officialPluginsRoot)
    ? readdirSync(officialPluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((id) => existsSync(join(officialPluginsRoot, id, "plugin.json")))
    : [];

  const missingRuntime = pluginIds.some((id) =>
    !existsSync(join(serverRoot, "dist", "official-plugins", id, "server", "index.js")),
  );
  if (!missingRuntime) return;

  execFileSync(process.execPath, ["scripts/build-official-plugins.mjs"], {
    cwd: serverRoot,
    stdio: "inherit",
  });
}

function databaseUri(adminUri: string, database: string): string {
  const uri = new URL(adminUri);
  uri.pathname = `/${database}`;
  return uri.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** How old a leftover run's databases must be before setup reclaims them. */
const STALE_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const TEMPLATE_PREFIX = "aspace_test_tpl_";

/** Serializes template creation between Vitest runs sharing one container. */
const TEMPLATE_LOCK_KEY = 7263123498013;

function migrationsFingerprint(dir: string): string {
  const hash = createHash("sha256");
  for (const file of loadMigrations(dir)) hash.update(`${file.version}:${file.checksum}\n`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Creates and migrates the template unless a run before us already did. The
 * advisory lock covers the whole check-create-migrate so a concurrent run
 * never clones a template that is still being migrated.
 */
async function ensureTemplateDatabase(
  admin: Pool,
  adminUri: string,
  templateDatabase: string,
  migrationsDir: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    try {
      const existing = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [templateDatabase],
      );
      if (existing.rowCount) return;
      await client.query(`CREATE DATABASE ${quoteIdentifier(templateDatabase)} TEMPLATE template0`);
      const templatePool = new Pool({ connectionString: databaseUri(adminUri, templateDatabase), max: 1 });
      try {
        await migrate(templatePool, migrationsDir);
      } catch (error) {
        await templatePool.end();
        // Never leave a half-migrated template for the next run to clone.
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(templateDatabase)}`);
        throw error;
      }
      await templatePool.end();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function dropTestDatabases(admin: Pool, pattern: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [pattern],
  );
  for (const { datname } of rows) {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [datname],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)}`);
  }
}

/**
 * A reused container accumulates databases from runs that were killed before
 * teardown (Ctrl-C, IDE restarts), and every one of them slows the next
 * `CREATE DATABASE ... TEMPLATE`. Reclaim runs older than the age cutoff;
 * anything younger may still be a concurrent Vitest run sharing the container.
 */
async function dropStaleTestDatabases(admin: Pool, currentTemplate: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE 'aspace_test_%'`,
  );
  const staleRuns = new Set<string>();
  for (const { datname } of rows) {
    if (datname.startsWith(TEMPLATE_PREFIX)) {
      // Templates outlive runs on purpose; only one for another baseline is stale.
      if (datname !== currentTemplate) staleRuns.add(datname);
      continue;
    }
    const match = /^aspace_test_([0-9a-z]+)x([0-9a-f]+)_/.exec(datname);
    // Databases from before run ids carried a timestamp have no age; they can
    // only come from finished runs, so reclaim them too.
    const startedAt = match ? parseInt(match[1], 36) : 0;
    if (Date.now() - startedAt > STALE_RUN_MAX_AGE_MS) {
      staleRuns.add(match ? `aspace_test_${match[1]}x${match[2]}_%` : datname);
    }
  }
  for (const pattern of staleRuns) await dropTestDatabases(admin, pattern);
}

/**
 * Docker's published-port path goes through the userland `docker-proxy`,
 * which copies every byte of every statement through an extra process. With
 * a dozen workers hammering one instance that proxy was the busiest thing on
 * the machine: a round trip direct to the container IP measured 3.4x the
 * throughput of the mapped port. Where the container's bridge address is
 * reachable from the host (native Linux engines, WSL2), talk to it directly;
 * where it is not (Docker Desktop on macOS/Windows), keep the mapped port.
 */
async function directConnectionUri(container: StartedPostgreSqlContainer): Promise<string> {
  const mapped = container.getConnectionUri();
  const [network] = container.getNetworkNames();
  if (!network) return mapped;
  let ip: string;
  try {
    ip = container.getIpAddress(network);
  } catch {
    return mapped;
  }
  if (!ip || !(await tcpReachable(ip, 5432))) return mapped;
  const uri = new URL(mapped);
  uri.hostname = ip;
  uri.port = "5432";
  return uri.toString();
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export default async function setup(project: GlobalSetupProject): Promise<() => Promise<void>> {
  buildOfficialPlugins();

  let container: StartedPostgreSqlContainer | undefined;
  const reuse = process.env.TESTCONTAINERS_REUSE_ENABLE !== "false";
  // Timestamp-prefixed so leftovers from a killed run can be aged out below.
  const runId = `${Date.now().toString(36)}x${randomBytes(4).toString("hex")}`;
  // Named by the migrations' content so a reused container can keep serving
  // the same template across runs, and a baseline change gets a fresh one.
  const migrationsDir = join(serverRoot, "migrations");
  const templateDatabase = `${TEMPLATE_PREFIX}${migrationsFingerprint(migrationsDir)}`;

  try {
    await getContainerRuntimeClient();
  } catch (error) {
    if (process.env.REQUIRE_TEST_POSTGRES === "true") throw error;
    project.provide("sharedPostgres", {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return async () => undefined;
  }

  let configured = new PostgreSqlContainer("pgvector/pgvector:pg18")
    // PostgreSQL 18 stores clusters below a versioned directory here. Mounting
    // the old /var/lib/postgresql/data path makes the pg18 image fail fast.
    .withTmpFs({ "/var/lib/postgresql": "rw" })
    // Throughput settings for a throwaway instance serving a dozen workers:
    // durability off (tmpfs anyway), no autovacuum churn behind per-test
    // DELETEs, no WAL beyond crash recovery, no JIT on thousands of tiny
    // statements, and a checkpoint horizon the whole run fits under.
    .withCommand([
      "postgres",
      "-c", "fsync=off",
      "-c", "synchronous_commit=off",
      "-c", "full_page_writes=off",
      "-c", "max_connections=300",
      "-c", "shared_buffers=512MB",
      "-c", "work_mem=16MB",
      "-c", "autovacuum=off",
      "-c", "jit=off",
      "-c", "wal_level=minimal",
      "-c", "max_wal_senders=0",
      "-c", "max_wal_size=4GB",
      "-c", "checkpoint_timeout=1h",
    ]);
  if (reuse) configured = configured.withReuse();

  try {
    container = await configured.start();

    const adminUri = await directConnectionUri(container);
    const admin = new Pool({ connectionString: adminUri, max: 1 });
    try {
      if (reuse) await dropStaleTestDatabases(admin, templateDatabase);
      await ensureTemplateDatabase(admin, adminUri, templateDatabase, migrationsDir);
    } finally {
      await admin.end();
    }

    const context: SharedPostgresContext = {
      available: true,
      adminUri,
      templateDatabase,
      runId,
    };
    project.provide("sharedPostgres", context);
  } catch (error) {
    if (container && !reuse) await container.stop();
    container = undefined;
    throw error;
  }

  return async () => {
    const context = project.getProvidedContext().sharedPostgres;
    if (context?.available && context.adminUri && context.runId) {
      const admin = new Pool({ connectionString: context.adminUri, max: 1 });
      try {
        // Any per-file database whose afterAll never ran. The template stays
        // for the next run on a reused container.
        await dropTestDatabases(admin, `aspace_test_${context.runId}_%`);
        if (!reuse) await dropTestDatabases(admin, context.templateDatabase ?? "");
      } finally {
        await admin.end();
      }
    }
    if (container && !reuse) await container.stop();
  };
}
