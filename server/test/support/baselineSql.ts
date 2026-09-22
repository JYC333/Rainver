import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading the epoch baseline the way assertions want to name things.
 *
 * `server/migrations/0000_baseline.sql` is drizzle-kit output: every
 * identifier is quoted, table names are unqualified, and the column type is
 * `varchar(n)`. The tests that pin schema decisions name objects the way the
 * catalog and `pg_dump` print them, so normalization happens here once rather
 * than in each test file.
 */
const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const BASELINE_FILE = "0000_baseline.sql";

export function rawBaselineSql(): string {
  return readFileSync(join(MIGRATIONS_DIR, BASELINE_FILE), "utf8");
}

export function normalizeBaselineSql(sql: string): string {
  return sql
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\bvarchar\(/g, "character varying(")
    .replace(/\bCREATE TABLE (?!public\.)([a-z_][a-z0-9_]*)/g, "CREATE TABLE public.$1")
    // drizzle-kit writes the enum's column references unqualified; the
    // assertions name it the way the catalog does.
    .replace(/(?<!public\.)\bretrieval_object_type\b/g, "public.retrieval_object_type")
    .replace(/,\s*/g, ", ")
    .replace(/[ \t]+/g, " ");
}

export function baselineSql(): string {
  return normalizeBaselineSql(rawBaselineSql());
}

/** The column/constraint body of one `CREATE TABLE`, already normalized. */
export function tableDefinition(sql: string, table: string): string {
  const match = new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(normalizeBaselineSql(sql));
  return match?.[1] ?? "";
}
