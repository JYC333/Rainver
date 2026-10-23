import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { loadMigrations } from "./migrator.js";
import { loadSquashPlan, prepareSquash } from "./migrationSquash.js";

const filename = z.string().min(1).refine((s) => s !== "." && s !== ".." && !/[\\/]/.test(s));
const stateSchema = z.object({
  format: z.literal("rainver-migration-archive.v1"),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: z.string().datetime().nullable(),
  // How a pending pair stopped being needed for the live database: its own
  // cutover, or this instance's database already carrying the target chain
  // (for example a peer that upgraded through normal `up`).
  resolution: z.enum(["cutover", "database_at_target"]).optional(),
  dumps: z.array(filename),
  backups: z.array(filename),
});
type ArchiveState = z.infer<typeof stateSchema>;
export interface MigrationIdentity { version: string; name: string; checksum: string }

/** A marker/lock older than this is reported as probably abandoned. */
const STALE_OPERATION_MS = 24 * 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function names(path: string): Promise<string[]> {
  if (!(await exists(path))) return [];
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe migration artifact directory: ${path}`);
  return readdir(path);
}

// Copy only ordinary files/dirs; never import paths outside an operator's archive.
async function safeTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) {
    throw new Error(`Unsafe migration artifact: ${path}`);
  }
  if (stat.isDirectory()) for (const name of await readdir(path)) await safeTree(join(path, name));
}

async function readState(archive: string): Promise<ArchiveState> {
  await safeTree(archive);
  const state = stateSchema.parse(JSON.parse(await readFile(join(archive, "state.json"), "utf8")));
  if (loadSquashPlan(join(archive, "source"), join(archive, "target")).id !== state.id) {
    throw new Error("Managed migration archive checksum mismatch");
  }
  return state;
}

async function saveState(archive: string, state: ArchiveState): Promise<void> {
  const temporary = join(archive, "state.json.tmp");
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(archive, "state.json"));
}

function identities(dir: string): MigrationIdentity[] {
  return loadMigrations(dir).map(({ version, name, checksum }) => ({ version, name, checksum }));
}

function startsWith(chain: readonly MigrationIdentity[], prefix: readonly MigrationIdentity[]): boolean {
  return prefix.length <= chain.length && prefix.every((file, i) =>
    file.version === chain[i].version && file.name === chain[i].name && file.checksum === chain[i].checksum);
}

/** Generated/manual dump names a pair may be needed to restore; partial dumps are never recovery points. */
async function completedDumps(home: string): Promise<string[]> {
  return (await names(join(home, "db", "dumps"))).filter((name) => !name.startsWith(".") && name.endsWith(".dump"));
}

/** Import a frozen pair into one instance, without taking ownership of its source. */
export async function registerMigrationArchive(store: string, archive: string): Promise<string> {
  await safeTree(archive);
  const plan = loadSquashPlan(join(archive, "source"), join(archive, "target"));
  await mkdir(store, { recursive: true, mode: 0o700 });
  await names(store);
  const destination = join(store, plan.id);
  if (await exists(destination)) { await readState(destination); return plan.id; }
  const staging = await mkdtemp(join(store, ".preparing-"));
  try {
    for (const name of ["source", "target"]) await cp(join(archive, name), join(staging, name), { recursive: true });
    // Revalidate the copied SQL, not only the source that might have changed during copy.
    if (loadSquashPlan(join(staging, "source"), join(staging, "target")).id !== plan.id) throw new Error("Archive changed while copying");
    await saveState(staging, { format: "rainver-migration-archive.v1", id: plan.id, completedAt: null, dumps: [], backups: [] });
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return plan.id;
}

export async function prepareManagedMigrationArchive(home: string, source: string, from: string, name: string): Promise<string> {
  const store = join(home, "db", "migration-archives");
  await mkdir(store, { recursive: true, mode: 0o700 });
  await names(store);
  await safeTree(source);
  const staging = await mkdtemp(join(store, ".preparing-"));
  try {
    await cp(source, join(staging, "source"), { recursive: true });
    prepareSquash(join(staging, "source"), join(staging, "target"), from, name);
    const id = await registerMigrationArchive(store, staging);
    // Each already configured local instance gets its own pending pair before
    // the source instance can complete/prune it. An idle test DB must not lose
    // its upgrade path merely because dev has rotated through newer backups.
    if (["dev", "test", "prod"].includes(basename(home))) {
      for (const mode of ["dev", "test", "prod"]) {
        const peer = join(dirname(home), mode);
        if (peer !== home && await exists(join(peer, ".env"))) {
          await registerMigrationArchive(join(peer, "db", "migration-archives"), staging);
        }
      }
    }
    return join(store, id);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

interface ArchivedPair { id: string; path: string; source: MigrationIdentity[]; target: MigrationIdentity[]; common: number }

/** The converter's own acceptance rule: an exact source prefix covering the retained prefix, not yet at the target. */
function converts(history: readonly MigrationIdentity[], pair: ArchivedPair): boolean {
  return history.length >= pair.common && startsWith(pair.source, history) && !startsWith(history, pair.target);
}

/**
 * The shortest sequence of conversions that takes `applied` to a target chain
 * the checkout starts with; normal `up` runs the rest. A history that follows
 * the checkout and already carries such a target keeps that pair (a no-op
 * conversion, as on a retry after the conversion committed).
 * Among equally short sequences the one ending at the longest target wins;
 * distinct sequences that remain tied are ambiguous.
 */
function cutoverPath(pairs: readonly ArchivedPair[], applied: readonly MigrationIdentity[], checkout: readonly MigrationIdentity[]): ArchivedPair[] {
  const best = (paths: ArchivedPair[][]): ArchivedPair[] => {
    const longest = Math.max(...paths.map((path) => path.at(-1)!.target.length));
    const selected = paths.filter((path) => path.at(-1)!.target.length === longest);
    if (selected.length !== 1) throw new Error("Ambiguous migration archives for this database's history; select --archive explicitly");
    return selected[0];
  };
  // Nothing left to convert only while the history itself follows the checkout;
  // a history past a target on development files still needs their pair.
  const follows = startsWith(checkout, applied) || startsWith(applied, checkout);
  const carried = pairs.filter((pair) => follows && startsWith(applied, pair.target) && startsWith(checkout, pair.target));
  if (carried.length) return best(carried.map((pair) => [pair]));
  let frontier: ArchivedPair[][] = [[]];
  while (frontier.length) {
    const next: ArchivedPair[][] = [];
    for (const path of frontier) {
      const history = path.at(-1)?.target ?? applied;
      for (const pair of pairs) if (!path.includes(pair) && converts(history, pair)) next.push([...path, pair]);
    }
    const done = next.filter((path) => startsWith(checkout, path.at(-1)!.target));
    if (done.length) return best(done);
    frontier = next;
  }
  throw new Error("No archive matches this database's migration history and the checkout; prepare/register the original migration chain first");
}

/**
 * Match content, never directory timestamp/name. Pairs are chosen by the
 * database's applied history as well as the checkout: the first pair's source
 * must accept that history exactly as conversion will, and each further pair's
 * source must accept the previous pair's target (a plan squashed again after an
 * earlier squash). The last target must be the checkout's chain or a prefix of
 * it: migrations appended after it run through normal `up` once the
 * conversions are done. Returns the ordered pair identities, each imported
 * into this instance's store.
 */
export async function selectMigrationArchives(
  store: string,
  checkout: string,
  catalogs: string[],
  applied: readonly MigrationIdentity[],
  explicit?: string,
): Promise<string[]> {
  const expected = identities(checkout);
  if (expected.length < 2) throw new Error("No merged migration found in checkout");
  const candidates = explicit ? [explicit] : (await Promise.all([store, ...catalogs].map(async (root) =>
    (await names(root)).filter((name) => !name.startsWith(".")).map((name) => join(root, name))))).flat();
  const pairs = new Map<string, ArchivedPair>();
  for (const candidate of candidates) {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe migration artifact: ${candidate}`);
    if (!stat.isDirectory()) continue;
    if (!(await exists(join(candidate, "target")))) continue;
    await safeTree(candidate);
    const plan = loadSquashPlan(join(candidate, "source"), join(candidate, "target"));
    if (!pairs.has(plan.id)) {
      pairs.set(plan.id, { id: plan.id, path: candidate, source: plan.manifest.source, target: plan.manifest.target, common: plan.common });
    }
  }
  const path = cutoverPath([...pairs.values()], applied, expected);
  for (const pair of path) await registerMigrationArchive(store, pair.path);
  return path.map((pair) => pair.id);
}

