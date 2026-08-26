import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PluginMigration } from "@agent-space/protocol";
import { DIARY_PLUGIN_ID } from "./manifest.js";

const SQL_FILE_RE = /^(\d{4}_.+)\.sql$/;

export const diaryMigrations = loadDiaryMigrations();

function loadDiaryMigrations(): readonly PluginMigration[] {
  const migrationDir = resolveMigrationDir();
  const sqlFiles = readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const invalid = sqlFiles.filter((file) => !SQL_FILE_RE.test(file));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid SQL file name(s) for plugin ${DIARY_PLUGIN_ID}: ${invalid.join(", ")}`,
    );
  }
  if (sqlFiles.length === 0) {
    throw new Error(`No SQL files found for plugin ${DIARY_PLUGIN_ID} in ${migrationDir}`);
  }

  return sqlFiles.map((file) => ({
    id: file.replace(/\.sql$/, ""),
    sql: readFileSync(join(migrationDir, file), "utf8"),
  }));
}

function resolveMigrationDir(): string {
  const candidates = [
    // Compiled package artifact: <package>/server/schema.js -> <package>/migrations
    resolve(import.meta.dirname, "..", "migrations"),
    // Source package: <package>/server/src/schema.ts -> <package>/migrations
    resolve(import.meta.dirname, "..", "..", "migrations"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Migration directory not found for plugin ${DIARY_PLUGIN_ID}. Checked: ${candidates.join(", ")}`,
  );
}
