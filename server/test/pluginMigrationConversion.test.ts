import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RainverPlugin } from "@rainver/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { preparePluginSquashArchive } from "../src/db/migrationSquash.js";
import { convertBundledPluginMigrationHistory, convertPluginMigrationHistory } from "../src/modules/plugins/migrationConversion.js";
import { migrateOperationPlugin } from "../src/modules/plugins/operationMigrations.js";
import { operationPackageIdentity } from "../src/modules/plugins/packageIdentity.js";
import { mergedPluginMigrationSql, originalPluginMigrations, type PluginMigrationSql } from "../src/modules/plugins/migrationSql.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { buildServerDist } from "./support/briefingWorkerHarness.js";
import { retiredApplicationsRelease } from "./support/retiredApplicationsRelease.js";

const db = useTestDatabase(import.meta.filename);
/**
 * The retired `applications` release (now `phd_application`): its frozen published
 * migration is a nested squash, so it stays the converter's real-world fixture.
 */
const shipped = retiredApplicationsRelease();
const COMBINED_ID = "0000_applications_baseline";
const TARGET_ID = "0000_applications_and_mail_facts";
const shippedSources = originalPluginMigrations(shipped.migrations![0].sql)!;
/**
 * The squashed baseline alone, as the image that introduced it bundled it: an archived squash targets exactly
 * that chain. The shipped package now bundles that baseline and the mail-facts migration together.
 */
const applications: RainverPlugin = {
  ...shipped, migrations: shippedSources.slice(0, 1),
  operationManifest: { ...shipped.operationManifest!, migrations: [COMBINED_ID] },
};
const predecessors = originalPluginMigrations(applications.migrations![0].sql)!;
const apply = { apply: true, offline: true, backupReference: "verified.dump" };
let root: string;
let sourceDir: string;
let targetDir: string;

const withMigrations = (migrations: NonNullable<RainverPlugin["migrations"]>): RainverPlugin => ({
  ...applications,
  migrations,
  operationManifest: { ...applications.operationManifest!, migrations: migrations.map(({ id }) => id) },
});

function prepare() {
  const source = join(root, "original");
  mkdirSync(source);
  for (const { id, sql } of predecessors) writeFileSync(join(source, `${id}.sql`), sql);
  const archive = join(root, "archive");
  preparePluginSquashArchive(source, archive, "0000", "applications_baseline");
  sourceDir = join(archive, "source");
  targetDir = join(archive, "target");
}

const squash = (id: string, migrations: PluginMigrationSql[]) => withMigrations([{ id, sql: mergedPluginMigrationSql(migrations) }]);

