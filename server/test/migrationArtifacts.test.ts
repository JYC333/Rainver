import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSquash } from "../src/db/migrationSquash.js";
import { loadMigrations } from "../src/db/migrator.js";
import { completeMigrationArchive, prepareManagedMigrationArchive, pruneMigrationArtifacts, selectMigrationArchives } from "../src/db/migrationArtifacts.js";
import { BackupService } from "../src/modules/backups/service.js";
import { loadConfig } from "../src/config.js";

let root: string;
let home: string;
let archive: string;
let store: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-migration-artifacts-"));
  home = join(root, "test");
  archive = join(root, "catalog", "plan");
  store = join(home, "db", "migration-archives");
  await mkdir(join(archive, "source"), { recursive: true });
  for (const [i, sql] of ["SELECT 0;", "SELECT 1;", "SELECT 2;"].entries()) {
    await writeFile(join(archive, "source", `${String(i).padStart(4, "0")}_step.sql`), sql);
  }
  prepareSquash(join(archive, "source"), join(archive, "target"), "0001", "plan");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function history(dir: string, count?: number) {
  return loadMigrations(dir).slice(0, count).map(({ version, name, checksum }) => ({ version, name, checksum }));
}
/** The single pair for an instance still on the archived source. */
async function select(applied = history(join(archive, "source"))) {
  const ids = await selectMigrationArchives(store, join(archive, "target"), [join(root, "catalog")], applied);
  expect(ids).toHaveLength(1);
  return ids[0];
}
async function dump(name: string, time = 1) {
  const path = join(home, "db", "dumps", name);
  await mkdir(join(home, "db", "dumps"), { recursive: true });
  await writeFile(path, "PGDMPfixture");
  await utimes(path, time, time);
  return path;
}
async function backup(name: string) {
  await mkdir(join(home, "backups"), { recursive: true });
  await writeFile(join(home, "backups", name), "fixture");
}

