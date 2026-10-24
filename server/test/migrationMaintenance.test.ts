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
    // 0004 drops the capability tables a pre-0004 release still reads, so it
    // is the one offline migration in this epoch; everything else applies live.
    expect(chain.map((migration) => requiresMaintenance(migration.sql)))
      .toEqual(chain.map((migration) => migration.version === "0004"));
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
