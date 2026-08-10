import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const srcDir = join(__dirname, "..", "src");
const officialPluginsDir = join(__dirname, "..", "..", "plugins", "official");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Bare module specifiers the server is allowed to import. Relative imports
 * (`./`, `../`), `node:` builtins, and `@agent-space/protocol` are allowed.
 * Anything else (frontend, ORM packages, migration tooling, sandbox/deployer
 * internals, local-host) must not appear.
 */
const ALLOWED_BARE = new Set(["fastify", "fast-xml-parser", "undici", "yaml", "zod", "@agent-space/protocol"]);

/**
 * Packages allowed only from a specific file or directory. `pg` is the raw DB
 * driver (deliberately not an ORM) and must stay confined to the `src/db/`
 * data-access layer (pool, transaction helper, migration runner) so database
 * access cannot spread into feature modules without showing up here. `node-pty`
 * is the CLI login PTY host and must stay confined to the login engine. A value
 * ending in `.ts` matches that exact file; a directory value matches any file
 * beneath it.
 */
const ALLOWED_BARE_BY_FILE = new Map<string, string>([
  ["pg", join("src", "db")],
  ["node-pty", join("src", "modules", "providers", "cli", "loginEngine.ts")],
  ["unpdf", join("src", "modules", "sources", "pdfExtract.ts")],
  // drizzle-orm is schema-declaration only (server/src/db/schema/), never a
  // query layer — repositories keep writing hand-written SQL through `pg`.
  // See .agent/architecture/DATABASE_AND_TRANSACTIONS.md, "Schema Authoring".
  ["drizzle-orm", join("src", "db", "schema")],
]);

/** Substrings that must never appear in any import specifier. */
const FORBIDDEN_SUBSTRINGS = [
  "../apps/web", // frontend app
  "../../apps/web",
  "../sandbox/", // first-level sandbox subsystem internals
  "../../sandbox/",
  "../deployer", // first-level deployer subsystem internals
  "../../deployer",
  "../ops", // compose/env/script tree
  "../../ops",
  "apps/web/src",
  "sandbox/",
  "deployer/",
  "ops/compose",
  "local-host",
  "src-tauri",
  "alembic",
  "migrations",
  "sqlalchemy",
  "psycopg",
  "knex",
  "typeorm",
];

const importRe = /\b(?:from|import)\s+["']([^"']+)["']/g;

describe("server import boundaries", () => {
  it("imports only approved runtime packages, node: builtins and relative modules", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1];
        for (const bad of FORBIDDEN_SUBSTRINGS) {
          if (spec.includes(bad)) offenders.push(`${file}: ${spec} (forbidden: ${bad})`);
        }
        if (spec.startsWith(".")) continue;
        if (spec.startsWith("node:")) continue;
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const scopedAllowance = ALLOWED_BARE_BY_FILE.get(pkg);
        if (scopedAllowance) {
          // `.ts` value → exact file; directory value → any file beneath it.
          const allowed = scopedAllowance.endsWith(".ts")
            ? file.endsWith(scopedAllowance)
            : file.includes(scopedAllowance + sep);
          if (!allowed) {
            offenders.push(`${file}: ${spec} (allowed only from ${scopedAllowance})`);
          }
          continue;
        }
        if (!ALLOWED_BARE.has(pkg)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders, `unexpected imports:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("plugin files do not import from server modules", () => {
    const pluginsDir = join(srcDir, "plugins");
    const offenders: string[] = [];
    for (const file of tsFiles(pluginsDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1];
        // Relative imports that traverse into src/modules/ are forbidden from src/plugins/
        if (spec.startsWith(".") && spec.includes("/modules/")) {
          offenders.push(`${file}: ${spec} (plugins must not import server modules)`);
        }
      }
    }
    expect(offenders, `plugin → server-module violations:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("official plugin package files do not import server internals", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(officialPluginsDir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1];
        if (
          spec.includes("server/src/") ||
          spec.includes("apps/web/src/") ||
          spec.includes("/modules/")
        ) {
          offenders.push(`${file}: ${spec} (official plugin packages must use host ports)`);
        }
      }
    }
    expect(offenders, `official plugin package violations:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not reference web or subsystem internals anywhere in src", () => {
    const dataReferenceAllowlist = new Set([
      // This is the fixed HOME path inside the dedicated one-shot Docker
      // image, not a repository subsystem import or host path.
      join(srcDir, "modules", "runs", "localCliExecution.ts"),
    ]);
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      if (dataReferenceAllowlist.has(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const bad of [
        "../apps/web",
        "../../apps/web",
        "apps/web/src",
        "../sandbox/",
        "../../sandbox/",
        "../deployer",
        "../../deployer",
        "deployer/",
        "local-host",
      ]) {
        if (text.includes(bad)) offenders.push(`${file}: contains "${bad}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
