import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { migrate, status, loadMigrations } from "../src/db/migrator.js";
import { withTransaction } from "../src/db/tx.js";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { assertLeastPrivilegeRuntimeRole, reconcileRuntimeRoles, runtimeRoleSuperset } from "../src/db/runtimeRoles.js";
import { migrateUp } from "../src/db/migrateUp.js";

// Real-Postgres tests for the server migration runner. The suite skips when
// that database is unreachable. CI sets REQUIRE_TEST_POSTGRES, which fails
// the run instead of skipping.


const db = useTestDatabase(import.meta.filename, { max: 5, empty: true });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "server-migrations-"));
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (db.available && db.pool) {
    // Reset between tests: drop everything the migrations created.
    await db.pool.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;",
    );
  }
});

function writeMigration(version: string, name: string, sql: string): void {
  writeFileSync(join(dir, `${version}_${name}.sql`), sql, "utf8");
}

describe("server migration runner", () => {
  it("re-protects the journal in the up sequence when runtime roles were reconciled on the empty database first (ADR 0031)", async () => {
    if (!db.available) return;
    const suffix = randomBytes(4).toString("hex"), app = `mo_app_${suffix}`, backup = `mo_backup_${suffix}`;
    const appPassword = randomBytes(18).toString("base64url");
    const real = join(import.meta.dirname, "..", "migrations");
    const runtime = new pg.Pool({ connectionString: (() => { const u = new URL(db.connectionUri); u.username = app; u.password = appPassword; return u.toString(); })() });
    runtime.on("error", () => {});
    try {
      await withTransaction(db.pool, (tx) => reconcileRuntimeRoles(tx, { appRole: app, backupRole: backup, appPassword }));
      // Parent negative control: the runner alone, after reconcile, leaves the journal writable through default privileges.
      expect((await migrate(db.pool, real)).applied.length).toBeGreaterThan(0);
      expect((await runtime.query(`SELECT has_table_privilege(current_user,'public.server_schema_migrations','INSERT') AS can`)).rows[0].can).toBe(true);
      await expect(assertLeastPrivilegeRuntimeRole(runtime)).rejects.toThrow(/INSERT on the migration journal/);
      // The CLI's real `up` sequence re-protects it; the app still writes data tables.
      expect((await migrateUp(db.pool, real, app)).applied).toEqual([]);
      await assertLeastPrivilegeRuntimeRole(runtime);
      const runtimeStatus = await status(runtime, real);
      expect(runtimeStatus.length).toBeGreaterThan(0);
      expect(runtimeStatus.every((entry) => entry.applied)).toBe(true);
      await expect(runtime.query(`INSERT INTO server_schema_migrations (version,name,checksum,applied_at) VALUES ('9999','x','x',now())`)).rejects.toThrow(/permission denied/);
      await runtime.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'After up','team',now(),now())`, [randomUUID()]);
      expect(await runtimeRoleSuperset(db.pool, backup, "backup")).toEqual([]);
    } finally {
      await runtime.end().catch(() => {});
      await db.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;");
      for (const role of [app, backup]) if ((await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length) {
        await db.pool.query(`DROP OWNED BY ${role}`); await db.pool.query(`DROP ROLE ${role}`);
      }
    }
  });

  it("applies pending migrations, records versions, and is idempotent", async () => {
    if (!db.available) return;
    writeMigration("0001", "alpha", "CREATE TABLE alpha (id int PRIMARY KEY);");
    writeMigration("0002", "beta", "CREATE TABLE beta (id int PRIMARY KEY);");

    expect((await status(db.pool, dir)).map((entry) => entry.applied)).toEqual([false, false]);
    expect((await db.pool.query("SELECT to_regclass('public.server_schema_migrations') AS journal")).rows[0].journal).toBeNull();

    const first = await migrate(db.pool, dir);
    expect(first.applied).toEqual(["0001", "0002"]);

    const tables = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('alpha','beta') ORDER BY table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(["alpha", "beta"]);

    const versions = await db.pool.query<{ version: string }>(
      "SELECT version FROM public.server_schema_migrations ORDER BY version",
    );
    expect(versions.rows.map((r) => r.version)).toEqual(["0001", "0002"]);

    // Re-running applies nothing.
    const second = await migrate(db.pool, dir);
    expect(second.applied).toEqual([]);
  });

  it("rolls back a failing migration atomically and records nothing", async () => {
    if (!db.available) return;
    // Second statement divides by zero — the whole migration transaction must roll back.
    writeMigration("0001", "boom", "CREATE TABLE boom_tbl (id int); SELECT 1/0;");

    await expect(migrate(db.pool, dir)).rejects.toThrow();

    const tbl = await db.pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='boom_tbl'",
    );
    expect(tbl.rowCount).toBe(0);

    const rows = await status(db.pool, dir);
    expect(rows).toEqual([{ version: "0001", name: "boom", applied: false, maintenance: false }]);
  });

  it("refuses to silently re-apply an edited (checksum-mismatched) migration", async () => {
    if (!db.available) return;
    writeMigration("0001", "gamma", "CREATE TABLE gamma (id int);");
    await migrate(db.pool, dir);

    // Edit the already-applied migration in place.
    writeMigration("0001", "gamma", "CREATE TABLE gamma (id int, extra text);");
    await expect(migrate(db.pool, dir)).rejects.toThrow(/checksum mismatch/);
  });

  it("serializes concurrent runs via the advisory lock (no double-apply)", async () => {
    if (!db.available) return;
    writeMigration("0001", "concur", "CREATE TABLE concur (id int PRIMARY KEY);");

    const [a, b] = await Promise.all([migrate(db.pool, dir), migrate(db.pool, dir)]);
    const appliedAll = [...a.applied, ...b.applied];
    // Exactly one of the two runs applied 0001; the other saw it done.
    expect(appliedAll).toEqual(["0001"]);

    const versions = await db.pool.query<{ version: string }>(
      "SELECT version FROM public.server_schema_migrations",
    );
    expect(versions.rows).toHaveLength(1);
  });

  it("loadMigrations orders by numeric prefix and ignores non-migration files", () => {
    writeMigration("0002", "b", "SELECT 1;");
    writeMigration("0001", "a", "SELECT 1;");
    writeFileSync(join(dir, "README.md"), "not a migration", "utf8");
    const files = loadMigrations(dir);
    expect(files.map((f) => f.version)).toEqual(["0001", "0002"]);
  });

  it("loadMigrations rejects duplicate version prefixes", () => {
    writeMigration("0002", "alpha", "SELECT 1;");
    writeMigration("0002", "beta", "SELECT 2;");

    expect(() => loadMigrations(dir)).toThrow(/duplicate migration version 0002/);
  });
});

describe("withTransaction", () => {
  it("commits on success and rolls back on error", async () => {
    if (!db.available) return;
    await db.pool.query("CREATE TABLE tx_demo (id int PRIMARY KEY)");

    await withTransaction(db.pool, async (c) => {
      await c.query("INSERT INTO tx_demo (id) VALUES (1)");
    });
    let count = await db.pool.query("SELECT count(*)::int AS n FROM tx_demo");
    expect(count.rows[0].n).toBe(1);

    await expect(
      withTransaction(db.pool, async (c) => {
        await c.query("INSERT INTO tx_demo (id) VALUES (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    count = await db.pool.query("SELECT count(*)::int AS n FROM tx_demo");
    expect(count.rows[0].n).toBe(1); // the rolled-back insert is gone
  });
});
