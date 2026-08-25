import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";

// Every static SQL string in server/src is PREPAREd against a migrated
// database. PREPARE parses, resolves names, and deduces parameter types
// without executing, so this catches the failures that otherwise only surface
// when a rarely-taken branch runs in production: columns dropped or renamed by
// a schema change, ambiguous references after a new JOIN, and a parameter used
// in two places whose types disagree (`$n` bound to a varchar column in one
// place and compared as text in another).
//
// Only self-contained literals are checked. Interpolated SQL is skipped, so is
// anything without a bound parameter (this codebase builds its composable
// fragments that way), and so are literals whose parameters are not a
// contiguous $1..$n — a fragment stitched into a larger statement elsewhere
// cannot be typed in isolation.

const SRC_DIR = join(process.cwd(), "src");
const STATEMENT_START = /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

interface StaticStatement {
  file: string;
  line: number;
  sql: string;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Template literal bodies, with comments and ordinary string literals skipped —
 * prose in a doc comment routinely quotes `SELECT ... FOR UPDATE` in backticks,
 * and a regex-based sweep would try to prepare it.
 */
function templateLiterals(source: string): Array<{ body: string; start: number }> {
  const found: Array<{ body: string; start: number }> = [];
  const stack: Array<{ template: boolean; start: number; braces: number }> = [
    { template: false, start: 0, braces: 0 },
  ];
  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1]!;
    const char = source[i];
    const next = source[i + 1];
    if (top.template) {
      if (char === "\\") i += 2;
      else if (char === "`") {
        stack.pop();
        found.push({ body: source.slice(top.start + 1, i), start: top.start });
        i += 1;
      } else if (char === "$" && next === "{") {
        stack.push({ template: false, start: i, braces: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"') {
      i += 1;
      while (i < source.length && source[i] !== char) i += source[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (char === "`") {
      stack.push({ template: true, start: i, braces: 0 });
      i += 1;
    } else if (char === "{") {
      top.braces += 1;
      i += 1;
    } else if (char === "}") {
      if (top.braces === 0 && stack.length > 1) stack.pop();
      else top.braces -= 1;
      i += 1;
    } else i += 1;
  }
  return found;
}

function hasContiguousParameters(sql: string): boolean {
  const numbers = new Set<number>();
  for (const match of sql.matchAll(/\$(\d+)/g)) numbers.add(Number(match[1]));
  if (!numbers.has(1)) return false;
  for (let i = 1; i <= Math.max(...numbers); i += 1) if (!numbers.has(i)) return false;
  return true;
}

function collectStaticStatements(): StaticStatement[] {
  const statements: StaticStatement[] = [];
  for (const file of tsFiles(SRC_DIR)) {
    const contents = readFileSync(file, "utf8");
    for (const literal of templateLiterals(contents)) {
      if (literal.body.includes("${")) continue;
      const sql = literal.body.trim().replace(/;$/, "");
      if (!STATEMENT_START.test(sql)) continue;
      if (!hasContiguousParameters(sql)) continue;
      statements.push({
        file: relative(process.cwd(), file),
        line: contents.slice(0, literal.start).split("\n").length,
        sql,
      });
    }
  }
  return statements;
}


const db = useTestDatabase(__filename, { max: 1 });

describe("static SQL", () => {
  it("parses, resolves, and types every statement against the migrated schema", async () => {
    if (!db.available) return;
    const statements = collectStaticStatements();
    expect(statements.length).toBeGreaterThan(500);

    const client = await db.pool.connect();
    const failures: string[] = [];
    try {
      let index = 0;
      for (const statement of statements) {
        index += 1;
        try {
          await client.query(`PREPARE static_sql_${index} AS ${statement.sql}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[static-sql-prepare] ${statement.file}:${statement.line}\n${statement.sql}`);
          failures.push(`${statement.file}:${statement.line} — ${message}`);
        }
      }
    } finally {
      client.release();
    }

    expect(failures).toEqual([]);
  }, 120_000);
});
