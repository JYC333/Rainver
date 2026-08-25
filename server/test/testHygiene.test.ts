import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Patterns that made this suite slow once and must not come back.
 *
 * Each rule below is a cost that scales with the size of the system rather
 * than with the test: truncating cascades across the whole schema, building
 * the whole server to test one module's routes, re-running migrations on a
 * cloned database, waiting on real time. A test using one of them looks fine
 * on the day it is written and gets slower with every table and module added.
 * Exemptions are listed here, by file, so adding one is a visible decision.
 */

const testDir = __dirname;
const files = readdirSync(testDir).filter((name) => name.endsWith(".test.ts") && name !== "testHygiene.test.ts");
const source = new Map(files.map((name) => [name, readFileSync(join(testDir, name), "utf8")]));

function offenders(matches: (name: string, text: string) => boolean, exempt: readonly string[] = []): string[] {
  return files.filter((name) => !exempt.includes(name) && matches(name, source.get(name)!)).sort();
}

describe("test hygiene", () => {
  it("clears rows with resetTables, never TRUNCATE", () => {
    expect(offenders((_, text) => /\bTRUNCATE\b(?![^\n]*\/\/)/.test(text.replace(/\/\/[^\n]*/g, "")))).toEqual([]);
  });

  it("builds only the module under test, not the whole server", () => {
    expect(offenders((_, text) => /from "\.\.\/src\/server"/.test(text), [
      // The gateway and the registry as a whole are what these test.
      "gateway.test.ts",
      "health.test.ts",
      "registryOwnership.test.ts",
      // automations' onReady checks every module's automation-target handler is registered.
      "automationsAutonomyEnableDb.test.ts",
    ])).toEqual([]);
  });

  it("does not migrate a database cloned from the migrated template", () => {
    expect(offenders(
      (_, text) => /\bmigrate\(/.test(text) && !/empty:\s*true/.test(text),
      ["migrator.test.ts"],
    )).toEqual([]);
  });

  it("does not wait on real time for more than 100ms", () => {
    // Guards that reject on a timeout are fine; resolving after a sleep is not.
    const sleep = /setTimeout\(\s*(?:\(\)\s*=>\s*)?(?:resolve|r|res|done)\b[^,)]*,\s*(\d[\d_]*)\s*\)/g;
    expect(offenders((_, text) => {
      for (const match of text.matchAll(sleep)) {
        if (Number(match[1].replaceAll("_", "")) > 100) return true;
      }
      return false;
    })).toEqual([]);
  });
});
