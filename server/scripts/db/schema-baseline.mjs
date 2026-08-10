import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const drizzleDir = join(serverRoot, "drizzle");
const migrationDir = join(serverRoot, "migrations");
const baselineMigration = join(migrationDir, "0001_baseline.sql");
const generatedSqlName = "0000_baseline.sql";
const databaseFeatures = JSON.parse(
  readFileSync(join(serverRoot, "src", "db", "schema", "database-features.json"), "utf8"),
);

function generateInto(outDir, { reportOutput = true } = {}) {
  const bin = process.platform === "win32"
    ? join(serverRoot, "node_modules", ".bin", "drizzle-kit.cmd")
    : join(serverRoot, "node_modules", ".bin", "drizzle-kit");
  const result = spawnSync(bin, [
    "generate",
    "--dialect=postgresql",
    "--schema=./src/db/schema/index.ts",
    `--out=${outDir}`,
    "--name=baseline",
  ], {
    cwd: serverRoot,
    encoding: "utf8",
    env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: "0" },
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`drizzle-kit generate failed with exit code ${result.status ?? "unknown"}`);
  }
  if (reportOutput && result.stdout) process.stdout.write(result.stdout);
  if (reportOutput && result.stderr) process.stderr.write(result.stderr);
  addGeneratedDatabaseFeatures(join(outDir, generatedSqlName));
}

function addGeneratedDatabaseFeatures(sqlPath) {
  const extensions = databaseFeatures.extensions;
  if (!Array.isArray(extensions) || extensions.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error("Invalid database extension declaration");
  }
  const generated = readFileSync(sqlPath, "utf8");
  const declarations = extensions
    .map((name) => `CREATE EXTENSION IF NOT EXISTS "${name}";\n--> statement-breakpoint`)
    .join("\n");
  writeFileSync(sqlPath, declarations.length > 0 ? `${declarations}\n${generated}` : generated);
}

function normalizedSnapshot(path) {
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  delete snapshot.id;
  delete snapshot.prevId;
  return JSON.stringify(snapshot);
}

function normalizedSql(path) {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n").trimEnd();
}

function preserveUnchangedMetadata(previousDir, generatedDir) {
  if (!existsSync(previousDir)) return;
  const previousSql = join(previousDir, generatedSqlName);
  const generatedSql = join(generatedDir, generatedSqlName);
  const previousSnapshot = join(previousDir, "meta", "0000_snapshot.json");
  const generatedSnapshot = join(generatedDir, "meta", "0000_snapshot.json");
  if (normalizedSql(previousSql) === normalizedSql(generatedSql)) {
    copyFileSync(previousSnapshot, generatedSnapshot);
    copyFileSync(join(previousDir, "meta", "_journal.json"), join(generatedDir, "meta", "_journal.json"));
  }
}

function assertSingleBaseline(root) {
  const sqlFiles = readdirSync(root).filter((name) => name.endsWith(".sql"));
  if (sqlFiles.length !== 1 || sqlFiles[0] !== generatedSqlName) {
    throw new Error(`server/drizzle must contain only ${generatedSqlName}`);
  }
  const snapshots = readdirSync(join(root, "meta")).filter((name) => name.endsWith("_snapshot.json"));
  if (snapshots.length !== 1 || snapshots[0] !== "0000_snapshot.json") {
    throw new Error("server/drizzle/meta must contain only 0000_snapshot.json");
  }
  const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));
  if (journal.entries?.length !== 1 || journal.entries[0]?.idx !== 0 || journal.entries[0]?.tag !== "0000_baseline") {
    throw new Error("Drizzle journal must contain one 0000_baseline entry");
  }
}

function assertSingleMigration() {
  const files = readdirSync(migrationDir).filter((name) => /^\d+_.+\.sql$/.test(name));
  if (files.length !== 1 || files[0] !== "0001_baseline.sql") {
    throw new Error("server/migrations must contain only 0001_baseline.sql");
  }
}

function generate() {
  const previous = `${drizzleDir}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(drizzleDir)) renameSync(drizzleDir, previous);
  try {
    generateInto(drizzleDir);
    assertSingleBaseline(drizzleDir);
    preserveUnchangedMetadata(previous, drizzleDir);
    copyFileSync(join(drizzleDir, generatedSqlName), baselineMigration);
    assertSingleMigration();
    rmSync(previous, { recursive: true, force: true });
    console.log("schema-baseline: rebuilt drizzle/0000_baseline.sql and migrations/0001_baseline.sql");
  } catch (error) {
    rmSync(drizzleDir, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, drizzleDir);
    throw error;
  }
}

function check() {
  if (!existsSync(drizzleDir) || !existsSync(baselineMigration)) {
    throw new Error("Generated schema baseline is missing; run npm run schema:generate");
  }
  assertSingleBaseline(drizzleDir);
  assertSingleMigration();
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-schema-check-"));
  try {
    generateInto(tempRoot, { reportOutput: false });
    assertSingleBaseline(tempRoot);
    if (
      normalizedSnapshot(join(tempRoot, "meta", "0000_snapshot.json"))
      !== normalizedSnapshot(join(drizzleDir, "meta", "0000_snapshot.json"))
    ) {
      throw new Error("Committed Drizzle snapshot does not match server/src/db/schema");
    }
    const expectedSql = normalizedSql(join(tempRoot, generatedSqlName));
    if (expectedSql !== normalizedSql(join(drizzleDir, generatedSqlName))) {
      throw new Error("Committed Drizzle SQL does not match server/src/db/schema");
    }
    if (expectedSql !== normalizedSql(baselineMigration)) {
      throw new Error("migrations/0001_baseline.sql is not the generated Drizzle baseline");
    }
    console.log("schema-baseline: schema, Drizzle, and migrations/0001_baseline.sql are in sync");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "generate") generate();
else if (mode === "check") check();
else {
  process.stderr.write("usage: node scripts/db/schema-baseline.mjs <generate|check>\n");
  process.exitCode = 2;
}