describe("managed migration archives and safety dump retention", () => {
  it("prepares a frozen source/target pair without an operator-selected output", async () => {
    const path = await prepareManagedMigrationArchive(home, join(archive, "source"), "0001", "plan");
    const id = await select();
    expect(path).toBe(join(store, id));
    expect(JSON.parse(await readFile(join(path, "state.json"), "utf8")).completedAt).toBeNull();
    expect(await readFile(join(path, "source", "0002_step.sql"), "utf8")).toBe("SELECT 2;");
  });

  it("deduplicates identical archives and preserves originals outside the instance", async () => {
    await writeFile(join(root, "catalog", "README.txt"), "Operator-owned catalog note");
    await cp(archive, join(root, "catalog", "duplicate"), { recursive: true });
    const id = await select();
    expect(await select()).toBe(id);
    await completeMigrationArchive(home, id);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([join(store, id)]);
    expect(await readFile(join(archive, "source", "0002_step.sql"), "utf8")).toBe("SELECT 2;");
  });

  it("keeps an idle configured instance's upgrade path when the source instance expires its pair", async () => {
    const peer = join(root, "dev");
    await mkdir(peer);
    await writeFile(join(peer, ".env"), "");
    const archivePath = await prepareManagedMigrationArchive(home, join(archive, "source"), "0001", "plan");
    const id = archivePath.split("/").at(-1)!;
    await completeMigrationArchive(home, id);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([archivePath]);
    expect(await pruneMigrationArtifacts(peer, join(peer, "backups"), 1)).toEqual([]);
    expect(await readFile(join(peer, "db", "migration-archives", id, "source", "0002_step.sql"), "utf8")).toBe("SELECT 2;");
  });

  it("rejects an absent match and distinct original histories for the same merged SQL", async () => {
    await expect(selectMigrationArchives(store, join(archive, "source"), [join(root, "catalog")], history(join(archive, "source"))))
      .rejects.toThrow(/No archive matches/);
    const duplicate = join(root, "catalog", "other");
    await cp(archive, duplicate, { recursive: true });
    // Names affect migration identity without changing the merged SQL.
    const { rename } = await import("node:fs/promises");
    await rename(join(duplicate, "source", "0002_step.sql"), join(duplicate, "source", "0002_other.sql"));
    // The applied history tells them apart once it reaches the renamed file;
    // a history that both sources accept stays ambiguous.
    const original = await select();
    expect(await select(history(join(duplicate, "source")))).not.toBe(original);
    await expect(select(history(join(archive, "source"), 2))).rejects.toThrow(/Ambiguous/);
    expect(await selectMigrationArchives(store, join(archive, "target"), [], history(join(archive, "source"), 2), archive))
      .toEqual([original]);
  });

  it("keeps only the configured newest generated dumps, leaving manual dumps alone", async () => {
    const old = await dump("pre-migrate-old.dump", 1);
    const newest = await dump("pre-squash-new.dump", 2);
    const manual = await dump("dump-manual.dump", 0);
    const config = loadConfig({ RAINVER_HOME: home, BACKUP_ENABLED: "false", BACKUP_RETENTION_COUNT: "1", BETTER_AUTH_SECRET: "test-secret" });
    expect(await new BackupService(config).pruneMigrationArtifacts()).toEqual([old]);
    expect(await readFile(newest, "utf8")).toContain("PGDMP");
    expect(await readFile(manual, "utf8")).toContain("PGDMP");
  });

  it("keeps old chains until both their dump and full-system backup dependencies expire", async () => {
    const id = await select();
    const old = await dump("pre-squash-old.dump", 1);
    await backup("auto-before.tar.gz");
    await backup("manual-before.tar.gz");
    await completeMigrationArchive(home, id);
    await dump("pre-migrate-new.dump", 2);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([old]);
    await rm(join(home, "backups", "auto-before.tar.gz"));
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([]);
    await rm(join(home, "backups", "manual-before.tar.gz"));
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([join(store, id)]);
  });

  it("pins prepared and failed conversions and skips a concurrent cutover", async () => {
    const id = await select();
    const old = await dump("pre-migrate-old.dump", 1);
    await dump("pre-migrate-new.dump", 2);
    const active = join(home, "db", ".migration-cutover.active");
    await mkdir(active);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([]);
    await rm(active, { recursive: true });
    const lock = join(home, "db", ".migration-artifacts.lock");
    await mkdir(lock);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([]);
    await rm(lock, { recursive: true });
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([old]);
    expect(JSON.parse(await readFile(join(store, id, "state.json"), "utf8")).completedAt).toBeNull();
  });

  it("fails closed on modified archives before pruning dumps", async () => {
    const id = await select();
    const old = await dump("pre-migrate-old.dump", 1);
    await dump("pre-migrate-new.dump", 2);
    await writeFile(join(store, id, "target", "0001_plan.sql"), "SELECT 9;");
    await expect(pruneMigrationArtifacts(home, join(home, "backups"), 1)).rejects.toThrow();
    expect(await readFile(old, "utf8")).toContain("PGDMP");
  });

  it("does not follow symlinks or delete hardlinked dumps", async () => {
    const old = await dump("pre-migrate-old.dump", 1);
    await dump("pre-migrate-new.dump", 2);
    await link(old, join(root, "keep.dump"));
    await symlink(old, join(home, "db", "dumps", "pre-squash-link.dump"));
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([]);
    await symlink(join(archive, "source"), join(archive, "linked"));
    await expect(select()).rejects.toThrow(/Unsafe/);
  });

  it("selects a pair whose target is a prefix of a checkout with later migrations", async () => {
    const checkout = join(root, "checkout");
    await cp(join(archive, "target"), checkout, { recursive: true });
    await writeFile(join(checkout, "0002_later.sql"), "SELECT 3;");
    const [id] = await selectMigrationArchives(store, checkout, [join(root, "catalog")], history(join(archive, "source")));
    expect(id).toBe(await select());
    // A checkout that diverges from every target still matches nothing.
    await writeFile(join(checkout, "0001_plan.sql"), "SELECT 9;");
    await expect(selectMigrationArchives(store, checkout, [join(root, "catalog")], history(join(archive, "source"))))
      .rejects.toThrow(/No archive matches/);
  });

  it("chooses pairs after two squashes by the database's applied history, not only the checkout", async () => {
    const catalog = [join(root, "catalog")];
    const first = await select();
    const firstSource = join(archive, "source");
    // Development continued on the first target and a later plan squashed
    // 0002+0003 into one formal migration; the checkout appended 0003 after it.
    const later = join(root, "catalog", "later");
    await cp(join(archive, "target"), join(later, "source"), { recursive: true });
    await writeFile(join(later, "source", "0002_later.sql"), "SELECT 3;");
    await writeFile(join(later, "source", "0003_more.sql"), "SELECT 4;");
    prepareSquash(join(later, "source"), join(later, "target"), "0002", "later_plan");
    const checkout = join(root, "later-checkout");
    await cp(join(later, "target"), checkout, { recursive: true });
    await writeFile(join(checkout, "0003_after.sql"), "SELECT 5;");
    const selectFor = (applied: ReturnType<typeof history>) => selectMigrationArchives(store, checkout, catalog, applied);
    const [second] = await selectFor(history(join(later, "source")));
    expect(second).not.toBe(first);
    // An idle instance still on (a prefix of) the first plan's source converts
    // with the first pair; normal `up` then applies the later formal migration.
    expect(await selectFor(history(firstSource))).toEqual([first]);
    expect(await selectFor(history(firstSource, 2))).toEqual([first]);
    // An instance on (a prefix of) the second plan's source takes the second pair.
    expect(await selectFor(history(join(later, "source"), 3))).toEqual([second]);
    // Already at or beyond the newest target: the conversion is a no-op.
    expect(await selectFor(history(join(later, "target")))).toEqual([second]);
    expect(await selectFor(history(checkout))).toEqual([second]);
    // A history matching no source fails before anything stops.
    await expect(selectFor([...history(firstSource, 2), { version: "0002", name: "other", checksum: "x" }]))
      .rejects.toThrow(/No archive matches/);
  });

  it("chains conversions when a later plan squashed the first plan's formal migration again", async () => {
    const catalog = [join(root, "catalog")];
    const first = await select();
    const again = join(root, "catalog", "again");
    await cp(join(archive, "target"), join(again, "source"), { recursive: true });
    await writeFile(join(again, "source", "0002_more.sql"), "SELECT 3;");
    await writeFile(join(again, "source", "0003_most.sql"), "SELECT 4;");
    prepareSquash(join(again, "source"), join(again, "target"), "0001", "again_plan");
    const checkout = join(again, "target");
    const [second] = await selectMigrationArchives(store, checkout, catalog, history(join(again, "source")));
    // The first target is no prefix of this checkout, but the second source
    // starts with it: convert with the first pair, then with the second.
    expect(await selectMigrationArchives(store, checkout, catalog, history(join(archive, "source")))).toEqual([first, second]);
    expect(await selectMigrationArchives(store, checkout, catalog, history(join(archive, "target")))).toEqual([second]);
    expect(await selectMigrationArchives(store, checkout, catalog, history(checkout))).toEqual([second]);
    for (const id of [first, second]) {
      expect(JSON.parse(await readFile(join(store, id, "state.json"), "utf8")).id).toBe(id);
    }
  });

  it("never records or counts a partial dump as a recovery point", async () => {
    const id = await select();
    const partial = join(home, "db", "dumps", ".pre-squash-20261022-000000-abc.partial");
    await dump("pre-squash-20261022-000000-abc.dump", 2);
    await writeFile(partial, "PGDMP");
    await writeFile(join(home, "db", "dumps", ".hidden.dump"), "PGDMP");
    await completeMigrationArchive(home, id);
    expect(JSON.parse(await readFile(join(store, id, "state.json"), "utf8")).dumps).toEqual(["pre-squash-20261022-000000-abc.dump"]);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1)).toEqual([]);
    expect(await readFile(partial, "utf8")).toBe("PGDMP");
  });

  it("counts retried dumps before one schema change as one recovery point", async () => {
    const before0001 = await dump("pre-migrate-20261020-000000-from-0001.dump", 1);
    const retried = await dump("pre-migrate-20261021-000000-from-0002.dump", 2);
    const before0002 = await dump("pre-migrate-20261021-010000-from-0002.dump", 3);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 2)).toEqual([retried]);
    expect(await readFile(before0001, "utf8")).toContain("PGDMP");
    expect(await readFile(before0002, "utf8")).toContain("PGDMP");
  });

  it("warns, naming the recovery command, when retention cannot run", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const active = join(home, "db", ".migration-cutover.active");
    await mkdir(active, { recursive: true });
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1, { warn })).toEqual([]);
    expect(warnings.pop()).toMatch(/unfinished migration cutover.*squash-migrations\.sh cutover --mode test/);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1, { warn, now: Date.now() + 2 * 86_400_000 })).toEqual([]);
    expect(warnings.pop()).toMatch(/probably stale/);
    await rm(active, { recursive: true });
    await mkdir(join(home, "db", ".migration-artifacts.lock"));
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1, { warn })).toEqual([]);
    expect(warnings.pop()).toMatch(/retention skipped.*migration-cutover\.lock/);
  });

  it("resolves a pending pair once this database carries its target, then expires it with its dependencies", async () => {
    const id = await select();
    const target = loadMigrations(join(archive, "target")).map(({ version, name, checksum }) => ({ version, name, checksum }));
    const source = loadMigrations(join(archive, "source")).map(({ version, name, checksum }) => ({ version, name, checksum }));
    // Still on the source chain: this instance needs the pair to convert.
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1, { appliedMigrations: source.slice(0, 2) })).toEqual([]);
    expect(JSON.parse(await readFile(join(store, id, "state.json"), "utf8")).completedAt).toBeNull();
    // Upgraded through normal `up` of the formal chain (and beyond it).
    const old = await dump("pre-migrate-20261020-000000-from-0000.dump", 1);
    const later = [...target, { version: "0002", name: "later", checksum: "x" }];
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1, { appliedMigrations: later })).toEqual([]);
    expect(JSON.parse(await readFile(join(store, id, "state.json"), "utf8"))).toMatchObject({
      resolution: "database_at_target", dumps: ["pre-migrate-20261020-000000-from-0000.dump"],
    });
    await rm(old);
    expect(await pruneMigrationArtifacts(home, join(home, "backups"), 1, { appliedMigrations: later })).toEqual([join(store, id)]);
  });

  it("preserves dependencies in a custom backup root", async () => {
    const id = await select();
    const backupRoot = join(root, "custom-backups");
    await mkdir(backupRoot);
    await writeFile(join(backupRoot, "system-before.tar.gz"), "fixture");
    await completeMigrationArchive(home, id, backupRoot);
    expect(await pruneMigrationArtifacts(home, backupRoot, 1)).toEqual([]);
    await rm(join(backupRoot, "system-before.tar.gz"));
    expect(await pruneMigrationArtifacts(home, backupRoot, 1)).toEqual([join(store, id)]);
  });
});