/** Called while writers are stopped; an unsuccessful cutover remains pinned. */
export async function completeMigrationArchive(home: string, id: string, backupRoot = join(home, "backups")): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid archive identity");
  const archive = join(home, "db", "migration-archives", id);
  const state = await readState(archive);
  const backups = (await names(backupRoot)).filter((name) => name.endsWith(".tar.gz"));
  await saveState(archive, { ...state, completedAt: new Date().toISOString(), resolution: "cutover", dumps: await completedDumps(home), backups });
}

export interface MigrationRetentionOptions {
  /** Retention that cannot run is reported, never silently skipped. */
  warn?: (message: string) => void;
  /**
   * The live database's applied history. A pending pair whose target chain it
   * already carries (normal `up` of the formal chain, or a fresh database) is
   * resolved and then expires with its recorded backup dependencies.
   */
  appliedMigrations?: readonly MigrationIdentity[];
  now?: number;
}

async function ageWarning(path: string, now: number): Promise<string> {
  const ageMs = now - (await lstat(path)).mtimeMs;
  return ageMs > STALE_OPERATION_MS ? ` It is ${Math.floor(ageMs / 3_600_000)} hours old and is probably stale.` : "";
}

/** Retention owns generated safety dumps and registered resolved pairs only. */
export async function pruneMigrationArtifacts(home: string, backupRoot: string, keep: number, options: MigrationRetentionOptions = {}): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("Retention must keep at least one backup");
  const db = join(home, "db");
  if (!(await exists(db))) return [];
  await names(db);
  const now = options.now ?? Date.now();
  const mode = basename(home);
  const lock = join(db, ".migration-artifacts.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    options.warn?.(`Migration artifact retention skipped: ${lock} is held by a cutover or another retention run.${await ageWarning(lock, now)}`
      + ` If no \`squash-migrations.sh cutover --mode ${mode}\` process holds ${join(db, "migration-cutover.lock")} (check with \`fuser\` or \`ps\`), remove the directory to resume retention.`);
    return [];
  }
  try { return await pruneUnlocked(home, backupRoot, keep, options, now); }
  finally { await rm(lock, { recursive: true }); }
}