async function journal() {
  return (await db.pool.query(`SELECT migration_id, applied_at::text, checksum, status, plugin_version FROM plugin_migrations
    WHERE plugin_id='applications' ORDER BY migration_id`)).rows;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rainver-plugin-squash-")); });

afterEach(async () => {
  rmSync(root, { force: true, recursive: true });
  if (db.available) await db.pool.query(`DROP SCHEMA IF EXISTS plugin_applications CASCADE;
    DELETE FROM official_plugin_events WHERE plugin_id='applications'; DELETE FROM plugin_migrations WHERE plugin_id='applications';
    DELETE FROM plugin_installs WHERE plugin_id='applications';`);
});

it("previews and converts a partially applied Applications chain using the real predecessor time", async () => {
  prepare();
  await migrateOperationPlugin(db.pool, withMigrations(predecessors.slice(0, 5)));
  await db.pool.query(`UPDATE plugin_migrations SET applied_at='2026-01-02T00:00:00Z'
    WHERE plugin_id='applications' AND migration_id='0004_submission_recorded'`);
  await db.pool.query(`INSERT INTO plugin_applications.applications
    (space_id,user_id,project_id,id,track,institution,program,status,revision,created_at,updated_at)
    VALUES ('s','u','p','old','funding','Institute','Program','planning',3,'2026-01-01','2026-01-01'),
           ('s','u','p','new','funding','Institute','Program','planning',3,'2026-01-03','2026-01-03')`);
  const old = await journal();
  await expect(migrateOperationPlugin(db.pool, applications)).rejects.toThrow(/offline squash cutover/);
  await expect(convertPluginMigrationHistory(db.pool, applications, sourceDir, targetDir, { apply: true })).rejects.toThrow(/offline/);
  await expect(convertPluginMigrationHistory(db.pool, withMigrations(predecessors), sourceDir, targetDir)).rejects.toThrow(/bundled plugin/);
  const preview = await convertBundledPluginMigrationHistory(db.pool, applications);
  expect(preview).toMatchObject({ state: "preview", pending: predecessors.slice(5).map(({ id }) => id) });
  expect(await journal()).toEqual(old);
  expect(await convertBundledPluginMigrationHistory(db.pool, applications, apply)).toMatchObject({ state: "converted", pending: preview.pending });
  expect((await db.pool.query(`SELECT id, submission_recorded_at IS NOT NULL AS recorded
    FROM plugin_applications.applications ORDER BY id`)).rows).toEqual([{ id: "new", recorded: false }, { id: "old", recorded: true }]);
  expect((await journal()).map((row) => row.migration_id)).toEqual([COMBINED_ID]);
  const installed = (await db.pool.query(`SELECT manifest_json FROM plugin_installs WHERE plugin_id='applications'`)).rows[0];
  expect(installed.manifest_json.operation_contract).toBe(operationPackageIdentity(applications));
  expect((await db.pool.query(`SELECT metadata_json FROM official_plugin_events WHERE event_type='migration_squashed'`)).rows[0].metadata_json)
    .toMatchObject({ backup_reference: apply.backupReference, source_records: expect.arrayContaining(old) });
  expect(await convertPluginMigrationHistory(db.pool, applications, sourceDir, targetDir, apply)).toMatchObject({ state: "already_target" });
  await expect(migrateOperationPlugin(db.pool, applications)).resolves.toBeUndefined();
});

it("writes one journal row on a fresh install of the shipped Applications chain", async () => {
  prepare();
  await expect(convertPluginMigrationHistory(db.pool, applications, sourceDir, targetDir, apply)).rejects.toThrow(/already be installed/);
  await migrateOperationPlugin(db.pool, shipped);
  expect((await journal()).map((row) => row.migration_id)).toEqual([TARGET_ID]);
  expect((await db.pool.query(`SELECT to_regclass('plugin_applications.application_mail_facts')::text AS ledger`)).rows[0].ledger).toBe('plugin_applications.application_mail_facts');
  expect((await db.pool.query(`SELECT tableowner FROM pg_tables WHERE schemaname='plugin_applications' AND tablename='applications'`)).rows)
    .toEqual([{ tableowner: "rainver_plugin_applications_ddl" }]);
});

it("replaces fully applied history without re-running DDL and preserves its last timestamp", async () => {
  prepare();
  await migrateOperationPlugin(db.pool, withMigrations(predecessors));
  const old = await journal();
  const results = await Promise.all([1, 2].map(() => convertPluginMigrationHistory(db.pool, applications, sourceDir, targetDir, apply)));
  expect(results.map(({ state }) => state).sort()).toEqual(["already_target", "converted"]);
  expect(results.flatMap(({ pending }) => pending)).toEqual([]);
  expect(await journal()).toEqual([expect.objectContaining({ migration_id: COMBINED_ID, applied_at: old.at(-1).applied_at })]);
});

it("discovers older journal records through a second bundled squash", async () => {
  await migrateOperationPlugin(db.pool, withMigrations(predecessors.slice(0, 5)));
  const appended = { id: "0001_cutover_marker", sql: "ALTER TABLE applications ADD COLUMN cutover_marker text" };
  const newest = squash("0000_second_squash", [...applications.migrations!, appended]);
  const pending = [...predecessors.slice(5), appended].map(({ id }) => id);
  expect(await convertBundledPluginMigrationHistory(db.pool, newest)).toMatchObject({ state: "preview", pending });
  await expect(convertBundledPluginMigrationHistory(db.pool, newest, apply)).resolves.toMatchObject({ state: "converted", pending });
  expect((await journal()).map(({ migration_id }) => migration_id)).toEqual(["0000_second_squash"]);
});

it("refuses mismatched history and rolls back earlier catch-up steps when later SQL fails", async () => {
  const target = squash("0000_failed_squash", [...predecessors, { id: "0007_failed_catchup", sql: "CREATE INDEX invalid_idx ON no_such_table (id)" }]);
  await migrateOperationPlugin(db.pool, withMigrations(predecessors.slice(0, 5)));
  const old = await journal();
  await db.pool.query(`UPDATE plugin_migrations SET checksum='mismatch' WHERE migration_id='0000_application_records'`);
  await expect(convertBundledPluginMigrationHistory(db.pool, target, apply)).rejects.toThrow(/exact applied prefix/);
  await db.pool.query(`UPDATE plugin_migrations SET checksum=$1 WHERE migration_id='0000_application_records'`, [old[0].checksum]);
  await expect(convertBundledPluginMigrationHistory(db.pool, target, apply)).rejects.toThrow(/no_such_table/);
  expect(await journal()).toEqual(old);
  expect((await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='plugin_applications'
    AND table_name='application_contacts' AND column_name='project_shared'`)).rows).toEqual([]);
});

it.for([0, 1, 2, 3])("converts Applications development journal variant %i to the baseline", async (count) => {
  const earlierSquash = predecessors.at(-1)!;
  const original = originalPluginMigrations(earlierSquash.sql)!;
  expect(earlierSquash.id).toBe("0006_project_collaboration");
  expect(original.map(({ id }) => id)).toEqual(["0006_project_shared_applications", "0007_project_collaboration"]);
  const installed = count === 3 ? predecessors : [...predecessors.slice(0, -1), ...original.slice(0, count)];
  await migrateOperationPlugin(db.pool, withMigrations(installed));
  await db.pool.query(`INSERT INTO plugin_applications.applications
    (space_id,user_id,project_id,id,track,institution,program,status)
    VALUES ('s','u','p','existing','funding','Institute','Program','planning')`);
  const pending = count === 0 ? [earlierSquash.id] : original.slice(count).map(({ id }) => id);
  await expect(convertBundledPluginMigrationHistory(db.pool, applications, apply)).resolves.toMatchObject({ state: "converted", pending });
  expect((await journal()).map(({ migration_id }) => migration_id)).toEqual([COMBINED_ID]);
  expect((await db.pool.query(`SELECT id, project_shared FROM plugin_applications.applications`)).rows)
    .toEqual([{ id: "existing", project_shared: false }]);
});

it("previews through the shell entrypoint: a renamed package is not a squash conversion in the current image", async () => {
  prepare();
  await buildServerDist();
  await migrateOperationPlugin(db.pool, withMigrations(predecessors));
  const script = fileURLToPath(new URL("../../ops/scripts/db/squash-migrations.sh", import.meta.url));
  const run = promisify(execFile);
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_OFFICIAL_PLUGINS_DIR: fileURLToPath(new URL("../dist/official-plugins/", import.meta.url)),
  };
  // This image bundles only the new package. The retired ID is excluded from bundled conversion.
  await expect(run("bash", [script, "convert", "--host", "--source", sourceDir, "--target", targetDir], { env }))
    .rejects.toThrow(/must match exactly one bundled plugin in the selected image/);
  const helper = fileURLToPath(new URL("../../ops/scripts/db/migration-artifacts.mjs", import.meta.url));
  const automatic = await run(process.execPath, [helper, "preview-plugins", "--home", root], { env });
  expect(automatic.stdout.trim()).toBe("0");
  expect(await journal()).toHaveLength(predecessors.length);
}, 90_000);

it.for(["original", "baseline", "baseline-and-facts"] as const)("converts the %s Applications history to the shipped single migration", async (history) => {
  await migrateOperationPlugin(db.pool, withMigrations(history === "original" ? predecessors : shippedSources.slice(0, history === "baseline" ? 1 : 2)));
  await db.pool.query(`INSERT INTO plugin_applications.applications
    (space_id,user_id,project_id,id,track,institution,program,status,revision,created_at,updated_at)
    VALUES ('s','u','p','untouched','phd','Institute','Program','planning',1,'2026-01-01','2026-01-01'),
           ('s','u','p','moved','phd','Institute','Program','interview',4,'2026-01-01','2026-02-01')`);
  if (history === "baseline-and-facts") {
    await db.pool.query(`UPDATE plugin_applications.applications SET status_changed_at=CASE WHEN id='moved' THEN updated_at ELSE to_timestamp(0) END`);
  }
  expect(shipped.migrations!.map(({ id }) => id)).toEqual([TARGET_ID]);
  const appended = history === "baseline-and-facts" ? [] : ["0001_gmail_mail_facts"];
  expect(await convertBundledPluginMigrationHistory(db.pool, shipped)).toMatchObject({ state: "preview", pending: appended });
  await expect(convertBundledPluginMigrationHistory(db.pool, shipped, apply)).resolves.toMatchObject({ state: "converted", pending: appended });
  expect((await journal()).map(({ migration_id }) => migration_id)).toEqual([TARGET_ID]);
  // A record still at its initial status observed nothing; a changed one keeps its last update as the instant.
  expect((await db.pool.query(`SELECT id, status_changed_at::text AS at FROM plugin_applications.applications ORDER BY id`)).rows)
    .toEqual([{ id: "moved", at: "2026-02-01 00:00:00+00" }, { id: "untouched", at: "1970-01-01 00:00:00+00" }]);
  await expect(migrateOperationPlugin(db.pool, shipped)).resolves.toBeUndefined();
});
