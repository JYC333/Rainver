import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
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

export default async function setup(project: GlobalSetupProject): Promise<() => Promise<void>> {
  buildOfficialPlugins();

  let container: StartedPostgreSqlContainer | undefined;
  const reuse = process.env.TESTCONTAINERS_REUSE_ENABLE !== "false";
  const runId = randomBytes(6).toString("hex");
  const templateDatabase = `aspace_test_${runId}_template`;

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
    .withCommand([
      "postgres",
      "-c", "fsync=off",
      "-c", "synchronous_commit=off",
      "-c", "full_page_writes=off",
      "-c", "max_connections=300",
    ]);
  if (reuse) configured = configured.withReuse();

  try {
    container = await configured.start();

    const adminUri = container.getConnectionUri();
    const admin = new Pool({ connectionString: adminUri, max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(templateDatabase)} TEMPLATE template0`);
    } finally {
      await admin.end();
    }

    const templatePool = new Pool({
      connectionString: databaseUri(adminUri, templateDatabase),
      max: 1,
    });
    try {
      await migrate(templatePool, join(serverRoot, "migrations"));
    } finally {
      await templatePool.end();
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
    if (context?.available && context.adminUri && context.templateDatabase) {
      const admin = new Pool({ connectionString: context.adminUri, max: 1 });
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [context.templateDatabase],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(context.templateDatabase)}`);
      } finally {
        await admin.end();
      }
    }
    if (container && !reuse) await container.stop();
  };
}
