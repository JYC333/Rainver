import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { loadMigrations, requiresMaintenance, type MigrationFile } from "./migrator.js";

export function mergedMigrationSql(files: readonly MigrationFile[]): string {
  // The runner resets search_path after each original file. Preserve that
  // boundary, SQL order, backfills, and the strongest maintenance requirement.
  return (files.some((file) => requiresMaintenance(file.sql)) ? "-- rainver:maintenance\n" : "")
    + files.map((file) => `${file.sql}\n\nRESET search_path;\n`).join("\n");
}

function sameFile(a: MigrationFile, b: MigrationFile): boolean {
  return a.version === b.version && a.name === b.name && a.checksum === b.checksum;
}

function chain(dir: string): MigrationFile[] {
  const files = loadMigrations(dir);
  if (files.length === 0) throw new Error("Migration chain is empty");
  files.forEach((file, i) => {
    if (file.version !== String(i).padStart(4, "0")) {
      throw new Error("Expected a contiguous four-digit migration chain starting at 0000");
    }
  });
  return files;
}

/** Only a terminal, unpublished suffix can be replaced; the baseline stays fixed. */
export function loadSquashPlan(sourceDir: string, targetDir: string) {
  const source = chain(sourceDir);
  const target = chain(targetDir);
  let common = 0;
  while (common < Math.min(source.length, target.length) && sameFile(source[common], target[common])) common++;
  if (common < 1 || source.length - common < 2 || target.length !== common + 1) {
    throw new Error("Squash must preserve the baseline and replace a suffix of at least two migrations with one");
  }
  const suffix = source.slice(common);
  const replacement = target[common];
  if (replacement.sql !== mergedMigrationSql(suffix)) {
    throw new Error("Merged SQL differs from the ordered original SQL; use squash prepare without editing its SQL");
  }
  const identities = (files: MigrationFile[]) => files.map(({ version, name, checksum }) => ({ version, name, checksum }));
  const manifest = { source: identities(source), target: identities(target) };
  const id = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return { source, target, suffix, replacement, common, manifest, id };
}

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string() }).passthrough()),
}).passthrough();
const snapshotSchema = z.object({ id: z.string(), prevId: z.string() }).passthrough();

/** Write a separate reviewable target directory; never rewrite the source. */
export function prepareSquash(sourceDir: string, outputDir: string, from: string, name: string): void {
  const source = chain(sourceDir);
  const index = source.findIndex((file) => file.version === from);
  if (index < 1 || source.length - index < 2) throw new Error("Select at least two terminal migrations after the baseline");
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Migration name must be snake_case");
  const output = resolve(outputDir);
  const input = resolve(sourceDir);
  if (output === input || output.startsWith(`${input}/`) || input.startsWith(`${output}/`)) {
    throw new Error("Source and output directories must be separate");
  }
  if (existsSync(output)) throw new Error("Output directory already exists");
  const staging = `${output}.preparing`;
  mkdirSync(dirname(output), { recursive: true });
  // No overwrite of a concurrent preparation or an existing directory.
  mkdirSync(staging);
  try {
    for (const file of source.slice(0, index)) cpSync(file.path, join(staging, `${file.version}_${file.name}.sql`));
    const tag = `${from}_${name}`;
    writeFileSync(join(staging, `${tag}.sql`), mergedMigrationSql(source.slice(index)), { flag: "wx" });
    const meta = join(input, "meta");
    if (existsSync(meta)) {
      const journal = journalSchema.parse(JSON.parse(readFileSync(join(meta, "_journal.json"), "utf8")));
      if (journal.entries.length !== source.length || journal.entries.some((entry, i) =>
        entry.idx !== i || entry.tag !== `${source[i].version}_${source[i].name}`)) {
        throw new Error("Drizzle journal does not match the source chain");
      }
      const snapshots = source.map((file) => snapshotSchema.parse(JSON.parse(
        readFileSync(join(meta, `${file.version}_snapshot.json`), "utf8"),
      )));
      mkdirSync(join(staging, "meta"));
      for (const file of source.slice(0, index)) cpSync(join(meta, `${file.version}_snapshot.json`), join(staging, "meta", `${file.version}_snapshot.json`));
      const last = snapshots.at(-1)!;
      // Keep the final schema, link it to the unchanged prefix's snapshot.
      writeFileSync(join(staging, "meta", `${from}_snapshot.json`), JSON.stringify({ ...last, prevId: snapshots[index - 1].id }, null, 2));
      writeFileSync(join(staging, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: [
        ...journal.entries.slice(0, index), { ...journal.entries.at(-1)!, idx: index, tag },
      ] }, null, 2));
    }
    loadSquashPlan(input, staging);
    renameSync(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