async function pruneUnlocked(home: string, backupRoot: string, keep: number, options: MigrationRetentionOptions, now: number): Promise<string[]> {
  const db = join(home, "db");
  const mode = basename(home);
  // Cutover creates this before any import/dump and removes it only on success.
  // A failed/crashed cutover pins recovery materials until explicitly retried.
  const active = join(db, ".migration-cutover.active");
  if (await exists(active)) {
    options.warn?.(`Migration artifact retention is paused: ${active} records an unfinished migration cutover.${await ageWarning(active, now)}`
      + ` Inspect the reported backup and container state, then rerun \`./ops/scripts/db/squash-migrations.sh cutover --mode ${mode}\`;`
      + " a successful retry restarts the recorded applications and clears the marker. Do not delete the marker merely to resume cleanup.");
    return [];
  }
  const store = join(db, "migration-archives");
  const records: { path: string; state: ArchiveState }[] = [];
  for (const name of await names(store)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const path = join(store, name);
    records.push({ path, state: await readState(path) });
  }
  if (options.appliedMigrations) {
    const backups = (await names(backupRoot)).filter((name) => name.endsWith(".tar.gz"));
    const dumps = await completedDumps(home);
    for (const record of records) {
      if (record.state.completedAt || !startsWith(options.appliedMigrations, identities(join(record.path, "target")))) continue;
      // Older local backups may still carry the source history; they keep the pair.
      record.state = { ...record.state, completedAt: new Date(now).toISOString(), resolution: "database_at_target", dumps, backups };
      await saveState(record.path, record.state);
    }
  }
  // Unknown/incomplete recovery state fails closed before deleting any file.
  const dumpRoot = join(db, "dumps");
  const dumps = [];
  for (const name of await names(dumpRoot)) {
    if (!/^pre-(?:squash|migrate)-[^/]+\.dump$/.test(name)) continue;
    const path = join(dumpRoot, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 5) continue;
    // Only recognizable pg_dump archives enter the generated-dump policy.
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(5);
      await file.read(header, 0, 5, 0);
      if (header.toString() !== "PGDMP") continue;
    } finally { await file.close(); }
    // `pre-migrate-<ts>-from-<version>.dump` names the schema version it preserves.
    const version = /^pre-migrate-.+-from-(\d{4})\.dump$/.exec(name)?.[1];
    dumps.push({ path, time: stat.mtimeMs, point: version ? `migrate:${version}` : path });
  }
  dumps.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
  // Count recovery points, not files: retried dumps before the same schema
  // change collapse to the newest one, so they cannot evict the dump taken
  // before an earlier change. The newest `keep` points remain.
  const points = new Set<string>();
  const expired = dumps.filter((dump) => {
    if (points.has(dump.point)) return true;
    points.add(dump.point);
    return points.size > keep;
  });
  const deleted: string[] = [];
  // Validate the backup directory before any deletion. An inaccessible custom
  // backup location must not be mistaken for an empty one.
  const retainedBackups = new Set(await names(backupRoot));
  for (const dump of expired) { await unlink(dump.path); deleted.push(dump.path); }
  const retainedDumps = new Set(await names(dumpRoot));
  for (const { path, state } of records) {
    if (!state.completedAt) continue;
    if (state.dumps.some((name) => retainedDumps.has(name)) || state.backups.some((name) => retainedBackups.has(name))) continue;
    await rm(path, { recursive: true });
    deleted.push(path);
  }
  return deleted;
}
