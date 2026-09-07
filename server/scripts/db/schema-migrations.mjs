import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Append-only migration chain.
 *
 * `server/migrations/` is the drizzle-kit output directory and the runtime
 * migration directory at once: `NNNN_<name>.sql` files are applied in order by
 * `src/db/migrator.ts`, and `meta/` holds the Drizzle journal and snapshots
 * that drizzle-kit diffs the TypeScript schema against. `0000_baseline.sql` is
 * the frozen starting point; every schema change after it is a new numbered
 * file. Files that any database has applied are never edited — the runner
 * records checksums and refuses a changed one.
 *
 *   generate --name <name> [--custom]  append the next migration
 *   check                              no-write: chain, extensions, and drift
 */

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationDir = join(serverRoot, "migrations");
const baselineFile = "0000_baseline.sql";
const migrationFileRe = /^(\d{4})_(.+)\.sql$/;
const databaseFeatures = JSON.parse(
  readFileSync(join(serverRoot, "src", "db", "schema", "database-features.json"), "utf8"),
);

function drizzleKit(args) {
  const bin = process.platform === "win32"
    ? join(serverRoot, "node_modules", ".bin", "drizzle-kit.cmd")
    : join(serverRoot, "node_modules", ".bin", "drizzle-kit");
  return spawnSync(bin, args, {
    cwd: serverRoot,
    encoding: "utf8",
    env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: "0" },
  });
}

/**
 * drizzle-kit resolves `--out` by prefixing "./", so an absolute path silently
 * becomes "./<abs>" and every snapshot read fails — and it still exits 0. So
 * the out dir is always passed relative to `server/`, and any error text in
 * the output is treated as failure. Returns true when drizzle-kit reported
 * that the schema already matches the chain.
 */
function generateInto(outDir, name, { custom = false, reportOutput = true } = {}) {
  const args = [
    "generate",
    "--dialect=postgresql",
    "--schema=./src/db/schema/index.ts",
    `--out=./${relative(serverRoot, outDir).split("\\").join("/")}`,
    `--name=${name}`,
  ];
  if (custom) args.push("--custom");
  const result = drizzleKit(args);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const failed = result.status !== 0 || /\bError\b|\berrno\b/.test(output);
  if (failed) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`drizzle-kit generate failed (exit code ${result.status ?? "unknown"})`);
  }
  if (reportOutput && result.stdout) process.stdout.write(result.stdout);
  if (reportOutput && result.stderr) process.stderr.write(result.stderr);
  return /No schema changes/.test(output);
}

/**
 * A short-lived scratch directory for the drift check. The OS temp dir first
 * — inside the server image `/app/server` belongs to root while the check
 * runs as `node`, so a scratch dir there is not creatable — then the
 * git-ignored `server/.tmp` for a host whose temp dir is unwritable. Either
 * way drizzle-kit receives it as a path relative to `server/` (see
 * `generateInto`).
 */
