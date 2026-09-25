import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, requiresMaintenance } from "../src/db/migrator.js";

/**
 * A migration that removes something the running release still reads cannot be
 * applied by an ordinary start or a UI update — it would break the server
 * that is running while it runs (ADR 0016 §10). The marker is what
 * both callers key on, so it is pinned here rather than only in a shell script.
 */
describe("maintenance-only migrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rainver-migrations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("recognises the marker only as its own line near the top", () => {
    expect(requiresMaintenance("-- rainver:maintenance\nDROP TABLE x;")).toBe(true);
    expect(requiresMaintenance("-- notes\n\n  -- rainver:maintenance  \nDROP TABLE x;")).toBe(true);
    // Not a marker: a mention inside other text would let a comment about the
    // mechanism turn an ordinary migration into an offline one.
    expect(requiresMaintenance("-- see -- rainver:maintenance for why\nDROP TABLE x;")).toBe(false);
    expect(requiresMaintenance("ALTER TABLE x ADD COLUMN y text;")).toBe(false);
  });

  it("does not scan the whole file, so a late mention cannot flip a migration", () => {
    const late = `${"-- filler\n".repeat(30)}-- rainver:maintenance\n`;
    expect(requiresMaintenance(late)).toBe(false);
  });

  it("keeps the current epoch as one ordinary baseline migration", async () => {
    const chain = loadMigrations(join(import.meta.dirname, "..", "migrations"));
    expect(chain[0]).toMatchObject({ version: "0000", name: "baseline" });
    // Nothing appended to this epoch so far removes what a running release reads.
    expect(chain.map((migration) => requiresMaintenance(migration.sql))).toEqual(chain.map(() => false));
    expect(chain[0]!.sql).not.toContain("cli_credential_profiles");
    expect(chain[0]!.sql).toContain('CREATE TABLE "auth_accounts"');
    expect(chain[0]!.sql).toContain('CREATE TABLE "registration_intents"');
    expect(chain[0]!.sql).not.toContain('CREATE TABLE "auth_action_tokens"');
  });

  it("reports the flag through the status the CLI prints", async () => {
    await writeFile(join(dir, "0001_ordinary.sql"), "ALTER TABLE x ADD COLUMN y text;\n");
    await writeFile(join(dir, "0002_offline.sql"), "-- rainver:maintenance\nDROP TABLE x;\n");
    expect(loadMigrations(dir).map((file) => requiresMaintenance(file.sql))).toEqual([false, true]);
  });
});

/**
 * The marker means "incompatible with the release that is running". A database
 * with nothing applied has no running release, so the whole chain is an
 * ordinary first migration — gating it sent a first-time operator to a
 * maintenance command that needs a running instance to drain.
 */
describe("what counts as pending maintenance", () => {
  function pendingFor(rows: Array<{ applied: boolean; maintenance: boolean }>): number {
    return rows.some((row) => row.applied)
      ? rows.filter((row) => !row.applied && row.maintenance).length
      : 0;
  }

  it("gates nothing on a database that has never been migrated", () => {
    expect(pendingFor([
      { applied: false, maintenance: false },
      { applied: false, maintenance: true },
    ])).toBe(0);
  });

  it("gates once a release is in place that the migration would break", () => {
    expect(pendingFor([
      { applied: true, maintenance: false },
      { applied: false, maintenance: true },
    ])).toBe(1);
  });

  it("does not gate a compatible migration on a live database", () => {
    expect(pendingFor([
      { applied: true, maintenance: false },
      { applied: false, maintenance: false },
    ])).toBe(0);
  });
});
