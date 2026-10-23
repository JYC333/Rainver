import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { loadMigrations, migrate } from "../src/db/migrator.js";
import { loadSquashPlan, prepareSquash } from "../src/db/migrationSquash.js";
import { convertMigrationHistory } from "../src/db/migrationConversion.js";
import { selectMigrationArchives } from "../src/db/migrationArtifacts.js";

const db = useTestDatabase(import.meta.filename, { empty: true });
let root: string;
let source: string;
let target: string;
const apply = { apply: true, offline: true, backupReference: "operator-verified-backup.dump" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rainver-migration-conversion-"));
  source = join(root, "source");
  target = join(root, "target");
  mkdirSync(source);
  writeFileSync(join(source, "0000_baseline.sql"), "CREATE TABLE demo (id int PRIMARY KEY, value int NOT NULL);");
  writeFileSync(join(source, "0001_label.sql"), "ALTER TABLE demo ADD COLUMN label text;");
  writeFileSync(join(source, "0002_backfill.sql"), "UPDATE demo SET value=value+1, label='kept';");
  writeFileSync(join(source, "0003_index.sql"), "CREATE INDEX demo_label_idx ON demo(label);");
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  if (db.available) await db.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;");
});

async function seedPrefix(count: number): Promise<void> {
  const prefix = join(root, "prefix");
  mkdirSync(prefix);
  for (const file of loadMigrations(source).slice(0, count)) cpSync(file.path, join(prefix, `${file.version}_${file.name}.sql`));
  await migrate(db.pool, prefix);
  await db.pool.query("INSERT INTO demo (id,value) VALUES (1,10)");
}