function scratchDir() {
  const name = `rainver-schema-check-${randomBytes(6).toString("hex")}`;
  const candidates = [join(tmpdir(), name), join(serverRoot, ".tmp", name)];
  const failures = [];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch (error) {
      failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no writable scratch directory for the schema check:\n  ${failures.join("\n  ")}`);
}

function migrationFiles(dir) {
  return readdirSync(dir).filter((name) => migrationFileRe.test(name)).sort();
}

/**
 * The chain is contiguous from the frozen baseline, and the Drizzle journal
 * names exactly the files on disk — a journal entry without its SQL, or SQL
 * without its journal entry, is a half-committed migration.
 */
function assertChain(dir) {
  const files = migrationFiles(dir);
  if (files[0] !== baselineFile) {
    throw new Error(`server/migrations must start with ${baselineFile}, found: ${files[0] ?? "nothing"}`);
  }
  files.forEach((file, index) => {
    const version = Number(migrationFileRe.exec(file)[1]);
    if (version !== index) {
      throw new Error(`migration versions must be contiguous: expected ${String(index).padStart(4, "0")}_*.sql, found ${file}`);
    }
  });
  const journalPath = join(dir, "meta", "_journal.json");
  if (!existsSync(journalPath)) throw new Error("server/migrations/meta/_journal.json is missing");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const tags = (journal.entries ?? []).map((entry) => entry.tag);
  const expectedTags = files.map((file) => file.replace(/\.sql$/, ""));
  if (JSON.stringify(tags) !== JSON.stringify(expectedTags)) {
    throw new Error(
      `Drizzle journal entries [${tags.join(", ")}] do not match migration files [${expectedTags.join(", ")}]`,
    );
  }
  for (const entry of journal.entries ?? []) {
    const snapshot = join(dir, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
    if (!existsSync(snapshot)) throw new Error(`missing Drizzle snapshot for ${entry.tag}`);
  }
  return files;
}

/**
 * drizzle-kit does not know about extensions. An extension declared in
 * database-features.json has to be created by some migration in the chain —
 * the baseline carries the original ones; a new one needs a --custom file.
 */
function assertExtensionsMigrated(dir, files) {
  const extensions = databaseFeatures.extensions;
  if (!Array.isArray(extensions) || extensions.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error("Invalid database extension declaration");
  }
  const sql = files.map((file) => readFileSync(join(dir, file), "utf8")).join("\n");
  for (const name of extensions) {
    if (!sql.includes(`CREATE EXTENSION IF NOT EXISTS "${name}"`)) {
      throw new Error(
        `extension "${name}" is declared in database-features.json but no migration creates it; `
        + `add one with: pnpm run schema:generate -- --custom --name enable_${name}`,
      );
    }
  }
}

function parseArgs(argv) {
  const opts = { name: null, custom: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--custom") opts.custom = true;
    else if (arg === "--name") opts.name = argv[++i] ?? null;
    else if (arg.startsWith("--name=")) opts.name = arg.slice("--name=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function generate(argv) {
  const { name, custom } = parseArgs(argv);
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error("usage: pnpm run schema:generate -- --name <snake_case_name> [--custom]");
  }
  const before = new Set(assertChain(migrationDir));
  const unchanged = generateInto(migrationDir, name, { custom });
  const after = assertChain(migrationDir);
  assertExtensionsMigrated(migrationDir, after);
  const added = after.filter((file) => !before.has(file));
  if (added.length === 0) {
    if (!unchanged) throw new Error("drizzle-kit produced neither a migration nor a no-change report");
    console.log("schema-migrations: schema already matches the migration chain; nothing generated");
    return;
  }
  console.log(
    `schema-migrations: added ${added.join(", ")} — review the SQL (and add data backfills) before it is applied anywhere; `
    + "an applied migration is never edited again",
  );
}

/**
 * No-write. Fails when the chain is malformed, when a declared extension has
 * no migration, or when `src/db/schema/` has changes no migration captures:
 * drizzle-kit is run against a temporary copy of the chain, and a new file
 * appearing there is exactly the migration someone forgot to generate.
 */
function check() {
  if (!existsSync(migrationDir)) throw new Error("server/migrations is missing");
  const files = assertChain(migrationDir);
  assertExtensionsMigrated(migrationDir, files);
  const tempRoot = scratchDir();
  try {
    cpSync(migrationDir, tempRoot, { recursive: true });
    const unchanged = generateInto(tempRoot, "drift_check", { reportOutput: false });
    const drift = migrationFiles(tempRoot).filter((file) => !files.includes(file));
    if (drift.length > 0) {
      const sql = readFileSync(join(tempRoot, drift[0]), "utf8");
      process.stderr.write(`${sql}\n`);
      throw new Error(
        "server/src/db/schema has changes that no migration captures (the SQL above is what is missing); "
        + "run: pnpm run schema:generate -- --name <name>",
      );
    }
    if (!unchanged) throw new Error("drizzle-kit produced neither a migration nor a no-change report");
    console.log(`schema-migrations: ${files.length} migration(s) in sync with server/src/db/schema`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "generate") generate(rest);
else if (mode === "check") check();
else {
  process.stderr.write("usage: node scripts/db/schema-migrations.mjs <generate --name <name> [--custom] | check>\n");
  process.exitCode = 2;
}
