import { existsSync, readFileSync, readdirSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";

// The runtime half of the SQL guard. `staticSqlPrepare.test.ts` covers SQL
// written as a complete literal; this covers SQL assembled at runtime from
// column-list constants, clause helpers, and builder-generated parameter
// numbering — the shapes a static resolver cannot reach. `support/sqlCapture.ts`
// records what the DB-backed suites actually execute; this prepares each one
// against a freshly migrated schema.
//
// Two-step by design, because capture has to happen first:
//   SQL_CAPTURE_DIR=.tmp/sql-capture pnpm exec vitest run          # capture
//   SQL_CAPTURE_DIR=.tmp/sql-capture pnpm exec vitest run test/capturedSqlPrepare.test.ts
// Without a capture directory there is nothing to check and the test no-ops,
// so a normal `vitest run` is unaffected.

const STATEMENT_START = /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

interface CapturedStatement {
  sql: string;
  sources: number;
}

function loadCapturedStatements(): CapturedStatement[] {
  const dir = process.env.SQL_CAPTURE_DIR;
  if (!dir || !existsSync(dir)) return [];
  const byStatement = new Map<string, number>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ndjson")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let sql: unknown;
      try {
        sql = (JSON.parse(line) as { sql?: unknown }).sql;
      } catch {
        continue; // A torn final line from a killed worker is not a finding.
      }
      if (typeof sql !== "string") continue;
      const trimmed = sql.trim().replace(/;$/, "");
      if (!STATEMENT_START.test(trimmed)) continue; // DDL and TRUNCATE are not preparable.
      if (/\bpg_temp\b/i.test(trimmed)) continue; // Session-scoped objects are gone by now.
      // PREPARE takes one statement; a multi-statement string would run its
      // tail for real against the verification database.
      if (/;\s*\S/.test(trimmed)) continue;
      byStatement.set(trimmed, (byStatement.get(trimmed) ?? 0) + 1);
    }
  }
  return [...byStatement].map(([sql, sources]) => ({ sql, sources }));
}


const db = useTestDatabase(__filename, { max: 1 });

beforeAll(async () => {
  if (!db.available) return;
  if (loadCapturedStatements().length === 0) return;
  // Optional plugins own their tables and ship their own migrations, so a
  // core-only schema reports every finance_/diary_ statement as a missing
  // relation. Their SQL is server code too — give it the same check.
  for (const file of globSync(join(process.cwd(), "..", "plugins", "official", "*", "migrations", "*.sql")).sort()) {
    await db.pool.query(readFileSync(file, "utf8"));
  }
});

describe("captured SQL", () => {
  it("parses, resolves, and types every runtime-assembled statement the suites executed", async () => {
    const statements = loadCapturedStatements();
    if (statements.length === 0) {
      console.warn("[captured-sql-prepare] no capture file — run the suites with SQL_CAPTURE_DIR set first");
      return;
    }
    if (!db.available) return;

    const client = await db.pool.connect();
    const failures: string[] = [];
    try {
      let index = 0;
      for (const statement of statements) {
        index += 1;
        try {
          await client.query(`PREPARE captured_sql_${index} AS ${statement.sql}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[captured-sql-prepare] ${message}\n${statement.sql}`);
          failures.push(`${message} :: ${statement.sql.replace(/\s+/g, " ").slice(0, 160)}`);
        }
      }
    } finally {
      client.release();
    }

    console.info(`[captured-sql-prepare] checked ${statements.length} distinct statements`);
    expect(failures).toEqual([]);
  }, 300_000);
});