async function columns() {
  return (await db.pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='demo' ORDER BY ordinal_position`,
  )).rows;
}

describe("root migration operations entrypoint", () => {
  const script = join(process.cwd(), "..", "ops", "scripts", "db", "squash-migrations.sh");

  it("shows help without a database or initialized environment", () => {
    const result = spawnSync("bash", [script, "--help"], { encoding: "utf8", env: {
      ...process.env, RAINVER_ROOT: join(root, "absent-runtime"),
    } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--host");
    expect(existsSync(join(root, "absent-runtime"))).toBe(false);
  });

  it.for(["dev", "test", "prod"])("routes %s through its existing Compose environment with read-only archives", (mode) => {
    mkdirSync(target);
    const runtimeRoot = join(root, "runtime");
    const modeRoot = join(runtimeRoot, mode);
    mkdirSync(modeRoot, { recursive: true });
    writeFileSync(join(modeRoot, ".env"), "POSTGRES_DB=fixture\n");
    writeFileSync(join(modeRoot, ".server.env"), "SERVER_DATABASE_URL=postgresql://fixture\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Docker is an external boundary: capture its argv in a real child process.
    writeFileSync(join(bin, "docker"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const result = spawnSync("bash", [script, "convert", "--mode", mode, "--source", source, "--target", target], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAINVER_ROOT: runtimeRoot, RAINVER_HOST_MODE_ROOT: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    const args = JSON.parse(result.stdout) as string[];
    expect(args).toContain(`rainver-${mode}`);
    expect(args).toContain(join(modeRoot, ".env"));
    expect(args).toContain("--no-deps");
    expect(args).toContain(`${source}:${source}:ro`);
    expect(args).toContain(`${target}:${target}:ro`);
    expect(args).toContain("/app/ops/scripts/db/migration-squash.mjs");
    expect(args).not.toContain("--apply");
    expect(readFileSync(join(modeRoot, ".server.env"), "utf8")).toBe("SERVER_DATABASE_URL=postgresql://fixture\n");
  });

  it.for([["prepare", "--from", "0001", "--name", "plan"], ["convert", "--host", "--target", "."]])("refuses host-side %s on a Node other than 24", (args) => {
    const bin = join(root, "node-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho 25.2.1\n", { mode: 0o755 });
    const result = spawnSync("bash", [script, ...args, "--source", source], {
      encoding: "utf8", cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAINVER_ROOT: join(root, "absent-runtime") },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires Node 24 (found: 25.2.1)");
    expect(existsSync(join(root, "absent-runtime"))).toBe(false);
  });

  it("refuses an absent mode environment without creating one", () => {
    mkdirSync(target);
    const runtimeRoot = join(root, "absent-runtime");
    const result = spawnSync("bash", [script, "convert", "--mode", "test", "--source", source, "--target", target], {
      encoding: "utf8", env: { ...process.env, RAINVER_ROOT: runtimeRoot, RAINVER_HOST_MODE_ROOT: "" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nothing was created");
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  function cutoverHarness() {
    const archive = join(root, "archive");
    mkdirSync(archive);
    cpSync(source, join(archive, "source"), { recursive: true });
    mkdirSync(join(archive, "target"));
    const runtimeRoot = join(root, "runtime");
    const modeRoot = join(runtimeRoot, "test");
    mkdirSync(modeRoot, { recursive: true });
    writeFileSync(join(modeRoot, ".env"), "POSTGRES_DB=fixture\n");
    writeFileSync(join(modeRoot, ".server.env"), "SERVER_DATABASE_URL=postgresql://fixture\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "commands.jsonl");
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CUTOVER_TEST_LOG, JSON.stringify(args)+'\\n');
const failure = process.env.CUTOVER_TEST_FAILURE;
if ((failure === 'build' && args.includes('build')) ||
    (failure === 'select' && args.includes('select')) ||
    (failure === 'complete' && args.includes('complete')) ||
    (failure === 'verify' && args.includes('--input-type=module')) ||
    (failure === 'backup' && args.includes('pg_dump')) ||
    (failure === 'apply' && args.includes('--apply')) ||
    (failure === 'up' && args.includes('dist/db/migrateCli.js'))) process.exit(9);
if (args.includes('ps')) process.stdout.write(args.includes('restarting') ? process.env.CUTOVER_TEST_RESTARTING : process.env.CUTOVER_TEST_RUNNING);
if (args.includes('select')) {
  const path = require('node:path');
  const ids = process.env.CUTOVER_TEST_CHAIN ? ['a'.repeat(64), 'b'.repeat(64)] : ['a'.repeat(64)];
  for (const id of ids) fs.cpSync(process.env.CUTOVER_TEST_ARCHIVE, path.join(process.env.RAINVER_ROOT, 'test/db/migration-archives', id), { recursive: true, force: true });
  process.stdout.write(ids.join('\\n') + '\\n');
}
if (args.includes('--input-type=module')) process.stdout.write(process.env.CUTOVER_TEST_LATER + '\\n');
if (args.includes('pg_dump')) process.stdout.write('PGDMP-fixture');
if (args.includes('convert')) process.stdout.write(JSON.stringify({state: args.includes('--apply') ? 'converted' : 'preview', pending: []}));
`, { mode: 0o755 });
    const run = (failure: string, options: { running?: string; restarting?: string; later?: number; chain?: boolean } = {}) => {
      rmSync(log, { force: true });
      const result = spawnSync("bash", [script, "cutover", "--mode", "test", ...(failure === "none" ? [] : ["--archive", archive])], {
        encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAINVER_ROOT: runtimeRoot,
          RAINVER_HOST_MODE_ROOT: "", CUTOVER_TEST_LOG: log, CUTOVER_TEST_FAILURE: failure, CUTOVER_TEST_ARCHIVE: archive,
          CUTOVER_TEST_RUNNING: options.running ?? "postgres\nserver\nfrontend\n",
          CUTOVER_TEST_RESTARTING: options.restarting ?? "", CUTOVER_TEST_LATER: String(options.later ?? 0),
          CUTOVER_TEST_CHAIN: options.chain ? "1" : "" },
      });
      const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      return {
        result, commands,
        stopped: commands.find((args) => args.includes("stop")),
        restore: commands.filter((args) => args.includes("start") || (args.includes("up") && args.includes("-d"))),
      };
    };
    return { modeRoot, run };
  }

  it.for(["none", "build", "select", "verify", "backup", "apply", "complete"])("cutover handles %s failure without restarting apps prematurely", (failure) => {
    const { modeRoot, run } = cutoverHarness();
    const { result, commands, stopped, restore } = run(failure);
    if (failure === "none") {
      expect(result.status, result.stderr).toBe(0);
      expect(stopped).toContain("server");
      expect(stopped).not.toContain("postgres");
      expect(commands.some((args) => args.includes("pg_dump"))).toBe(true);
      expect(commands.some((args) => args.includes("--apply") && args.includes("--backup"))).toBe(true);
      expect(commands.some((args) => args.includes("dist/db/migrateCli.js"))).toBe(false);
      expect(restore).toHaveLength(2);
      expect(restore.flat()).not.toContain("sandbox-runner");
      expect(restore.flat()).not.toContain("deployer");
      // The dump is published under its final name only once it is verified.
      const dumps = readdirSync(join(modeRoot, "db", "dumps"));
      expect(dumps).toHaveLength(1);
      expect(dumps[0]).toMatch(/^pre-squash-\d{8}-\d{6}-.+\.dump$/);
      const backup = commands.find((args) => args.includes("--backup"))!;
      expect(backup[backup.indexOf("--backup") + 1]).toBe(join(modeRoot, "db", "dumps", dumps[0]));
    } else {
      expect(result.status).not.toBe(0);
      expect(restore).toEqual([]);
      if (failure === "build" || failure === "verify" || failure === "select") expect(stopped).toBeUndefined();
      else expect(result.stderr).toContain("no automatic recovery");
      if (failure === "backup") expect(readdirSync(join(modeRoot, "db", "dumps"))).toEqual([]);
    }
    expect(existsSync(join(modeRoot, "db", ".migration-artifacts.lock"))).toBe(false);
    expect(existsSync(join(modeRoot, "db", ".migration-cutover.active")))
      .toBe(["backup", "apply", "complete"].includes(failure));
  });

  it("stops restarting apps too, and a retry after a failure restores the apps the first attempt stopped", () => {
    const { modeRoot, run } = cutoverHarness();
    const failed = run("apply", { restarting: "sandbox-runner\n" });
    expect(failed.stopped).toEqual(expect.arrayContaining(["server", "frontend", "sandbox-runner"]));
    expect(readFileSync(join(modeRoot, "db", ".migration-cutover.active", "apps"), "utf8").trim().split("\n").sort())
      .toEqual(["frontend", "sandbox-runner", "server"]);
    // Nothing is running any more; the retry still brings back all three.
    const retry = run("retry", { running: "postgres\n" });
    expect(retry.result.status, retry.result.stderr).toBe(0);
    expect(retry.restore.flat()).toEqual(expect.arrayContaining(["server", "frontend", "sandbox-runner"]));
    expect(existsSync(join(modeRoot, "db", ".migration-cutover.active"))).toBe(false);
  });

  it("applies a selected chain of pairs in order, each completed after its own conversion", () => {
    const { modeRoot, run } = cutoverHarness();
    const { result, commands } = run("none", { chain: true, later: 1 });
    expect(result.status, result.stderr).toBe(0);
    const pair = (id: string) => join(modeRoot, "db", "migration-archives", id.repeat(64));
    const index = (predicate: (args: string[]) => boolean) => commands.findIndex(predicate);
    // Only the first pair can be previewed against the live history.
    const previews = commands.filter((args) => args.includes("convert") && !args.includes("--apply"));
    expect(previews.map((args) => args[args.indexOf("--source") + 1])).toEqual([join(pair("a"), "source")]);
    // The image/checkout check uses the last pair's target.
    expect(commands.find((args) => args.includes("--input-type=module"))).toContain(`${join(pair("b"), "target")}:/squash-target:ro`);
    const applyA = index((args) => args.includes("--apply") && args.includes(join(pair("a"), "source")));
    const completeA = index((args) => args.includes("complete") && args.includes("a".repeat(64)));
    const applyB = index((args) => args.includes("--apply") && args.includes(join(pair("b"), "source")));
    const completeB = index((args) => args.includes("complete") && args.includes("b".repeat(64)));
    expect(applyA).toBeGreaterThan(-1);
    expect([applyA, completeA, applyB, completeB]).toEqual([...[applyA, completeA, applyB, completeB]].sort((x, y) => x - y));
    expect(index((args) => args.includes("dist/db/migrateCli.js"))).toBeGreaterThan(completeB);
  });

  it("converts to the archived target, then applies migrations appended after it before restarting apps", () => {
    const { modeRoot, run } = cutoverHarness();
    const { result, commands } = run("none", { later: 1 });
    expect(result.status, result.stderr).toBe(0);
    const order = (predicate: (args: string[]) => boolean) => commands.findIndex(predicate);
    const up = order((args) => args.includes("dist/db/migrateCli.js") && args.includes("up"));
    expect(up).toBeGreaterThan(order((args) => args.includes("complete")));
    expect(up).toBeLessThan(order((args) => args.includes("start") || (args.includes("up") && args.includes("-d"))));
    const failed = run("up", { later: 1 });
    expect(failed.result.status).not.toBe(0);
    expect(failed.restore).toEqual([]);
    expect(existsSync(join(modeRoot, "db", ".migration-cutover.active"))).toBe(true);
  });
});

describe("migration squash preparation", () => {
  it("preserves the baseline, full SQL/backfills, maintenance and the final Drizzle snapshot", () => {
    const meta = join(source, "meta");
    mkdirSync(meta);
    const files = loadMigrations(source);
    writeFileSync(join(meta, "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries:
      files.map((file, idx) => ({ idx, tag: `${file.version}_${file.name}`, version: "7", when: idx, breakpoints: true })),
    }));
    files.forEach((file, idx) => writeFileSync(join(meta, `${file.version}_snapshot.json`), JSON.stringify({
      id: `snapshot-${idx}`, prevId: `snapshot-${idx - 1}`, tables: { finalSchema: idx },
    })));
    writeFileSync(join(source, "0003_index.sql"), "-- rainver:maintenance\nCREATE INDEX demo_label_idx ON demo(label);");
    prepareSquash(source, target, "0001", "release_plan");
    const plan = loadSquashPlan(source, target);
    expect(plan.target).toHaveLength(2);
    expect(plan.replacement.sql).toMatch(/^-- rainver:maintenance\n/);
    expect(plan.replacement.sql).toContain("UPDATE demo SET value=value+1");
    expect(readFileSync(join(target, "0000_baseline.sql"), "utf8")).toBe(files[0].sql);
    expect(JSON.parse(readFileSync(join(target, "meta", "0001_snapshot.json"), "utf8")))
      .toMatchObject({ id: "snapshot-3", prevId: "snapshot-0", tables: { finalSchema: 3 } });
    expect(JSON.parse(readFileSync(join(target, "meta", "_journal.json"), "utf8")).entries.map((entry: { tag: string }) => entry.tag))
      .toEqual(["0000_baseline", "0001_release_plan"]);
    expect(existsSync(join(source, "0003_index.sql"))).toBe(true);
    expect(() => prepareSquash(source, target, "0001", "again")).toThrow(/already exists/);
  });

  it("refuses to squash the baseline, a single migration, or edit the resulting SQL", () => {
    expect(() => prepareSquash(source, target, "0000", "release")).toThrow(/after the baseline/);
    expect(() => prepareSquash(source, target, "0003", "release")).toThrow(/at least two/);
    prepareSquash(source, target, "0001", "release");
    writeFileSync(join(target, "0001_release.sql"), "SELECT 1;");
    expect(() => loadSquashPlan(source, target)).toThrow(/differs/);
  });

  it("leaves the source intact and no output when Drizzle metadata is broken", () => {
    mkdirSync(join(source, "meta"));
    writeFileSync(join(source, "meta", "_journal.json"), '{"entries":[]}');
    expect(() => prepareSquash(source, target, "0001", "release")).toThrow(/journal/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.preparing`)).toBe(false);
    expect(loadMigrations(source)).toHaveLength(4);
  });

  it("retains all previously released prefix migrations", () => {
    prepareSquash(source, target, "0002", "release");
    const plan = loadSquashPlan(source, target);
    expect(plan.common).toBe(2);
    expect(plan.target[1].checksum).toBe(plan.source[1].checksum);
  });
});

describe("data-preserving migration history conversion (real PostgreSQL)", () => {
  it.for([1, 2, 3, 4])("continues a database with %i original migrations without replaying an applied backfill", async (count, ctx) => {
    if (!db.available) return ctx.skip();
    prepareSquash(source, target, "0001", "release");
    await seedPrefix(count);
    const result = await convertMigrationHistory(db.pool, source, target, apply);
    expect(result.state).toBe("converted");
    expect(result.pending).toHaveLength(4 - count);
    // Existing rows survive. Only a backfill not previously executed may run.
    expect((await db.pool.query("SELECT * FROM demo")).rows).toEqual([
      { id: 1, value: count <= 2 ? 11 : 10, label: count <= 2 ? "kept" : null },
    ]);
    const audit = (await db.pool.query("SELECT * FROM public.server_schema_migration_conversions")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].original_records).toHaveLength(count);
    expect(audit[0].original_records[0]).toHaveProperty("applied_at");
    expect(audit[0].manifest.source).toHaveLength(4);
    expect(audit[0].catchup_versions).toHaveLength(4 - count);
    expect((await db.pool.query("SELECT version,name FROM public.server_schema_migrations ORDER BY version")).rows)
      .toEqual([{ version: "0000", name: "baseline" }, { version: "0001", name: "release" }]);
    expect((await convertMigrationHistory(db.pool, source, target, apply)).state).toBe("already_target");
    expect((await migrate(db.pool, target)).applied).toEqual([]);
    const extended = join(root, "extended");
    cpSync(target, extended, { recursive: true });
    writeFileSync(join(extended, "0002_next.sql"), "ALTER TABLE demo ADD COLUMN next_value int DEFAULT 7;");
    expect((await migrate(db.pool, extended)).applied).toEqual(["0002"]);
    expect((await db.pool.query("SELECT next_value FROM demo")).rows[0].next_value).toBe(7);
    // Past the target by normal `up`: nothing of this pair remains to convert.
    expect(await convertMigrationHistory(db.pool, source, target, apply)).toMatchObject({ state: "beyond_target", pending: [] });
  });

  it("previews without changing data, schema, migration records or audit tables", async (ctx) => {
    if (!db.available) return ctx.skip();
    prepareSquash(source, target, "0001", "release");
    await seedPrefix(1);
    const before = await columns();
    expect(await convertMigrationHistory(db.pool, source, target)).toMatchObject({ state: "preview", pending: ["0001_label", "0002_backfill", "0003_index"] });
    expect(await columns()).toEqual(before);
    expect((await db.pool.query("SELECT * FROM demo")).rows).toEqual([{ id: 1, value: 10 }]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM public.server_schema_migrations")).rows[0].n).toBe(1);
    expect((await db.pool.query("SELECT to_regclass('public.server_schema_migration_conversions') AS audit")).rows[0].audit).toBeNull();
    await expect(convertMigrationHistory(db.pool, source, target, { apply: true })).rejects.toThrow(/offline/);
  });

  it("rolls back all catch-up SQL and retains the old history if any step fails", async (ctx) => {
    if (!db.available) return ctx.skip();
    writeFileSync(join(source, "0002_backfill.sql"), "UPDATE demo SET value=value+1; SELECT 1/0;");
    prepareSquash(source, target, "0001", "release");
    await seedPrefix(1);
    const before = await columns();
    await expect(convertMigrationHistory(db.pool, source, target, apply)).rejects.toThrow(/division by zero/);
    expect(await columns()).toEqual(before);
    expect((await db.pool.query("SELECT * FROM demo")).rows).toEqual([{ id: 1, value: 10 }]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM public.server_schema_migrations")).rows[0].n).toBe(1);
  });

  it.for(["checksum", "gap", "unknown"])("rejects %s history before applying anything", async (kind, ctx) => {
    if (!db.available) return ctx.skip();
    prepareSquash(source, target, "0001", "release");
    await seedPrefix(2);
    if (kind === "checksum") await db.pool.query("UPDATE public.server_schema_migrations SET checksum='changed' WHERE version='0001'");
    if (kind === "gap") await db.pool.query("DELETE FROM public.server_schema_migrations WHERE version='0000'");
    if (kind === "unknown") await db.pool.query("INSERT INTO public.server_schema_migrations(version,name,checksum) VALUES ('0099','foreign','unknown')");
    await expect(convertMigrationHistory(db.pool, source, target, apply)).rejects.toThrow(/exact prefix/);
    expect((await db.pool.query("SELECT * FROM demo")).rows).toEqual([{ id: 1, value: 10, label: null }]);
  });

  it("serializes two conversions and records the operation only once", async (ctx) => {
    if (!db.available) return ctx.skip();
    prepareSquash(source, target, "0001", "release");
    await seedPrefix(2);
    const results = await Promise.all([
      convertMigrationHistory(db.pool, source, target, apply),
      convertMigrationHistory(db.pool, source, target, apply),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual(["already_target", "converted"]);
    expect((await db.pool.query("SELECT value FROM demo")).rows[0].value).toBe(11);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM public.server_schema_migration_conversions")).rows[0].n).toBe(1);
  });

  it("converts an instance left on the first plan's source through two consecutive squashes", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Plan one squashes 0001..0003; development continues on its target and
    // plan two squashes that formal migration again with two more files.
    const catalog = join(root, "catalog");
    const first = join(catalog, "first");
    const second = join(catalog, "second");
    cpSync(source, join(first, "source"), { recursive: true });
    prepareSquash(join(first, "source"), join(first, "target"), "0001", "release");
    cpSync(join(first, "target"), join(second, "source"), { recursive: true });
    writeFileSync(join(second, "source", "0002_note.sql"), "ALTER TABLE demo ADD COLUMN note text DEFAULT 'n';");
    writeFileSync(join(second, "source", "0003_double.sql"), "UPDATE demo SET value=value*2;");
    prepareSquash(join(second, "source"), join(second, "target"), "0001", "again");
    const checkout = join(second, "target");
    await seedPrefix(2);
    const applied = (await db.pool.query("SELECT version, name, checksum FROM public.server_schema_migrations ORDER BY version")).rows;
    const store = join(root, "store");
    const ids = await selectMigrationArchives(store, checkout, [catalog], applied);
    expect(ids).toEqual([loadSquashPlan(join(first, "source"), join(first, "target")).id, loadSquashPlan(join(second, "source"), checkout).id]);
    for (const id of ids) {
      expect((await convertMigrationHistory(db.pool, join(store, id, "source"), join(store, id, "target"), apply)).state).toBe("converted");
    }
    expect((await migrate(db.pool, checkout)).applied).toEqual([]);
    expect((await db.pool.query("SELECT version, name FROM public.server_schema_migrations ORDER BY version")).rows)
      .toEqual([{ version: "0000", name: "baseline" }, { version: "0001", name: "again" }]);
    // Every pending backfill ran exactly once, in order.
    expect((await db.pool.query("SELECT * FROM demo")).rows).toEqual([{ id: 1, value: 22, label: "kept", note: "n" }]);
    // Retrying after both conversions committed only repeats the last, as a no-op.
    const retry = (await db.pool.query("SELECT version, name, checksum FROM public.server_schema_migrations ORDER BY version")).rows;
    expect(await selectMigrationArchives(store, checkout, [catalog], retry)).toEqual([ids[1]]);
  });

  it("produces the same table structure for a converted database and a fresh merged-chain database", async (ctx) => {
    if (!db.available) return ctx.skip();
    prepareSquash(source, target, "0001", "release");
    await seedPrefix(2);
    await convertMigrationHistory(db.pool, source, target, apply);
    const converted = await columns();
    // Only this test file's disposable empty-database fixture is recreated.
    await db.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db.pool, target);
    expect(await columns()).toEqual(converted);
    expect((await db.pool.query("SELECT indexname FROM pg_indexes WHERE tablename='demo' AND indexname='demo_label_idx'")).rowCount).toBe(1);
  });
});
